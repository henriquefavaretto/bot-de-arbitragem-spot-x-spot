import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';

import { config } from './config.js';
import { logger, logBus, recentLogs, type LogEntry } from './log.js';
import { engine, type EngineStatus } from './engine.js';
import { resetChain, setPosition } from './position.js';
import { resetMonitorCounters, startMonitor, stopMonitor } from './recorder.js';
import { assertChainReady } from './quote.js';

const log = logger('server');
const ROOT = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());

// ─── Autenticação opcional ──────────────────────────────────────────────────
if (config.server.password) {
  app.use((req, res, next) => {
    const header = req.headers.authorization ?? '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
      const pass = Buffer.from(encoded, 'base64').toString('utf8').split(':').slice(1).join(':');
      const a = Buffer.from(pass);
      const b = Buffer.from(config.server.password);
      if (a.length === b.length && timingSafeEqual(a, b)) return next();
    }
    res.setHeader('WWW-Authenticate', 'Basic realm="bot-picnic"');
    res.status(401).send('Autenticação necessária');
  });
} else {
  log.warn('DASHBOARD_PASSWORD não definida — o dashboard está aberto para quem acessar a porta');
}

// ─── API ────────────────────────────────────────────────────────────────────

app.get('/api/status', (_req, res) => {
  res.json(engine.status());
});

app.get('/api/cycles', (_req, res) => {
  res.json(engine.cycles());
});

app.get('/api/logs', (_req, res) => {
  res.json(recentLogs());
});

app.post('/api/settings', (req, res) => {
  try {
    const { routeId, autoMode, minSpreadPct, amountBrl } = req.body ?? {};
    if (!routeId) throw new Error('routeId é obrigatório');

    const patch: Record<string, unknown> = {};
    if (autoMode !== undefined) patch.autoMode = Boolean(autoMode);
    if (minSpreadPct !== undefined) patch.minSpreadPct = Number(minSpreadPct);
    if (amountBrl !== undefined) patch.amountBrl = Number(amountBrl);
    res.json(engine.updateSettings(String(routeId), patch));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post('/api/run', (req, res) => {
  const routeId = req.body?.routeId;
  if (!routeId) {
    res.status(400).json({ error: 'routeId é obrigatório' });
    return;
  }
  // Não esperamos o ciclo terminar: ele leva minutos e o progresso vai pelo SSE.
  engine
    .runCycle(String(routeId), 'manual')
    .catch((e) => log.error(`ciclo manual falhou: ${(e as Error).message}`));
  res.json({ started: true });
});

app.post('/api/acknowledge', (_req, res) => {
  engine.acknowledgeStuck();
  res.json({ ok: true });
});

// ─── Malha: posição do capital e pulos ──────────────────────────────────────

app.post('/api/position', (req, res) => {
  try {
    const { venueId, amountBrl } = req.body ?? {};
    if (!venueId) throw new Error('venueId é obrigatório');
    res.json(setPosition(String(venueId), Number(amountBrl)));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post('/api/hop', (req, res) => {
  try {
    const { toId } = req.body ?? {};
    if (!toId) throw new Error('toId é obrigatório');
    // Fase 2: o pulo é registrado com o resultado previsto, sem mover dinheiro.
    res.json(engine.simulateHop(String(toId)));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post('/api/chain/reset', (_req, res) => {
  res.json(resetChain());
});

// ─── Gravação contínua ──────────────────────────────────────────────────────

app.post('/api/monitor', (req, res) => {
  try {
    const action = String(req.body?.action ?? '');
    if (action === 'start') res.json(startMonitor());
    else if (action === 'stop') res.json(stopMonitor());
    else if (action === 'reset') res.json(resetMonitorCounters());
    else throw new Error('ação inválida: use start, stop ou reset');
    engine.emit('status', engine.status());
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// ─── Stream de eventos ──────────────────────────────────────────────────────

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('status', engine.status());
  for (const entry of recentLogs()) send('log', entry);

  const onStatus = (s: EngineStatus) => send('status', s);
  const onLog = (e: LogEntry) => send('log', e);
  engine.on('status', onStatus);
  logBus.on('log', onLog);

  // Alguns proxies derrubam conexões ociosas; um comentário periódico segura.
  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25_000);

  req.on('close', () => {
    clearInterval(keepAlive);
    engine.off('status', onStatus);
    logBus.off('log', onLog);
  });
});

app.use(express.static(join(ROOT, '..', 'public')));

// ─── Boot ───────────────────────────────────────────────────────────────────

const host = process.env.HOST?.trim() || '127.0.0.1';

async function main() {
  if (config.dryRun) {
    log.warn('DRY_RUN ativo: nenhuma ordem, saque ou transação será enviada de verdade');
  } else {
    log.warn('MODO REAL: ordens, saques e transações serão executados com dinheiro de verdade');
  }

  try {
    await assertChainReady();
  } catch (e) {
    log.error(`RPC da Polygon indisponível: ${(e as Error).message}`);
    if (!config.dryRun) process.exit(1);
  }

  engine.start();

  app.listen(config.server.port, host, () => {
    log.success(`dashboard em http://${host}:${config.server.port}`);
  });
}

process.on('SIGINT', () => {
  log.info('encerrando...');
  engine.stop();
  process.exit(0);
});

void main();
