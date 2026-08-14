import { networksOf, venues, type NetworkSupport, type VenueDef, type VenueQuote } from './venues.js';

/**
 * Uma perna é mover o capital de um venue para outro: comprar USDT na origem,
 * transferir pela rede escolhida e vender USDT no destino.
 *
 * A malha é o conjunto de todas as pernas ordenadas entre os venues — é isso
 * que permite encadear operações sem precisar sacar para o banco no meio.
 */
export interface Leg {
  fromId: string;
  toId: string;

  /** Rede escolhida para a transferência. */
  network: string;
  networkFeeUsdt: number;
  /** false quando a rede foi estimada por falta de dado da exchange. */
  networkFeeKnown: boolean;

  askFrom: number;
  bidTo: number;

  grossPct: number;
  feesPct: number;
  netPct: number;
  profitBrl: number;

  tradeFeeFromBrl: number;
  tradeFeeToBrl: number;
  withdrawFeeBrl: number;
  gasBrl: number;

  depthOk: boolean;
  /** Já existe código de execução para esta perna? */
  executable: boolean;
  /** Por que não é executável, quando não for. */
  blockedReason?: string;
}

/**
 * Redes que consideramos, da mais barata para a mais cara. As DEX só existem
 * na Polygon, então MATIC precisa estar na lista para alcançá-las.
 */
const NETWORK_PREFERENCE = ['BSC', 'MATIC', 'OP', 'ARBONE', 'AVAXC', 'SOL', 'TRC20', 'ERC20'];

/** Usada quando a exchange não expõe a taxa publicamente. */
const FALLBACK_FEE_USDT = 1;

export interface NetworkChoice {
  network: string;
  feeUsdt: number;
  known: boolean;
  reason?: string;
}

/**
 * Escolhe a rede mais barata que a origem consegue sacar e o destino consegue
 * depositar. Uma DEX só é alcançável pela Polygon, então qualquer perna que
 * toque uma DEX é forçada para MATIC.
 */
export function pickNetwork(
  from: VenueDef,
  to: VenueDef,
  netsFrom: Record<string, NetworkSupport>,
  netsTo: Record<string, NetworkSupport>,
): NetworkChoice {
  const touchesDex = from.kind === 'dex' || to.kind === 'dex';
  const candidates = touchesDex ? ['MATIC'] : NETWORK_PREFERENCE;

  let best: NetworkChoice | null = null;

  for (const net of candidates) {
    const f = netsFrom[net];
    const t = netsTo[net];

    // Sair de uma DEX é transferência on-chain: não depende de rede da exchange.
    const canWithdraw = from.kind === 'dex' ? true : f?.withdrawEnable === true;
    const canDeposit = to.kind === 'dex' ? true : t?.depositEnable === true;
    if (!canWithdraw || !canDeposit) continue;

    const raw = from.kind === 'dex' ? 0 : f?.withdrawFee;
    const known = Number.isFinite(raw);
    const feeUsdt = known ? (raw as number) : FALLBACK_FEE_USDT;

    if (!best || feeUsdt < best.feeUsdt) best = { network: net, feeUsdt, known };
  }

  if (best) return best;

  // Sem interseção conhecida: assume a rede padrão e avisa que é estimativa.
  return {
    network: touchesDex ? 'MATIC' : 'BSC',
    feeUsdt: FALLBACK_FEE_USDT,
    known: false,
    reason: `nenhuma rede em comum confirmada entre ${from.label} e ${to.label}`,
  };
}

/**
 * Pernas que já têm código de execução. As demais aparecem no painel para
 * análise, mas o botão fica desabilitado — a execução em malha é a fase 3.
 */
function executability(from: VenueDef, to: VenueDef): { executable: boolean; reason?: string } {
  if (from.id !== 'binance') {
    return { executable: false, reason: `comprar USDT na ${from.label} ainda não implementado (fase 3)` };
  }
  if (!to.depositAddresses || Object.keys(to.depositAddresses).length === 0) {
    return { executable: false, reason: `sem endereço de depósito configurado para ${to.label}` };
  }
  return { executable: true };
}

export interface LegInput {
  quotes: VenueQuote[];
  amountBrl: number;
  /** Custo em BRL de uma perna on-chain (swap + transferência). */
  gasBrl: number;
}

/** Monta a matriz completa de pernas a partir das cotações do momento. */
export async function computeLegs({ quotes, amountBrl, gasBrl }: LegInput): Promise<Leg[]> {
  const byId = new Map(quotes.map((q) => [q.venueId, q]));

  // Redes são consultadas uma vez por venue, não por par.
  const nets = new Map<string, Record<string, NetworkSupport>>();
  await Promise.all(
    venues.map(async (v) => {
      nets.set(v.id, await networksOf(v));
    }),
  );

  const out: Leg[] = [];

  for (const from of venues) {
    for (const to of venues) {
      if (from.id === to.id) continue;

      const qf = byId.get(from.id);
      const qt = byId.get(to.id);
      if (!qf?.ok || !qt?.ok || qf.effAsk <= 0 || qt.effBid <= 0) continue;

      out.push(buildLeg(from, to, qf, qt, nets, amountBrl, gasBrl));
    }
  }

  return out;
}

function buildLeg(
  from: VenueDef,
  to: VenueDef,
  qf: VenueQuote,
  qt: VenueQuote,
  nets: Map<string, Record<string, NetworkSupport>>,
  amountBrl: number,
  gasBrl: number,
): Leg {
  const choice = pickNetwork(from, to, nets.get(from.id) ?? {}, nets.get(to.id) ?? {});

  const askFrom = qf.effAsk;
  const bidTo = qt.effBid;

  // Quanto USDT o aporte compra na origem, já sem a taxa de negociação.
  const usdtGross = amountBrl / askFrom;
  const tradeFeeFromUsdt = usdtGross * from.takerFee;
  const usdtArriving = usdtGross - tradeFeeFromUsdt - choice.feeUsdt;

  const brlGrossAtDest = usdtArriving * bidTo;
  const tradeFeeToBrl = brlGrossAtDest * to.takerFee;

  // Gás entra por ponta on-chain: swap na DEX e/ou transferência.
  const legsOnChain = (from.kind === 'dex' ? 1 : 0) + (to.kind === 'dex' ? 1 : 0);
  const gasCost = gasBrl * legsOnChain;

  const netBrl = brlGrossAtDest - tradeFeeToBrl - gasCost;

  const grossPct = (bidTo / askFrom - 1) * 100;
  const netPct = (netBrl / amountBrl - 1) * 100;

  const exec = executability(from, to);

  return {
    fromId: from.id,
    toId: to.id,
    network: choice.network,
    networkFeeUsdt: choice.feeUsdt,
    networkFeeKnown: choice.known,
    askFrom,
    bidTo,
    grossPct,
    // Derivada da diferença: assim bruto − taxas = líquido sempre fecha.
    feesPct: grossPct - netPct,
    netPct,
    profitBrl: netBrl - amountBrl,
    tradeFeeFromBrl: tradeFeeFromUsdt * bidTo,
    tradeFeeToBrl,
    withdrawFeeBrl: choice.feeUsdt * bidTo,
    gasBrl: gasCost,
    depthOk: qf.askDepthOk && qt.bidDepthOk,
    executable: exec.executable,
    blockedReason: exec.reason ?? choice.reason,
  };
}

/** Só as pernas que saem de onde o capital está agora, da melhor para a pior. */
export function legsFrom(legs: Leg[], venueId: string): Leg[] {
  return legs.filter((l) => l.fromId === venueId).sort((a, b) => b.netPct - a.netPct);
}
