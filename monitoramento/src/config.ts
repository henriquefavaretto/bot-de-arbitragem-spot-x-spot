import 'dotenv/config';

function num(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`${name} precisa ser numérico, recebi "${raw}"`);
  return v;
}

function opt(name: string, fallback: string): string {
  const v = process.env[name]?.trim();
  return v === undefined || v === '' ? fallback : v;
}

export type VenueKind = 'cex' | 'dex';

export interface VenueDef {
  id: string;
  label: string;
  kind: VenueKind;

  /** Taxa de negociação (fração). Zero em DEX — o custo já vem na cotação. */
  takerFee: number;

  /**
   * Taxa de saque de USDT, em USDT, cobrada por ESTE venue ao enviar para
   * outro, na rede mais barata em comum (BEP20 entre as CEX).
   *
   * Os padrões abaixo foram LIDOS da API de cada exchange, não estimados.
   * A diferença é grande: a KuCoin cobra 100x a Binance, o que muda o
   * ranking das rotas. OKX e MEXC não expõem sem chave — ficaram
   * conservadores e devem ser confirmados.
   */
  withdrawFeeUsdt: number;

  /** Só CEX: id no ccxt. O símbolo é resolvido em runtime. */
  exchange?: string;

  /** Só DEX: contrato do token lastreado em BRL na Polygon. */
  token?: string;
  tokenDecimals?: number;
}

/** Contratos verificados on-chain na Polygon. */
export const POLYGON = {
  usdt: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
  usdtDecimals: 6,
  brla: '0xE6A537a407488807F0bbeb0038B79004f19DdDfb',
  // BRZ v2 (18 casas). O contrato antigo 0x491a...556f está sem liquidez.
  brz: '0x4eD141110F6EeeAbA9A1df36d8c26f684d2475Dc',
  rpcUrl: opt('POLYGON_RPC_URL', 'https://polygon-bor-rpc.publicnode.com'),
} as const;

export const venues: VenueDef[] = [
  {
    id: 'binance',
    label: 'Binance',
    kind: 'cex',
    exchange: 'binance',
    takerFee: num('BINANCE_TAKER_FEE', 0.001),
    withdrawFeeUsdt: num('BINANCE_WITHDRAW_FEE', 0.01),
  },
  {
    id: 'okx',
    label: 'OKX',
    kind: 'cex',
    exchange: 'okx',
    takerFee: num('OKX_TAKER_FEE', 0.001),
    withdrawFeeUsdt: num('OKX_WITHDRAW_FEE', 0.1),
  },
  {
    id: 'kucoin',
    label: 'KuCoin',
    kind: 'cex',
    exchange: 'kucoin',
    takerFee: num('KUCOIN_TAKER_FEE', 0.001),
    withdrawFeeUsdt: num('KUCOIN_WITHDRAW_FEE', 1.0),
  },
  {
    id: 'bitget',
    label: 'Bitget',
    kind: 'cex',
    exchange: 'bitget',
    takerFee: num('BITGET_TAKER_FEE', 0.001),
    withdrawFeeUsdt: num('BITGET_WITHDRAW_FEE', 0.15),
  },
  {
    // A MEXC lista o par invertido, como BRL/USDT. O símbolo e a orientação
    // são resolvidos em runtime lendo os mercados da própria exchange.
    id: 'mexc',
    label: 'MEXC',
    kind: 'cex',
    exchange: 'mexc',
    takerFee: num('MEXC_TAKER_FEE', 0.001),
    withdrawFeeUsdt: num('MEXC_WITHDRAW_FEE', 0.5),
  },
  {
    id: 'dex-brla',
    label: 'BRLA (KyberSwap)',
    kind: 'dex',
    token: POLYGON.brla,
    tokenDecimals: 18,
    takerFee: 0,
    // "Saque" de uma DEX é uma transferência on-chain: só gás, contabilizado à parte.
    withdrawFeeUsdt: 0,
  },
  {
    id: 'dex-brz',
    label: 'BRZ (KyberSwap)',
    kind: 'dex',
    token: POLYGON.brz,
    tokenDecimals: 18,
    takerFee: 0,
    withdrawFeeUsdt: 0,
  },
];

export const config = {
  /** Tamanho da operação simulada. Define a profundidade de livro considerada. */
  amountBrl: num('AMOUNT_BRL', 1000),

  intervalMs: num('INTERVAL_MS', 10_000),

  /** Spread líquido (%) a partir do qual a linha vai para oportunidades.csv */
  opportunityThresholdPct: num('OPPORTUNITY_THRESHOLD_PCT', 0.3),

  /** Gás estimado por swap e por transferência na Polygon. */
  gasSwapUnits: num('GAS_SWAP_UNITS', 400_000),
  gasTransferUnits: num('GAS_TRANSFER_UNITS', 70_000),

  kyber: {
    baseUrl: 'https://aggregator-api.kyberswap.com',
    chain: 'polygon',
    clientId: opt('KYBER_CLIENT_ID', 'monitor-spreads'),
  },

  dataDir: opt('DATA_DIR', 'data'),
} as const;
