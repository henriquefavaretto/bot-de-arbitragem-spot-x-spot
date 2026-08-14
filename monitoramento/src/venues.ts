import ccxt from 'ccxt';
import { POLYGON, venues, type VenueDef } from './config.js';
import { getRoute } from './kyber.js';
import { fromRaw, toRaw } from './units.js';

type Exchange = InstanceType<typeof ccxt.Exchange>;
type Level = [number, number];

/**
 * Cotação normalizada de um venue, sempre no sentido "BRL por 1 USDT".
 *
 *  - `ask` é quanto custa adquirir 1 USDT aqui (usado quando a rota SAI daqui)
 *  - `bid` é quanto se recebe ao vender 1 USDT aqui (usado quando a rota CHEGA)
 *
 * Nos venues DEX o "BRL" é na verdade BRLA ou BRZ, tratados 1:1 com o real.
 */
export interface VenueQuote {
  venueId: string;
  ok: boolean;
  /** Preços no topo do livro, sem considerar profundidade. */
  topAsk: number;
  topBid: number;
  /** Preços efetivos para o tamanho simulado, já percorrendo o livro. */
  effAsk: number;
  effBid: number;
  /** false quando o livro não tem profundidade para o tamanho simulado. */
  askDepthOk: boolean;
  bidDepthOk: boolean;
  error?: string;
}

// ─── Clientes ccxt, criados uma vez ────────────────────────────────────────

const clients = new Map<string, Exchange>();

function client(exchangeId: string): Exchange {
  let ex = clients.get(exchangeId);
  if (!ex) {
    const Ctor = (ccxt as unknown as Record<string, new (c: unknown) => Exchange>)[exchangeId];
    if (!Ctor) throw new Error(`exchange "${exchangeId}" não existe no ccxt`);
    ex = new Ctor({ enableRateLimit: true, options: { adjustForTimeDifference: true } });
    clients.set(exchangeId, ex);
  }
  return ex;
}

/**
 * Descobre como cada exchange lista o par. A MEXC usa BRL/USDT (BRL na base),
 * enquanto Binance, OKX, KuCoin e Bitget usam USDT/BRL. Cravar um símbolo fixo
 * quebra silenciosamente quando a exchange muda a listagem.
 */
export interface SymbolInfo {
  symbol: string;
  /** true quando o par é BRL/USDT, ou seja, o preço é USDT por BRL. */
  inverted: boolean;
}

const symbolCache = new Map<string, SymbolInfo>();

export async function resolveSymbol(exchangeId: string): Promise<SymbolInfo> {
  const cached = symbolCache.get(exchangeId);
  if (cached) return cached;

  const ex = client(exchangeId);
  const markets = await ex.loadMarkets();

  let info: SymbolInfo;
  if (markets['USDT/BRL']) info = { symbol: 'USDT/BRL', inverted: false };
  else if (markets['BRL/USDT']) info = { symbol: 'BRL/USDT', inverted: true };
  else throw new Error(`nem USDT/BRL nem BRL/USDT listados em ${exchangeId}`);

  symbolCache.set(exchangeId, info);
  return info;
}

// ─── Caminhada de livro ────────────────────────────────────────────────────

/**
 * Gasta `brl` comprando USDT.
 * Livro normal (USDT/BRL): consome asks, quantidade em USDT, preço em BRL/USDT.
 * Livro invertido (BRL/USDT): vender BRL é bater nos bids, quantidade em BRL,
 * preço em USDT/BRL.
 */
function buyUsdtWithBrl(book: { bids: Level[]; asks: Level[] }, brl: number, inverted: boolean) {
  let remaining = brl;
  let usdt = 0;

  if (!inverted) {
    for (const [price, qty] of book.asks) {
      if (remaining <= 0) break;
      const levelCost = price * qty;
      if (levelCost >= remaining) {
        usdt += remaining / price;
        remaining = 0;
      } else {
        usdt += qty;
        remaining -= levelCost;
      }
    }
  } else {
    for (const [priceUsdtPerBrl, qtyBrl] of book.bids) {
      if (remaining <= 0) break;
      const take = Math.min(qtyBrl, remaining);
      usdt += take * priceUsdtPerBrl;
      remaining -= take;
    }
  }

  const spent = brl - remaining;
  return { usdt, effAsk: usdt > 0 ? spent / usdt : 0, filled: remaining <= 1e-8 };
}

/**
 * Vende `usdt` recebendo BRL.
 * Livro normal: consome bids. Invertido: comprar BRL é bater nos asks, pagando
 * em USDT (custo = qtyBrl * preço).
 */
function sellUsdtForBrl(book: { bids: Level[]; asks: Level[] }, usdt: number, inverted: boolean) {
  let remaining = usdt;
  let brl = 0;

  if (!inverted) {
    for (const [price, qty] of book.bids) {
      if (remaining <= 0) break;
      const take = Math.min(qty, remaining);
      brl += take * price;
      remaining -= take;
    }
  } else {
    for (const [priceUsdtPerBrl, qtyBrl] of book.asks) {
      if (remaining <= 0) break;
      const levelCostUsdt = qtyBrl * priceUsdtPerBrl;
      if (levelCostUsdt >= remaining) {
        brl += remaining / priceUsdtPerBrl;
        remaining = 0;
      } else {
        brl += qtyBrl;
        remaining -= levelCostUsdt;
      }
    }
  }

  const sold = usdt - remaining;
  return { brl, effBid: sold > 0 ? brl / sold : 0, filled: remaining <= 1e-8 };
}

// ─── Cotação por tipo de venue ─────────────────────────────────────────────

async function quoteCex(v: VenueDef, amountBrl: number, usdtSize: number): Promise<VenueQuote> {
  const { symbol, inverted } = await resolveSymbol(v.exchange!);
  const ex = client(v.exchange!);
  // 100 é o único limite aceito por todas: a KuCoin rejeita qualquer outro
  // valor que não seja 20 ou 100.
  const raw = await ex.fetchOrderBook(symbol, 100);

  const book = {
    bids: (raw.bids ?? []) as Level[],
    asks: (raw.asks ?? []) as Level[],
  };
  if (!book.bids.length || !book.asks.length) throw new Error(`livro de ${symbol} vazio`);

  const buy = buyUsdtWithBrl(book, amountBrl, inverted);
  const sell = sellUsdtForBrl(book, usdtSize, inverted);

  // No livro invertido o topo também troca de lado ao converter para BRL/USDT.
  const topAsk = inverted ? 1 / book.bids[0][0] : book.asks[0][0];
  const topBid = inverted ? 1 / book.asks[0][0] : book.bids[0][0];

  return {
    venueId: v.id,
    ok: true,
    topAsk,
    topBid,
    effAsk: buy.effAsk,
    effBid: sell.effBid,
    askDepthOk: buy.filled,
    bidDepthOk: sell.filled,
  };
}

/**
 * DEX: os dois sentidos do swap.
 *  - chegar aqui  = USDT -> token, então `bid` = token recebido por USDT
 *  - sair daqui   = token -> USDT, então `ask` = token gasto por USDT
 */
async function quoteDex(v: VenueDef, amountBrl: number, usdtSize: number): Promise<VenueQuote> {
  const dec = v.tokenDecimals!;

  const [toToken, toUsdt] = await Promise.all([
    getRoute(POLYGON.usdt, v.token!, toRaw(usdtSize, POLYGON.usdtDecimals)),
    getRoute(v.token!, POLYGON.usdt, toRaw(amountBrl, dec)),
  ]);

  const tokenOut = fromRaw(toToken.amountOutRaw, dec);
  const usdtOut = fromRaw(toUsdt.amountOutRaw, POLYGON.usdtDecimals);

  if (tokenOut <= 0 || usdtOut <= 0) throw new Error('KyberSwap devolveu rota sem saída');

  return {
    venueId: v.id,
    ok: true,
    // Num pool não existe topo de livro; a cotação já é o preço efetivo.
    topAsk: amountBrl / usdtOut,
    topBid: tokenOut / usdtSize,
    effAsk: amountBrl / usdtOut,
    effBid: tokenOut / usdtSize,
    askDepthOk: true,
    bidDepthOk: true,
  };
}

function failed(venueId: string, e: unknown): VenueQuote {
  return {
    venueId,
    ok: false,
    topAsk: 0,
    topBid: 0,
    effAsk: 0,
    effBid: 0,
    askDepthOk: false,
    bidDepthOk: false,
    error: (e as Error).message.slice(0, 160),
  };
}

/**
 * Cota todos os venues em paralelo. Uma falha isolada não derruba o tick —
 * o venue entra com ok=false e o erro fica registrado no CSV.
 */
export async function quoteAll(amountBrl: number, usdtSize: number): Promise<VenueQuote[]> {
  return Promise.all(
    venues.map(async (v) => {
      try {
        return v.kind === 'dex' ? await quoteDex(v, amountBrl, usdtSize) : await quoteCex(v, amountBrl, usdtSize);
      } catch (e) {
        return failed(v.id, e);
      }
    }),
  );
}

/**
 * Tamanho de referência em USDT. Todos os venues cotam a venda desse mesmo
 * tamanho, o que mantém a matriz comparável e o custo em O(n) chamadas.
 */
export async function referenceUsdtSize(amountBrl: number): Promise<number> {
  try {
    const { symbol, inverted } = await resolveSymbol('binance');
    const t = await client('binance').fetchTicker(symbol);
    const ask = inverted ? 1 / (t.bid as number) : (t.ask as number);
    if (ask > 0) return amountBrl / ask;
  } catch {
    // cai no padrão abaixo
  }
  return amountBrl / 5.15;
}
