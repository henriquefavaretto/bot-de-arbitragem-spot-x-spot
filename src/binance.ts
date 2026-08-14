import { createHmac } from 'node:crypto';
import { config } from './config.js';
import { logger } from './log.js';

const log = logger('binance');

export interface OrderBook {
  bids: [string, string][];
  asks: [string, string][];
}

export interface MarketBuyResult {
  orderId: number;
  /** BRL efetivamente gasto (cummulativeQuoteQty). */
  spentBrl: number;
  /** USDT recebido já descontando a comissão cobrada em USDT. */
  netUsdt: number;
  /** USDT bruto antes da comissão. */
  grossUsdt: number;
  /** Preço médio de execução em BRL por USDT. */
  avgPrice: number;
}

export interface NetworkInfo {
  network: string;
  name: string;
  withdrawFee: number;
  withdrawMin: number;
  withdrawMax: number;
  withdrawEnable: boolean;
  depositEnable: boolean;
}

export type WithdrawStatus =
  | 'email_sent'
  | 'cancelled'
  | 'awaiting_approval'
  | 'rejected'
  | 'processing'
  | 'failure'
  | 'completed'
  | 'unknown';

const WITHDRAW_STATUS: Record<number, WithdrawStatus> = {
  0: 'email_sent',
  1: 'cancelled',
  2: 'awaiting_approval',
  3: 'rejected',
  4: 'processing',
  5: 'failure',
  6: 'completed',
};

export interface WithdrawRecord {
  id: string;
  amount: number;
  transactionFee: number;
  coin: string;
  status: WithdrawStatus;
  address: string;
  txId?: string;
  network?: string;
}

class BinanceError extends Error {
  constructor(readonly code: number, message: string, readonly endpoint: string) {
    super(`Binance ${endpoint} falhou (code ${code}): ${message}`);
    this.name = 'BinanceError';
  }
}

/** Diferença entre o relógio local e o da Binance, em ms. */
let timeOffset = 0;
let timeSyncedAt = 0;

export class BinanceClient {
  private readonly base = config.binance.baseUrl;

  private async syncTime(): Promise<void> {
    // Ressincroniza a cada 5 min; drift de relógio é a causa nº1 de erro -1021.
    if (Date.now() - timeSyncedAt < 5 * 60_000) return;
    const before = Date.now();
    const res = await fetch(`${this.base}/api/v3/time`);
    if (!res.ok) return;
    const { serverTime } = (await res.json()) as { serverTime: number };
    const rtt = Date.now() - before;
    timeOffset = serverTime - (before + rtt / 2);
    timeSyncedAt = Date.now();
    if (Math.abs(timeOffset) > 1000) {
      log.warn(`relógio local está ${Math.round(timeOffset)}ms fora do servidor da Binance — compensando`);
    }
  }

  private async publicGet<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    const url = `${this.base}${path}${qs.toString() ? `?${qs}` : ''}`;
    const res = await fetch(url);
    const body = await res.json();
    if (!res.ok) {
      const e = body as { code?: number; msg?: string };
      throw new BinanceError(e.code ?? res.status, e.msg ?? res.statusText, path);
    }
    return body as T;
  }

  private async signedRequest<T>(
    method: 'GET' | 'POST',
    path: string,
    params: Record<string, string | number> = {},
  ): Promise<T> {
    if (!config.binance.apiKey || !config.binance.apiSecret) {
      throw new Error('BINANCE_API_KEY / BINANCE_API_SECRET não configuradas');
    }
    await this.syncTime();

    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) qs.append(k, String(v));
    qs.append('timestamp', String(Date.now() + Math.round(timeOffset)));
    qs.append('recvWindow', '10000');

    const signature = createHmac('sha256', config.binance.apiSecret).update(qs.toString()).digest('hex');
    qs.append('signature', signature);

    const url = method === 'GET' ? `${this.base}${path}?${qs}` : `${this.base}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        'X-MBX-APIKEY': config.binance.apiKey,
        ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: method === 'POST' ? qs.toString() : undefined,
    });

    const body = await res.json();
    if (!res.ok) {
      const e = body as { code?: number; msg?: string };
      throw new BinanceError(e.code ?? res.status, e.msg ?? res.statusText, path);
    }
    return body as T;
  }

  // ─── Dados públicos ───────────────────────────────────────────────────────

  orderBook(limit = 100): Promise<OrderBook> {
    return this.publicGet<OrderBook>('/api/v3/depth', { symbol: config.binance.symbol, limit });
  }

  async price(symbol: string): Promise<number> {
    const r = await this.publicGet<{ price: string }>('/api/v3/ticker/price', { symbol });
    return Number(r.price);
  }

  /**
   * Precisão do ativo de cotação (BRL) — usada para arredondar o quoteOrderQty.
   * Cacheado porque exchangeInfo é pesado.
   */
  private quotePrecisionCache: number | null = null;
  async quotePrecision(): Promise<number> {
    if (this.quotePrecisionCache !== null) return this.quotePrecisionCache;
    const info = await this.publicGet<{ symbols: { symbol: string; quoteAssetPrecision: number }[] }>(
      '/api/v3/exchangeInfo',
      { symbol: config.binance.symbol },
    );
    const s = info.symbols.find((x) => x.symbol === config.binance.symbol);
    if (!s) throw new Error(`Par ${config.binance.symbol} não existe na Binance`);
    this.quotePrecisionCache = Math.min(s.quoteAssetPrecision, 8);
    return this.quotePrecisionCache;
  }

  // ─── Conta ────────────────────────────────────────────────────────────────

  async balances(): Promise<Record<string, number>> {
    const acct = await this.signedRequest<{ balances: { asset: string; free: string; locked: string }[] }>(
      'GET',
      '/api/v3/account',
    );
    const out: Record<string, number> = {};
    for (const b of acct.balances) {
      const free = Number(b.free);
      if (free > 0) out[b.asset] = free;
    }
    return out;
  }

  /** Taxa e limites de saque da moeda na rede informada. */
  async networkInfo(network = config.binance.withdrawNetwork): Promise<NetworkInfo> {
    const coins = await this.signedRequest<
      {
        coin: string;
        networkList: {
          network: string;
          name: string;
          withdrawFee: string;
          withdrawMin: string;
          withdrawMax: string;
          withdrawEnable: boolean;
          depositEnable: boolean;
        }[];
      }[]
    >('GET', '/sapi/v1/capital/config/getall');

    const coin = coins.find((c) => c.coin === config.binance.withdrawCoin);
    if (!coin) throw new Error(`Moeda ${config.binance.withdrawCoin} não encontrada na sua conta Binance`);

    const net = coin.networkList.find((n) => n.network === network);
    if (!net) {
      const nomes = coin.networkList.map((n) => n.network).join(', ');
      throw new Error(`Rede "${network}" não disponível para ${coin.coin}. Redes válidas: ${nomes}`);
    }

    return {
      network: net.network,
      name: net.name,
      withdrawFee: Number(net.withdrawFee),
      withdrawMin: Number(net.withdrawMin),
      withdrawMax: Number(net.withdrawMax),
      withdrawEnable: net.withdrawEnable,
      depositEnable: net.depositEnable,
    };
  }

  // ─── Execução ─────────────────────────────────────────────────────────────

  /** Compra a mercado gastando exatamente `amountBrl` de BRL. */
  async marketBuyWithQuote(amountBrl: number): Promise<MarketBuyResult> {
    const precision = await this.quotePrecision();
    const quoteOrderQty = amountBrl.toFixed(precision);

    const order = await this.signedRequest<{
      orderId: number;
      executedQty: string;
      cummulativeQuoteQty: string;
      status: string;
      fills: { price: string; qty: string; commission: string; commissionAsset: string }[];
    }>('POST', '/api/v3/order', {
      symbol: config.binance.symbol,
      side: 'BUY',
      type: 'MARKET',
      quoteOrderQty,
      newOrderRespType: 'FULL',
    });

    if (order.status !== 'FILLED') {
      throw new Error(`Ordem ${order.orderId} terminou com status ${order.status}, esperado FILLED`);
    }

    const grossUsdt = Number(order.executedQty);
    const spentBrl = Number(order.cummulativeQuoteQty);

    // A comissão sai no ativo base (USDT) quando não há desconto em BNB.
    const baseAsset = config.binance.withdrawCoin;
    const commissionInBase = (order.fills ?? [])
      .filter((f) => f.commissionAsset === baseAsset)
      .reduce((acc, f) => acc + Number(f.commission), 0);

    return {
      orderId: order.orderId,
      spentBrl,
      grossUsdt,
      netUsdt: grossUsdt - commissionInBase,
      avgPrice: spentBrl / grossUsdt,
    };
  }

  /** Envia o saque. `amount` é o valor bruto; a taxa de rede é debitada dele. */
  async withdraw(address: string, amount: number, clientOrderId?: string): Promise<string> {
    const r = await this.signedRequest<{ id: string }>('POST', '/sapi/v1/capital/withdraw/apply', {
      coin: config.binance.withdrawCoin,
      network: config.binance.withdrawNetwork,
      address,
      amount: amount.toFixed(6),
      ...(clientOrderId ? { withdrawOrderId: clientOrderId } : {}),
    });
    return r.id;
  }

  async withdrawHistory(sinceMs: number): Promise<WithdrawRecord[]> {
    const rows = await this.signedRequest<
      {
        id: string;
        amount: string;
        transactionFee: string;
        coin: string;
        status: number;
        address: string;
        txId?: string;
        network?: string;
      }[]
    >('GET', '/sapi/v1/capital/withdraw/history', {
      coin: config.binance.withdrawCoin,
      startTime: sinceMs,
    });

    return rows.map((r) => ({
      id: r.id,
      amount: Number(r.amount),
      transactionFee: Number(r.transactionFee),
      coin: r.coin,
      status: WITHDRAW_STATUS[r.status] ?? 'unknown',
      address: r.address,
      txId: r.txId,
      network: r.network,
    }));
  }
}

export const binance = new BinanceClient();

/**
 * Percorre o livro de asks comprando até esgotar `amountBrl`.
 * Devolve o USDT que sairia da ordem a mercado, considerando a profundidade real.
 */
export function simulateMarketBuy(
  book: OrderBook,
  amountBrl: number,
): { usdt: number; avgPrice: number; filled: boolean } {
  let remainingBrl = amountBrl;
  let usdt = 0;

  for (const [priceStr, qtyStr] of book.asks) {
    if (remainingBrl <= 0) break;
    const price = Number(priceStr);
    const qty = Number(qtyStr);
    const levelCostBrl = price * qty;

    if (levelCostBrl >= remainingBrl) {
      usdt += remainingBrl / price;
      remainingBrl = 0;
    } else {
      usdt += qty;
      remainingBrl -= levelCostBrl;
    }
  }

  return {
    usdt,
    avgPrice: usdt > 0 ? (amountBrl - remainingBrl) / usdt : 0,
    // Se sobrou BRL, o livro que baixamos não tem profundidade suficiente.
    filled: remainingBrl <= 1e-8,
  };
}
