import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import { config, hasCredentials, routeById, routes, type RouteDef } from './config.js';
import { logger } from './log.js';
import { binance } from './binance.js';
import {
  ensureAllowance,
  fromRaw,
  nativeBalance,
  sendRawSwap,
  toRaw,
  tokenBalance,
  transferToken,
  waitForBalanceIncrease,
  walletAddress,
} from './chain.js';
import { buildRoute, getRoute } from './kyber.js';
import { binanceCcxt, cexPrivate, freeUsdt, sellAtBestBid, waitForCexDeposit } from './cex.js';
import { buildQuote, fetchMarket, type Quote } from './quote.js';
import { quoteAllVenues, venues as meshVenues, type VenueQuote } from './venues.js';
import { computeLegs, legsFrom, type Leg } from './legs.js';
import { chainHistory, chainPnl, currentPosition, recordHop, type ChainHop, type Position } from './position.js';
import { monitorState, recordTick, type MonitorState } from './recorder.js';
import { readAllBalances, type BalanceSnapshot } from './balances.js';
import {
  allCycles,
  loadSettings,
  saveCycle,
  saveSettings,
  unfinishedCycle,
  type Cycle,
  type CycleState,
  type RouteSettings,
  type SettingsMap,
} from './store.js';

const log = logger('engine');

const WITHDRAW_POLL_MS = 15_000;
const WITHDRAW_TIMEOUT_MS = 30 * 60_000;
const DEPOSIT_POLL_MS = 20_000;
const DEPOSIT_TIMEOUT_MS = 45 * 60_000;
/** Espera depois de um ciclo antes do modo auto poder disparar de novo. */
const AUTO_COOLDOWN_MS = 60_000;

export interface RouteView extends RouteDef {
  settings: RouteSettings;
  quote: Quote | null;
  quoteError: string | null;
}

/** Visão da malha: onde o capital está e para onde dá para ir. */
export interface MeshView {
  position: Position;
  pnl: { profitBrl: number; profitPct: number; hops: number };
  venues: { id: string; label: string; kind: string; quote: VenueQuote | null }[];
  /** Todas as pernas ordenadas, para a matriz completa. */
  legs: Leg[];
  /** Só as que saem da posição atual, já ranqueadas. */
  outgoing: Leg[];
  history: ChainHop[];
}

export interface EngineStatus {
  running: boolean;
  dryRun: boolean;
  walletAddress: string;
  maxAmountBrl: number;
  routes: RouteView[];
  mesh: MeshView | null;
  monitor: MonitorState;
  /** Saldos consolidados de todas as exchanges e da carteira. */
  wallet: BalanceSnapshot | null;
  currentCycle: Cycle | null;
  stuckCycleId: string | null;
  balances: {
    brlBinance: number | null;
    usdtBinance: number | null;
    pol: number | null;
    usdtChain: number | null;
    /** Saldo do ativo de saída de cada rota, indexado por routeId. */
    tokens: Record<string, number | null>;
  };
}

export class Engine extends EventEmitter {
  private settings: SettingsMap;
  private running = false;
  private current: Cycle | null = null;
  private quotes: Record<string, Quote | null> = {};
  private quoteErrors: Record<string, string | null> = {};
  private stuckCycleId: string | null = null;
  private lastCycleEndedAt = 0;
  private quoteTimer: NodeJS.Timeout | null = null;
  private venueQuotes: VenueQuote[] = [];
  private legs: Leg[] = [];
  private wallet: BalanceSnapshot | null = null;
  private balances: EngineStatus['balances'] = {
    brlBinance: null,
    usdtBinance: null,
    pol: null,
    usdtChain: null,
    tokens: {},
  };

  constructor() {
    super();

    const defaults: SettingsMap = {};
    for (const r of routes) {
      defaults[r.id] = {
        autoMode: false,
        minSpreadPct: config.trade.minSpreadPct,
        amountBrl: config.trade.amountBrl,
      };
      this.quotes[r.id] = null;
      this.quoteErrors[r.id] = null;
      this.balances.tokens[r.id] = null;
    }
    this.settings = loadSettings(defaults);

    // Um ciclo interrompido pode ter dinheiro parado no meio do caminho.
    // Nunca retomamos sozinhos — exigimos que o operador confirme.
    const stuck = unfinishedCycle();
    if (stuck) {
      this.stuckCycleId = stuck.id;
      this.disableAllAuto();
      log.warn(
        `Ciclo ${stuck.id} ficou preso em "${stuck.state}". Modo automático bloqueado até você revisar e liberar pelo dashboard.`,
      );
    }
  }

  private disableAllAuto() {
    for (const id of Object.keys(this.settings)) this.settings[id].autoMode = false;
    saveSettings(this.settings);
  }

  // ─── Ciclo de vida ────────────────────────────────────────────────────────

  start() {
    const tick = () => {
      void this.refresh();
    };
    tick();
    this.quoteTimer = setInterval(tick, config.trade.quoteIntervalMs);
  }

  stop() {
    if (this.quoteTimer) clearInterval(this.quoteTimer);
  }

  status(): EngineStatus {
    return {
      running: this.running,
      dryRun: config.dryRun,
      walletAddress,
      maxAmountBrl: config.trade.maxAmountBrl,
      routes: routes.map((r) => ({
        ...r,
        settings: this.settings[r.id],
        quote: this.quotes[r.id] ?? null,
        quoteError: this.quoteErrors[r.id] ?? null,
      })),
      mesh: this.meshView(),
      monitor: monitorState(),
      wallet: this.wallet,
      currentCycle: this.current,
      stuckCycleId: this.stuckCycleId,
      balances: this.balances,
    };
  }

  private meshView(): MeshView {
    const position = currentPosition();
    return {
      position,
      pnl: chainPnl(),
      venues: meshVenues.map((v) => ({
        id: v.id,
        label: v.label,
        kind: v.kind,
        quote: this.venueQuotes.find((q) => q.venueId === v.id) ?? null,
      })),
      legs: this.legs,
      outgoing: legsFrom(this.legs, position.venueId),
      history: chainHistory(),
    };
  }

  /** Registra um pulo simulado usando a cotação da perna neste instante. */
  simulateHop(toId: string): ChainHop {
    const position = currentPosition();
    const leg = this.legs.find((l) => l.fromId === position.venueId && l.toId === toId);
    if (!leg) throw new Error(`sem cotação para ${position.venueId} → ${toId} neste momento`);

    // A perna é cotada para o valor configurado; reescalamos para o saldo real.
    const amountAfter = position.amountBrl * (1 + leg.netPct / 100);

    const hop = recordHop({
      fromId: leg.fromId,
      toId: leg.toId,
      network: leg.network,
      amountAfter,
      expectedNetPct: leg.netPct,
      simulated: true,
      note: leg.networkFeeKnown ? undefined : 'taxa de rede estimada',
    });
    this.emit('status', this.status());
    return hop;
  }

  cycles(): Cycle[] {
    return allCycles();
  }

  updateSettings(routeId: string, patch: Partial<RouteSettings>): RouteSettings {
    const route = routeById(routeId);

    if (patch.amountBrl !== undefined) {
      if (!Number.isFinite(patch.amountBrl) || patch.amountBrl <= 0) {
        throw new Error('Valor por ciclo precisa ser um número positivo');
      }
      if (patch.amountBrl > config.trade.maxAmountBrl) {
        throw new Error(`Valor por ciclo acima do teto de R$ ${config.trade.maxAmountBrl} (MAX_TRADE_AMOUNT_BRL)`);
      }
    }
    if (patch.minSpreadPct !== undefined && !Number.isFinite(patch.minSpreadPct)) {
      throw new Error('Spread mínimo precisa ser numérico');
    }
    if (patch.autoMode) {
      if (this.stuckCycleId) {
        throw new Error('Existe um ciclo pendente de revisão. Libere-o antes de ligar o modo automático.');
      }
      if (!route.enabled) {
        throw new Error(`A rota ${route.short} não tem endereço de destino configurado`);
      }
    }

    this.settings[routeId] = { ...this.settings[routeId], ...patch };
    saveSettings(this.settings);
    log.info(`[${route.short}] configuração: ${JSON.stringify(this.settings[routeId])}`);
    this.emit('status', this.status());
    return this.settings[routeId];
  }

  /** Marca o ciclo travado como falho para desbloquear o bot. */
  acknowledgeStuck(): void {
    const stuck = allCycles().find((c) => c.id === this.stuckCycleId);
    if (stuck) {
      stuck.state = 'failed';
      stuck.finishedAt = Date.now();
      stuck.error = (stuck.error ?? '') + ' [liberado manualmente pelo operador]';
      saveCycle(stuck);
    }
    this.stuckCycleId = null;
    log.info('ciclo travado liberado — modo automático pode ser reativado');
    this.emit('status', this.status());
  }

  // ─── Cotação periódica ────────────────────────────────────────────────────

  private async refresh() {
    try {
      // Um snapshot de mercado serve todas as rotas: mesmo livro, mesmo gás.
      const market = await fetchMarket();

      await Promise.all(
        routes.map(async (r) => {
          try {
            this.quotes[r.id] = await buildQuote(r, this.settings[r.id].amountBrl, market);
            this.quoteErrors[r.id] = null;
          } catch (e) {
            this.quoteErrors[r.id] = (e as Error).message;
          }
        }),
      );
    } catch (e) {
      const msg = (e as Error).message;
      for (const r of routes) this.quoteErrors[r.id] = msg;
      log.warn(`falha ao buscar dados de mercado: ${msg}`);
    }

    await this.refreshMesh();
    await this.refreshBalances();
    await this.refreshWallet();
    this.emit('status', this.status());

    const candidate = this.autoCandidate();
    if (candidate) {
      const q = this.quotes[candidate.id]!;
      log.success(
        `[${candidate.short}] gatilho automático: spread ${q.spreadPct.toFixed(3)}% >= ${this.settings[candidate.id].minSpreadPct}%`,
      );
      void this.runCycle(candidate.id, 'auto').catch((e) =>
        log.error(`ciclo automático falhou: ${(e as Error).message}`),
      );
    }
  }

  /** Entre as rotas que bateram o alvo, escolhe a de maior spread. */
  private autoCandidate(): RouteDef | null {
    if (this.running || this.stuckCycleId) return null;
    if (Date.now() - this.lastCycleEndedAt < AUTO_COOLDOWN_MS) return null;

    const eligible = routes.filter((r) => {
      const s = this.settings[r.id];
      const q = this.quotes[r.id];
      return r.enabled && s.autoMode && q && q.spreadPct >= s.minSpreadPct;
    });

    if (!eligible.length) return null;
    return eligible.sort((a, b) => this.quotes[b.id]!.spreadPct - this.quotes[a.id]!.spreadPct)[0];
  }

  /**
   * Cota os 7 venues e monta a matriz de pernas. É o que permite ver as saídas
   * de onde o capital está, e não só as rotas que partem da Binance.
   */
  private async refreshMesh() {
    try {
      // Valor FIXO, não o saldo da posição: spreads cotados com valores
      // diferentes percorrem profundidades diferentes do livro, e registros
      // com base móvel não são comparáveis entre si ao longo dos dias.
      const amountBrl = config.monitor.referenceBrl;

      // Tamanho de referência em USDT: todos os venues cotam a venda do mesmo
      // volume, o que mantém a matriz comparável com O(n) chamadas.
      const refAsk = this.venueQuotes.find((q) => q.ok && q.venueId === 'binance')?.effAsk ?? 5.15;
      const usdtSize = amountBrl / refAsk;

      this.venueQuotes = await quoteAllVenues(amountBrl, usdtSize);

      // Gás de uma perna on-chain (swap + transferência) convertido para BRL.
      const dexQuote = Object.values(this.quotes).find((q) => q?.kind === 'dex') ?? null;
      const gasBrl = dexQuote?.gasBrl ?? 0;

      this.legs = await computeLegs({ quotes: this.venueQuotes, amountBrl, gasBrl });

      // Grava a coleta, se a gravação estiver ligada. Fica aqui de propósito:
      // é exatamente a mesma cotação que o painel mostra, sem recalcular nada.
      recordTick({
        quotes: this.venueQuotes,
        legs: this.legs,
        gasBrl,
        polUsdt: dexQuote ? dexQuote.polPriceBrl / (dexQuote.usdtBrlBinance || 1) : 0,
        usdtBrlRef: this.venueQuotes.find((q) => q.ok && q.venueId === 'binance')?.effAsk ?? 0,
      });
    } catch (e) {
      log.warn(`falha ao montar a malha: ${(e as Error).message}`);
    }
  }

  /**
   * Saldos de todas as exchanges e da carteira, com patrimônio total.
   * Roda depois da malha para reaproveitar a cotação de USDT/BRL do tick.
   */
  private async refreshWallet() {
    try {
      const usdtBrl = this.venueQuotes.find((q) => q.ok && q.venueId === 'binance')?.effAsk ?? 0;
      if (!usdtBrl) return;

      const dexQuote = Object.values(this.quotes).find((q) => q?.kind === 'dex') ?? null;
      const polBrl = dexQuote?.polPriceBrl ?? 0;

      this.wallet = await readAllBalances(usdtBrl, polBrl);
    } catch (e) {
      log.warn(`falha ao consolidar saldos: ${(e as Error).message}`);
    }
  }

  private async refreshBalances() {
    const next: EngineStatus['balances'] = { ...this.balances, tokens: { ...this.balances.tokens } };

    if (config.binance.apiKey && config.binance.apiSecret) {
      try {
        const b = await binance.balances();
        next.brlBinance = b.BRL ?? 0;
        next.usdtBinance = b.USDT ?? 0;
      } catch (e) {
        log.warn(`não consegui ler saldos da Binance: ${(e as Error).message}`);
      }
    }

    const dexRoutes = routes.filter((r) => r.kind === 'dex');
    try {
      const [pol, usdt, ...tokens] = await Promise.all([
        nativeBalance(),
        tokenBalance(config.tokens.usdt),
        ...dexRoutes.map((r) => tokenBalance(r.token!)),
      ]);
      next.pol = pol.formatted;
      next.usdtChain = usdt.formatted;
      dexRoutes.forEach((r, i) => {
        next.tokens[r.id] = tokens[i].formatted;
      });
    } catch (e) {
      log.warn(`não consegui ler saldos on-chain: ${(e as Error).message}`);
    }

    for (const r of routes) {
      if (r.kind !== 'cex' || !hasCredentials(r.exchange!)) continue;
      try {
        next.tokens[r.id] = await freeUsdt(cexPrivate(r.exchange!));
      } catch (e) {
        log.warn(`não consegui ler saldo da ${r.venue}: ${(e as Error).message}`);
      }
    }

    this.balances = next;
  }

  // ─── Execução do ciclo ────────────────────────────────────────────────────

  private setState(cycle: Cycle, state: CycleState) {
    cycle.state = state;
    saveCycle(cycle);
    this.emit('status', this.status());
    log.info(`ciclo ${cycle.id.slice(0, 8)} -> ${state}`);
  }

  private async preflight(route: RouteDef, amountBrl: number, quote: Quote) {
    if (amountBrl > config.trade.maxAmountBrl) {
      throw new Error(`Valor R$ ${amountBrl} acima do teto MAX_TRADE_AMOUNT_BRL (R$ ${config.trade.maxAmountBrl})`);
    }
    if (!route.enabled) {
      throw new Error(`A rota ${route.short} → ${route.venue} não tem endereço de destino configurado`);
    }
    if (config.dryRun) return;

    if (!config.binance.apiKey || !config.binance.apiSecret) throw new Error('Credenciais da Binance ausentes');

    const bal = await binance.balances();
    const brl = bal.BRL ?? 0;
    if (brl < amountBrl) {
      throw new Error(`Saldo BRL na Binance insuficiente: R$ ${brl.toFixed(2)} < R$ ${amountBrl.toFixed(2)}`);
    }

    const net = await binance.networkInfo(route.network);
    if (!net.withdrawEnable) {
      throw new Error(`Saque de ${config.binance.withdrawCoin} na rede ${net.network} está desabilitado agora`);
    }

    // Folga de 20%: a compra sofre taxa de negociação e o preço pode variar
    // entre a cotação e a execução. Sem margem, um valor "no limite" passa
    // aqui e falha no saque de verdade, com o USDT já comprado e parado.
    const minWithdrawBrl = (net.withdrawMin * 1.2) * quote.avgPriceBrl;
    if (amountBrl < minWithdrawBrl) {
      throw new Error(
        `Valor R$ ${amountBrl.toFixed(2)} abaixo do mínimo prático para essa rota: ` +
          `a Binance exige saque mínimo de ${net.withdrawMin} ${config.binance.withdrawCoin} na rede ${net.network} ` +
          `(~R$ ${minWithdrawBrl.toFixed(2)} com margem). Aumente o valor do ciclo.`,
      );
    }

    if (route.kind === 'dex') {
      if (!config.chain.privateKey) throw new Error('POLYGON_PRIVATE_KEY não configurada');

      // Gás para approve + swap + transfer, com folga de 100%.
      const pol = await nativeBalance();
      const needed = quote.gasNative * 2;
      if (pol.formatted < needed) {
        throw new Error(
          `POL insuficiente para gás: ${pol.formatted.toFixed(4)} < ${needed.toFixed(4)} necessários. Recarregue ${walletAddress}.`,
        );
      }
    } else {
      const prefix = route.exchange!.toUpperCase();
      if (!hasCredentials(route.exchange!)) {
        throw new Error(`Credenciais da ${route.venue} ausentes (${prefix}_API_KEY / ${prefix}_API_SECRET / ${prefix}_PASSWORD)`);
      }
    }
  }

  async runCycle(routeId: string, trigger: 'manual' | 'auto'): Promise<Cycle> {
    if (this.running) throw new Error('Já existe um ciclo em execução');
    if (this.stuckCycleId) throw new Error('Existe um ciclo pendente de revisão — libere-o antes de rodar outro');

    const route = routeById(routeId);
    this.running = true;
    const amountBrl = this.settings[routeId].amountBrl;

    try {
      const market = await fetchMarket();
      const quote = await buildQuote(route, amountBrl, market);
      await this.preflight(route, amountBrl, quote);

      const cycle: Cycle = {
        id: randomUUID(),
        routeId,
        dryRun: config.dryRun,
        state: 'pending',
        startedAt: Date.now(),
        amountBrl,
        quoteAtStart: quote,
        trigger,
        actual: {},
        txs: [],
      };
      saveCycle(cycle);
      this.current = cycle;
      this.emit('status', this.status());

      log.success(
        `[${route.short}] iniciando ciclo ${cycle.id.slice(0, 8)} — R$ ${amountBrl} com spread previsto de ${quote.spreadPct.toFixed(3)}% (lucro R$ ${quote.profitBrl.toFixed(2)})`,
      );

      await this.executeSteps(cycle, route, quote);

      cycle.state = 'completed';
      cycle.finishedAt = Date.now();
      saveCycle(cycle);
      log.success(
        `[${route.short}] ciclo ${cycle.id.slice(0, 8)} concluído — lucro realizado R$ ${(cycle.actual.profitBrl ?? 0).toFixed(2)} (${(cycle.actual.spreadPct ?? 0).toFixed(3)}%)`,
      );
      return cycle;
    } catch (e) {
      const msg = (e as Error).message;
      if (this.current) {
        this.current.state = 'failed';
        this.current.finishedAt = Date.now();
        this.current.error = msg;
        saveCycle(this.current);
        // Falha depois da compra significa fundos parados em algum ponto do
        // caminho — em simulação não há nada em trânsito para travar o bot.
        if (!config.dryRun && this.current.actual.spentBrl !== undefined) {
          this.stuckCycleId = this.current.id;
          this.disableAllAuto();
          log.error(
            `ciclo interrompido com fundos em trânsito. Verifique manualmente Binance e ${walletAddress} antes de continuar.`,
          );
        }
      }
      log.error(`ciclo falhou: ${msg}`);
      throw e;
    } finally {
      this.running = false;
      this.lastCycleEndedAt = Date.now();
      this.current = this.current?.state === 'completed' || this.current?.state === 'failed' ? null : this.current;
      this.emit('status', this.status());
    }
  }

  private executeSteps(cycle: Cycle, route: RouteDef, quote: Quote): Promise<void> {
    return route.kind === 'cex'
      ? this.executeCexSteps(cycle, route, quote)
      : this.executeDexSteps(cycle, route, quote);
  }

  /**
   * Rota CEX → CEX. Porte fiel do bot Python `binance_arb_bep20.py`:
   * compra a mercado por quantidade calculada sobre o ask, saca pela rede
   * configurada, espera o saldo aparecer no destino e vende com ordens LIMIT
   * reprecificadas no melhor bid. Ver src/cex.ts.
   */
  private async executeCexSteps(cycle: Cycle, route: RouteDef, quote: Quote) {
    const symbol = route.symbol!;

    // ── 1. Compra na Binance ──────────────────────────────────────────────
    this.setState(cycle, 'buying');

    if (config.dryRun) {
      cycle.actual.spentBrl = cycle.amountBrl;
      cycle.actual.usdtBought = quote.usdtAfterTradeFee;
      log.info(`[DRY_RUN] compraria ~${quote.usdtGross.toFixed(2)} USDT por R$ ${cycle.amountBrl}`);
    }

    const bnc = config.dryRun ? null : binanceCcxt(true);
    const dest = config.dryRun ? null : cexPrivate(route.exchange!);

    let amountUsdt = quote.usdtGross;
    let buyPrice = quote.avgPriceBrl;

    if (bnc) {
      // Como no original: quantidade derivada do ask, ordem a mercado por quantidade.
      buyPrice = (await bnc.fetchTicker(symbol)).ask as number;
      amountUsdt = cycle.amountBrl / buyPrice;

      log.info(`Utilizando R$ ${cycle.amountBrl.toFixed(2)} para comprar ~${amountUsdt.toFixed(2)} USDT...`);
      const order = await bnc.createMarketBuyOrder(symbol, amountUsdt);
      log.success('Compra concluída!');

      // O custo real da ordem, não o valor pedido: uma ordem a mercado por
      // quantidade gasta o que o livro cobrar, e o lucro é medido sobre isso.
      const cost = (order.cost as number) || cycle.amountBrl;
      const filled = (order.filled as number) || amountUsdt;
      cycle.actual.spentBrl = cost;
      cycle.actual.usdtBought = filled;
      amountUsdt = filled;
      buyPrice = filled > 0 ? cost / filled : buyPrice;

      await new Promise((r) => setTimeout(r, 2000));
    }
    saveCycle(cycle);

    // ── 2. Saque para a exchange de destino ───────────────────────────────
    this.setState(cycle, 'withdrawing');
    let withdrawAmount = amountUsdt;
    let initialBalance = 0;

    if (bnc && dest) {
      const usdtBalance = await freeUsdt(bnc);
      withdrawAmount = Math.min(amountUsdt, usdtBalance);

      log.info(`Sacando ${withdrawAmount.toFixed(2)} USDT para ${route.venue}... via rede ${route.network}`);
      await bnc.withdraw('USDT', withdrawAmount, route.destination, undefined, { network: route.network });
      log.info(`Saque enviado. Monitorando saldo na ${route.venue}...`);

      initialBalance = await freeUsdt(dest);
    } else {
      log.info(`[DRY_RUN] sacaria ${withdrawAmount.toFixed(2)} USDT para ${route.destination} via ${route.network}`);
    }
    cycle.actual.usdtWithdrawn = withdrawAmount;
    saveCycle(cycle);

    // ── 3. Chegada na exchange de destino ─────────────────────────────────
    this.setState(cycle, 'awaiting_deposit');
    if (dest) {
      await waitForCexDeposit(dest, initialBalance, withdrawAmount);
      log.success(`USDT recebido na ${route.venue}!`);
    } else {
      log.info(`[DRY_RUN] ${quote.usdtOnChain.toFixed(2)} USDT teriam chegado na ${route.venue}`);
      cycle.actual.usdtReceivedOnChain = quote.usdtOnChain;
    }

    // ── 4. Venda no destino ───────────────────────────────────────────────
    this.setState(cycle, 'selling');
    let soldUsdt: number;
    let sellPrice: number;

    if (dest) {
      log.info(`Verificando saldo final na ${route.venue} para venda...`);
      const finalBalance = await freeUsdt(dest);

      // Vende só o que ESTE ciclo trouxe, não o saldo inteiro da conta.
      // O bot original assumia uma conta dedicada; aqui um saldo pré-existente
      // (de um ciclo anterior que falhou, ou dinheiro seu) seria vendido junto
      // sem você ter pedido.
      const arrived = finalBalance - initialBalance;
      const preExisting = finalBalance - arrived;
      if (preExisting > 1) {
        log.warn(
          `há ${preExisting.toFixed(2)} USDT na ${route.venue} que não vieram deste ciclo — ` +
            `serão preservados, o bot vende apenas os ${arrived.toFixed(2)} que chegaram`,
        );
      }

      // Arredonda para baixo em duas casas para evitar rejeição da API
      const sellAmountTruncated = Math.floor(Math.min(arrived, finalBalance) * 100) / 100;

      if (sellAmountTruncated <= 0) {
        throw new Error(`Saldo disponível para venda na ${route.venue} é insignificante ou zero`);
      }

      log.info(
        `Vendendo ${sellAmountTruncated} USDT por BRL na ${route.venue} (ordens LIMIT reprecificadas no melhor bid)...`,
      );
      const result = await sellAtBestBid(dest, symbol, sellAmountTruncated);

      if (result.usedMarketFallback) {
        log.warn('Aviso: parte da venda usou fallback a mercado (limite de tentativas limit atingido).');
      }

      soldUsdt = result.soldUsdt;
      sellPrice = result.avgSellPrice;
      cycle.actual.usedMarketFallback = result.usedMarketFallback;
      // O que chegou de fato, para o histórico bater com a realidade.
      cycle.actual.usdtReceivedOnChain = arrived;
    } else {
      soldUsdt = quote.usdtOnChain;
      sellPrice = quote.tokenPerUsdt;
      log.info(`[DRY_RUN] venderia ${soldUsdt.toFixed(2)} USDT a R$ ${sellPrice.toFixed(4)}`);
    }

    const retornoBrl = soldUsdt * sellPrice;
    const spent = cycle.actual.spentBrl ?? cycle.amountBrl;
    const venueFee = route.fees.flatBrl + retornoBrl * (route.fees.pct / 100);
    const netBrl = retornoBrl - venueFee;

    cycle.actual.tokenReceived = retornoBrl;
    cycle.actual.avgSellPrice = sellPrice;
    cycle.actual.gasNative = 0;
    cycle.actual.netBrl = netBrl;
    cycle.actual.profitBrl = netBrl - spent;
    cycle.actual.spreadPct = (netBrl / spent - 1) * 100;
    saveCycle(cycle);

    log.success(`>> Lucro/Prejuízo da operação: R$ ${cycle.actual.profitBrl.toFixed(2)}`);
    log.info(`>> AÇÃO: O dinheiro está em BRL na ${route.venue}. Faça o saque via PIX manualmente.`);
  }

  private async executeDexSteps(cycle: Cycle, route: RouteDef, quote: Quote) {
    const token = route.token!;

    // ── 1. Compra USDT com BRL ────────────────────────────────────────────
    this.setState(cycle, 'buying');
    let usdtBought: number;
    if (config.dryRun) {
      usdtBought = quote.usdtAfterTradeFee;
      cycle.actual.spentBrl = cycle.amountBrl;
      log.info(`[DRY_RUN] compraria ${usdtBought.toFixed(4)} USDT por R$ ${cycle.amountBrl}`);
    } else {
      const buy = await binance.marketBuyWithQuote(cycle.amountBrl);
      usdtBought = buy.netUsdt;
      cycle.actual.spentBrl = buy.spentBrl;
      log.success(`comprados ${usdtBought.toFixed(4)} USDT a R$ ${buy.avgPrice.toFixed(4)} (ordem ${buy.orderId})`);

      // A ordem sai como FILLED antes de o saldo ficar sacável. Sem esta
      // espera o saque pede um valor que ainda não está disponível e a
      // Binance responde -4026 "insufficient balance".
      await new Promise((r) => setTimeout(r, 2000));
    }
    cycle.actual.usdtBought = usdtBought;
    saveCycle(cycle);

    // ── 2. Saque para a Polygon ───────────────────────────────────────────
    this.setState(cycle, 'withdrawing');
    // Baseline lido ANTES do saque: é a referência para detectar a chegada.
    const usdtBaseline = config.dryRun ? 0n : (await tokenBalance(config.tokens.usdt)).raw;
    const withdrawFee = quote.withdrawFeeUsdt;

    // O saldo livre é a fonte da verdade, não o que a ordem disse ter rendido:
    // comissão em USDT, poeira de operações anteriores e arredondamento fazem
    // os dois números divergirem. Sacar mais do que existe derruba o ciclo.
    let available = usdtBought;
    if (!config.dryRun) {
      const free = (await binance.balances()).USDT ?? 0;
      available = Math.min(usdtBought, free);
      if (available < usdtBought) {
        log.warn(`saldo livre (${free.toFixed(6)}) menor que o comprado (${usdtBought.toFixed(6)}) — sacando o disponível`);
      }
    }

    // A Binance debita `amount` do saldo e entrega `amount - fee` on-chain.
    const withdrawAmount = Math.floor(available * 1e6) / 1e6;
    const expectedOnChain = withdrawAmount - withdrawFee;

    if (expectedOnChain <= 0) {
      throw new Error(`Taxa de saque (${withdrawFee} USDT) consome tudo que foi comprado`);
    }

    if (config.dryRun) {
      log.info(`[DRY_RUN] sacaria ${withdrawAmount} USDT para ${walletAddress} (chegariam ${expectedOnChain})`);
      cycle.actual.withdrawId = 'dryrun';
    } else {
      const id = await binance.withdraw(walletAddress, withdrawAmount, cycle.id.replace(/-/g, '').slice(0, 32));
      cycle.actual.withdrawId = id;
      saveCycle(cycle);
      log.info(`saque ${id} solicitado — aguardando chegada na carteira`);

      // A chegada on-chain é o sinal de sucesso; a Binance só é consultada
      // para abortar cedo se o saque for recusado.
      const alvoRaw = usdtBaseline + (await toRaw(config.tokens.usdt, expectedOnChain * 0.98));
      await this.awaitWithdrawal(cycle, id, async () => (await tokenBalance(config.tokens.usdt)).raw >= alvoRaw);
    }
    cycle.actual.usdtWithdrawn = withdrawAmount;
    saveCycle(cycle);

    // ── 3. Chegada na carteira ────────────────────────────────────────────
    this.setState(cycle, 'awaiting_deposit');
    let usdtOnChainRaw: bigint;
    if (config.dryRun) {
      usdtOnChainRaw = await toRaw(config.tokens.usdt, expectedOnChain);
      log.info(`[DRY_RUN] ${expectedOnChain.toFixed(4)} USDT teriam chegado`);
    } else {
      // 2% de tolerância: a taxa real pode diferir da cotada.
      const minIncrease = await toRaw(config.tokens.usdt, expectedOnChain * 0.98);
      const after = await waitForBalanceIncrease(config.tokens.usdt, usdtBaseline, minIncrease, {
        timeoutMs: DEPOSIT_TIMEOUT_MS,
        pollMs: DEPOSIT_POLL_MS,
      });
      usdtOnChainRaw = after - usdtBaseline;
      log.success(`recebidos ${await fromRaw(config.tokens.usdt, usdtOnChainRaw)} USDT na Polygon`);
    }
    cycle.actual.usdtReceivedOnChain = await fromRaw(config.tokens.usdt, usdtOnChainRaw);
    saveCycle(cycle);

    // ── 4. Rota + allowance ───────────────────────────────────────────────
    this.setState(cycle, 'approving');
    const kyber = await getRoute(config.tokens.usdt, token,usdtOnChainRaw, walletAddress);

    // A allowance tem que existir ANTES do /route/build: aquele endpoint simula
    // a transação para estimar gás e reverte com TRANSFER_FROM_FAILED sem ela.
    let gasSpent = 0;
    const approveTx = await ensureAllowance(config.tokens.usdt, kyber.routerAddress, usdtOnChainRaw);
    if (approveTx) {
      gasSpent += approveTx.costNative;
      cycle.txs.push({ label: 'approve', hash: approveTx.hash });
      saveCycle(cycle);
    }

    const built = await buildRoute(kyber, walletAddress, walletAddress, config.trade.slippageBps);

    // ── 5. Swap USDT -> token ─────────────────────────────────────────────
    this.setState(cycle, 'swapping');
    const tokenBefore = config.dryRun ? 0n : (await tokenBalance(token)).raw;
    let tokenReceivedRaw: bigint;

    if (config.dryRun) {
      tokenReceivedRaw = built.amountOutRaw;
      log.info(`[DRY_RUN] swap renderia ${await fromRaw(token,tokenReceivedRaw)} ${route.short}`);
    } else {
      const gasLimit = built.gas > 0n ? (built.gas * 130n) / 100n : undefined;
      const swapTx = await sendRawSwap(built.routerAddress, built.data, built.transactionValue, gasLimit);
      gasSpent += swapTx.costNative;
      cycle.txs.push({ label: 'swap', hash: swapTx.hash });

      const tokenAfter = (await tokenBalance(token)).raw;
      tokenReceivedRaw = tokenAfter - tokenBefore;

      if (tokenReceivedRaw < built.amountOutMinRaw) {
        const dec = (await fromRaw(token,built.amountOutMinRaw)).toString();
        throw new Error(
          `Swap entregou menos que o mínimo aceito: ${await fromRaw(token,tokenReceivedRaw)} < ${dec} ${route.short}`,
        );
      }
      log.success(`swap concluído: ${await fromRaw(token,tokenReceivedRaw)} ${route.short}`);
    }
    cycle.actual.tokenReceived = await fromRaw(token,tokenReceivedRaw);
    saveCycle(cycle);

    // ── 6. Envio para a plataforma de saque ───────────────────────────────
    this.setState(cycle, 'transferring');
    if (!route.destination) throw new Error(`Endereço de destino da rota ${route.short} não configurado`);

    if (config.dryRun) {
      log.info(`[DRY_RUN] enviaria ${cycle.actual.tokenReceived} ${route.short} para ${route.destination}`);
    } else {
      const transferTx = await transferToken(token,route.destination, tokenReceivedRaw);
      gasSpent += transferTx.costNative;
      cycle.txs.push({ label: 'transfer', hash: transferTx.hash });
      log.success(`${route.short} enviado para a ${route.venue}: ${transferTx.hash}`);
    }

    // ── Resultado realizado ───────────────────────────────────────────────
    const gasNative = config.dryRun ? quote.gasNative : gasSpent;
    const gasBrl = gasNative * quote.polPriceBrl;
    const tokenReceived = cycle.actual.tokenReceived ?? 0;
    const venueFee = route.fees.flatBrl + tokenReceived * (route.fees.pct / 100);
    const netBrl = tokenReceived - gasBrl - venueFee;
    const spent = cycle.actual.spentBrl ?? cycle.amountBrl;

    cycle.actual.gasNative = gasNative;
    cycle.actual.netBrl = netBrl;
    cycle.actual.profitBrl = netBrl - spent;
    cycle.actual.spreadPct = (netBrl / spent - 1) * 100;
    saveCycle(cycle);
  }

  /** Aguarda o saque sair do status de processamento na Binance. */
  /**
   * Acompanha o saque até ele estar utilizável, e não até a Binance carimbar
   * "completed".
   *
   * A diferença importa: na Polygon a Binance só marca `completed` depois de
   * 200 confirmações (~7 min), mas o USDT já está gastável na carteira com 1.
   * Esperar o carimbo desperdiça minutos com o dinheiro parado e ainda arrisca
   * estourar o timeout à toa.
   *
   * Então: sucesso é a chegada on-chain; a consulta à Binance serve só para
   * abortar cedo se o saque for cancelado ou rejeitado, que é a única
   * informação que ela adiciona.
   */
  private async awaitWithdrawal(cycle: Cycle, withdrawId: string, hasArrived: () => Promise<boolean>) {
    const deadline = Date.now() + WITHDRAW_TIMEOUT_MS;
    const since = cycle.startedAt - 60_000;
    let carimbado = false;

    while (Date.now() < deadline) {
      if (await hasArrived()) {
        log.success(`saque ${withdrawId} chegou na carteira`);
        return;
      }

      await new Promise((r) => setTimeout(r, WITHDRAW_POLL_MS));

      const rec = (await binance.withdrawHistory(since)).find((h) => h.id === withdrawId);
      if (!rec) continue;

      if (rec.status === 'cancelled' || rec.status === 'rejected' || rec.status === 'failure') {
        throw new Error(`Saque ${withdrawId} terminou com status "${rec.status}" na Binance`);
      }

      if (rec.txId && !cycle.txs.some((t) => t.hash === rec.txId)) {
        cycle.txs.push({ label: 'saque Binance', hash: rec.txId });
        saveCycle(cycle);
      }

      // Se a Binance carimbar antes da chegada aparecer, seguimos: o passo
      // seguinte confirma o saldo de qualquer forma.
      if (rec.status === 'completed' && !carimbado) {
        carimbado = true;
        log.success(`saque ${withdrawId} concluído pela Binance`);
        return;
      }
    }

    throw new Error(`Timeout de ${WITHDRAW_TIMEOUT_MS / 60000} min aguardando o saque ${withdrawId} chegar`);
  }
}

export const engine = new Engine();
