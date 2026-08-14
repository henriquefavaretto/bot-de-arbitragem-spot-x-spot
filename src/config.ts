import 'dotenv/config';
import { getAddress, isHexString } from 'ethers';

function req(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Variável de ambiente obrigatória ausente: ${name}. Copie .env.example para .env e preencha.`);
  return v;
}

function opt(name: string, fallback: string): string {
  const v = process.env[name]?.trim();
  return v === undefined || v === '' ? fallback : v;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`${name} precisa ser numérico, recebi "${raw}"`);
  return v;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

/** Aceita endereço em qualquer capitalização e devolve na forma EIP-55. */
function addr(name: string, value: string): string {
  try {
    return getAddress(value.trim().toLowerCase());
  } catch {
    throw new Error(`${name} não é um endereço EVM válido: "${value}"`);
  }
}

/** Endereços de queima: mandar stablecoin para cá é perda total e irreversível. */
const BURN_ADDRESSES = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
]);

const dryRun = bool('DRY_RUN', true);

/** Destino de saque: validado e protegido contra endereço de queima. */
function destination(name: string, raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) return '';
  const checksummed = addr(name, value);
  if (BURN_ADDRESSES.has(checksummed.toLowerCase()) && !dryRun) {
    throw new Error(
      `${name} aponta para um endereço de queima (${checksummed}). ` +
        'Coloque o endereço de depósito real da sua conta antes de rodar com DRY_RUN=false.',
    );
  }
  return checksummed;
}

// Em dry-run a chave privada é opcional: geramos uma efêmera só para ter um
// endereço de leitura. Em modo real ela é obrigatória.
function privateKey(): string {
  const raw = process.env.POLYGON_PRIVATE_KEY?.trim();
  if (!raw) {
    if (dryRun) return '';
    throw new Error('POLYGON_PRIVATE_KEY é obrigatória quando DRY_RUN=false');
  }
  const withPrefix = raw.startsWith('0x') ? raw : `0x${raw}`;
  if (!isHexString(withPrefix, 32)) {
    throw new Error(
      'POLYGON_PRIVATE_KEY inválida: esperado 32 bytes em hex (64 caracteres). ' +
        'Atenção: o endereço da carteira (40 caracteres) não serve — é preciso a chave privada.',
    );
  }
  return withPrefix;
}

function binanceKeys(): { key: string; secret: string } {
  if (dryRun) {
    return { key: opt('BINANCE_API_KEY', ''), secret: opt('BINANCE_API_SECRET', '') };
  }
  return { key: req('BINANCE_API_KEY'), secret: req('BINANCE_API_SECRET') };
}

const keys = binanceKeys();

const tradeAmountBrl = num('TRADE_AMOUNT_BRL', 1000);
const maxTradeAmountBrl = num('MAX_TRADE_AMOUNT_BRL', 5000);
if (tradeAmountBrl > maxTradeAmountBrl) {
  throw new Error(`TRADE_AMOUNT_BRL (${tradeAmountBrl}) não pode ser maior que MAX_TRADE_AMOUNT_BRL (${maxTradeAmountBrl})`);
}

const slippageBps = num('SLIPPAGE_BPS', 50);
if (slippageBps < 0 || slippageBps > 2000) {
  throw new Error('SLIPPAGE_BPS precisa estar entre 0 e 2000 (limite da API do KyberSwap)');
}

/**
 * Uma rota é um caminho completo BRL -> USDT -> saque em BRL.
 * Existem dois formatos:
 *
 *  - `dex`: saca USDT para a Polygon, faz swap num agregador e envia a
 *    stablecoin para a carteira de uma plataforma que saca via PIX.
 *  - `cex`: saca USDT para outra exchange e vende o par USDT/BRL lá dentro.
 *
 * Todas compartilham a mesma conta Binance de origem.
 */
export type RouteKind = 'dex' | 'cex';

export interface RouteDef {
  id: string;
  kind: RouteKind;
  /** Nome curto do ativo de saída, para rótulos. */
  short: string;
  /** Nome da plataforma que faz o saque em BRL. */
  venue: string;
  /** Rótulo completo do caminho. */
  label: string;
  /** Endereço de depósito no destino. */
  destination: string;
  /** Rede da Binance usada no saque. */
  network: string;
  fees: { flatBrl: number; pct: number };
  /** Rota sem destino configurado fica visível mas não executa. */
  enabled: boolean;

  /** Só em rotas `dex`: contrato do token de saída na Polygon. */
  token?: string;
  /** Só em rotas `cex`: id da exchange no ccxt e o par negociado lá. */
  exchange?: string;
  symbol?: string;
  /** Só em rotas `cex`: taxa de negociação cobrada na exchange de destino. */
  takerFee?: number;
}

/** Credenciais das exchanges de destino, indexadas pelo id no ccxt. */
export const cexCredentials: Record<string, { apiKey: string; secret: string; password: string }> = {
  bitget: {
    apiKey: opt('BITGET_API_KEY', ''),
    secret: opt('BITGET_API_SECRET', ''),
    password: opt('BITGET_PASSWORD', ''),
  },
  kucoin: {
    apiKey: opt('KUCOIN_API_KEY', ''),
    secret: opt('KUCOIN_API_SECRET', ''),
    password: opt('KUCOIN_PASSWORD', ''),
  },
  // OKX e MEXC entram só como leitura: sem chave elas não expõem taxa de
  // saque, e as pernas que saem delas ficam com estimativa conservadora.
  okx: {
    apiKey: opt('OKX_API_KEY', ''),
    secret: opt('OKX_API_SECRET', ''),
    password: opt('OKX_PASSWORD', ''),
  },
  mexc: {
    apiKey: opt('MEXC_API_KEY', ''),
    secret: opt('MEXC_API_SECRET', ''),
    password: opt('MEXC_PASSWORD', ''),
  },
};

export function hasCredentials(exchangeId: string): boolean {
  const c = cexCredentials[exchangeId];
  return Boolean(c?.apiKey && c.secret);
}

/**
 * Rotas desligadas à mão, por id, separadas por vírgula em `DISABLED_ROUTES`.
 *
 * Serve para tirar do ar uma rota que se sabe quebrada — chave com IP
 * bloqueado, exchange em manutenção — sem apagar a configuração dela. Uma rota
 * desligada não executa nem entra no modo automático.
 */
const disabledRoutes = new Set(
  opt('DISABLED_ROUTES', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

export function isRouteDisabled(id: string): boolean {
  return disabledRoutes.has(id);
}

function dexRoute(args: {
  id: string;
  short: string;
  venue: string;
  tokenEnv: string;
  tokenDefault: string;
  destEnv: string;
  feeFlatEnv: string;
  feePctEnv: string;
}): RouteDef {
  const dest = destination(args.destEnv, process.env[args.destEnv]);
  return {
    id: args.id,
    kind: 'dex',
    short: args.short,
    venue: args.venue,
    label: `USDT (Binance) → ${args.short} (KyberSwap) → BRL (${args.venue})`,
    destination: dest,
    network: opt('BINANCE_WITHDRAW_NETWORK', 'MATIC'),
    token: addr(args.tokenEnv, opt(args.tokenEnv, args.tokenDefault)),
    fees: { flatBrl: num(args.feeFlatEnv, 0), pct: num(args.feePctEnv, 0) },
    enabled: dest !== '' && !isRouteDisabled(args.id),
  };
}

function cexRoute(args: {
  id: string;
  venue: string;
  exchange: string;
  prefix: string;
  networkDefault: string;
}): RouteDef {
  const dest = destination(`${args.prefix}_DEPOSIT_ADDRESS`, process.env[`${args.prefix}_DEPOSIT_ADDRESS`]);
  const network = opt(`${args.prefix}_WITHDRAW_NETWORK`, args.networkDefault);
  return {
    id: args.id,
    kind: 'cex',
    short: 'USDT',
    venue: args.venue,
    label: `USDT (Binance) → ${network} → BRL (${args.venue})`,
    destination: dest,
    network,
    exchange: args.exchange,
    symbol: opt(`${args.prefix}_SYMBOL`, 'USDT/BRL'),
    takerFee: num(`${args.prefix}_TAKER_FEE`, 0.001),
    fees: {
      flatBrl: num(`${args.prefix}_WITHDRAW_FEE_BRL`, 0),
      pct: num(`${args.prefix}_WITHDRAW_FEE_PCT`, 0),
    },
    // Rota CEX também precisa das credenciais da exchange de destino.
    enabled: dest !== '' && (hasCredentials(args.exchange) || dryRun) && !isRouteDisabled(args.id),
  };
}

export const routes: RouteDef[] = [
  dexRoute({
    id: 'brla-picnic',
    short: 'BRLA',
    venue: 'Picnic',
    tokenEnv: 'BRLA_ADDRESS',
    tokenDefault: '0xE6A537a407488807F0bbeb0038B79004f19DdDfb',
    destEnv: 'PICNIC_DEPOSIT_ADDRESS',
    feeFlatEnv: 'PICNIC_WITHDRAW_FEE_BRL',
    feePctEnv: 'PICNIC_WITHDRAW_FEE_PCT',
  }),
  dexRoute({
    id: 'brz-chainless',
    short: 'BRZ',
    venue: 'Chainless',
    tokenEnv: 'BRZ_ADDRESS',
    // BRZ v2 na Polygon (18 decimais). O contrato antigo de 4 decimais
    // (0x491a...556f) ainda existe e está sem liquidez — não use.
    tokenDefault: '0x4eD141110F6EeeAbA9A1df36d8c26f684d2475Dc',
    destEnv: 'CHAINLESS_DEPOSIT_ADDRESS',
    feeFlatEnv: 'CHAINLESS_WITHDRAW_FEE_BRL',
    feePctEnv: 'CHAINLESS_WITHDRAW_FEE_PCT',
  }),
  cexRoute({
    id: 'usdt-bitget',
    venue: 'Bitget',
    exchange: 'bitget',
    prefix: 'BITGET',
    networkDefault: 'BSC',
  }),
  cexRoute({
    id: 'usdt-kucoin',
    venue: 'KuCoin',
    exchange: 'kucoin',
    prefix: 'KUCOIN',
    // BEP20 é a rede mais barata para sacar USDT da Binance (0,01 USDT) e a
    // KuCoin credita em ~3 min. TRC20 chega em 1 min mas custa 1,5 USDT, o que
    // come 0,77 p.p. do spread num ciclo de R$ 1.000. TON exigiria memo.
    networkDefault: 'BSC',
  }),
];

export function routeById(id: string): RouteDef {
  const r = routes.find((x) => x.id === id);
  if (!r) throw new Error(`Rota desconhecida: ${id}`);
  return r;
}

export const config = {
  dryRun,

  binance: {
    apiKey: keys.key,
    apiSecret: keys.secret,
    baseUrl: opt('BINANCE_BASE_URL', 'https://api.binance.com'),
    symbol: opt('BINANCE_SYMBOL', 'USDTBRL'),
    withdrawCoin: opt('BINANCE_WITHDRAW_COIN', 'USDT'),
    withdrawNetwork: opt('BINANCE_WITHDRAW_NETWORK', 'MATIC'),
    takerFee: num('BINANCE_TAKER_FEE', 0.001),
    /** Usado só para cotar quando a API key ainda não está configurada (dry-run). */
    withdrawFeeFallback: num('BINANCE_WITHDRAW_FEE_FALLBACK', 1),
  },

  chain: {
    rpcUrl: opt('POLYGON_RPC_URL', 'https://polygon-bor-rpc.publicnode.com'),
    chainId: 137,
    chainSlug: 'polygon', // path param da API do KyberSwap
    privateKey: privateKey(),
    nativeSymbol: 'POL',
  },

  tokens: {
    usdt: addr('USDT_ADDRESS', opt('USDT_ADDRESS', '0xc2132D05D31c914a87C6611C10748AEb04B58e8F')),
    brla: addr('BRLA_ADDRESS', opt('BRLA_ADDRESS', '0xE6A537a407488807F0bbeb0038B79004f19DdDfb')),
    // BRZ v2 (18 casas). O contrato antigo 0x491a...556f está sem liquidez.
    brz: addr('BRZ_ADDRESS', opt('BRZ_ADDRESS', '0x4eD141110F6EeeAbA9A1df36d8c26f684d2475Dc')),
  },

  trade: {
    amountBrl: tradeAmountBrl,
    maxAmountBrl: maxTradeAmountBrl,
    minSpreadPct: num('MIN_SPREAD_PCT', 0.5),
    slippageBps,
    quoteIntervalMs: Math.max(3000, num('QUOTE_INTERVAL_MS', 10000)),
  },

  /**
   * Gravação contínua da malha em CSV.
   *
   * O valor de referência é FIXO de propósito: spreads cotados com R$ 1.000 e
   * com R$ 5.000 percorrem profundidades diferentes do livro. Se ele
   * acompanhasse o saldo da posição, os registros de dias diferentes deixariam
   * de ser comparáveis entre si.
   */
  monitor: {
    referenceBrl: num('MONITOR_AMOUNT_BRL', num('TRADE_AMOUNT_BRL', 1000)),
    dir: opt('MONITOR_DIR', 'data/monitor'),
    /** Spread líquido (%) a partir do qual a perna vai para oportunidades.csv */
    opportunityPct: num('MONITOR_OPPORTUNITY_PCT', 0.3),
  },

  server: {
    port: num('PORT', 3000),
    password: opt('DASHBOARD_PASSWORD', ''),
  },

  kyber: {
    baseUrl: 'https://aggregator-api.kyberswap.com',
    clientId: opt('KYBER_CLIENT_ID', 'bot-picnic'),
  },

  /**
   * Constantes portadas do bot original em Python — mexer aqui muda a lógica
   * de execução dele. Valem para toda rota CEX. Ver src/cex.ts.
   */
  cexTuning: {
    estimatedWithdrawalFee: 0.5,
    sellMaxAttempts: 8,
    sellWaitSeconds: 3,
    depositPollSeconds: 5,
    depositMaxAttempts: 240,
  },
} as const;

export type Config = typeof config;
