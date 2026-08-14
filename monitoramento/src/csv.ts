import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';

/**
 * Escritor CSV append-only com rotação diária. Cada linha é gravada na hora,
 * sem buffer, para que uma queda de energia perca no máximo um tick.
 */
export class CsvWriter {
  private currentDay = '';
  private currentPath = '';

  constructor(
    private readonly prefix: string,
    private readonly header: string[],
    /** true grava tudo num arquivo só, sem rotação por dia. */
    private readonly singleFile = false,
  ) {
    if (!existsSync(config.dataDir)) mkdirSync(config.dataDir, { recursive: true });
  }

  private pathFor(ts: Date): string {
    const day = ts.toISOString().slice(0, 10);
    if (this.singleFile) {
      if (!this.currentPath) {
        this.currentPath = join(config.dataDir, `${this.prefix}.csv`);
        this.ensureHeader(this.currentPath);
      }
      return this.currentPath;
    }
    if (day !== this.currentDay) {
      this.currentDay = day;
      this.currentPath = join(config.dataDir, `${this.prefix}-${day}.csv`);
      this.ensureHeader(this.currentPath);
    }
    return this.currentPath;
  }

  private ensureHeader(path: string) {
    // BOM para o Excel abrir acentos corretamente ao dar duplo clique.
    if (!existsSync(path)) writeFileSync(path, '﻿' + this.header.join(',') + '\n', 'utf8');
  }

  append(ts: Date, rows: (string | number | boolean | null | undefined)[][]) {
    if (!rows.length) return;
    const path = this.pathFor(ts);
    const body = rows.map((r) => r.map(cell).join(',')).join('\n') + '\n';
    appendFileSync(path, body, 'utf8');
  }

  get path(): string {
    return this.currentPath;
  }
}

/**
 * Grava um CSV do zero, substituindo o que existia. Para resultados de
 * simulação, que representam uma execução inteira — diferente dos arquivos de
 * coleta, que são append-only.
 */
export function writeCsv(
  name: string,
  header: string[],
  rows: (string | number | boolean | null | undefined)[][],
): string {
  if (!existsSync(config.dataDir)) mkdirSync(config.dataDir, { recursive: true });
  const path = join(config.dataDir, `${name}.csv`);
  const body = rows.map((r) => r.map(cell).join(',')).join('\n');
  writeFileSync(path, '﻿' + header.join(',') + '\n' + (body ? body + '\n' : ''), 'utf8');
  return path;
}

function cell(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '';
    // Ponto decimal: o Excel pt-BR converte na importação e ferramentas de
    // análise (pandas, R) esperam ponto.
    return String(Math.round(v * 1e8) / 1e8);
  }
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** ISO local sem timezone, no formato que o Excel reconhece como data/hora. */
export function stamp(ts: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${ts.getFullYear()}-${pad(ts.getMonth() + 1)}-${pad(ts.getDate())} ` +
    `${pad(ts.getHours())}:${pad(ts.getMinutes())}:${pad(ts.getSeconds())}`
  );
}
