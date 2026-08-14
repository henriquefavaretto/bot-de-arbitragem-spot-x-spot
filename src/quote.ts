import { binance, simulateMarketBuy, type OrderBook } from './binance.js';
import { gasFees, provider, toRaw, fromRaw, walletAddress } from './chain.js';
import { getRoute } from './kyber.js';
import { cexPublic } from './cex.js';
import { config, routes, type RouteDef } from './config.js';
import { logger } from './log.js';
import { formatUnits } from 'ethers';

const log = logger('quote');

/** Gás estimado de cada passo on-chain, usado antes de termos o número real. */
const GAS_APPROVE = 60_000n;
const GAS_TRANSFER = 70_000n;
const GAS_SWAP_FALLBACK = 400_000n;

/**
 * Dados de mercado que todas as rotas compartilham. Buscados uma vez por
 * atualização: o livro da Binance e o preço do gás são os mesmos para todas.
 */
export interface MarketSnapshot {
  ts: number;
  book: OrderBook;
  /** Taxa de saque por rede, indexada pelo código da rede na Binance. */
  withdrawFees: Record<string, number>;
  polUsdt: number;
  maxFeePerGas: bigint;
  warnings: string[];
}

export interface Quote {
  ts: number;
  routeId: string;
  kind: 'dex' | 'cex';
  amountBrl: number;

  /** Etapa 1 — Binance */
  usdtGross: number;
  avgPriceBrl: number;
  binanceFeeUsdt: number;
  usdtAfterTradeFee: number;

  /** Etapa 2 — saque */
  withdrawFeeUsdt: number;
  usdtOnChain: number;

  /** Etapa 3 — swap (dex) ou venda (cex) */
  tokenOut: number;
  tokenPerUsdt: number;
  priceImpactPct: number;
  /** Só em rotas cex: taxa de negociação cobrada na exchange de destino. */
  destTradeFeeBrl: number;

  /** Etapa 4 — custos de rede (zero em rotas cex) */
  gasNative: number;
  gasBrl: number;
  polPriceBrl: number;

  /** Etapa 5 — saque na plataforma de destino */
  venueFeeBrl: number;

  /** Decomposição em % sobre o aporte: bruto − taxas = líquido. */
  grossSpreadPct: number;
  feesPct: number;
  spreadPct: number;

  /** Taxas em reais, para o detalhamento da UI. */
  tradeFeeBrl: number;
  withdrawFeeBrl: number;
  totalFeesBrl: number;

  netBrl: number;
  profitBrl: number;

  usdtBrlBinance: number;
  bookDepthOk: boolean;
  warnings: string[];
}

// A taxa de saque vem de um endpoint pesado (weight 10) — cache curto.
let feeCache: { value: Record<string, number>; at: number } | null = null;

/** Redes usadas por alguma rota configurada. */
function networksInUse(): string[] {
  return [...new Set(routes.map((r) => r.network))];
}

async function withdrawFees(warnings: string[]): Promise<Record<string, number>> {
  if (feeCache && Date.now() - feeCache.at < 60_000) return feeCache.value;

  const nets = networksInUse();

  if (!config.binance.apiKey || !config.binance.apiSecret) {
    warnings.push(`Sem API key da Binance: usando taxa de saque estimada de ${config.binance.withdrawFeeFallback} USDT`);
    return Object.fromEntries(nets.map((n) => [n, config.binance.withdrawFeeFallback]));
  }

  const out: Record<string, number> = {};
  for (const net of nets) {
    try {
      const info = await binance.networkInfo(net);
      if (!info.withdrawEnable) {
        warnings.push(`Saque de ${config.binance.withdrawCoin} na rede ${net} está DESABILITADO na Binance`);
      }
      out[net] = info.withdrawFee;
    } catch (e) {
      warnings.push(`Não consegui ler a taxa de saque da rede ${net} (${(e as Error).message}); usando fallback`);
      out[net] = config.binance.withdrawFeeFallback;
    }
  }

  feeCache = { value: out, at: Date.now() };
  return out;
}

// Preço do POL para converter gás em BRL. Cache de 60s.
let polCache: { usdt: number; at: number } | null = null;

async function polPriceUsdt(warnings: string[]): Promise<number> {
  if (polCache && Date.now() - polCache.at < 60_000) return polCache.usdt;

  for (const symbol of ['POLUSDT', 'MATICUSDT']) {
    try {
      const p = await binance.price(symbol);
      polCache = { usdt: p, at: Date.now() };
      return p;
    } catch {
      // tenta o próximo símbolo
    }
  }

  warnings.push('Não consegui cotar POL/USDT — custo de gás em BRL está subestimado');
  return 0;
}

/** Busca uma vez os dados que valem para todas as rotas. */
export async function fetchMarket(): Promise<MarketSnapshot> {
  const warnings: string[] = [];
  const [book, fees, polUsdt, gas] = await Promise.all([
    binance.orderBook(500),
    withdrawFees(warnings),
    polPriceUsdt(warnings),
    gasFees(),
  ]);

  return { ts: Date.now(), book, withdrawFees: fees, polUsdt, maxFeePerGas: gas.maxFeePerGas, warnings };
}

/** Percorre os bids vendendo `usdt` — o espelho de simulateMarketBuy. */
function simulateMarketSell(bids: [number, number][], usdt: number): { brl: number; avgPrice: number; filled: boolean } {
  let remaining = usdt;
  let brl = 0;

  for (const [price, qty] of bids) {
    if (remaining <= 0) break;
    const take = Math.min(qty, remaining);
    brl += take * price;
    remaining -= take;
  }

  const sold = usdt - remaining;
  return { brl, avgPrice: sold > 0 ? brl / sold : 0, filled: remaining <= 1e-8 };
}

/**
 * Cotação ponta a ponta de uma rota. Nenhuma ordem é enviada — é simulação
 * sobre livros e rotas reais.
 */
export async function buildQuote(route: RouteDef, amountBrl: number, market: MarketSnapshot): Promise<Quote> {
  const warnings = [...market.warnings];

  // ── 1. Compra a mercado na Binance ──────────────────────────────────────
  const sim = simulateMarketBuy(market.book, amountBrl);
  if (!sim.filled) {
    warnings.push('O livro de ofertas da Binance não tem profundidade para esse valor — o preço real será pior');
  }
  const usdtGross = sim.usdt;
  const binanceFeeUsdt = usdtGross * config.binance.takerFee;
  const usdtAfterTradeFee = usdtGross - binanceFeeUsdt;

  // ── 2. Saque ────────────────────────────────────────────────────────────
  const withdrawFeeUsdt = market.withdrawFees[route.network] ?? config.binance.withdrawFeeFallback;
  const usdtOut = usdtAfterTradeFee - withdrawFeeUsdt;
  if (usdtOut <= 0) {
    throw new Error(`Valor pequeno demais: após taxas sobrariam ${usdtOut.toFixed(4)} USDT. Aumente o valor por ciclo.`);
  }

  // ── 3. Conversão de volta para BRL ──────────────────────────────────────
  let tokenOut: number;
  let priceImpactPct: number;
  let destTradeFeeBrl = 0;
  let gasNative = 0;

  if (route.kind === 'dex') {
    const amountInRaw = await toRaw(config.tokens.usdt, usdtOut);
    const kyber = await getRoute(config.tokens.usdt, route.token!, amountInRaw, walletAddress);
    tokenOut = await fromRaw(route.token!, kyber.amountOutRaw);

    const inUsd = Number(kyber.routeSummary.amountInUsd ?? 0);
    const outUsd = Number(kyber.routeSummary.amountOutUsd ?? 0);
    priceImpactPct = inUsd > 0 && outUsd > 0 ? (1 - outUsd / inUsd) * 100 : 0;

    const swapGas = kyber.routeSummary.gas ? BigInt(kyber.routeSummary.gas) : GAS_SWAP_FALLBACK;
    const gasWei = (GAS_APPROVE + swapGas + GAS_TRANSFER) * market.maxFeePerGas;
    gasNative = Number(formatUnits(gasWei, 18));
  } else {
    // Venda na exchange de destino: percorre os bids reais dela.
    const ob = await cexPublic(route.exchange!).fetchOrderBook(route.symbol!, 100);
    const bids = (ob.bids as [number, number][]) ?? [];
    if (!bids.length) throw new Error(`Livro de ${route.symbol} vazio na ${route.venue}`);

    const sell = simulateMarketSell(bids, usdtOut);
    if (!sell.filled) {
      warnings.push(`O livro da ${route.venue} não tem profundidade para esse valor — o preço real será pior`);
    }

    // O bot vende com ordens LIMIT no melhor bid, que cruzam o book e pagam
    // taxa de taker.
    destTradeFeeBrl = sell.brl * (route.takerFee ?? 0);
    tokenOut = sell.brl - destTradeFeeBrl;
    priceImpactPct = bids[0][0] > 0 ? (1 - sell.avgPrice / bids[0][0]) * 100 : 0;
  }

  // ── 4. Custos de rede ───────────────────────────────────────────────────
  const usdtBrlBinance = sim.avgPrice;
  const polPriceBrl = market.polUsdt * usdtBrlBinance;
  const gasBrl = gasNative * polPriceBrl;

  // ── 5. Saque na plataforma de destino ───────────────────────────────────
  const venueFeeBrl = route.fees.flatBrl + tokenOut * (route.fees.pct / 100);

  // ── Decomposição bruto/taxas ────────────────────────────────────────────
  // A taxa efetiva de conversão é aplicada ao volume bruto para separar o ganho
  // de preço puro das taxas. Ignora a curvatura do slippage entre os volumes.
  const tokenPerUsdt = tokenOut / usdtOut;
  const grossBrl = usdtGross * tokenPerUsdt + destTradeFeeBrl;
  const tradeFeeBrl = binanceFeeUsdt * tokenPerUsdt;
  const withdrawFeeBrl = withdrawFeeUsdt * tokenPerUsdt;
  const totalFeesBrl = tradeFeeBrl + withdrawFeeBrl + destTradeFeeBrl + gasBrl + venueFeeBrl;

  const netBrl = tokenOut - gasBrl - venueFeeBrl;
  const profitBrl = netBrl - amountBrl;

  return {
    ts: Date.now(),
    routeId: route.id,
    kind: route.kind,
    amountBrl,
    usdtGross,
    avgPriceBrl: sim.avgPrice,
    binanceFeeUsdt,
    usdtAfterTradeFee,
    withdrawFeeUsdt,
    usdtOnChain: usdtOut,
    tokenOut,
    tokenPerUsdt,
    priceImpactPct,
    destTradeFeeBrl,
    gasNative,
    gasBrl,
    polPriceBrl,
    venueFeeBrl,
    grossSpreadPct: (grossBrl / amountBrl - 1) * 100,
    feesPct: (totalFeesBrl / amountBrl) * 100,
    spreadPct: (netBrl / amountBrl - 1) * 100,
    tradeFeeBrl,
    withdrawFeeBrl,
    totalFeesBrl,
    netBrl,
    profitBrl,
    usdtBrlBinance,
    bookDepthOk: sim.filled,
    warnings,
  };
}

/** Checagem de sanidade antes de gastar dinheiro de verdade. */
export async function assertChainReady(): Promise<void> {
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== config.chain.chainId) {
    throw new Error(`RPC aponta para chainId ${net.chainId}, esperado ${config.chain.chainId} (Polygon)`);
  }
  log.info(`RPC conectado à Polygon (bloco ${await provider.getBlockNumber()})`);
}
