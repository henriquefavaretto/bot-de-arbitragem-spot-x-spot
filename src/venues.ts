import { config, hasCredentials } from './config.js';
import { binanceCcxt, cexPrivate, cexPublic } from './cex.js';
import { getRoute } from './kyber.js';
import { fromRaw, toRaw, walletAddress } from './chain.js';
import { logger } from './log.js';

const log = logger('venues');

/**
 * Um venue é um lugar onde o capital pode ficar parado, cotado sempre no mesmo
 * sentido: **BRL por 1 USDT**.
 *
 *  - `ask` — quanto custa adquirir 1 USDT ali (a perna SAI daqui)
 *  - `bid` — quanto se recebe ao vender 1 USDT ali (a perna CHEGA aqui)
 *
 * Nas DEX o "BRL" é BRLA ou BRZ, tratados 1:1 com o real. É essa normalização
 * que permite tratar CEX e DEX como nós do mesmo grafo.
 */
export interface VenueDef {
  id: string;
  label: string;
  kind: 'cex' | 'dex';

  /** Taxa de negociação. Zero em DEX — o custo já vem embutido na cotação. */
  takerFee: number;

  /** Só CEX: id no ccxt. O símbolo é resolvido em runtime. */
  exchange?: string;

  /** Só DEX: contrato do token lastreado em BRL na Polygon. */
  token?: string;
  tokenDecimals?: number;

  /** Endereços para receber USDT, indexados pela rede. */
  depositAddresses: Record<string, string>;
}

function envAddr(name: string): string {
  return process.env[name]?.trim() ?? '';
}

/**
 * Monta o catálogo de endereços de depósito de um venue a partir do .env.
 * Aceita `<PREFIXO>_DEPOSIT_<REDE>` e mantém `<PREFIXO>_DEPOSIT_ADDRESS` como
 * atalho para a rede padrão, que era o formato antigo.
 */
function depositAddresses(prefix: string, defaultNetwork: string): Record<string, string> {
  const out: Record<string, string> = {};

  const legacy = envAddr(`${prefix}_DEPOSIT_ADDRESS`);
  if (legacy) out[defaultNetwork] = legacy;

  for (const net of ['BSC', 'MATIC', 'TRX', 'ARBONE', 'OPTIMISM', 'AVAXC', 'SOL', 'ETH']) {
    const v = envAddr(`${prefix}_DEPOSIT_${net}`);
    if (v) out[net] = v;
  }
  return out;
}

const takerFee = (name: string, fallback = 0.001) => {
  const raw = process.env[name]?.trim();
  const v = raw ? Number(raw) : NaN;
  return Number.isFinite(v) ? v : fallback;
};

export const venues: VenueDef[] = [
  {
    id: 'binance',
    label: 'Binance',
    kind: 'cex',
    exchange: 'binance',
    takerFee: takerFee('BINANCE_TAKER_FEE'),
    depositAddresses: depositAddresses('BINANCE', 'BSC'),
  },
  {
    id: 'bitget',
    label: 'Bitget',
    kind: 'cex',
    exchange: 'bitget',
    takerFee: takerFee('BITGET_TAKER_FEE'),
    depositAddresses: depositAddresses('BITGET', 'BSC'),
  },
  {
    id: 'kucoin',
    label: 'KuCoin',
    kind: 'cex',
    exchange: 'kucoin',
    takerFee: takerFee('KUCOIN_TAKER_FEE'),
    depositAddresses: depositAddresses('KUCOIN', 'BSC'),
  },
  {
    id: 'okx',
    label: 'OKX',
    kind: 'cex',
    exchange: 'okx',
    takerFee: takerFee('OKX_TAKER_FEE'),
    depositAddresses: depositAddresses('OKX', 'BSC'),
  },
  {
    id: 'mexc',
    label: 'MEXC',
    kind: 'cex',
    exchange: 'mexc',
    takerFee: takerFee('MEXC_TAKER_FEE'),
    depositAddresses: depositAddresses('MEXC', 'BSC'),
  },
  {
    id: 'dex-brla',
    label: 'BRLA',
    kind: 'dex',
    token: config.tokens.brla,
    tokenDecimals: 18,
    takerFee: 0,
    // Chegar numa DEX significa mandar USDT para a carteira do bot na Polygon.
    depositAddresses: { MATIC: walletAddress },
  },
  {
    id: 'dex-brz',
    label: 'BRZ',
    kind: 'dex',
    token: config.tokens.brz,
    tokenDecimals: 18,
    takerFee: 0,
    depositAddresses: { MATIC: walletAddress },
  },
];

export const venueById = new Map(venues.map((v) => [v.id, v]));

// ─── Resolução do símbolo ──────────────────────────────────────────────────

export interface SymbolInfo {
  symbol: string;
  /** true quando o par é BRL/USDT, ou seja, o preço vem em USDT por BRL. */
  inverted: boolean;
}

const symbolCache = new Map<string, SymbolInfo>();

/**
 * Descobre como cada exchange lista o par. A MEXC usa BRL/USDT (BRL na base),
 * as outras usam USDT/BRL. Cravar um símbolo fixo faz o par sumir sem erro.
 */
export async function resolveSymbol(exchangeId: string): Promise<SymbolInfo> {
  const cached = symbolCache.get(exchangeId);
  if (cached) return cached;

  const markets = await cexPublic(exchangeId).loadMarkets();

  let info: SymbolInfo;
  if (markets['USDT/BRL']) info = { symbol: 'USDT/BRL', inverted: false };
  else if (markets['BRL/USDT']) info = { symbol: 'BRL/USDT', inverted: true };
  else throw new Error(`nem USDT/BRL nem BRL/USDT listados em ${exchangeId}`);

  symbolCache.set(exchangeId, info);
  return info;
}

// ─── Redes suportadas e taxas de saque ─────────────────────────────────────

export interface NetworkSupport {
  withdrawFee: number;
  withdrawEnable: boolean;
  depositEnable: boolean;
  /** Como a exchange chama essa rede, para aparecer no log e na UI. */
  nativeName: string;
}

/**
 * Cada exchange batiza as redes de um jeito: a Binance chama de BSC o que a
 * KuCoin e a Bitget chamam de BEP20, e por aí vai. Sem normalizar, nenhuma
 * perna acha rede em comum e todas caem no fallback.
 */
const NETWORK_ALIASES: Record<string, string[]> = {
  BSC: ['BSC', 'BEP20', 'BNB', 'BNBSMARTCHAIN', 'BSCSCAN', 'BINANCESMARTCHAIN'],
  MATIC: ['MATIC', 'POLYGON', 'POLYGONPOS', 'POL'],
  TRX: ['TRX', 'TRC20', 'TRON'],
  ETH: ['ETH', 'ERC20', 'ETHEREUM'],
  ARBONE: ['ARBONE', 'ARBITRUM', 'ARBITRUMONE', 'ARB'],
  OPTIMISM: ['OPTIMISM', 'OP', 'OPTIMISMETH'],
  AVAXC: ['AVAXC', 'AVAXCCHAIN', 'AVALANCHECCHAIN', 'CAVAX'],
  SOL: ['SOL', 'SOLANA'],
};

/** Do nome nativo para o nome canônico. */
const CANONICAL = new Map<string, string>();
for (const [canon, aliases] of Object.entries(NETWORK_ALIASES)) {
  for (const a of aliases) CANONICAL.set(a, canon);
}

function canonicalNetwork(nativeName: string): string | null {
  const key = nativeName.toUpperCase().replace(/[\s\-_()]/g, '');
  return CANONICAL.get(key) ?? null;
}

const networkCache = new Map<string, { at: number; nets: Record<string, NetworkSupport> }>();
const NETWORK_TTL_MS = 10 * 60_000;

/**
 * Redes de USDT que a exchange suporta, com a taxa de saque de cada uma.
 * Algumas devolvem isso publicamente, outras só com chave — por isso o
 * resultado é opcional e o cálculo cai num fallback quando falta.
 */
export async function networksOf(venue: VenueDef): Promise<Record<string, NetworkSupport>> {
  if (venue.kind === 'dex') {
    // Sair de uma DEX é uma transferência on-chain: sem taxa fixa, só gás.
    return { MATIC: { withdrawFee: 0, withdrawEnable: true, depositEnable: true, nativeName: 'Polygon' } };
  }

  const hit = networkCache.get(venue.id);
  if (hit && Date.now() - hit.at < NETWORK_TTL_MS) return hit.nets;

  const out: Record<string, NetworkSupport> = {};
  try {
    // Binance, OKX e MEXC só expõem taxas de saque para quem está autenticado;
    // sem chave o resultado vem vazio e o cálculo cai no fallback.
    const client = clientFor(venue);
    const currencies = await client.fetchCurrencies();
    const raw = (currencies as Record<string, { networks?: Record<string, unknown> }>).USDT?.networks ?? {};

    for (const [id, n] of Object.entries(raw)) {
      const canon = canonicalNetwork(id);
      if (!canon) continue;

      const net = n as { fee?: number; withdraw?: boolean; deposit?: boolean; active?: boolean };
      const fee = Number(net.fee ?? NaN);

      // Mesma rede pode aparecer duas vezes com nomes diferentes: fica a mais barata.
      const prev = out[canon];
      if (prev && Number.isFinite(prev.withdrawFee) && !(fee < prev.withdrawFee)) continue;

      out[canon] = {
        withdrawFee: fee,
        withdrawEnable: net.withdraw !== false,
        depositEnable: net.deposit !== false,
        nativeName: id,
      };
    }

    if (!Object.keys(out).length) {
      log.warn(`${venue.label}: nenhuma rede de USDT retornada (provavelmente exige chave de API)`);
    }
  } catch (e) {
    log.warn(`não consegui listar redes de ${venue.label}: ${(e as Error).message.slice(0, 80)}`);
  }

  networkCache.set(venue.id, { at: Date.now(), nets: out });
  return out;
}

/**
 * Venues cuja taxa de saque não pôde ser lida da API — a causa raiz das
 * estimativas. Aponta o venue que falta credencial, não os que apenas têm
 * alguma perna estimada por causa dele.
 */
export function venuesMissingNetworkData(): string[] {
  return venues
    .filter((v) => v.kind === 'cex')
    .filter((v) => {
      const hit = networkCache.get(v.id);
      return hit ? Object.keys(hit.nets).length === 0 : false;
    })
    .map((v) => v.id);
}

/** Cliente autenticado quando há credenciais — é o que libera as taxas de saque. */
function clientFor(venue: VenueDef) {
  const id = venue.exchange!;
  if (id === 'binance' && config.binance.apiKey && config.binance.apiSecret) return binanceCcxt(true);
  if (hasCredentials(id)) return cexPrivate(id);
  return cexPublic(id);
}

// ─── Caminhada de livro ────────────────────────────────────────────────────

type Level = [number, number];

/**
 * Gasta `brl` comprando USDT.
 * Livro normal (USDT/BRL): consome asks, quantidade em USDT.
 * Livro invertido (BRL/USDT): vender BRL é bater nos bids, quantidade em BRL.
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

/** Vende `usdt` recebendo BRL — o espelho da função acima. */
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

// ─── Cotação ───────────────────────────────────────────────────────────────

export interface VenueQuote {
  venueId: string;
  ok: boolean;
  topAsk: number;
  topBid: number;
  effAsk: number;
  effBid: number;
  askDepthOk: boolean;
  bidDepthOk: boolean;
  error?: string;
}

async function quoteCex(v: VenueDef, amountBrl: number, usdtSize: number): Promise<VenueQuote> {
  const { symbol, inverted } = await resolveSymbol(v.exchange!);
  // 100 é o único limite aceito por todas: a KuCoin rejeita qualquer outro
  // valor que não seja 20 ou 100.
  const raw = await cexPublic(v.exchange!).fetchOrderBook(symbol, 100);

  const book = { bids: (raw.bids ?? []) as Level[], asks: (raw.asks ?? []) as Level[] };
  if (!book.bids.length || !book.asks.length) throw new Error(`livro de ${symbol} vazio`);

  const buy = buyUsdtWithBrl(book, amountBrl, inverted);
  const sell = sellUsdtForBrl(book, usdtSize, inverted);

  return {
    venueId: v.id,
    ok: true,
    // No livro invertido o topo também troca de lado ao converter para BRL/USDT.
    topAsk: inverted ? 1 / book.bids[0][0] : book.asks[0][0],
    topBid: inverted ? 1 / book.asks[0][0] : book.bids[0][0],
    effAsk: buy.effAsk,
    effBid: sell.effBid,
    askDepthOk: buy.filled,
    bidDepthOk: sell.filled,
  };
}

/**
 * DEX nos dois sentidos:
 *  - chegar aqui = USDT → token, então `bid` = token recebido por USDT
 *  - sair daqui  = token → USDT, então `ask` = token gasto por USDT
 */
async function quoteDex(v: VenueDef, amountBrl: number, usdtSize: number): Promise<VenueQuote> {
  const [toToken, toUsdt] = await Promise.all([
    getRoute(config.tokens.usdt, v.token!, await toRaw(config.tokens.usdt, usdtSize), walletAddress),
    getRoute(v.token!, config.tokens.usdt, await toRaw(v.token!, amountBrl), walletAddress),
  ]);

  const tokenOut = await fromRaw(v.token!, toToken.amountOutRaw);
  const usdtOut = await fromRaw(config.tokens.usdt, toUsdt.amountOutRaw);
  if (tokenOut <= 0 || usdtOut <= 0) throw new Error('KyberSwap devolveu rota sem saída');

  const ask = amountBrl / usdtOut;
  const bid = tokenOut / usdtSize;

  return {
    venueId: v.id,
    ok: true,
    // Num pool não existe topo de livro: a cotação já é o preço efetivo.
    topAsk: ask,
    topBid: bid,
    effAsk: ask,
    effBid: bid,
    askDepthOk: true,
    bidDepthOk: true,
  };
}

/** Cota todos os venues. Uma falha isolada não derruba o conjunto. */
export async function quoteAllVenues(amountBrl: number, usdtSize: number): Promise<VenueQuote[]> {
  return Promise.all(
    venues.map(async (v) => {
      try {
        return v.kind === 'dex' ? await quoteDex(v, amountBrl, usdtSize) : await quoteCex(v, amountBrl, usdtSize);
      } catch (e) {
        return {
          venueId: v.id,
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
    }),
  );
}
