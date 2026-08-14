import { venues } from './config.js';
import { writeCsv } from './csv.js';
import { describe, loadHistory, VENUE_IDS, type Snapshot } from './history.js';

/**
 * Testa QUALQUER sequência de venues sobre o histórico coletado.
 *
 * A diferença em relação ao `chains.ts`: lá o algoritmo escolhe o caminho. Aqui
 * você diz o caminho e a ferramenta responde se ele fecha — ou pede para ela
 * ranquear todos os caminhos possíveis.
 *
 * Duas correções de modelagem que este simulador incorpora, ambas descobertas
 * comparando com a operação real:
 *
 *  1. Cada perna espera SEU PRÓPRIO gatilho. Simular as pernas no mesmo
 *     instante, ou com um limiar único, subestima o resultado brutalmente:
 *     numa cadeia testada a diferença foi de −0,88% para −0,03%.
 *
 *  2. A compra acontece num instante e a venda no instante da CHEGADA, depois
 *     do atraso de transferência. É o preço que se pega de verdade.
 */

const V = venues.length;
const IDX = new Map(VENUE_IDS.map((id, i) => [id, i]));

/** Quanto o atraso real pode esticar antes de invalidarmos o pulo. */
const MAX_DELAY_STRETCH = 2.5;

// ─── Índices de chegada ─────────────────────────────────────────────────────

/**
 * Para cada coleta, a primeira coleta pelo menos `delayMs` depois. O atraso
 * precisa ser medido em relógio, não em número de coletas: a coleta tem
 * buracos (reinício, queda de rede) e um passo fixo de índice vira qualquer
 * coisa depois de uma interrupção.
 */
function buildArrivals(snaps: Snapshot[], delayMs: number): Int32Array {
  const T = snaps.length;
  const out = new Int32Array(T).fill(-1);
  const limit = delayMs * MAX_DELAY_STRETCH;

  let j = 0;
  for (let t = 0; t < T; t++) {
    if (j < t + 1) j = t + 1;
    const target = snaps[t].ts + delayMs;
    while (j < T && snaps[j].ts < target) j++;
    if (j >= T) break;
    if (snaps[j].ts - snaps[t].ts <= limit) out[t] = j;
  }
  return out;
}

// ─── Retorno de uma perna ───────────────────────────────────────────────────

/**
 * Retorno líquido (%) de sair de `from` no tick `t` e vender em `to` na
 * chegada. NaN quando falta cotação utilizável em qualquer das pontas.
 */
function legReturn(snaps: Snapshot[], arrivals: Int32Array, from: number, to: number, t: number): number {
  const t2 = arrivals[t];
  if (t2 < 0) return NaN;

  const qf = snaps[t].q[from];
  const qt = snaps[t2].q[to];
  if (!qf?.askOk || !qt?.bidOk || !(qf.ask > 0) || !(qt.bid > 0)) return NaN;

  const vFrom = venues[from];
  const vTo = venues[to];

  const usdtGross = 1 / qf.ask;
  const usdtArriving = usdtGross - usdtGross * vFrom.takerFee - vFrom.withdrawFeeUsdt / REFERENCE_BRL;
  if (usdtArriving <= 0) return NaN;

  const brl = usdtArriving * qt.bid;
  const legsOnChain = (vFrom.kind === 'dex' ? 1 : 0) + (vTo.kind === 'dex' ? 1 : 0);
  const gas = (snaps[t].gasBrl * legsOnChain) / REFERENCE_BRL;

  return (brl - brl * vTo.takerFee - gas - 1) * 100;
}

/**
 * Aporte usado para amortizar as taxas FIXAS (saque e gás). As taxas
 * proporcionais não dependem disso, mas as fixas sim — e a diferença entre
 * R$ 1.000 e R$ 25.000 chega a meio ponto percentual por ciclo.
 */
let REFERENCE_BRL = 5000;

// ─── Estatística por perna ──────────────────────────────────────────────────

export interface LegStats {
  from: number;
  to: number;
  samples: number;
  max: number;
  p95: number;
  p90: number;
  median: number;
  /** Fração do tempo acima de cada limiar candidato. */
  quantis: number[];
}

const QUANTIS = [0.5, 0.7, 0.8, 0.9, 0.95, 0.98];

function legStats(snaps: Snapshot[], arrivals: Int32Array, from: number, to: number): LegStats | null {
  const vals: number[] = [];
  for (let t = 0; t < snaps.length; t++) {
    const r = legReturn(snaps, arrivals, from, to, t);
    if (Number.isFinite(r)) vals.push(r);
  }
  if (vals.length < 10) return null;

  vals.sort((a, b) => a - b);
  const q = (p: number) => vals[Math.min(vals.length - 1, Math.floor(vals.length * p))];

  return {
    from,
    to,
    samples: vals.length,
    max: vals[vals.length - 1],
    p95: q(0.95),
    p90: q(0.9),
    median: q(0.5),
    quantis: QUANTIS.map(q),
  };
}

// ─── Simulação cronológica de uma rota ──────────────────────────────────────

export interface RouteHop {
  step: number;
  from: number;
  to: number;
  departTick: number;
  arriveTick: number;
  ret: number;
  balance: number;
}

export interface RouteResult {
  route: number[];
  thresholds: number[];
  hops: RouteHop[];
  finalBalance: number;
  /**
   * Saldo no último momento em que o capital voltou ao ponto de partida.
   *
   * É este o número honesto. O saldo final superestima quando a rota para no
   * meio: a última perna conta o ganho, mas o capital ficou num venue de onde
   * ainda teria que pagar para sair.
   */
  closedBalance: number;
  /** Onde o capital parou, se a rota não completou ciclos inteiros. */
  endStep: number;
  cyclesCompleted: number;
}

/**
 * Percorre a rota em ordem cronológica. Em cada passo o capital fica parado
 * até a perna daquele passo atingir seu gatilho — que é exatamente como a
 * operação manual funciona.
 */
export function simulateRoute(
  snaps: Snapshot[],
  arrivals: Int32Array,
  route: number[],
  thresholds: number[],
  amount: number,
): RouteResult {
  const hops: RouteHop[] = [];
  const legCount = route.length - 1;

  let balance = amount;
  let step = 0;
  let t = 0;

  while (t < snaps.length && step < legCount * MAX_CYCLES) {
    const i = step % legCount;
    const from = route[i];
    const to = route[i + 1];

    const r = legReturn(snaps, arrivals, from, to, t);
    if (Number.isFinite(r) && r >= thresholds[i]) {
      balance *= 1 + r / 100;
      hops.push({ step, from, to, departTick: t, arriveTick: arrivals[t], ret: r, balance });
      t = arrivals[t];
      step++;
    } else {
      t++;
    }
  }

  const cyclesCompleted = Math.floor(hops.length / legCount);
  // Saldo no fim do último ciclo inteiro — descarta as pernas soltas do final.
  const closedBalance = cyclesCompleted > 0 ? hops[cyclesCompleted * legCount - 1].balance : amount;

  return {
    route,
    thresholds,
    hops,
    finalBalance: balance,
    closedBalance,
    endStep: step % legCount,
    cyclesCompleted,
  };
}

/** Teto de voltas para a rota não rodar para sempre num histórico grande. */
const MAX_CYCLES = 200;

// ─── Busca de limiares ──────────────────────────────────────────────────────

/**
 * Procura o conjunto de gatilhos que maximiza o resultado da rota.
 *
 * Os candidatos vêm dos quantis da própria distribuição de cada perna, não de
 * uma grade arbitrária: assim a busca se adapta a pernas que vivem em faixas
 * muito diferentes (a entrada opera perto de +0,5%, a volta perto de −0,3%).
 */
export function optimizeThresholds(
  snaps: Snapshot[],
  arrivals: Int32Array,
  route: number[],
  stats: (LegStats | null)[],
  amount: number,
): RouteResult | null {
  const legCount = route.length - 1;
  const candidates: number[][] = [];

  for (let i = 0; i < legCount; i++) {
    const s = stats[i];
    if (!s) return null;
    candidates.push([...new Set(s.quantis)]);
  }

  let best: RouteResult | null = null;
  const combo = new Array<number>(legCount);

  const walk = (i: number) => {
    if (i === legCount) {
      const r = simulateRoute(snaps, arrivals, route, [...combo], amount);
      // Só interessa rota que fechou pelo menos um ciclo inteiro: terminar no
      // meio do caminho significa capital preso, não lucro.
      if (r.cyclesCompleted >= 1 && (!best || r.closedBalance > best.closedBalance)) best = r;
      return;
    }
    for (const c of candidates[i]) {
      combo[i] = c;
      walk(i + 1);
    }
  };
  walk(0);

  return best;
}

// ─── Enumeração de ciclos ───────────────────────────────────────────────────

/**
 * Todos os ciclos que saem de `start` e voltam a ele, com até `depth` pernas.
 * `blocked` remove venues do grafo — serve para responder "e se eu não usar
 * a Bitget?" ou "e se eu ficar só nas CEX?".
 */
function enumerateCycles(start: number, depth: number, blocked: Set<number>): number[][] {
  const out: number[][] = [];
  if (blocked.has(start)) return out;

  const walk = (path: number[]) => {
    if (path.length > 1 && path[path.length - 1] === start) {
      out.push([...path]);
      return;
    }
    if (path.length > depth) return;

    for (let v = 0; v < V; v++) {
      if (v === path[path.length - 1] || blocked.has(v)) continue;
      // Não repete venue no meio do caminho: passar duas vezes pelo mesmo
      // lugar só adiciona taxa.
      if (v !== start && path.includes(v)) continue;
      walk([...path, v]);
    }
  };

  walk([start]);
  return out.filter((c) => c.length - 1 <= depth && c.length - 1 >= 2);
}

// ─── Saída ──────────────────────────────────────────────────────────────────

const name = (i: number) => venues[i].label;
const routeLabel = (r: number[]) => r.map(name).join(' → ');
const pct = (v: number) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(3)}%` : '—');
const brl = (v: number) => v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function printLegTable(stats: Map<string, LegStats>) {
  console.log('\nRETORNO LÍQUIDO POR PERNA (esperando o melhor momento de cada uma)\n');
  console.log('  ' + 'perna'.padEnd(26) + 'melhor'.padStart(10) + 'p95'.padStart(10) + 'p90'.padStart(10) + 'mediana'.padStart(10) + 'amostras'.padStart(10));
  console.log('  ' + '─'.repeat(76));

  const rows = [...stats.values()].sort((a, b) => b.max - a.max);
  for (const s of rows.slice(0, 20)) {
    console.log(
      '  ' +
        `${name(s.from)} → ${name(s.to)}`.padEnd(26) +
        pct(s.max).padStart(10) +
        pct(s.p95).padStart(10) +
        pct(s.p90).padStart(10) +
        pct(s.median).padStart(10) +
        String(s.samples).padStart(10),
    );
  }
}

function printRoute(r: RouteResult, snaps: Snapshot[], amount: number) {
  console.log(`\n  rota: ${routeLabel(r.route)}`);
  console.log(`  gatilhos: ${r.thresholds.map((t) => pct(t)).join('  ·  ')}`);

  if (!r.hops.length) {
    console.log('  nenhuma operação disparou com esses gatilhos.');
    return;
  }

  console.log(
    '\n  ' + '#'.padEnd(4) + 'saída'.padEnd(21) + 'perna'.padEnd(26) + 'chegada'.padEnd(21) + 'retorno'.padStart(9) + 'saldo'.padStart(13),
  );
  for (const [i, h] of r.hops.entries()) {
    console.log(
      '  ' +
        String(i + 1).padEnd(4) +
        snaps[h.departTick].label.padEnd(21) +
        `${name(h.from)} → ${name(h.to)}`.padEnd(26) +
        snaps[h.arriveTick].label.padEnd(21) +
        pct(h.ret).padStart(9) +
        `R$ ${brl(h.balance)}`.padStart(13),
    );
  }

  const fechado = (r.closedBalance / amount - 1) * 100;
  const legCount = r.route.length - 1;
  const hopsFechados = r.cyclesCompleted * legCount;

  console.log(
    `\n  ${r.cyclesCompleted} ciclo(s) fechado(s) em ${hopsFechados} operações · ` +
      `R$ ${brl(amount)} → R$ ${brl(r.closedBalance)} · ${pct(fechado)}` +
      (r.cyclesCompleted ? `  (${pct(fechado / r.cyclesCompleted)} por ciclo)` : ''),
  );

  if (r.hops.length > hopsFechados) {
    const soltas = r.hops.length - hopsFechados;
    console.log(
      `  as ${soltas} operação(ões) seguintes não fecharam ciclo — capital parado em ` +
        `${name(r.route[r.endStep])}, e sair dali ainda custaria. Não entram na conta.`,
    );
  }
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}

async function main() {
  const amount = Number(arg('valor', '5000'));
  const delayMin = Number(arg('atraso', '5'));
  const depth = Number(arg('profundidade', '3'));
  const rotaArg = arg('rota', '');
  const startArg = arg('inicio', '');
  // Aceita ids de venue ou os atalhos "dex" (as duas DEX) e "cex" (todas as CEX).
  const excluirArg = arg('excluir', '');

  REFERENCE_BRL = amount;

  const snaps = await loadHistory();
  const info = describe(snaps);
  const arrivals = buildArrivals(snaps, delayMin * 60_000);
  const usable = [...arrivals].filter((a) => a >= 0).length;

  console.log('═'.repeat(96));
  console.log('SIMULADOR DE ROTAS');
  console.log('═'.repeat(96));
  console.log(`período: ${info.from}  →  ${info.to}   (${info.hours.toFixed(1)}h, ${info.count} coletas)`);
  console.log(`capital: R$ ${brl(amount)} · atraso por transferência: ${delayMin} min · ${usable} coletas com par de chegada`);

  // Estatística de todas as pernas: base para tudo o que vem depois.
  const stats = new Map<string, LegStats>();
  for (let a = 0; a < V; a++) {
    for (let b = 0; b < V; b++) {
      if (a === b) continue;
      const s = legStats(snaps, arrivals, a, b);
      if (s) stats.set(`${a}>${b}`, s);
    }
  }
  printLegTable(stats);

  // ── Modo 1: rota explícita ────────────────────────────────────────────────
  if (rotaArg) {
    const ids = rotaArg.split(',').map((x) => x.trim());
    const route = ids.map((id) => {
      const i = IDX.get(id);
      if (i === undefined) throw new Error(`venue desconhecido: "${id}". Use: ${VENUE_IDS.join(', ')}`);
      return i;
    });
    if (route.length < 3) throw new Error('a rota precisa de pelo menos 3 pontos, ex: --rota=binance,bitget,binance');

    const legStatsList = route.slice(0, -1).map((_, i) => stats.get(`${route[i]}>${route[i + 1]}`) ?? null);

    console.log('\n' + '─'.repeat(96));
    console.log('ROTA ESCOLHIDA — melhores gatilhos encontrados');
    console.log('─'.repeat(96));

    const teto = legStatsList.reduce((a, s) => a + (s?.max ?? NaN), 0);
    console.log(`  teto absoluto (melhor momento de cada perna): ${pct(teto)} por ciclo`);

    const best = optimizeThresholds(snaps, arrivals, route, legStatsList, amount);
    if (!best) {
      console.log('  nenhum conjunto de gatilhos completou um ciclo inteiro nesta janela.');
      return;
    }
    printRoute(best, snaps, amount);

    writeCsv(
      'rota-simulada',
      ['ordem', 'saida', 'de', 'para', 'chegada', 'retorno_pct', 'saldo_brl'],
      best.hops.map((h, i) => [
        i + 1,
        snaps[h.departTick].label,
        VENUE_IDS[h.from],
        VENUE_IDS[h.to],
        snaps[h.arriveTick].label,
        h.ret,
        h.balance,
      ]),
    );
    console.log('\n  detalhe exportado para data/rota-simulada.csv');
    return;
  }

  // ── Modo 2: ranquear todos os ciclos ──────────────────────────────────────
  console.log('\n' + '─'.repeat(96));
  console.log(`RANKING DE CICLOS (até ${depth} pernas)`);
  console.log('─'.repeat(96));
  console.log('  teto = soma do melhor momento de cada perna. É o limite superior, não uma promessa.\n');

  const blocked = new Set<number>();
  for (const raw of excluirArg.split(',').map((x) => x.trim()).filter(Boolean)) {
    if (raw === 'dex') venues.forEach((v, i) => v.kind === 'dex' && blocked.add(i));
    else if (raw === 'cex') venues.forEach((v, i) => v.kind === 'cex' && blocked.add(i));
    else {
      const i = IDX.get(raw);
      if (i === undefined) throw new Error(`venue desconhecido em --excluir: "${raw}"`);
      blocked.add(i);
    }
  }
  if (blocked.size) {
    console.log(`  excluídos: ${[...blocked].map(name).join(', ')}`);
  }

  const starts = startArg ? [IDX.get(startArg)!] : [...Array(V).keys()].filter((i) => !blocked.has(i));
  const ranked: { route: number[]; teto: number; p95: number }[] = [];

  for (const start of starts) {
    for (const cycle of enumerateCycles(start, depth, blocked)) {
      const legs = cycle.slice(0, -1).map((_, i) => stats.get(`${cycle[i]}>${cycle[i + 1]}`));
      if (legs.some((l) => !l)) continue;
      ranked.push({
        route: cycle,
        teto: legs.reduce((a, l) => a + l!.max, 0),
        p95: legs.reduce((a, l) => a + l!.p95, 0),
      });
    }
  }

  ranked.sort((a, b) => b.teto - a.teto);
  console.log('  ' + 'ciclo'.padEnd(52) + 'teto'.padStart(10) + 'p95 somado'.padStart(13));
  console.log('  ' + '─'.repeat(75));
  for (const r of ranked.slice(0, 20)) {
    const mark = r.teto > 0 ? ' ✓' : '';
    console.log('  ' + routeLabel(r.route).padEnd(52) + pct(r.teto).padStart(10) + pct(r.p95).padStart(13) + mark);
  }

  const viable = ranked.filter((r) => r.teto > 0);
  console.log(`\n  ${viable.length} de ${ranked.length} ciclos com teto positivo.`);
  if (viable.length) {
    console.log(`  para detalhar: npm run rotas -- --rota=${viable[0].route.map((i) => VENUE_IDS[i]).join(',')}`);
  }
  console.log('\nopções: --rota=a,b,c  --inicio=binance  --profundidade=3  --valor=5000  --atraso=5');
}

void main();
