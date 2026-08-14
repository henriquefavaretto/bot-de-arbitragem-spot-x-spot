import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { logger } from './log.js';

const log = logger('position');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const FILE = join(DATA_DIR, 'position.json');

/**
 * Onde o capital está agora.
 *
 * Esta é a diferença entre o bot antigo e a malha: antes toda rota assumia que
 * o dinheiro começava em BRL na Binance. Para encadear operações o bot precisa
 * saber de onde partir — e é isso que este estado guarda.
 */
export interface Position {
  venueId: string;
  amountBrl: number;
  /** Quando o capital chegou neste venue. */
  since: number;
  /** Valor com que a cadeia começou, para medir o acumulado. */
  initialBrl: number;
}

export interface ChainHop {
  id: string;
  fromId: string;
  toId: string;
  network: string;
  at: number;
  amountBefore: number;
  amountAfter: number;
  /** Spread líquido visível no momento em que o pulo foi registrado. */
  expectedNetPct: number;
  simulated: boolean;
  note?: string;
}

interface Stored {
  position: Position;
  history: ChainHop[];
}

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function read(): Stored {
  try {
    if (existsSync(FILE)) return JSON.parse(readFileSync(FILE, 'utf8')) as Stored;
  } catch (e) {
    log.warn(`não consegui ler position.json: ${(e as Error).message} — recomeçando`);
  }
  const amount = Number(process.env.TRADE_AMOUNT_BRL ?? 1000);
  return {
    position: { venueId: 'binance', amountBrl: amount, since: Date.now(), initialBrl: amount },
    history: [],
  };
}

function write(s: Stored) {
  ensureDir();
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
  renameSync(tmp, FILE);
}

let state = read();

export function currentPosition(): Position {
  return state.position;
}

export function chainHistory(): ChainHop[] {
  return state.history;
}

/** Lucro acumulado da cadeia desde o capital inicial. */
export function chainPnl(): { profitBrl: number; profitPct: number; hops: number } {
  const { amountBrl, initialBrl } = state.position;
  return {
    profitBrl: amountBrl - initialBrl,
    profitPct: initialBrl > 0 ? (amountBrl / initialBrl - 1) * 100 : 0,
    hops: state.history.length,
  };
}

/** Declara manualmente onde o capital está. Reinicia a contagem da cadeia. */
export function setPosition(venueId: string, amountBrl: number): Position {
  if (!Number.isFinite(amountBrl) || amountBrl <= 0) {
    throw new Error('O valor precisa ser um número positivo');
  }
  state.position = { venueId, amountBrl, since: Date.now(), initialBrl: amountBrl };
  write(state);
  log.info(`posição definida: R$ ${amountBrl.toFixed(2)} em ${venueId}`);
  return state.position;
}

/**
 * Registra um pulo e move a posição. Em dry-run o resultado é o previsto pela
 * cotação; quando a execução real existir, `amountAfter` virá do realizado.
 */
export function recordHop(args: {
  fromId: string;
  toId: string;
  network: string;
  amountAfter: number;
  expectedNetPct: number;
  simulated: boolean;
  note?: string;
}): ChainHop {
  if (args.fromId !== state.position.venueId) {
    throw new Error(
      `O capital está em ${state.position.venueId}, não em ${args.fromId} — corrija a posição antes de registrar o pulo`,
    );
  }

  const hop: ChainHop = {
    id: randomUUID(),
    fromId: args.fromId,
    toId: args.toId,
    network: args.network,
    at: Date.now(),
    amountBefore: state.position.amountBrl,
    amountAfter: args.amountAfter,
    expectedNetPct: args.expectedNetPct,
    simulated: args.simulated,
    note: args.note,
  };

  state.history.unshift(hop);
  if (state.history.length > 500) state.history = state.history.slice(0, 500);

  state.position = {
    venueId: args.toId,
    amountBrl: args.amountAfter,
    since: hop.at,
    initialBrl: state.position.initialBrl,
  };

  write(state);
  log.success(
    `${args.simulated ? '[SIMULADO] ' : ''}capital movido ${args.fromId} → ${args.toId} via ${args.network}: ` +
      `R$ ${hop.amountBefore.toFixed(2)} → R$ ${hop.amountAfter.toFixed(2)}`,
  );
  return hop;
}

/** Zera o histórico mantendo a posição atual como novo ponto de partida. */
export function resetChain(): Position {
  state = {
    position: { ...state.position, since: Date.now(), initialBrl: state.position.amountBrl },
    history: [],
  };
  write(state);
  log.info('cadeia reiniciada');
  return state.position;
}
