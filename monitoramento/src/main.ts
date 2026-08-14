import { config, venues } from './config.js';
import { CsvWriter, stamp } from './csv.js';
import { polygonGasPriceWei } from './kyber.js';
import { computeSpreads, isOpportunity, venueLabel, type Spread } from './spreads.js';
import { fromRaw } from './units.js';
import { quoteAll, referenceUsdtSize, resolveSymbol, type VenueQuote } from './venues.js';

// ─── Arquivos de saída ─────────────────────────────────────────────────────

const quotesCsv = new CsvWriter('cotacoes', [
  'timestamp',
  'venue',
  'top_ask',
  'top_bid',
  'ask_efetivo',
  'bid_efetivo',
  'profundidade_compra_ok',
  'profundidade_venda_ok',
  'erro',
]);

const spreadsCsv = new CsvWriter('spreads', [
  'timestamp',
  'de',
  'para',
  'ask_origem',
  'bid_destino',
  'spread_bruto_pct',
  'taxas_pct',
  'spread_liquido_pct',
  'lucro_brl',
  'taxa_trade_origem_brl',
  'taxa_trade_destino_brl',
  'taxa_saque_brl',
  'gas_brl',
  'profundidade_ok',
]);

// Contexto global por coleta. O simulador de cadeias precisa do gás daquele
// instante para recalcular rotas on-chain no replay.
const marketCsv = new CsvWriter('mercado', ['timestamp', 'gas_brl', 'pol_usdt', 'usdt_brl_ref']);

// Arquivo único e enxuto: é o que você vai olhar depois de dias rodando.
const oppsCsv = new CsvWriter(
  'oportunidades',
  ['timestamp', 'de', 'para', 'spread_liquido_pct', 'lucro_brl', 'spread_bruto_pct', 'ask_origem', 'bid_destino'],
  true,
);

// ─── Estado da sessão, só para o painel do console ─────────────────────────

let ticks = 0;
let errors = 0;
let opportunities = 0;
const bestByPair = new Map<string, { netPct: number; at: Date }>();

// ─── Custo de gás na Polygon ───────────────────────────────────────────────

let gasCache: { brl: number; at: number } = { brl: 0, at: 0 };

/**
 * Custo em BRL de uma perna on-chain (swap + transferência), convertido via
 * POL/USDT × USDT/BRL. Cacheado por 60s: o gás não muda a cada 10 segundos.
 */
async function gasCostBrl(usdtBrl: number): Promise<number> {
  if (Date.now() - gasCache.at < 60_000) return gasCache.brl;

  try {
    const [gasWei, polUsdt] = await Promise.all([polygonGasPriceWei(), polPriceUsdt()]);
    const units = BigInt(config.gasSwapUnits + config.gasTransferUnits);
    const pol = fromRaw(gasWei * units, 18);
    gasCache = { brl: pol * polUsdt * usdtBrl, at: Date.now() };
  } catch {
    // Mantém o último valor conhecido em vez de zerar o custo.
  }
  return gasCache.brl;
}

let polCache: { usdt: number; at: number } = { usdt: 0, at: 0 };

async function polPriceUsdt(): Promise<number> {
  if (Date.now() - polCache.at < 300_000 && polCache.usdt > 0) return polCache.usdt;
  const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=POLUSDT');
  const body = (await res.json()) as { price?: string };
  const p = Number(body.price ?? 0);
  if (p > 0) polCache = { usdt: p, at: Date.now() };
  return p;
}

// ─── Painel do console ─────────────────────────────────────────────────────

function renderPanel(ts: Date, quotes: VenueQuote[], spreads: Spread[], opps: Spread[]) {
  const top = [...spreads].sort((a, b) => b.netPct - a.netPct).slice(0, 8);

  console.clear();
  console.log(`monitor de spreads · ${stamp(ts)} · tick ${ticks} · aporte R$ ${config.amountBrl}`);
  console.log(`falhas ${errors} · oportunidades registradas ${opportunities} · limiar ${config.opportunityThresholdPct}%\n`);

  console.log('VENUES'.padEnd(22) + 'ASK'.padStart(10) + 'BID'.padStart(10) + '  profundidade');
  for (const v of venues) {
    const q = quotes.find((x) => x.venueId === v.id);
    if (!q?.ok) {
      console.log(`  ${v.label.padEnd(20)}${'—'.padStart(10)}${'—'.padStart(10)}  ${q?.error ?? 'sem cotação'}`);
      continue;
    }
    const depth = `${q.askDepthOk ? 'ok' : 'RASO'}/${q.bidDepthOk ? 'ok' : 'RASO'}`;
    console.log(
      `  ${v.label.padEnd(20)}${q.effAsk.toFixed(4).padStart(10)}${q.effBid.toFixed(4).padStart(10)}  ${depth}`,
    );
  }

  console.log(`\nMELHORES ROTAS (${spreads.length} combinações)`);
  console.log('  ' + 'rota'.padEnd(34) + 'bruto'.padStart(9) + 'taxas'.padStart(9) + 'líquido'.padStart(10) + 'lucro'.padStart(11));
  for (const s of top) {
    const name = `${venueLabel(s.fromId)} → ${venueLabel(s.toId)}`;
    const flag = !s.depthOk ? ' (raso)' : '';
    console.log(
      '  ' +
        (name + flag).padEnd(34) +
        `${s.grossPct >= 0 ? '+' : ''}${s.grossPct.toFixed(3)}%`.padStart(9) +
        `${s.feesPct.toFixed(3)}%`.padStart(9) +
        `${s.netPct >= 0 ? '+' : ''}${s.netPct.toFixed(3)}%`.padStart(10) +
        `R$ ${s.profitBrl.toFixed(2)}`.padStart(11),
    );
  }

  if (opps.length) {
    console.log(`\n  >>> ${opps.length} acima do limiar neste tick`);
  }
  console.log(`\narquivos em ${config.dataDir}/ · Ctrl+C para parar`);
}

// ─── Tick ──────────────────────────────────────────────────────────────────

async function tick() {
  const ts = new Date();
  const label = stamp(ts);

  const usdtSize = await referenceUsdtSize(config.amountBrl);
  const quotes = await quoteAll(config.amountBrl, usdtSize);

  const failedCount = quotes.filter((q) => !q.ok).length;
  errors += failedCount;

  // Referência para converter gás em BRL: o ask do venue mais líquido que respondeu.
  const usdtBrl = quotes.find((q) => q.ok && q.venueId === 'binance')?.effAsk ?? quotes.find((q) => q.ok)?.effAsk ?? 5.15;
  const gas = await gasCostBrl(usdtBrl);

  const spreads = computeSpreads(quotes, config.amountBrl, gas);
  const opps = spreads.filter(isOpportunity);

  marketCsv.append(ts, [[label, gas, polCache.usdt, usdtBrl]]);

  quotesCsv.append(
    ts,
    quotes.map((q) => [
      label,
      q.venueId,
      q.topAsk,
      q.topBid,
      q.effAsk,
      q.effBid,
      q.askDepthOk,
      q.bidDepthOk,
      q.error ?? '',
    ]),
  );

  spreadsCsv.append(
    ts,
    spreads.map((s) => [
      label,
      s.fromId,
      s.toId,
      s.askFrom,
      s.bidTo,
      s.grossPct,
      s.feesPct,
      s.netPct,
      s.profitBrl,
      s.tradeFeeFromBrl,
      s.tradeFeeToBrl,
      s.withdrawFeeBrl,
      s.gasBrl,
      s.depthOk,
    ]),
  );

  if (opps.length) {
    oppsCsv.append(
      ts,
      opps.map((s) => [label, s.fromId, s.toId, s.netPct, s.profitBrl, s.grossPct, s.askFrom, s.bidTo]),
    );
    opportunities += opps.length;
  }

  for (const s of spreads) {
    const key = `${s.fromId}>${s.toId}`;
    const prev = bestByPair.get(key);
    if (!prev || s.netPct > prev.netPct) bestByPair.set(key, { netPct: s.netPct, at: ts });
  }

  ticks++;
  renderPanel(ts, quotes, spreads, opps);
}

// ─── Loop ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('resolvendo símbolos das exchanges...');
  for (const v of venues) {
    if (v.kind !== 'cex') continue;
    try {
      const { symbol, inverted } = await resolveSymbol(v.exchange!);
      console.log(`  ${v.label.padEnd(10)} ${symbol}${inverted ? '  (invertido, preço em USDT por BRL)' : ''}`);
    } catch (e) {
      console.log(`  ${v.label.padEnd(10)} FALHOU: ${(e as Error).message}`);
    }
  }

  const n = venues.length;
  console.log(`\n${n} venues · ${n * (n - 1)} combinações por tick · intervalo ${config.intervalMs / 1000}s\n`);

  // setTimeout encadeado em vez de setInterval: um tick lento nunca empilha
  // execuções sobrepostas, o que estouraria o rate limit das exchanges.
  const loop = async () => {
    try {
      await tick();
    } catch (e) {
      errors++;
      console.error(`tick falhou: ${(e as Error).message}`);
    }
    setTimeout(loop, config.intervalMs);
  };
  await loop();
}

process.on('SIGINT', () => {
  console.log(`\n\nencerrado após ${ticks} ticks · ${opportunities} oportunidades registradas`);
  console.log(`dados em ${config.dataDir}/ — rode "npm run report" para analisar`);
  process.exit(0);
});

void main();
