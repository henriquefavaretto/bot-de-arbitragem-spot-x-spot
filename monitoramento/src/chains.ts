import { venues } from './config.js';
import { writeCsv } from './csv.js';
import { describe, loadHistory, VENUE_IDS, type Snapshot } from './history.js';

/**
 * Reconstrói cadeias de operações sobre o histórico coletado.
 *
 * A pergunta que isto responde: começando com R$ X num venue, qual sequência de
 * pulos ao longo dos dias teria dado o melhor resultado — comprar na Binance,
 * vender na Bitget, esperar, e daí sair da Bitget para outro lugar.
 *
 * A diferença crucial em relação ao spreads.csv: aqui a compra acontece num
 * instante e a venda no instante da CHEGADA, depois do atraso de transferência.
 * É o preço que você realmente pegaria, não o do mesmo segundo.
 */

const V = venues.length;

/**
 * Quanto o atraso real pode esticar antes de invalidarmos o pulo. A coleta tem
 * buracos (reinício, queda de rede, máquina dormindo), e casar a compra com uma
 * venda muito depois do previsto inventaria um resultado que nunca existiu.
 */
const MAX_DELAY_STRETCH = 2.5;

/**
 * Para cada coleta, o índice da primeira coleta que acontece pelo menos
 * `delayMs` depois. -1 quando não existe, ou quando o buraco nos dados é grande
 * demais para representar honestamente esse atraso.
 *
 * O atraso precisa ser medido em tempo de relógio, não em número de coletas:
 * um intervalo fixo de índices vira qualquer coisa depois de uma interrupção.
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

interface Hop {
  fromIdx: number;
  toIdx: number;
  /** Índices na linha do tempo. */
  departTick: number;
  arriveTick: number;
  balanceBefore: number;
  balanceAfter: number;
  /** Spread que estava visível no momento da decisão. */
  observedPct: number;
  /** Spread que de fato se realizou, com o preço da chegada. */
  realizedPct: number;
}

interface Chain {
  startIdx: number;
  hops: Hop[];
  finalBalance: number;
  finalVenue: number;
}

// ─── Mecânica de um pulo ───────────────────────────────────────────────────

/**
 * Resultado de sair de `from` no tick `t` e vender em `to` no tick `t2`.
 * Devolve null quando algum dos lados não tem cotação utilizável.
 */
function hop(
  snaps: Snapshot[],
  fromIdx: number,
  toIdx: number,
  t: number,
  t2: number,
  balance: number,
): number | null {
  const qFrom = snaps[t].q[fromIdx];
  const qTo = snaps[t2].q[toIdx];
  if (!qFrom?.askOk || !qTo?.bidOk) return null;
  if (!(qFrom.ask > 0) || !(qTo.bid > 0)) return null;

  const from = venues[fromIdx];
  const to = venues[toIdx];

  const usdtGross = balance / qFrom.ask;
  const usdtArriving = usdtGross - usdtGross * from.takerFee - from.withdrawFeeUsdt;
  if (usdtArriving <= 0) return null;

  const brlGross = usdtArriving * qTo.bid;
  const legsOnChain = (from.kind === 'dex' ? 1 : 0) + (to.kind === 'dex' ? 1 : 0);
  const net = brlGross - brlGross * to.takerFee - snaps[t].gasBrl * legsOnChain;

  return net > 0 ? net : null;
}

// ─── Melhor cadeia possível (programação dinâmica) ─────────────────────────

/**
 * Encontra a sequência ótima com visão retroativa perfeita. É o teto do que
 * era capturável na janela — nenhuma estratégia ao vivo bate isso.
 *
 * Estado: (tick, venue) -> maior saldo possível estando naquele venue naquele
 * instante. Transições: ficar parado, ou pular e chegar `delayTicks` depois.
 */
function bestChain(snaps: Snapshot[], startIdx: number, amount: number, arrivals: Int32Array): Chain {
  const T = snaps.length;
  const best = new Float64Array(T * V).fill(-Infinity);
  const prevTick = new Int32Array(T * V).fill(-1);
  const prevVenue = new Int32Array(T * V).fill(-1);

  best[startIdx] = amount;

  for (let t = 0; t < T; t++) {
    for (let v = 0; v < V; v++) {
      const bal = best[t * V + v];
      if (bal === -Infinity) continue;

      // Ficar parado até a próxima coleta.
      if (t + 1 < T && bal > best[(t + 1) * V + v]) {
        best[(t + 1) * V + v] = bal;
        prevTick[(t + 1) * V + v] = t;
        prevVenue[(t + 1) * V + v] = v;
      }

      const t2 = arrivals[t];
      if (t2 < 0) continue;

      for (let u = 0; u < V; u++) {
        if (u === v) continue;
        const result = hop(snaps, v, u, t, t2, bal);
        if (result === null) continue;
        if (result > best[t2 * V + u]) {
          best[t2 * V + u] = result;
          prevTick[t2 * V + u] = t;
          prevVenue[t2 * V + u] = v;
        }
      }
    }
  }

  // Melhor saldo final, em qualquer venue.
  let endVenue = startIdx;
  let endBal = -Infinity;
  for (let v = 0; v < V; v++) {
    const b = best[(T - 1) * V + v];
    if (b > endBal) {
      endBal = b;
      endVenue = v;
    }
  }

  // Volta pelo caminho: prevVenue diferente do atual significa que houve pulo.
  const hops: Hop[] = [];
  let t = T - 1;
  let v = endVenue;

  while (t > 0) {
    const pt = prevTick[t * V + v];
    const pv = prevVenue[t * V + v];
    if (pt < 0) break;

    if (pv !== v) {
      const before = best[pt * V + pv];
      const after = best[t * V + v];
      hops.push({
        fromIdx: pv,
        toIdx: v,
        departTick: pt,
        arriveTick: t,
        balanceBefore: before,
        balanceAfter: after,
        observedPct: observedSpread(snaps, pv, v, pt),
        realizedPct: (after / before - 1) * 100,
      });
    }
    t = pt;
    v = pv;
  }

  hops.reverse();
  return { startIdx, hops, finalBalance: endBal, finalVenue: endVenue };
}

/** Spread que apareceria no painel no instante da decisão (compra e venda em t). */
function observedSpread(snaps: Snapshot[], fromIdx: number, toIdx: number, t: number): number {
  const r = hop(snaps, fromIdx, toIdx, t, t, 1000);
  return r === null ? NaN : (r / 1000 - 1) * 100;
}

// ─── Simulação ao vivo (greedy por limiar) ─────────────────────────────────

/**
 * O que um bot com regra simples teria capturado: a cada coleta, se alguma
 * saída do venue atual mostra spread acima do limiar, executa a melhor.
 * A decisão usa o preço visível; o resultado usa o preço da chegada.
 */
function greedyChain(
  snaps: Snapshot[],
  startIdx: number,
  amount: number,
  arrivals: Int32Array,
  thresholdPct: number,
): Chain {
  const T = snaps.length;
  const hops: Hop[] = [];

  let v = startIdx;
  let bal = amount;
  let t = 0;

  while (t < T) {
    const t2 = arrivals[t];
    if (t2 < 0) {
      t++;
      continue;
    }

    let bestU = -1;
    let bestObserved = thresholdPct;

    for (let u = 0; u < V; u++) {
      if (u === v) continue;
      const obs = observedSpread(snaps, v, u, t);
      if (Number.isFinite(obs) && obs > bestObserved) {
        bestObserved = obs;
        bestU = u;
      }
    }

    if (bestU < 0) {
      t++;
      continue;
    }

    const after = hop(snaps, v, bestU, t, t2, bal);
    if (after === null) {
      t++;
      continue;
    }

    hops.push({
      fromIdx: v,
      toIdx: bestU,
      departTick: t,
      arriveTick: t2,
      balanceBefore: bal,
      balanceAfter: after,
      observedPct: bestObserved,
      realizedPct: (after / bal - 1) * 100,
    });

    bal = after;
    v = bestU;
    t = t2;
  }

  return { startIdx, hops, finalBalance: bal, finalVenue: v };
}

// ─── Saída ─────────────────────────────────────────────────────────────────

const brl = (v: number) => v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (v: number) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(3)}%` : '—');

function printChain(title: string, chain: Chain, snaps: Snapshot[], amount: number) {
  console.log(`\n${'─'.repeat(104)}`);
  console.log(title);
  console.log('─'.repeat(104));

  if (!chain.hops.length) {
    console.log('  Nenhuma operação lucrativa encontrada nesta janela.');
    return;
  }

  console.log(
    '  #  ' +
      'saída'.padEnd(20) +
      'rota'.padEnd(30) +
      'chegada'.padEnd(20) +
      'visto'.padStart(9) +
      'real'.padStart(9) +
      'saldo'.padStart(13),
  );

  chain.hops.forEach((h, i) => {
    const route = `${venues[h.fromIdx].label} → ${venues[h.toIdx].label}`;
    console.log(
      `  ${String(i + 1).padStart(2)} ` +
        snaps[h.departTick].label.padEnd(20) +
        route.padEnd(30) +
        snaps[h.arriveTick].label.padEnd(20) +
        pct(h.observedPct).padStart(9) +
        pct(h.realizedPct).padStart(9) +
        `R$ ${brl(h.balanceAfter)}`.padStart(13),
    );
  });

  const totalPct = (chain.finalBalance / amount - 1) * 100;
  const hours = (snaps[chain.hops[chain.hops.length - 1].arriveTick].ts - snaps[chain.hops[0].departTick].ts) / 3_600_000;

  console.log('─'.repeat(104));
  console.log(
    `  ${chain.hops.length} operações · R$ ${brl(amount)} → R$ ${brl(chain.finalBalance)} · ` +
      `${pct(totalPct)} · lucro R$ ${brl(chain.finalBalance - amount)}`,
  );
  console.log(`  terminou em ${venues[chain.finalVenue].label} · ${hours.toFixed(1)}h entre o primeiro e o último pulo`);
}

function exportChain(chain: Chain, snaps: Snapshot[], tag: string) {
  // Substitui o arquivo: cada execução é um resultado completo, não um
  // histórico ao qual se acrescenta.
  writeCsv(
    `cadeia-${tag}`,
    [
      'ordem',
      'saida_timestamp',
      'de',
      'para',
      'chegada_timestamp',
      'spread_visto_pct',
      'spread_realizado_pct',
      'saldo_antes_brl',
      'saldo_depois_brl',
      'lucro_brl',
    ],
    chain.hops.map((h, i) => [
      i + 1,
      snaps[h.departTick].label,
      VENUE_IDS[h.fromIdx],
      VENUE_IDS[h.toIdx],
      snaps[h.arriveTick].label,
      h.observedPct,
      h.realizedPct,
      h.balanceBefore,
      h.balanceAfter,
      h.balanceAfter - h.balanceBefore,
    ]),
  );
}

// ─── CLI ───────────────────────────────────────────────────────────────────

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}

async function main() {
  const amount = Number(arg('valor', '1000'));
  const delayMin = Number(arg('atraso', '30'));
  const threshold = Number(arg('limiar', '0.3'));
  const startArg = arg('inicio', 'binance');

  const snaps = await loadHistory();
  const info = describe(snaps);

  if (snaps.length < 3) {
    console.log('Histórico curto demais para simular cadeias. Deixe o monitor rodando por mais tempo.');
    return;
  }

  const delayMs = delayMin * 60_000;
  const arrivals = buildArrivals(snaps, delayMs);
  const usable = [...arrivals].filter((a) => a >= 0).length;

  console.log('═'.repeat(104));
  console.log('SIMULAÇÃO DE CADEIAS DE OPERAÇÕES');
  console.log('═'.repeat(104));
  console.log(`período: ${info.from}  →  ${info.to}   (${info.hours.toFixed(1)}h, ${info.count} coletas)`);
  console.log(
    `capital inicial: R$ ${brl(amount)} · atraso por transferência: ${delayMin} min · limiar do greedy: ${threshold}%`,
  );

  // Buracos na coleta impedem casar compra e venda com o atraso pedido.
  const gaps = info.count - 1 - usable;
  if (gaps > 0) {
    console.log(
      `\n  aviso: ${gaps} de ${info.count - 1} coletas não têm par de chegada a ${delayMin} min ` +
        `(fim da janela ou interrupção na coleta) — esses instantes foram descartados`,
    );
  }
  console.log('\nA coluna "visto" é o spread que apareceria no painel na hora de decidir.');
  console.log('A coluna "real" é o que se realizou, já vendendo ao preço do momento da chegada.');

  const startCandidates =
    startArg === 'todos' ? VENUE_IDS.map((_, i) => i) : [Math.max(0, VENUE_IDS.indexOf(startArg))];

  for (const startIdx of startCandidates) {
    const label = venues[startIdx].label;

    const optimal = bestChain(snaps, startIdx, amount, arrivals);
    printChain(`MELHOR CADEIA POSSÍVEL — começando em ${label}  (visão retroativa, é o teto)`, optimal, snaps, amount);

    const greedy = greedyChain(snaps, startIdx, amount, arrivals, threshold);
    printChain(`BOT COM LIMIAR DE ${threshold}% — começando em ${label}  (o que dava para capturar ao vivo)`, greedy, snaps, amount);

    if (startCandidates.length === 1) {
      exportChain(optimal, snaps, `otima-${VENUE_IDS[startIdx]}`);
      exportChain(greedy, snaps, `greedy-${VENUE_IDS[startIdx]}`);
      console.log(`\ncadeias exportadas para ${'data'}/cadeia-*.csv`);
    }
  }

  console.log('\nopções: --inicio=binance|todos  --valor=1000  --atraso=30  --limiar=0.3');
}

void main();
