import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { logger } from './log.js';
import type { Leg } from './legs.js';
import { venuesMissingNetworkData, type VenueQuote } from './venues.js';

const log = logger('monitor');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, config.monitor.dir);
const STATE_FILE = join(DIR, 'estado.json');

/**
 * Gravação contínua da malha em CSV.
 *
 * O que faz este registro ser fiel:
 *
 *  - preços vêm da caminhada real do livro, não do topo
 *  - taxa de saque é lida da API de cada exchange, por rede, autenticada
 *  - o nome da rede é normalizado (BSC ≡ BEP20) antes de comparar origem/destino
 *  - toda estimativa é marcada: `taxa_rede_conhecida`, `profundidade_ok`
 *  - falha de venue vira linha com `erro`, nunca dado antigo repetido
 *  - o valor de referência é fixo, então linhas de dias diferentes se comparam
 *
 * O formato das colunas é compatível com os scripts `report` e `chains` do
 * projeto de monitoramento — basta apontar `DATA_DIR` para esta pasta.
 */

export interface MonitorState {
  active: boolean;
  startedAt: number | null;
  ticks: number;
  legRows: number;
  opportunities: number;
  lastTickAt: number | null;
  lastError: string | null;
  referenceBrl: number;
  dir: string;
  files: { name: string; sizeKb: number }[];
  /** Venues cuja taxa de saque não pôde ser lida da API. */
  estimatedFeeVenues: string[];
}

// ─── CSV ────────────────────────────────────────────────────────────────────

function ensureDir() {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
}

function cell(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') return Number.isFinite(v) ? String(Math.round(v * 1e8) / 1e8) : '';
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

class DailyCsv {
  private day = '';
  private path = '';

  constructor(
    private readonly prefix: string,
    private readonly header: string[],
    private readonly singleFile = false,
  ) {}

  private target(ts: Date): string {
    if (this.singleFile) {
      if (!this.path) {
        this.path = join(DIR, `${this.prefix}.csv`);
        this.ensureHeader();
      }
      return this.path;
    }
    const day = `${ts.getFullYear()}-${pad(ts.getMonth() + 1)}-${pad(ts.getDate())}`;
    if (day !== this.day) {
      this.day = day;
      this.path = join(DIR, `${this.prefix}-${day}.csv`);
      this.ensureHeader();
    }
    return this.path;
  }

  private ensureHeader() {
    ensureDir();
    // BOM para o Excel abrir os acentos corretamente com duplo clique.
    if (!existsSync(this.path)) writeFileSync(this.path, '﻿' + this.header.join(',') + '\n', 'utf8');
  }

  append(ts: Date, rows: (string | number | boolean | null | undefined)[][]) {
    if (!rows.length) return;
    const file = this.target(ts);
    appendFileSync(file, rows.map((r) => r.map(cell).join(',')).join('\n') + '\n', 'utf8');
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

export function stamp(ts: Date): string {
  return (
    `${ts.getFullYear()}-${pad(ts.getMonth() + 1)}-${pad(ts.getDate())} ` +
    `${pad(ts.getHours())}:${pad(ts.getMinutes())}:${pad(ts.getSeconds())}`
  );
}

// Nomes de coluna iguais aos do projeto de monitoramento, para os scripts de
// análise lerem esta pasta sem adaptação.
const quotesCsv = new DailyCsv('cotacoes', [
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

const legsCsv = new DailyCsv('spreads', [
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
  // Colunas extras desta versão: rastreiam a fidelidade de cada linha.
  'rede',
  'taxa_rede_usdt',
  'taxa_rede_conhecida',
  'aporte_referencia_brl',
]);

const marketCsv = new DailyCsv('mercado', ['timestamp', 'gas_brl', 'pol_usdt', 'usdt_brl_ref', 'venues_ok', 'venues_total']);

const oppsCsv = new DailyCsv(
  'oportunidades',
  ['timestamp', 'de', 'para', 'rede', 'spread_liquido_pct', 'lucro_brl', 'spread_bruto_pct', 'ask_origem', 'bid_destino'],
  true,
);

// ─── Estado ─────────────────────────────────────────────────────────────────

interface Persisted {
  active: boolean;
  startedAt: number | null;
  ticks: number;
  legRows: number;
  opportunities: number;
}

function readState(): Persisted {
  try {
    if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Persisted;
  } catch {
    // arquivo corrompido: recomeça
  }
  return { active: false, startedAt: null, ticks: 0, legRows: 0, opportunities: 0 };
}

let state = readState();
let lastTickAt: number | null = null;
let lastError: string | null = null;
let estimatedFeeVenues: string[] = [];

function persist() {
  ensureDir();
  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  renameSync(tmp, STATE_FILE);
}

function listFiles(): { name: string; sizeKb: number }[] {
  if (!existsSync(DIR)) return [];
  const names = ['cotacoes', 'spreads', 'mercado', 'oportunidades'];
  const out: { name: string; sizeKb: number }[] = [];

  try {
    for (const f of readdirSync(DIR)) {
      if (!f.endsWith('.csv')) continue;
      if (!names.some((n) => f.startsWith(n))) continue;
      out.push({ name: f, sizeKb: Math.round(statSync(join(DIR, f)).size / 1024) });
    }
  } catch {
    // pasta pode não existir ainda
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function monitorState(): MonitorState {
  return {
    ...state,
    lastTickAt,
    lastError,
    referenceBrl: config.monitor.referenceBrl,
    dir: config.monitor.dir,
    files: listFiles(),
    estimatedFeeVenues,
  };
}

export function startMonitor(): MonitorState {
  if (!state.active) {
    state.active = true;
    state.startedAt = Date.now();
    persist();
    log.success(`gravação iniciada — referência R$ ${config.monitor.referenceBrl} · pasta ${config.monitor.dir}/`);
  }
  return monitorState();
}

export function stopMonitor(): MonitorState {
  if (state.active) {
    state.active = false;
    persist();
    log.info(`gravação parada — ${state.ticks} coletas acumuladas`);
  }
  return monitorState();
}

export function resetMonitorCounters(): MonitorState {
  state = { ...state, ticks: 0, legRows: 0, opportunities: 0, startedAt: state.active ? Date.now() : null };
  persist();
  return monitorState();
}

export function isRecording(): boolean {
  return state.active;
}

// ─── Gravação de um tick ────────────────────────────────────────────────────

export interface TickInput {
  quotes: VenueQuote[];
  legs: Leg[];
  gasBrl: number;
  polUsdt: number;
  usdtBrlRef: number;
}

/** Grava uma coleta. Chamado pelo engine a cada atualização da malha. */
export function recordTick({ quotes, legs, gasBrl, polUsdt, usdtBrlRef }: TickInput) {
  if (!state.active) return;

  const ts = new Date();
  const label = stamp(ts);
  const ref = config.monitor.referenceBrl;

  try {
    // Uma linha por venue, inclusive os que falharam — o erro fica registrado
    // em vez de virar um buraco silencioso no histórico.
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

    legsCsv.append(
      ts,
      legs.map((l) => [
        label,
        l.fromId,
        l.toId,
        l.askFrom,
        l.bidTo,
        l.grossPct,
        l.feesPct,
        l.netPct,
        l.profitBrl,
        l.tradeFeeFromBrl,
        l.tradeFeeToBrl,
        l.withdrawFeeBrl,
        l.gasBrl,
        l.depthOk,
        l.network,
        l.networkFeeUsdt,
        l.networkFeeKnown,
        ref,
      ]),
    );

    const ok = quotes.filter((q) => q.ok).length;
    marketCsv.append(ts, [[label, gasBrl, polUsdt, usdtBrlRef, ok, quotes.length]]);

    // Só entram aqui pernas executáveis de verdade: com profundidade e com
    // taxa de rede confirmada. Estimativa não vira oportunidade.
    const opps = legs.filter(
      (l) => l.netPct >= config.monitor.opportunityPct && l.depthOk && l.networkFeeKnown,
    );
    if (opps.length) {
      oppsCsv.append(
        ts,
        opps.map((l) => [label, l.fromId, l.toId, l.network, l.netPct, l.profitBrl, l.grossPct, l.askFrom, l.bidTo]),
      );
    }

    state.ticks++;
    state.legRows += legs.length;
    state.opportunities += opps.length;
    lastTickAt = ts.getTime();
    lastError = null;

    // Persiste o contador de vez em quando para não escrever demais no disco.
    if (state.ticks % 30 === 0) persist();

    // A causa raiz é o venue sem credencial, não toda origem que tenha alguma
    // perna estimada por causa dele.
    estimatedFeeVenues = venuesMissingNetworkData();
  } catch (e) {
    lastError = (e as Error).message;
    log.error(`falha ao gravar coleta: ${lastError}`);
  }
}
