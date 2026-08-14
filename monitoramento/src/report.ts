import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { config } from './config.js';
import { venueLabel } from './spreads.js';

/**
 * Analisa os CSVs acumulados. O objetivo é responder: em que rotas e com que
 * frequência apareceram oportunidades, e — depois de mover fundos para um
 * venue — quais saídas esse venue ofereceu.
 */

interface PairStats {
  from: string;
  to: string;
  samples: number;
  above: number;
  max: number;
  maxAt: string;
  sum: number;
  values: number[];
}

const stats = new Map<string, PairStats>();
let firstTs = '';
let lastTs = '';

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

async function readFile(path: string) {
  const rl = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });

  let header: string[] | null = null;
  let idx = { ts: 0, from: 1, to: 2, net: 7, depth: 13 };

  for await (const raw of rl) {
    const line = raw.replace(/^﻿/, '').trim();
    if (!line) continue;

    const cols = line.split(',');
    if (!header) {
      header = cols;
      // Localiza as colunas pelo nome: sobrevive a mudanças de ordem.
      const at = (name: string, fallback: number) => {
        const i = header!.indexOf(name);
        return i >= 0 ? i : fallback;
      };
      idx = {
        ts: at('timestamp', 0),
        from: at('de', 1),
        to: at('para', 2),
        net: at('spread_liquido_pct', 7),
        depth: at('profundidade_ok', 13),
      };
      continue;
    }

    const net = Number(cols[idx.net]);
    if (!Number.isFinite(net)) continue;
    // Linhas sem profundidade não representam operação executável.
    if (cols[idx.depth] === '0') continue;

    const ts = cols[idx.ts];
    if (!firstTs || ts < firstTs) firstTs = ts;
    if (ts > lastTs) lastTs = ts;

    const from = cols[idx.from];
    const to = cols[idx.to];
    const key = `${from}>${to}`;

    let s = stats.get(key);
    if (!s) {
      s = { from, to, samples: 0, above: 0, max: -Infinity, maxAt: '', sum: 0, values: [] };
      stats.set(key, s);
    }

    s.samples++;
    s.sum += net;
    s.values.push(net);
    if (net >= config.opportunityThresholdPct) s.above++;
    if (net > s.max) {
      s.max = net;
      s.maxAt = ts;
    }
  }
}

function pct(v: number): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(3)}%`;
}

async function main() {
  if (!existsSync(config.dataDir)) {
    console.log(`Nada para analisar: a pasta ${config.dataDir}/ ainda não existe. Rode "npm start" primeiro.`);
    return;
  }

  const files = readdirSync(config.dataDir).filter((f) => f.startsWith('spreads-') && f.endsWith('.csv'));
  if (!files.length) {
    console.log(`Nenhum arquivo spreads-*.csv em ${config.dataDir}/.`);
    return;
  }

  for (const f of files) await readFile(join(config.dataDir, f));

  if (!stats.size) {
    console.log('Os arquivos existem mas não têm linhas válidas ainda.');
    return;
  }

  const all = [...stats.values()].map((s) => {
    const sorted = [...s.values].sort((a, b) => a - b);
    return {
      ...s,
      avg: s.sum / s.samples,
      p50: quantile(sorted, 0.5),
      p95: quantile(sorted, 0.95),
      pctAbove: (s.above / s.samples) * 100,
    };
  });

  const totalSamples = all.reduce((a, s) => a + s.samples, 0);

  console.log('═'.repeat(96));
  console.log(`RELATÓRIO DE SPREADS · ${files.length} arquivo(s) · ${totalSamples.toLocaleString('pt-BR')} amostras`);
  console.log(`período: ${firstTs}  →  ${lastTs}`);
  console.log(`aporte simulado: R$ ${config.amountBrl} · limiar de oportunidade: ${config.opportunityThresholdPct}%`);
  console.log('═'.repeat(96));

  // ── Ranking geral ────────────────────────────────────────────────────────
  console.log('\nMELHORES ROTAS (por pico de spread líquido)\n');
  console.log(
    '  ' + 'rota'.padEnd(38) + 'pico'.padStart(9) + 'p95'.padStart(9) + 'mediana'.padStart(9) +
      '% do tempo'.padStart(12) + '  melhor momento',
  );
  console.log('  ' + '─'.repeat(92));

  for (const s of [...all].sort((a, b) => b.max - a.max).slice(0, 20)) {
    const name = `${venueLabel(s.from)} → ${venueLabel(s.to)}`;
    console.log(
      '  ' +
        name.padEnd(38) +
        pct(s.max).padStart(9) +
        pct(s.p95).padStart(9) +
        pct(s.p50).padStart(9) +
        `${s.pctAbove.toFixed(1)}%`.padStart(12) +
        `  ${s.maxAt}`,
    );
  }

  // ── Saídas por venue de origem ───────────────────────────────────────────
  // Esta é a visão que responde "já movi fundos para X, e agora?".
  console.log('\n\nSAÍDAS DISPONÍVEIS A PARTIR DE CADA VENUE');
  console.log('(depois de mover fundos para um venue, estas foram as rotas de saída)\n');

  const origins = [...new Set(all.map((s) => s.from))];
  for (const origin of origins) {
    const outs = all.filter((s) => s.from === origin).sort((a, b) => b.max - a.max);
    if (!outs.length) continue;

    const anyGood = outs.filter((s) => s.above > 0);
    console.log(`  ${venueLabel(origin).toUpperCase()}`);
    if (!anyGood.length) {
      console.log(`    nenhuma saída passou de ${config.opportunityThresholdPct}% no período`);
    }
    for (const s of outs.slice(0, 4)) {
      const mark = s.above > 0 ? '✓' : ' ';
      console.log(
        `    ${mark} → ${venueLabel(s.to).padEnd(20)} pico ${pct(s.max).padStart(8)} · ` +
          `acima do limiar em ${s.pctAbove.toFixed(1)}% do tempo`,
      );
    }
    console.log('');
  }

  // ── Oportunidades registradas ────────────────────────────────────────────
  const oppsPath = join(config.dataDir, 'oportunidades.csv');
  if (existsSync(oppsPath)) {
    let count = 0;
    const rl = createInterface({ input: createReadStream(oppsPath, 'utf8'), crlfDelay: Infinity });
    for await (const line of rl) if (line.trim()) count++;
    console.log(`oportunidades.csv: ${Math.max(0, count - 1).toLocaleString('pt-BR')} linhas acima do limiar`);
  }
}

void main();
