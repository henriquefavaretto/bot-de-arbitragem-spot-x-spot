const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

const brl = (v) =>
  v == null || !isFinite(v) ? '—' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const n = (v, d = 4) =>
  v == null || !isFinite(v) ? '—' : v.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v, d = 4) => (v == null || !isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${n(v, d)}%`);
const signedBrl = (v) => (v == null || !isFinite(v) ? '—' : (v >= 0 ? '+' : '') + brl(v));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** @type {import('./types').EngineStatus | null} */
let state = null;
let view = 'oportunidades';
let activeRouteId = null;
let lastQuoteTs = 0;

// ═══ Conexão ══════════════════════════════════════════════════════

function connect() {
  const es = new EventSource('/api/stream');
  es.addEventListener('open', () => setConn(true));
  es.addEventListener('status', (e) => render(JSON.parse(e.data)));
  es.addEventListener('log', (e) => appendLog(JSON.parse(e.data)));
  es.addEventListener('error', () => setConn(false));
}

function setConn(on) {
  $('#conn-dot').classList.toggle('on', on);
  $('#conn-text').textContent = on ? 'ao vivo' : 'reconectando';
}

// ═══ Render raiz ══════════════════════════════════════════════════

function render(s) {
  const first = state === null;
  state = s;

  const tag = $('#mode-tag');
  tag.textContent = s.dryRun ? 'simulação' : 'modo real';
  tag.className = `mode-tag ${s.dryRun ? 'sim' : 'live'}`;

  $('#banner-stuck').classList.toggle('hidden', !s.stuckCycleId);

  const q0 = s.routes.find((r) => r.quote)?.quote;
  if (q0) lastQuoteTs = q0.ts;
  if (first && q0) $('#sim-amount').value = q0.amountBrl;
  else if (first) $('#sim-amount').value = s.routes[0]?.settings.amountBrl ?? 1000;

  renderWalletBar(s);
  renderSidebarRoutes(s);
  renderTopbar(s);
  renderCurrentView(s);
}

// ═══ Barra de saldos ══════════════════════════════════════════════

function renderWalletBar(s) {
  const host = $('#wallet-bar');
  const w = s.wallet;

  if (!w) {
    host.innerHTML = '<div class="wb-loading">lendo saldos…</div>';
    return;
  }

  const parcial = w.ok < w.total;

  const chips = w.venues
    .map((v) => {
      if (!v.ok) {
        return `<div class="wb-chip wb-off" title="${esc(v.error ?? 'indisponível')}">
          <span class="wb-name">${esc(v.label)}</span>
          <span class="wb-val">—</span>
        </div>`;
      }

      // Mostra só o que existe: zerar a tela com linhas de 0,00 atrapalha.
      const partes = [];
      if (v.brl > 0.005) partes.push(`<b>${brl(v.brl)}</b>`);
      if (v.usdt > 0.005) partes.push(`<b>${n(v.usdt, 2)}</b> <i>USDT</i>`);
      for (const e of v.extras ?? []) {
        if (e.symbol === 'POL' && e.amount > 0.0001) partes.push(`<b>${n(e.amount, 2)}</b> <i>POL</i>`);
      }

      return `<div class="wb-chip" title="total ${brl(v.totalBrl)}">
        <span class="wb-name">${esc(v.label)}</span>
        <span class="wb-val">${partes.join('<em>·</em>') || '<span class="wb-zero">vazio</span>'}</span>
      </div>`;
    })
    .join('');

  host.innerHTML = `
    <div class="wb-chips">${chips}</div>
    <div class="wb-total ${parcial ? 'wb-partial' : ''}" title="${parcial ? `${w.ok} de ${w.total} venues responderam` : 'todos os venues responderam'}">
      <span class="wb-total-label">patrimônio${parcial ? ` · parcial ${w.ok}/${w.total}` : ''}</span>
      <span class="wb-total-val">${brl(w.patrimonioBrl)}</span>
    </div>`;
}

function renderSidebarRoutes(s) {
  $('#nav-routes').innerHTML = s.routes
    .map(
      (r) => `<button class="nav-item ${view === 'rota' && activeRouteId === r.id ? 'active' : ''}"
        data-view="rota" data-route="${r.id}">
        <i data-ico="route"></i>${esc(r.short)} · ${esc(r.venue)}
        ${r.settings.autoMode ? '<span class="auto-pip">auto</span>' : ''}
      </button>`,
    )
    .join('');
}

function renderTopbar(s) {
  const titles = { oportunidades: 'oportunidades', malha: 'malha', historico: 'histórico', config: 'configurações' };

  if (view === 'rota') {
    const r = s.routes.find((x) => x.id === activeRouteId);
    $('#head-count').textContent = '';
    $('#head-title').textContent = `${r.short.toLowerCase()} · ${r.venue.toLowerCase()}`;
    $('#head-sub').textContent = r.enabled ? '' : 'sem endereço de destino';
    $('#head-meta').textContent = r.quote ? `impacto ${n(r.quote.priceImpactPct, 3)}%` : 'sem cotação';
  } else {
    const viable = s.routes.filter((r) => r.quote && r.enabled && r.quote.spreadPct >= r.settings.minSpreadPct);
    const goodLegs = s.mesh?.outgoing.filter((l) => l.netPct > 0).length ?? 0;

    $('#head-count').textContent =
      view === 'oportunidades' ? String(viable.length).padStart(2, '0')
      : view === 'malha' ? String(goodLegs).padStart(2, '0')
      : '';
    $('#head-title').textContent = titles[view];
    $('#head-sub').textContent = '';
    $('#head-meta').textContent =
      view === 'oportunidades' ? `${viable.length} de ${s.routes.length} rotas viáveis`
      : view === 'malha' ? `${goodLegs} saídas positivas de ${s.mesh?.outgoing.length ?? 0}`
      : `teto ${brl(s.maxAmountBrl)}`;
  }

  $$('.nav-item').forEach((b) => {
    const match = b.dataset.view === view && (b.dataset.view !== 'rota' || b.dataset.route === activeRouteId);
    b.classList.toggle('active', match);
  });
  $$('.view').forEach((sec) => sec.classList.toggle('hidden', sec.dataset.view !== view));
}

function renderCurrentView(s) {
  if (view === 'oportunidades') renderOpportunities(s);
  else if (view === 'malha') renderMesh(s);
  else if (view === 'rota') renderRouteDetail(s);
  else if (view === 'historico') void renderHistory();
  else if (view === 'config') renderConfig(s);
}

// ═══ Malha ════════════════════════════════════════════════════════

const venueName = (s, id) => s.mesh?.venues.find((v) => v.id === id)?.label ?? id;

function renderMesh(s) {
  const m = s.mesh;
  const host = $('#mesh');
  if (!m) {
    host.innerHTML = '<div class="empty-state">aguardando primeira cotação da malha…</div>';
    return;
  }

  const pos = m.position;
  const since = new Date(pos.since).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

  const options = m.venues
    .map((v) => `<option value="${v.id}" ${v.id === pos.venueId ? 'selected' : ''}>${esc(v.label)}</option>`)
    .join('');

  host.innerHTML = `<div class="detail-grid">
    <div>
      <div class="card-hero panel">
        <div class="hero-label">capital está em</div>
        <div class="hero-row">
          <div>
            <div class="hero-value" style="font-size:34px">${esc(venueName(s, pos.venueId))}</div>
            <div class="hint">parado desde ${since}</div>
          </div>
          <div class="hero-side">
            <div class="hero-side-label">saldo</div>
            <div class="hero-side-value">${brl(pos.amountBrl)}</div>
            <div class="hero-side-sub ${m.pnl.profitBrl >= 0 ? 'pos' : 'neg'}">
              ${signedBrl(m.pnl.profitBrl)} · ${pct(m.pnl.profitPct, 3)} · ${m.pnl.hops} pulos
            </div>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head">
          <h2>saídas a partir daqui</h2>
          <span class="tool-static">${m.outgoing.length} pernas</span>
        </div>
        ${legTable(s, m.outgoing, true)}
      </div>

      <div class="panel">
        <div class="panel-head">
          <h2>matriz completa</h2>
          <span class="tool-static">${m.legs.length} de ${m.venues.length * (m.venues.length - 1)} pernas</span>
        </div>
        ${legTable(s, [...m.legs].sort((a, b) => b.netPct - a.netPct).slice(0, 15), false)}
      </div>
    </div>

    <div>
      <div class="panel">
        <div class="panel-head"><h2>posição</h2></div>
        <label class="field"><span>onde está o capital</span>
          <select id="pos-venue" class="field-select">${options}</select>
        </label>
        <label class="field"><span>saldo (R$)</span>
          <input id="pos-amount" type="number" min="1" step="10" value="${pos.amountBrl.toFixed(2)}">
        </label>
        <button class="btn btn-ghost btn-sm" id="btn-set-pos" style="width:100%">Definir posição</button>
        <p class="hint">Definir a posição reinicia a contagem de lucro da cadeia.</p>
        <button class="btn btn-ghost btn-sm" id="btn-reset-chain" style="width:100%;margin-top:8px">Zerar histórico</button>
      </div>

      ${monitorPanel(s)}

      <div class="panel">
        <div class="panel-head"><h2>cotação dos venues</h2></div>
        <div class="stat-list">
          ${m.venues
            .map((v) => {
              const q = v.quote;
              const val = q?.ok ? `${n(q.effAsk, 4)} / ${n(q.effBid, 4)}` : '—';
              return `<div class="row"><span class="k">${esc(v.label)}</span><span class="v ${q?.ok ? '' : 'low'}">${val}</span></div>`;
            })
            .join('')}
        </div>
        <p class="hint">ask / bid em BRL por USDT, já com a profundidade do livro.</p>
      </div>

      <div class="panel">
        <div class="panel-head"><h2>cadeia</h2></div>
        ${
          m.history.length
            ? `<div class="history">${m.history
                .slice(0, 20)
                .map(
                  (h) => `<div class="hist-item">
                    <div class="hist-top">
                      <span>${esc(venueName(s, h.fromId))} → ${esc(venueName(s, h.toId))}</span>
                      <span class="hist-profit ${h.amountAfter >= h.amountBefore ? 'pos' : 'neg'}">
                        ${signedBrl(h.amountAfter - h.amountBefore)}
                      </span>
                    </div>
                    <div class="hist-meta">
                      <span>${new Date(h.at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })} · ${esc(h.network)}</span>
                      <span class="hist-state">${h.simulated ? 'simulado' : 'real'}</span>
                    </div>
                  </div>`,
                )
                .join('')}</div>`
            : '<div class="empty-state">nenhum pulo registrado</div>'
        }
      </div>
    </div>
  </div>`;
}

function monitorPanel(s) {
  const mo = s.monitor;
  if (!mo) return '';

  const dur = mo.startedAt ? (Date.now() - mo.startedAt) / 3_600_000 : 0;
  const last = mo.lastTickAt ? `${Math.round((Date.now() - mo.lastTickAt) / 1000)}s atrás` : '—';
  const totalKb = mo.files.reduce((a, f) => a + f.sizeKb, 0);

  const estimated = (mo.estimatedFeeVenues ?? [])
    .map((id) => venueName(s, id))
    .join(', ');

  return `<div class="panel">
    <div class="panel-head">
      <h2>monitoramento</h2>
      <span class="opp-status ${mo.active ? 'ok' : 'off'}"><span class="dot"></span>${mo.active ? 'gravando' : 'parado'}</span>
    </div>

    <div class="stat-list">
      <div class="row"><span class="k">coletas</span><span class="v">${mo.ticks.toLocaleString('pt-BR')}</span></div>
      <div class="row"><span class="k">linhas de pernas</span><span class="v">${mo.legRows.toLocaleString('pt-BR')}</span></div>
      <div class="row"><span class="k">oportunidades</span><span class="v">${mo.opportunities.toLocaleString('pt-BR')}</span></div>
      <div class="row"><span class="k">tempo gravando</span><span class="v">${mo.active ? `${dur.toFixed(1)}h` : '—'}</span></div>
      <div class="row"><span class="k">última coleta</span><span class="v">${last}</span></div>
      <div class="row"><span class="k">aporte de referência</span><span class="v">${brl(mo.referenceBrl)}</span></div>
      <div class="row"><span class="k">arquivos</span><span class="v">${mo.files.length} · ${totalKb.toLocaleString('pt-BR')} KB</span></div>
    </div>

    <button class="btn ${mo.active ? 'btn-ghost' : 'btn-exec'}" id="btn-monitor"
            data-action="${mo.active ? 'stop' : 'start'}" style="width:100%;margin-top:14px">
      ${mo.active ? 'parar monitoramento' : '⚡ monitorar'}
    </button>

    ${mo.lastError ? `<div class="opp-warn">falha ao gravar: ${esc(mo.lastError)}</div>` : ''}
    ${
      estimated
        ? `<div class="opp-warn">taxa de saque estimada em: ${esc(estimated)}. Pernas que saem daí não entram em oportunidades.csv — configure chaves de leitura para corrigir.</div>`
        : ''
    }

    <p class="hint">Grava em <code>${esc(mo.dir)}/</code> a cada atualização da malha,
    com o mesmo cálculo que o painel mostra. Aporte fixo para os dias serem comparáveis.</p>
  </div>`;
}

function legTable(s, legs, showAction) {
  if (!legs.length) return '<div class="empty-state">sem pernas cotadas</div>';

  return `<table class="htable">
    <thead><tr>
      <th>rota</th><th>rede</th><th>bruto</th><th>taxas</th><th>líquido</th><th>lucro</th>${showAction ? '<th></th>' : ''}
    </tr></thead>
    <tbody>${legs
      .map((l) => {
        const warn = !l.depthOk ? ' <span class="warnc" title="livro raso">raso</span>' : '';
        const est = !l.networkFeeKnown ? ' <span class="warnc" title="taxa estimada">~</span>' : '';
        return `<tr>
          <td>${esc(venueName(s, l.fromId))} → ${esc(venueName(s, l.toId))}${warn}</td>
          <td>${esc(l.network)}${est}</td>
          <td class="${l.grossPct >= 0 ? 'pos' : 'neg'}">${pct(l.grossPct, 3)}</td>
          <td>−${n(l.feesPct, 3)}%</td>
          <td class="${l.netPct >= 0 ? 'pos' : 'neg'}">${pct(l.netPct, 3)}</td>
          <td class="${l.profitBrl >= 0 ? 'pos' : 'neg'}">${signedBrl(l.profitBrl)}</td>
          ${
            showAction
              ? `<td><button class="btn btn-ghost btn-sm" data-hop="${l.toId}"
                   title="${esc(l.blockedReason ?? 'registra o pulo com o resultado previsto')}">
                   ${l.executable ? 'simular' : 'registrar'}
                 </button></td>`
              : ''
          }
        </tr>`;
      })
      .join('')}</tbody></table>`;
}

// ═══ Oportunidades ════════════════════════════════════════════════

function statusOf(r) {
  if (!r.enabled) return { cls: 'off', text: 'sem destino' };
  if (r.quoteError) return { cls: 'bad', text: 'erro' };
  if (!r.quote) return { cls: 'off', text: 'cotando' };
  if (r.quote.spreadPct >= r.settings.minSpreadPct) return { cls: 'ok', text: 'viável' };
  if (r.quote.spreadPct > 0) return { cls: 'mid', text: 'abaixo do alvo' };
  return { cls: 'bad', text: 'negativo' };
}

/** Destaca em laranja o ativo/rede que diferencia a rota. */
function routeLabelHtml(r) {
  return r.kind === 'cex'
    ? `USDT (Binance) → <b>${esc(r.network)}</b> → BRL (${esc(r.venue)})`
    : `USDT (Binance) → <b>${esc(r.short)}</b> (KyberSwap) → BRL (${esc(r.venue)})`;
}

function feeBreakdown(r, q) {
  const parts = [`Trade: ${brl(q.tradeFeeBrl)}`, `Saque: ${brl(q.withdrawFeeBrl)}`];
  if (r.kind === 'cex') parts.push(`Venda ${esc(r.venue)}: ${brl(q.destTradeFeeBrl)}`);
  else parts.push(`Rede: ${brl(q.gasBrl)}`);
  parts.push(`${esc(r.venue)}: ${brl(q.venueFeeBrl)}`);
  return parts.join(' · ');
}

function renderOpportunities(s) {
  $('#opp-grid').innerHTML = s.routes
    .map((r) => {
      const st = statusOf(r);
      const q = r.quote;
      const busy = s.running || s.stuckCycleId || !r.enabled;

      const body = q
        ? `<div class="opp-profit">
             <span class="val ${q.profitBrl >= 0 ? 'pos' : 'neg'}">${signedBrl(q.profitBrl)}</span>
             <span class="pct ${q.profitBrl >= 0 ? 'pos' : 'neg'}">${pct(q.spreadPct)}</span>
           </div>
           <div class="opp-metrics">
             <div><div class="metric-k">spread bruto</div><div class="metric-v ${q.grossSpreadPct >= 0 ? 'pos' : 'neg'}">${pct(q.grossSpreadPct)}</div></div>
             <div><div class="metric-k">taxas</div><div class="metric-v">−${n(q.feesPct, 4)}%</div></div>
           </div>
           <div class="opp-fees">${feeBreakdown(r, q)}</div>
           <div class="opp-impact">Impacto de preço estimado: ${n(q.priceImpactPct, 3)}%</div>
           ${(q.warnings ?? []).map((w) => `<div class="opp-warn">${esc(w)}</div>`).join('')}`
        : `<div class="opp-profit"><span class="val">—</span></div>
           <div class="opp-warn">${esc(r.quoteError ?? 'aguardando primeira cotação')}</div>`;

      return `<article class="opp ${st.cls === 'ok' ? 'viable' : ''} ${r.enabled ? '' : 'disabled'}">
        <div class="opp-top">
          <span class="opp-kind">${r.kind === 'cex' ? 'CEX → CEX' : 'CEX → DEX'}</span>
          <span class="opp-status ${st.cls}"><span class="dot"></span>${st.text}</span>
        </div>
        <div class="opp-route">${routeLabelHtml(r)}</div>
        ${body}
        <div class="opp-actions">
          <button class="btn btn-exec" data-run="${r.id}" ${busy ? 'disabled' : ''}>
            ${s.running ? 'em execução' : s.dryRun ? '⚡ simular' : '⚡ executar'}
          </button>
          <label class="switch" title="modo automático">
            <input type="checkbox" data-auto="${r.id}" ${r.settings.autoMode ? 'checked' : ''} ${r.enabled ? '' : 'disabled'}>
            <span class="slider"></span>
          </label>
        </div>
      </article>`;
    })
    .join('');

  renderLiveCycle(s, $('#live-cycle'));
}

const STEPS_BY_KIND = {
  dex: [
    ['buying', 'Comprar USDT na Binance'],
    ['withdrawing', 'Sacar USDT para a Polygon'],
    ['awaiting_deposit', 'Aguardar chegada na carteira'],
    ['approving', 'Aprovar router do KyberSwap'],
    ['swapping', 'Swap USDT → token'],
    ['transferring', 'Enviar para a plataforma'],
  ],
  cex: [
    ['buying', 'Comprar USDT na Binance'],
    ['withdrawing', 'Sacar USDT pela rede'],
    ['awaiting_deposit', 'Aguardar chegada na exchange'],
    ['selling', 'Vender USDT/BRL no melhor bid'],
  ],
};

function stepsHtml(cycle, kind = 'dex') {
  const steps = STEPS_BY_KIND[kind] ?? STEPS_BY_KIND.dex;
  const idx = cycle ? steps.findIndex(([k]) => k === cycle.state) : -1;
  return `<ol class="steps">${steps
    .map(([, label], i) => {
      const cls = !cycle ? '' : i < idx ? 'done' : i === idx ? 'active' : '';
      return `<li class="${cls}"><span class="sdot"></span>${label}</li>`;
    })
    .join('')}</ol>`;
}

function txsHtml(cycle) {
  const txs = (cycle.txs ?? []).filter((t) => t.hash?.startsWith('0x') && t.hash !== '0xdryrun');
  if (!txs.length) return '';
  return `<div class="hint">${txs
    .map((t) => `<a class="tx-link" href="https://polygonscan.com/tx/${t.hash}" target="_blank" rel="noopener">${esc(t.label)}</a>`)
    .join(' · ')}</div>`;
}

function renderLiveCycle(s, host) {
  const c = s.currentCycle;
  if (!c) {
    host.classList.add('hidden');
    host.innerHTML = '';
    return;
  }
  const route = s.routes.find((r) => r.id === c.routeId);
  host.classList.remove('hidden');
  host.innerHTML = `<div class="panel">
    <div class="panel-head">
      <h2>ciclo em execução — ${esc(route?.short ?? c.routeId)} · ${esc(route?.venue ?? '')}</h2>
      <span class="tool-static">${esc(c.id.slice(0, 8))} · ${c.trigger === 'auto' ? 'auto' : 'manual'} · ${brl(c.amountBrl)}</span>
    </div>
    ${stepsHtml(c, route?.kind)}
    ${txsHtml(c)}
  </div>`;
}

// ═══ Detalhe da rota ══════════════════════════════════════════════

/** As duas primeiras etapas são iguais nos dois formatos de rota. */
function flowRows(r, q) {
  const head = `
    <tr class="sec"><td colspan="3">1 · compra na binance</td></tr>
    <tr><td>Aporte</td><td></td><td>${brl(q.amountBrl)}</td></tr>
    <tr><td>USDT comprado</td><td>@ ${brl(q.avgPriceBrl)}</td><td>${n(q.usdtGross)} USDT</td></tr>
    <tr><td>Taxa de negociação</td><td></td><td class="neg">− ${n(q.binanceFeeUsdt)} USDT</td></tr>

    <tr class="sec"><td colspan="3">2 · saque via ${esc(r.network.toLowerCase())}</td></tr>
    <tr><td>Taxa de saque da rede</td><td></td><td class="neg">− ${n(q.withdrawFeeUsdt)} USDT</td></tr>
    <tr><td>USDT que chega ${r.kind === 'cex' ? `na ${esc(r.venue)}` : 'na carteira'}</td><td></td><td>${n(q.usdtOnChain)} USDT</td></tr>`;

  if (r.kind === 'cex') {
    return `${head}
      <tr class="sec"><td colspan="3">3 · venda na ${esc(r.venue.toLowerCase())}</td></tr>
      <tr><td>BRL recebido</td><td>@ ${brl(q.tokenPerUsdt)} / USDT</td><td>${brl(q.tokenOut)}</td></tr>
      <tr><td>Taxa de negociação ${esc(r.venue)}</td><td></td><td class="neg">− ${brl(q.destTradeFeeBrl)}</td></tr>
      <tr><td>Impacto de preço no book</td><td></td><td>${n(q.priceImpactPct, 3)}%</td></tr>

      <tr class="sec"><td colspan="3">4 · saque via pix</td></tr>
      <tr><td>Taxa da plataforma</td><td></td><td class="neg">− ${brl(q.venueFeeBrl)}</td></tr>`;
  }

  return `${head}
    <tr class="sec"><td colspan="3">3 · swap no kyberswap</td></tr>
    <tr><td>${esc(r.short)} recebido</td><td>@ ${n(q.tokenPerUsdt)} ${esc(r.short)}/USDT</td><td>${n(q.tokenOut, 2)} ${esc(r.short)}</td></tr>
    <tr><td>Impacto de preço</td><td></td><td>${n(q.priceImpactPct, 3)}%</td></tr>

    <tr class="sec"><td colspan="3">4 · custos de rede</td></tr>
    <tr><td>Gás (approve + swap + transfer)</td><td>${n(q.gasNative, 4)} POL</td><td class="neg">− ${brl(q.gasBrl)}</td></tr>

    <tr class="sec"><td colspan="3">5 · saque na ${esc(r.venue.toLowerCase())}</td></tr>
    <tr><td>Taxa da plataforma</td><td></td><td class="neg">− ${brl(q.venueFeeBrl)}</td></tr>`;
}

function renderRouteDetail(s) {
  const r = s.routes.find((x) => x.id === activeRouteId);
  if (!r) return;
  const q = r.quote;
  const busy = s.running || s.stuckCycleId || !r.enabled;

  const flow = q
    ? `<table class="flow">${flowRows(r, q)}
      <tr class="total"><td>Líquido em BRL</td><td></td><td>${brl(q.netBrl)}</td></tr>
      <tr class="total"><td>Resultado</td><td>${pct(q.spreadPct, 3)}</td><td class="${q.profitBrl >= 0 ? 'pos' : 'neg'}">${signedBrl(q.profitBrl)}</td></tr>
    </table>
    ${(q.warnings ?? []).map((w) => `<div class="opp-warn">${esc(w)}</div>`).join('')}`
    : `<div class="empty-state">${esc(r.quoteError ?? 'aguardando cotação…')}</div>`;

  $('#route-detail').innerHTML = `<div class="detail-grid">
    <div>
      <div class="panel">
        <div class="panel-head">
          <h2>composição do ciclo</h2>
          <span class="tool-static">${esc(r.label)}</span>
        </div>
        ${flow}
      </div>
      <div class="panel">
        <div class="panel-head"><h2>progresso</h2></div>
        ${stepsHtml(s.currentCycle?.routeId === r.id ? s.currentCycle : null, r.kind)}
        ${s.currentCycle?.routeId === r.id ? txsHtml(s.currentCycle) : '<div class="hint">Nenhum ciclo desta rota em execução.</div>'}
      </div>
    </div>

    <div>
      <div class="panel">
        <div class="panel-head"><h2>controles</h2></div>
        <label class="field"><span>valor por ciclo (R$)</span>
          <input type="number" min="1" step="10" data-cfg="amountBrl" value="${r.settings.amountBrl}">
        </label>
        <label class="field"><span>spread mínimo p/ auto (%)</span>
          <input type="number" step="0.05" data-cfg="minSpreadPct" value="${r.settings.minSpreadPct}">
        </label>
        <button class="btn btn-ghost btn-sm" data-save="${r.id}" style="width:100%">Salvar parâmetros</button>

        <div class="row-between">
          <div class="switch-wrap"><span>modo automático</span></div>
          <label class="switch">
            <input type="checkbox" data-auto="${r.id}" ${r.settings.autoMode ? 'checked' : ''} ${r.enabled ? '' : 'disabled'}>
            <span class="slider"></span>
          </label>
        </div>

        <button class="btn btn-exec" data-run="${r.id}" ${busy ? 'disabled' : ''} style="width:100%;margin-top:14px">
          ${s.running ? 'em execução' : s.dryRun ? '⚡ simular ciclo' : '⚡ executar ciclo'}
        </button>
        ${
          !r.enabled
            ? `<p class="hint warnc">Defina o endereço de depósito da ${esc(r.venue)} no .env para habilitar esta rota.</p>`
            : q && q.spreadPct < r.settings.minSpreadPct
              ? `<p class="hint">Spread atual abaixo do alvo — a execução manual ignora o alvo.</p>`
              : ''
        }
      </div>

      <div class="panel">
        <div class="panel-head"><h2>destino</h2></div>
        <div class="addr">
          <div class="k">${esc(r.venue)} · rede ${esc(r.network)}</div>
          <code class="${r.destination ? '' : 'empty'}">${esc(r.destination || 'não configurado')}</code>
        </div>
        ${
          r.kind === 'dex'
            ? `<div class="addr"><div class="k">contrato ${esc(r.short)}</div><code>${esc(r.token)}</code></div>
               <div class="stat-list">
                 <div class="row"><span class="k">saldo ${esc(r.short)} na carteira</span><span class="v">${n(s.balances.tokens[r.id], 2)}</span></div>
               </div>`
            : `<div class="stat-list">
                 <div class="row"><span class="k">par negociado</span><span class="v">${esc(r.symbol)}</span></div>
                 <div class="row"><span class="k">saldo USDT na ${esc(r.venue)}</span><span class="v">${n(s.balances.tokens[r.id], 2)}</span></div>
               </div>
               <p class="hint">O saque final em BRL é feito manualmente via PIX no app da ${esc(r.venue)}.</p>`
        }
      </div>
    </div>
  </div>`;
}

// ═══ Histórico ════════════════════════════════════════════════════

async function renderHistory() {
  const host = $('#history-table');
  let cycles = [];
  try {
    cycles = await (await fetch('/api/cycles')).json();
  } catch {
    host.innerHTML = '<div class="empty-state">não consegui carregar o histórico</div>';
    return;
  }

  if (!cycles.length) {
    host.innerHTML = '<div class="empty-state">nenhum ciclo executado ainda</div>';
    return;
  }

  // Ciclos gravados antes das rotas existirem não têm routeId.
  const routeName = (id) => state?.routes.find((r) => r.id === id)?.short ?? id ?? '—';

  host.innerHTML = `<table class="htable">
    <thead><tr>
      <th>quando</th><th>rota</th><th>aporte</th><th>previsto</th><th>realizado</th><th>status</th><th>txs</th>
    </tr></thead>
    <tbody>${cycles
      .slice(0, 60)
      .map((c) => {
        const cls = c.state === 'completed' ? 'completed' : c.state === 'failed' ? 'failed' : 'running';
        const real = c.actual?.profitBrl;
        return `<tr>
          <td>${new Date(c.startedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</td>
          <td>${esc(routeName(c.routeId))}${c.dryRun ? ' <span style="color:var(--muted)">sim</span>' : ''}</td>
          <td>${brl(c.amountBrl)}</td>
          <td class="${c.quoteAtStart?.profitBrl >= 0 ? 'pos' : 'neg'}">${signedBrl(c.quoteAtStart?.profitBrl)}</td>
          <td class="${real >= 0 ? 'pos' : 'neg'}">${real == null ? '—' : signedBrl(real)}</td>
          <td><span class="tag ${cls}">${esc(c.state)}</span></td>
          <td>${(c.txs ?? [])
            .filter((t) => t.hash?.startsWith('0x') && t.hash !== '0xdryrun')
            .map((t) => `<a class="tx-link" href="https://polygonscan.com/tx/${t.hash}" target="_blank" rel="noopener">${esc(t.label)}</a>`)
            .join(' ') || '—'}</td>
        </tr>${c.error ? `<tr><td colspan="7" class="neg" style="font-size:11px;padding-top:0">${esc(c.error)}</td></tr>` : ''}`;
      })
      .join('')}</tbody></table>`;
}

// ═══ Configurações ════════════════════════════════════════════════

function renderConfig(s) {
  const b = s.balances;
  const rows = [
    ['BRL · Binance', b.brlBinance, 2, null],
    ['USDT · Binance', b.usdtBinance, 2, null],
    ['POL · carteira (gás)', b.pol, 4, 0.5],
    ['USDT · carteira', b.usdtChain, 2, null],
    ...s.routes
      .filter((r) => r.kind === 'dex')
      .map((r) => [`${r.short} · carteira`, b.tokens[r.id], 2, null]),
    ...s.routes
      .filter((r) => r.kind === 'cex')
      .map((r) => [`USDT · ${r.venue}`, b.tokens[r.id], 2, null]),
  ];

  $('#cfg-balances').innerHTML = rows
    .map(
      ([k, v, d, low]) =>
        `<div class="row"><span class="k">${esc(k)}</span><span class="v ${low != null && v != null && v < low ? 'low' : ''}">${n(v, d)}</span></div>`,
    )
    .join('');

  $('#cfg-addresses').innerHTML =
    `<div class="addr"><div class="k">carteira do bot (recebe o USDT)</div><code>${esc(s.walletAddress)}</code></div>` +
    s.routes
      .map(
        (r) =>
          `<div class="addr"><div class="k">destino ${esc(r.venue)} · ${esc(r.short)} · ${esc(r.network)}</div>
           <code class="${r.destination ? '' : 'empty'}">${esc(r.destination || 'não configurado')}</code></div>`,
      )
      .join('');
}

// ═══ Logs ═════════════════════════════════════════════════════════

const seen = new Set();

function appendLog(entry) {
  const key = `${entry.ts}-${entry.message}`;
  if (seen.has(key)) return;
  seen.add(key);

  const div = document.createElement('div');
  div.className = 'log-line';
  div.innerHTML =
    `<span class="log-ts">${new Date(entry.ts).toLocaleTimeString('pt-BR')}</span>` +
    `<span class="log-scope">${esc(entry.scope)}</span>` +
    `<span class="log-${entry.level}"></span>`;
  div.lastChild.textContent = entry.message;

  const box = $('#logs');
  box.prepend(div);
  while (box.childElementCount > 300) box.lastElementChild.remove();
}

// ═══ Ações ════════════════════════════════════════════════════════

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

// Delegação de eventos: o conteúdo é re-renderizado a cada status.
document.addEventListener('click', async (ev) => {
  const nav = ev.target.closest('.nav-item');
  if (nav) {
    view = nav.dataset.view;
    activeRouteId = nav.dataset.route ?? activeRouteId;
    if (state) {
      renderSidebarRoutes(state);
      renderTopbar(state);
      renderCurrentView(state);
    }
    return;
  }

  const runId = ev.target.closest('[data-run]')?.dataset.run;
  if (runId) {
    const r = state.routes.find((x) => x.id === runId);
    if (!state.dryRun) {
      const q = r.quote;
      const ok = confirm(
        `MODO REAL\n\n` +
          `Rota: ${r.label}\n` +
          `Vai gastar ${brl(r.settings.amountBrl)} de verdade.\n` +
          (q ? `Spread previsto: ${pct(q.spreadPct, 3)} (${signedBrl(q.profitBrl)})\n` : '') +
          `Destino final: ${r.destination}\n\nConfirma?`,
      );
      if (!ok) return;
    }
    try {
      await post('/api/run', { routeId: runId });
    } catch (e) {
      alert(e.message);
    }
    return;
  }

  const saveId = ev.target.closest('[data-save]')?.dataset.save;
  if (saveId) {
    const host = ev.target.closest('.panel');
    try {
      await post('/api/settings', {
        routeId: saveId,
        amountBrl: Number($('[data-cfg="amountBrl"]', host).value),
        minSpreadPct: Number($('[data-cfg="minSpreadPct"]', host).value),
      });
    } catch (e) {
      alert(e.message);
    }
    return;
  }

  const hopTo = ev.target.closest('[data-hop]')?.dataset.hop;
  if (hopTo) {
    const from = venueName(state, state.mesh.position.venueId);
    if (!confirm(`Registrar o pulo ${from} → ${venueName(state, hopTo)}?\n\nO capital passa a constar no destino com o resultado previsto. Nenhum dinheiro é movido.`)) return;
    try {
      await post('/api/hop', { toId: hopTo });
    } catch (e) {
      alert(e.message);
    }
    return;
  }

  if (ev.target.closest('#btn-set-pos')) {
    try {
      await post('/api/position', {
        venueId: $('#pos-venue').value,
        amountBrl: Number($('#pos-amount').value),
      });
    } catch (e) {
      alert(e.message);
    }
    return;
  }

  const monitorBtn = ev.target.closest('#btn-monitor');
  if (monitorBtn) {
    const action = monitorBtn.dataset.action;
    if (action === 'stop' && !confirm('Parar a gravação? Os arquivos já escritos são mantidos.')) return;
    try {
      await post('/api/monitor', { action });
    } catch (e) {
      alert(e.message);
    }
    return;
  }

  if (ev.target.closest('#btn-reset-chain')) {
    if (!confirm('Zerar o histórico da cadeia? A posição atual vira o novo ponto de partida.')) return;
    try {
      await post('/api/chain/reset');
    } catch (e) {
      alert(e.message);
    }
    return;
  }

  if (ev.target.closest('#btn-ack')) {
    if (!confirm('Confirma que já verificou onde os fundos pararam e quer liberar o bot?')) return;
    try {
      await post('/api/acknowledge');
    } catch (e) {
      alert(e.message);
    }
  }
});

document.addEventListener('change', async (ev) => {
  const autoId = ev.target.dataset?.auto;
  if (autoId) {
    try {
      await post('/api/settings', { routeId: autoId, autoMode: ev.target.checked });
    } catch (e) {
      ev.target.checked = false;
      alert(e.message);
    }
    return;
  }

  // O campo do topo aplica o mesmo valor a todas as rotas de uma vez.
  if (ev.target.id === 'sim-amount') {
    const amountBrl = Number(ev.target.value);
    try {
      for (const r of state.routes) await post('/api/settings', { routeId: r.id, amountBrl });
    } catch (e) {
      alert(e.message);
    }
  }
});

setInterval(() => {
  if (!lastQuoteTs || view === 'historico' || view === 'config') return;
  const secs = Math.round((Date.now() - lastQuoteTs) / 1000);
  const el = $('#head-sub');
  if (view === 'oportunidades') el.textContent = `atualizado há ${secs}s`;
}, 1000);

connect();
