import { config, hasCredentials } from './config.js';
import { binanceCcxt, cexPrivate } from './cex.js';
import { nativeBalance, tokenBalance } from './chain.js';
import { venues } from './venues.js';
import { logger } from './log.js';

const log = logger('saldos');

/**
 * Saldo consolidado de um lugar onde o capital pode estar.
 *
 * `brl` e `usdt` são os dois ativos que interessam ao ciclo. `extras` guarda o
 * resto (POL, BRLA, BRZ) para a carteira on-chain.
 */
export interface VenueBalance {
  venueId: string;
  label: string;
  kind: 'cex' | 'dex' | 'wallet';
  brl: number | null;
  usdt: number | null;
  extras: { symbol: string; amount: number }[];
  /** Valor total do venue convertido para BRL. */
  totalBrl: number | null;
  ok: boolean;
  error?: string;
}

export interface BalanceSnapshot {
  ts: number;
  venues: VenueBalance[];
  /** Soma de tudo em BRL. Null quando falta cotação para converter. */
  patrimonioBrl: number | null;
  /** Quantos venues responderam, para a UI saber se o total está completo. */
  ok: number;
  total: number;
  usdtBrl: number;
}

/**
 * Lê tudo em paralelo. Uma exchange fora do ar não derruba o conjunto: ela
 * volta com `ok: false` e o total é marcado como incompleto, em vez de somar
 * zero e mentir sobre o patrimônio.
 */
export async function readAllBalances(usdtBrl: number, polBrl: number): Promise<BalanceSnapshot> {
  const cexVenues = venues.filter((v) => v.kind === 'cex');

  const results = await Promise.all([
    ...cexVenues.map((v) => readCex(v.id, v.label, v.exchange!, usdtBrl)),
    readWallet(usdtBrl, polBrl),
  ]);

  const ok = results.filter((r) => r.ok).length;

  return {
    ts: Date.now(),
    venues: results,
    // Soma o que deu para ler. `ok`/`total` dizem se está completo — melhor um
    // parcial rotulado do que um total que finge incluir o que falhou.
    patrimonioBrl: results.reduce((acc, r) => acc + (r.totalBrl ?? 0), 0),
    ok,
    total: results.length,
    usdtBrl,
  };
}

async function readCex(venueId: string, label: string, exchangeId: string, usdtBrl: number): Promise<VenueBalance> {
  const base: VenueBalance = {
    venueId,
    label,
    kind: 'cex',
    brl: null,
    usdt: null,
    extras: [],
    totalBrl: null,
    ok: false,
  };

  // Sem credencial não há como ler — não é erro, só não temos acesso.
  const isBinance = exchangeId === 'binance';
  if (isBinance ? !config.binance.apiKey : !hasCredentials(exchangeId)) {
    return { ...base, error: 'sem credenciais' };
  }

  try {
    const ex = isBinance ? binanceCcxt(true) : cexPrivate(exchangeId);
    const bal = await ex.fetchBalance();

    const brl = Number((bal as Record<string, { free?: number }>).BRL?.free ?? 0);
    const usdt = Number((bal as Record<string, { free?: number }>).USDT?.free ?? 0);

    return { ...base, brl, usdt, totalBrl: brl + usdt * usdtBrl, ok: true };
  } catch (e) {
    const msg = (e as Error).message.slice(0, 120);
    log.warn(`${label}: ${msg}`);
    return { ...base, error: msg };
  }
}

async function readWallet(usdtBrl: number, polBrl: number): Promise<VenueBalance> {
  const base: VenueBalance = {
    venueId: 'carteira',
    label: 'Carteira Polygon',
    kind: 'wallet',
    brl: null,
    usdt: null,
    extras: [],
    totalBrl: null,
    ok: false,
  };

  try {
    const dex = venues.filter((v) => v.kind === 'dex');
    const [pol, usdt, ...tokens] = await Promise.all([
      nativeBalance(),
      tokenBalance(config.tokens.usdt),
      ...dex.map((v) => tokenBalance(v.token!)),
    ]);

    const extras = [
      { symbol: 'POL', amount: pol.formatted },
      ...dex.map((v, i) => ({ symbol: v.label, amount: tokens[i].formatted })),
    ];

    // BRLA e BRZ são lastreados em real, então entram no total 1:1.
    const stablesBrl = dex.reduce((acc, _, i) => acc + tokens[i].formatted, 0);

    return {
      ...base,
      brl: stablesBrl,
      usdt: usdt.formatted,
      extras,
      totalBrl: stablesBrl + usdt.formatted * usdtBrl + pol.formatted * polBrl,
      ok: true,
    };
  } catch (e) {
    const msg = (e as Error).message.slice(0, 120);
    log.warn(`carteira: ${msg}`);
    return { ...base, error: msg };
  }
}
