import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Quote } from './quote.js';
import { logger } from './log.js';

const log = logger('store');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const CYCLES_FILE = join(DATA_DIR, 'cycles.json');
const SETTINGS_FILE = join(DATA_DIR, 'settings.json');

export type CycleState =
  | 'pending'
  | 'buying'
  | 'withdrawing'
  | 'awaiting_deposit'
  | 'approving'
  | 'swapping'
  | 'transferring'
  | 'selling'
  | 'completed'
  | 'failed';

/** Sequência de passos por tipo de rota. */
export const CYCLE_STEPS: Record<'dex' | 'cex', CycleState[]> = {
  dex: ['buying', 'withdrawing', 'awaiting_deposit', 'approving', 'swapping', 'transferring'],
  cex: ['buying', 'withdrawing', 'awaiting_deposit', 'selling'],
};

export interface Cycle {
  id: string;
  routeId: string;
  dryRun: boolean;
  state: CycleState;
  startedAt: number;
  finishedAt?: number;
  amountBrl: number;
  /** Cotação no instante em que o ciclo foi disparado. */
  quoteAtStart: Quote;
  trigger: 'manual' | 'auto';

  /** Valores realizados, preenchidos conforme o ciclo avança. */
  actual: {
    spentBrl?: number;
    usdtBought?: number;
    withdrawId?: string;
    usdtWithdrawn?: number;
    usdtReceivedOnChain?: number;
    tokenReceived?: number;
    /** Rotas cex: preço médio de venda e se houve fallback a mercado. */
    avgSellPrice?: number;
    usedMarketFallback?: boolean;
    gasNative?: number;
    netBrl?: number;
    profitBrl?: number;
    spreadPct?: number;
  };

  txs: { label: string; hash: string }[];
  error?: string;
}

export interface RouteSettings {
  autoMode: boolean;
  minSpreadPct: number;
  amountBrl: number;
}

/** Configurações por rota, indexadas pelo id da rota. */
export type SettingsMap = Record<string, RouteSettings>;

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch (e) {
    log.warn(`não consegui ler ${file}: ${(e as Error).message} — começando do zero`);
    return fallback;
  }
}

/** Grava em arquivo temporário e renomeia: evita JSON truncado se o processo cair. */
function writeJson(file: string, value: unknown) {
  ensureDir();
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmp, file);
}

let cycles: Cycle[] = readJson<Cycle[]>(CYCLES_FILE, []);

export function allCycles(): Cycle[] {
  return cycles;
}

export function saveCycle(cycle: Cycle) {
  const i = cycles.findIndex((c) => c.id === cycle.id);
  if (i >= 0) cycles[i] = cycle;
  else cycles.unshift(cycle);
  // Mantém histórico enxuto.
  if (cycles.length > 200) cycles = cycles.slice(0, 200);
  writeJson(CYCLES_FILE, cycles);
}

/** Ciclo que ficou preso em estado intermediário (ex.: processo caiu no meio). */
export function unfinishedCycle(): Cycle | undefined {
  return cycles.find((c) => c.state !== 'completed' && c.state !== 'failed');
}

export function loadSettings(defaults: SettingsMap): SettingsMap {
  const stored = readJson<Partial<SettingsMap>>(SETTINGS_FILE, {});
  const out: SettingsMap = {};
  for (const [id, def] of Object.entries(defaults)) {
    out[id] = { ...def, ...(stored[id] ?? {}) };
  }
  return out;
}

export function saveSettings(s: SettingsMap) {
  writeJson(SETTINGS_FILE, s);
}
