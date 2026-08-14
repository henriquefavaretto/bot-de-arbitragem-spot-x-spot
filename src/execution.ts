import { config } from './config.js';
import { logger } from './log.js';
import { binanceCcxt, cexPrivate, freeUsdt, sellAtBestBid } from './cex.js';
import { getRoute, buildRoute } from './kyber.js';
import {
  ensureAllowance,
  fromRaw,
  sendRawSwap,
  toRaw,
  tokenBalance,
  transferToken,
  waitForBalanceIncrease,
  walletAddress,
} from './chain.js';
import { resolveSymbol, type VenueDef } from './venues.js';

const log = logger('exec');

/**
 * Operações elementares de um venue, no mesmo vocabulário para CEX e DEX.
 *
 * Uma perna A→B se decompõe sempre em:
 *   1. `acquireUsdt` em A   — comprar USDT com o saldo local em BRL
 *   2. `sendUsdt` de A      — sacar/transferir para o endereço de B
 *   3. `awaitUsdt` em B     — esperar a chegada
 *   4. `disposeUsdt` em B   — vender USDT pelo BRL local
 *
 * Em CEX "BRL local" é saldo fiduciário na exchange. Em DEX é BRLA ou BRZ na
 * carteira. As quatro operações abaixo escondem essa diferença.
 */

export interface AcquireResult {
  usdt: number;
  /** Preço médio pago, em BRL por USDT. */
  avgPrice: number;
  ref: string;
}

export interface DisposeResult {
  brl: number;
  avgPrice: number;
  ref: string;
  usedMarketFallback?: boolean;
}

export interface SendResult {
  amountSent: number;
  ref: string;
}

// ─── 1. Adquirir USDT ───────────────────────────────────────────────────────

/** Compra USDT gastando `amountBrl` do saldo local do venue. */
export async function acquireUsdt(venue: VenueDef, amountBrl: number): Promise<AcquireResult> {
  if (config.dryRun) {
    log.info(`[DRY_RUN] compraria ~${amountBrl.toFixed(2)} BRL de USDT em ${venue.label}`);
    return { usdt: 0, avgPrice: 0, ref: 'dryrun' };
  }

  if (venue.kind === 'dex') return acquireUsdtOnDex(venue, amountBrl);
  return acquireUsdtOnCex(venue, amountBrl);
}

async function acquireUsdtOnCex(venue: VenueDef, amountBrl: number): Promise<AcquireResult> {
  const ex = venue.id === 'binance' ? binanceCcxt(true) : cexPrivate(venue.exchange!);
  const { symbol, inverted } = await resolveSymbol(venue.exchange!);
  await ex.loadMarkets();

  const before = await freeUsdt(ex);

  if (!inverted) {
    // Par USDT/BRL: comprar USDT gastando um valor exato em BRL (a quote).
    log.info(`${venue.label}: comprando USDT com R$ ${amountBrl.toFixed(2)} (${symbol})`);
    await ex.createMarketBuyOrderWithCost(symbol, amountBrl);
  } else {
    // Par BRL/USDT (MEXC): comprar USDT é VENDER BRL, que é a base.
    const amount = Number(ex.amountToPrecision(symbol, amountBrl));
    log.info(`${venue.label}: vendendo ${amount} BRL por USDT (${symbol}, invertido)`);
    await ex.createMarketSellOrder(symbol, amount);
  }

  // O saldo é a fonte da verdade: campos de ordem variam muito entre exchanges.
  await sleep(2000);
  const after = await freeUsdt(ex);
  const usdt = after - before;
  if (usdt <= 0) throw new Error(`${venue.label}: saldo de USDT não subiu após a compra`);

  log.success(`${venue.label}: ${usdt.toFixed(4)} USDT adquiridos a R$ ${(amountBrl / usdt).toFixed(4)}`);
  return { usdt, avgPrice: amountBrl / usdt, ref: symbol };
}

/** Numa DEX, adquirir USDT é dar swap do token lastreado em BRL. */
async function acquireUsdtOnDex(venue: VenueDef, amountBrl: number): Promise<AcquireResult> {
  const token = venue.token!;
  const amountInRaw = await toRaw(token, amountBrl);

  const route = await getRoute(token, config.tokens.usdt, amountInRaw, walletAddress);
  await ensureAllowance(token, route.routerAddress, amountInRaw);
  const built = await buildRoute(route, walletAddress, walletAddress, config.trade.slippageBps);

  const before = (await tokenBalance(config.tokens.usdt)).raw;
  const gasLimit = built.gas > 0n ? (built.gas * 130n) / 100n : undefined;
  const tx = await sendRawSwap(built.routerAddress, built.data, built.transactionValue, gasLimit);
  const after = (await tokenBalance(config.tokens.usdt)).raw;

  const usdt = await fromRaw(config.tokens.usdt, after - before);
  if (usdt <= 0) throw new Error(`${venue.label}: swap não entregou USDT`);

  log.success(`${venue.label}: swap rendeu ${usdt.toFixed(4)} USDT`);
  return { usdt, avgPrice: amountBrl / usdt, ref: tx.hash };
}

// ─── 2. Enviar USDT ─────────────────────────────────────────────────────────

/** Saca (CEX) ou transfere (DEX) USDT para o endereço de destino. */
export async function sendUsdt(
  venue: VenueDef,
  network: string,
  address: string,
  amount: number,
): Promise<SendResult> {
  if (!address) throw new Error(`sem endereço de depósito para a rede ${network}`);

  if (config.dryRun) {
    log.info(`[DRY_RUN] ${venue.label} enviaria ${amount.toFixed(4)} USDT via ${network} para ${address}`);
    return { amountSent: amount, ref: 'dryrun' };
  }

  if (venue.kind === 'dex') {
    const raw = await toRaw(config.tokens.usdt, amount);
    const tx = await transferToken(config.tokens.usdt, address, raw);
    return { amountSent: amount, ref: tx.hash };
  }

  const ex = venue.id === 'binance' ? binanceCcxt(true) : cexPrivate(venue.exchange!);
  log.info(`${venue.label}: sacando ${amount.toFixed(4)} USDT via ${network}`);

  const r = await ex.withdraw('USDT', amount, address, undefined, { network });
  return { amountSent: amount, ref: String(r.id ?? '') };
}

// ─── 3. Aguardar chegada ────────────────────────────────────────────────────

/**
 * Espera o USDT aparecer no destino. Usa o saldo como sinal, que é o que
 * funciona igual em exchange e on-chain.
 */
export async function awaitUsdt(
  venue: VenueDef,
  baseline: number,
  expected: number,
  opts: { timeoutMs: number; pollMs: number },
): Promise<number> {
  if (config.dryRun) {
    log.info(`[DRY_RUN] ${venue.label} receberia ${expected.toFixed(4)} USDT`);
    return expected;
  }

  // Tolerância de 2%: a taxa real de saque pode diferir da cotada.
  const target = baseline + expected * 0.98;
  const deadline = Date.now() + opts.timeoutMs;

  if (venue.kind === 'dex') {
    const baselineRaw = await toRaw(config.tokens.usdt, baseline);
    const minIncrease = await toRaw(config.tokens.usdt, expected * 0.98);
    const after = await waitForBalanceIncrease(config.tokens.usdt, baselineRaw, minIncrease, {
      timeoutMs: opts.timeoutMs,
      pollMs: opts.pollMs,
    });
    // O contrato desta função é devolver o quanto CHEGOU, não o saldo total.
    return fromRaw(config.tokens.usdt, after - baselineRaw);
  }

  const ex = venue.id === 'binance' ? binanceCcxt(true) : cexPrivate(venue.exchange!);
  let waited = 0;

  while (Date.now() < deadline) {
    const current = await freeUsdt(ex);
    if (current >= target) {
      log.success(`${venue.label}: recebidos ${(current - baseline).toFixed(4)} USDT`);
      return current - baseline;
    }
    if (waited % 5 === 0) log.info(`${venue.label}: aguardando chegada... (${waited * (opts.pollMs / 1000)}s)`);
    waited++;
    await sleep(opts.pollMs);
  }

  throw new Error(`${venue.label}: depósito não chegou no prazo — verifique manualmente`);
}

// ─── 4. Vender USDT ─────────────────────────────────────────────────────────

/** Vende `amountUsdt` pelo ativo em BRL local do venue. */
export async function disposeUsdt(venue: VenueDef, amountUsdt: number): Promise<DisposeResult> {
  if (config.dryRun) {
    log.info(`[DRY_RUN] ${venue.label} venderia ${amountUsdt.toFixed(4)} USDT`);
    return { brl: 0, avgPrice: 0, ref: 'dryrun' };
  }

  if (venue.kind === 'dex') return disposeUsdtOnDex(venue, amountUsdt);
  return disposeUsdtOnCex(venue, amountUsdt);
}

async function disposeUsdtOnCex(venue: VenueDef, amountUsdt: number): Promise<DisposeResult> {
  const ex = venue.id === 'binance' ? binanceCcxt(true) : cexPrivate(venue.exchange!);
  const { symbol, inverted } = await resolveSymbol(venue.exchange!);
  await ex.loadMarkets();

  // Arredonda para baixo: sobra de casas decimais faz a exchange rejeitar.
  const amount = Math.floor(amountUsdt * 100) / 100;
  if (amount <= 0) throw new Error(`${venue.label}: valor a vender é insignificante`);

  if (!inverted) {
    // Ordens LIMIT reprecificadas no melhor bid, como no bot original.
    const r = await sellAtBestBid(ex, symbol, amount);
    if (!r.soldUsdt) throw new Error(`${venue.label}: nada foi vendido`);
    return {
      brl: r.soldUsdt * r.avgSellPrice,
      avgPrice: r.avgSellPrice,
      ref: symbol,
      usedMarketFallback: r.usedMarketFallback,
    };
  }

  // Par BRL/USDT: vender USDT é COMPRAR BRL gastando USDT (a quote).
  // Margem de 0.1% para não estourar o saldo por arredondamento.
  const spend = amount * 0.999;
  log.info(`${venue.label}: comprando BRL a mercado gastando ${spend.toFixed(4)} USDT (invertido)`);
  const order = await ex.createMarketBuyOrderWithCost(symbol, spend);

  const brl = (order.filled as number) || 0;
  if (brl <= 0) throw new Error(`${venue.label}: ordem invertida não retornou quantidade preenchida`);

  return { brl, avgPrice: brl / spend, ref: symbol };
}

/** Numa DEX, dispor do USDT é dar swap para o token lastreado em BRL. */
async function disposeUsdtOnDex(venue: VenueDef, amountUsdt: number): Promise<DisposeResult> {
  const token = venue.token!;
  const amountInRaw = await toRaw(config.tokens.usdt, amountUsdt);

  const route = await getRoute(config.tokens.usdt, token, amountInRaw, walletAddress);
  await ensureAllowance(config.tokens.usdt, route.routerAddress, amountInRaw);
  const built = await buildRoute(route, walletAddress, walletAddress, config.trade.slippageBps);

  const before = (await tokenBalance(token)).raw;
  const gasLimit = built.gas > 0n ? (built.gas * 130n) / 100n : undefined;
  const tx = await sendRawSwap(built.routerAddress, built.data, built.transactionValue, gasLimit);
  const after = (await tokenBalance(token)).raw;

  const received = after - before;
  if (received < built.amountOutMinRaw) {
    throw new Error(`${venue.label}: swap entregou menos que o mínimo aceito`);
  }

  const brl = await fromRaw(token, received);
  log.success(`${venue.label}: swap rendeu ${brl.toFixed(2)} ${venue.label}`);
  return { brl, avgPrice: brl / amountUsdt, ref: tx.hash };
}

// ─── Saldos ─────────────────────────────────────────────────────────────────

/** Saldo de USDT disponível no venue — a linha de base antes de um envio. */
export async function usdtBalance(venue: VenueDef): Promise<number> {
  if (config.dryRun) return 0;
  if (venue.kind === 'dex') return (await tokenBalance(config.tokens.usdt)).formatted;
  const ex = venue.id === 'binance' ? binanceCcxt(true) : cexPrivate(venue.exchange!);
  return freeUsdt(ex);
}

/** Saldo do ativo em BRL local: fiduciário na CEX, token na DEX. */
export async function localBrlBalance(venue: VenueDef): Promise<number> {
  if (config.dryRun) return 0;
  if (venue.kind === 'dex') return (await tokenBalance(venue.token!)).formatted;

  const ex = venue.id === 'binance' ? binanceCcxt(true) : cexPrivate(venue.exchange!);
  const bal = await ex.fetchBalance();
  return (bal.BRL?.free as number) ?? 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
