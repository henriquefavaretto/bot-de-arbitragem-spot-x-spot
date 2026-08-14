import { EventEmitter } from 'node:events';

export type LogLevel = 'info' | 'warn' | 'error' | 'success';

export interface LogEntry {
  ts: number;
  level: LogLevel;
  scope: string;
  message: string;
}

/** Buffer circular dos últimos logs — o dashboard puxa isso ao conectar. */
const BUFFER_SIZE = 300;
const buffer: LogEntry[] = [];

export const logBus = new EventEmitter();

function push(level: LogLevel, scope: string, message: string) {
  const entry: LogEntry = { ts: Date.now(), level, scope, message };
  buffer.push(entry);
  if (buffer.length > BUFFER_SIZE) buffer.shift();

  const stamp = new Date(entry.ts).toISOString().slice(11, 19);
  const line = `[${stamp}] [${scope}] ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);

  logBus.emit('log', entry);
}

export function logger(scope: string) {
  return {
    info: (m: string) => push('info', scope, m),
    warn: (m: string) => push('warn', scope, m),
    error: (m: string) => push('error', scope, m),
    success: (m: string) => push('success', scope, m),
  };
}

export function recentLogs(): LogEntry[] {
  return [...buffer];
}
