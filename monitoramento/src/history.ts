import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { config, venues } from './config.js';

/** Cotação de um venue num instante. */
export interface Tick {
  ask: number;
  bid: number;
  askOk: boolean;
  bidOk: boolean;
}

/** Uma coleta: o instante e o que cada venue estava cotando nele. */
export interface Snapshot {
  ts: number;
  label: string;
  /** Indexado pela posição do venue em `venues`. `null` = venue falhou. */
  q: (Tick | null)[];
  /** Custo em BRL de uma perna on-chain naquele instante. */
  gasBrl: number;
}

export const VENUE_IDS = venues.map((v) => v.id);
const INDEX = new Map(VENUE_IDS.map((id, i) => [id, i]));

/**
 * Converte "2026-08-04 14:05:38" para epoch ms interpretando como hora local,
 * que é como o monitor grava.
 */
function parseStamp(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return NaN;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
}

/**
 * Lê todos os cotacoes-*.csv e monta a linha do tempo.
 *
 * Usamos as cotações e não o spreads.csv de propósito: uma cadeia real compra
 * num instante e vende em outro, então precisamos dos dois preços separados
 * para casar compra em t com venda em t+atraso.
 */
export async function loadHistory(): Promise<Snapshot[]> {
  if (!existsSync(config.dataDir)) {
    throw new Error(`a pasta ${config.dataDir}/ não existe — rode "npm start" primeiro para coletar dados`);
  }

  const files = readdirSync(config.dataDir)
    .filter((f) => f.startsWith('cotacoes-') && f.endsWith('.csv'))
    .sort();

  if (!files.length) throw new Error(`nenhum arquivo cotacoes-*.csv em ${config.dataDir}/`);

  const byTs = new Map<number, Snapshot>();

  for (const f of files) {
    const rl = createInterface({ input: createReadStream(join(config.dataDir, f), 'utf8'), crlfDelay: Infinity });

    let cols: Record<string, number> | null = null;

    for await (const raw of rl) {
      const line = raw.replace(/^﻿/, '').trim();
      if (!line) continue;
      const parts = line.split(',');

      if (!cols) {
        cols = {};
        parts.forEach((name, i) => (cols![name] = i));
        continue;
      }

      const ts = parseStamp(parts[cols.timestamp]);
      if (!Number.isFinite(ts)) continue;

      const vi = INDEX.get(parts[cols.venue]);
      if (vi === undefined) continue;

      const ask = Number(parts[cols.ask_efetivo]);
      const bid = Number(parts[cols.bid_efetivo]);
      if (!(ask > 0) || !(bid > 0)) continue;

      let snap = byTs.get(ts);
      if (!snap) {
        snap = { ts, label: parts[cols.timestamp], q: new Array(VENUE_IDS.length).fill(null), gasBrl: 0 };
        byTs.set(ts, snap);
      }

      snap.q[vi] = {
        ask,
        bid,
        askOk: parts[cols.profundidade_compra_ok] === '1',
        bidOk: parts[cols.profundidade_venda_ok] === '1',
      };
    }
  }

  await attachGas(byTs);
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

/**
 * Anexa o custo de gás de cada coleta. Coletas gravadas antes do arquivo
 * mercado-*.csv existir ficam com o último valor conhecido.
 */
async function attachGas(byTs: Map<number, Snapshot>) {
  const files = readdirSync(config.dataDir)
    .filter((f) => f.startsWith('mercado-') && f.endsWith('.csv'))
    .sort();

  let last = 0;

  for (const f of files) {
    const rl = createInterface({ input: createReadStream(join(config.dataDir, f), 'utf8'), crlfDelay: Infinity });
    let cols: Record<string, number> | null = null;

    for await (const raw of rl) {
      const line = raw.replace(/^﻿/, '').trim();
      if (!line) continue;
      const parts = line.split(',');

      if (!cols) {
        cols = {};
        parts.forEach((name, i) => (cols![name] = i));
        continue;
      }

      const ts = parseStamp(parts[cols.timestamp]);
      const gas = Number(parts[cols.gas_brl]);
      if (!Number.isFinite(ts) || !Number.isFinite(gas)) continue;

      last = gas;
      const snap = byTs.get(ts);
      if (snap) snap.gasBrl = gas;
    }
  }

  for (const snap of byTs.values()) if (!snap.gasBrl) snap.gasBrl = last;
}

/** Estatística rápida da janela carregada, para o cabeçalho dos relatórios. */
export function describe(snaps: Snapshot[]) {
  const first = snaps[0];
  const last = snaps[snaps.length - 1];
  const spanMs = last.ts - first.ts;
  const gapMs = snaps.length > 1 ? spanMs / (snaps.length - 1) : config.intervalMs;

  return {
    count: snaps.length,
    from: first.label,
    to: last.label,
    hours: spanMs / 3_600_000,
    /** Intervalo médio real entre coletas — pode diferir do configurado. */
    avgGapMs: gapMs,
  };
}
