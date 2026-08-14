import ccxt from 'ccxt';
import { cexCredentials, config } from './config.js';
import { logger } from './log.js';

const log = logger('cex');

/**
 * Porte fiel do bot Python `binance_arb_bep20.py`.
 *
 * A lógica de execução (preços usados, ordem das chamadas, reprecificação no
 * melhor bid, fallback a mercado, tolerância de poeira, detecção de chegada
 * pelo saldo) foi mantida linha a linha. Usamos a mesma biblioteca (ccxt) para
 * que a semântica das chamadas seja idêntica à da versão original.
 *
 * Não altere as constantes em `config.cexTuning` sem revisar o original.
 *
 * A mecânica é a mesma para qualquer exchange de destino: o que muda é só o
 * cliente ccxt, então tudo aqui recebe a exchange por parâmetro.
 */

type Exchange = InstanceType<typeof ccxt.Exchange>;

function ctor(exchangeId: string): new (c: unknown) => Exchange {
  const C = (ccxt as unknown as Record<string, new (c: unknown) => Exchange>)[exchangeId];
  if (!C) throw new Error(`exchange "${exchangeId}" não existe no ccxt`);
  return C;
}

/** Cliente público (sem chaves) — cotação. Um por exchange, reaproveitado. */
const publicClients = new Map<string, Exchange>();

export function cexPublic(exchangeId: string): Exchange {
  let ex = publicClients.get(exchangeId);
  if (!ex) {
    ex = new (ctor(exchangeId))({ enableRateLimit: true });
    publicClients.set(exchangeId, ex);
  }
  return ex;
}

/** Cliente autenticado — execução. */
export function cexPrivate(exchangeId: string): Exchange {
  const creds = cexCredentials[exchangeId];
  if (!creds?.apiKey || !creds.secret) {
    throw new Error(`credenciais da ${exchangeId} não configuradas (${exchangeId.toUpperCase()}_API_KEY / _API_SECRET)`);
  }
  return new (ctor(exchangeId))({
    apiKey: creds.apiKey,
    secret: creds.secret,
    // Bitget e KuCoin exigem passphrase; exchanges que não usam ignoram.
    password: creds.password,
    enableRateLimit: true,
  });
}

/** Binance via ccxt, como no original (inclui adjustForTimeDifference). */
export function binanceCcxt(authenticated: boolean): Exchange {
  return new ccxt.binance({
    ...(authenticated ? { apiKey: config.binance.apiKey, secret: config.binance.apiSecret } : {}),
    enableRateLimit: true,
    options: { adjustForTimeDifference: true },
  });
}

export interface SellResult {
  /** Preço médio de venda ponderado. */
  avgSellPrice: number;
  soldUsdt: number;
  usedMarketFallback: boolean;
}

/**
 * Vende via ordens LIMIT reprecificadas no melhor bid do book, em vez de ordem
 * a mercado. Isso evita "comer" o spread/slippage do market, capturando o topo
 * do book. A cada tentativa que não enche, cancela e recoloca no bid
 * atualizado. Se esgotar as tentativas, faz fallback para mercado para garantir
 * que o capital não fique preso em uma ordem parada.
 */
export async function sellAtBestBid(
  ex: Exchange,
  symbol: string,
  amount: number,
  maxAttempts = config.cexTuning.sellMaxAttempts,
  waitSeconds = config.cexTuning.sellWaitSeconds,
): Promise<SellResult> {
  let remaining = amount;
  let totalReceivedBrl = 0;
  let totalSoldUsdt = 0;

  // Tolerância de "poeira": abaixo do mínimo negociável da própria exchange,
  // o resíduo não pode ser vendido mesmo que quiséssemos, então tratamos
  // como zero em vez de tentar (e falhar) uma nova ordem.
  let minAmount = 0.1;
  try {
    await ex.loadMarkets();
    minAmount = (ex.market(symbol)?.limits?.amount?.min as number) || 0.1;
  } catch {
    minAmount = 0.1;
  }
  const dustThreshold = minAmount;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (remaining <= dustThreshold) break;

    const ticker = await ex.fetchTicker(symbol);
    const bidPrice = ticker.bid as number;

    // Ajusta a quantidade à precisão exigida pela exchange
    const amountToSell = Number(ex.amountToPrecision(symbol, remaining));
    if (amountToSell <= 0) break;

    log.info(
      `Tentativa ${attempt}/${maxAttempts}: ordem LIMIT de venda a R$ ${bidPrice.toFixed(4)} (${amountToSell} USDT)...`,
    );

    const order = await ex.createLimitSellOrder(symbol, amountToSell, bidPrice);
    const orderId = order.id as string;

    await sleep(waitSeconds * 1000);

    const fetched = await ex.fetchOrder(orderId, symbol);
    const filled = (fetched.filled as number) || 0;
    const avgPrice = (fetched.average as number) || bidPrice;
    const status = fetched.status;

    if (filled > 0) {
      totalReceivedBrl += filled * avgPrice;
      totalSoldUsdt += filled;
      remaining -= filled;
      log.info(`  -> Executado parcial/total: ${filled.toFixed(4)} USDT a R$ ${avgPrice.toFixed(4)}`);
    }

    if (status !== 'closed' && remaining > dustThreshold) {
      // Não encheu (ou encheu só parcialmente): cancela o restante da ordem
      try {
        await ex.cancelOrder(orderId, symbol);
      } catch {
        // pode já ter fechado/cancelado entre o fetch e o cancel
      }
    }
  }

  if (remaining > dustThreshold) {
    // Esgotou as tentativas com limit: fallback para mercado para não
    // deixar capital parado em USDT sem vender.
    const amountToSell = Number(ex.amountToPrecision(symbol, remaining));
    if (amountToSell > 0) {
      log.warn(`Limite de tentativas atingido. Vendendo o restante (${amountToSell} USDT) a MERCADO...`);
      const order = await ex.createMarketSellOrder(symbol, amountToSell);
      const filled = (order.filled as number) || amountToSell;
      const avgPrice =
        (order.average as number) || (order.price as number) || ((await ex.fetchTicker(symbol)).bid as number);
      totalReceivedBrl += filled * avgPrice;
      totalSoldUsdt += filled;
      return {
        avgSellPrice: totalSoldUsdt ? totalReceivedBrl / totalSoldUsdt : avgPrice,
        soldUsdt: totalSoldUsdt,
        usedMarketFallback: true,
      };
    }
  }

  if (remaining > 0 && remaining <= dustThreshold) {
    log.info(
      `Resíduo de ${remaining.toFixed(8)} USDT abaixo do mínimo negociável (${dustThreshold}) — ignorado, fica na conta para a próxima operação.`,
    );
  }

  return {
    avgSellPrice: totalSoldUsdt > 0 ? totalReceivedBrl / totalSoldUsdt : 0,
    soldUsdt: totalSoldUsdt,
    usedMarketFallback: false,
  };
}

/**
 * Monitora o saldo de USDT na exchange de destino até a chegada do saque.
 * Mantém a heurística do original: compara contra o saldo lido logo após o
 * envio, descontando a taxa estimada de saque.
 */
export async function waitForCexDeposit(
  ex: Exchange,
  initialBalance: number,
  withdrawAmount: number,
): Promise<void> {
  const POLL_INTERVAL = config.cexTuning.depositPollSeconds;
  const MAX_ATTEMPTS = config.cexTuning.depositMaxAttempts;
  const LOG_EVERY = 3; // loga só a cada 3 tentativas (~15s) pra não poluir o log

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const current = await freeUsdt(ex);
    if (current >= initialBalance + (withdrawAmount - config.cexTuning.estimatedWithdrawalFee)) return;
    if (i % LOG_EVERY === 0) {
      log.info(`Aguardando confirmação de rede... (${i * POLL_INTERVAL}s)`);
    }
    await sleep(POLL_INTERVAL * 1000);
  }

  throw new Error('O depósito demorou muito. Verifique manualmente na exchange.');
}

export async function freeUsdt(exchange: Exchange): Promise<number> {
  const bal = await exchange.fetchBalance();
  return (bal.USDT?.free as number) ?? 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
