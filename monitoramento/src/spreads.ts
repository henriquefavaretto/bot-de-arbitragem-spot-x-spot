import { config, venues, type VenueDef } from './config.js';
import type { VenueQuote } from './venues.js';

export interface Spread {
  fromId: string;
  toId: string;
  /** Preço de compra no venue de origem (BRL por USDT). */
  askFrom: number;
  /** Preço de venda no venue de destino (BRL por USDT). */
  bidTo: number;

  /** Diferença pura de preço, sem taxa nenhuma. */
  grossPct: number;
  /** Soma das taxas, em % sobre o aporte. */
  feesPct: number;
  /** grossPct − feesPct. É este número que decide se vale operar. */
  netPct: number;
  profitBrl: number;

  /** Taxas em reais, para auditar a conta. */
  tradeFeeFromBrl: number;
  tradeFeeToBrl: number;
  withdrawFeeBrl: number;
  gasBrl: number;

  /** false se algum dos dois lados não tinha profundidade para o tamanho. */
  depthOk: boolean;
}

const byId = new Map<string, VenueDef>(venues.map((v) => [v.id, v]));

/**
 * Monta a matriz de todas as combinações ordenadas de venues.
 *
 * Uma perna A→B é: comprar USDT com BRL em A, mover o USDT para B, vender USDT
 * por BRL em B. Em venues DEX o "BRL" é BRLA ou BRZ, e mover significa uma
 * transferência on-chain (só gás) em vez de saque de exchange.
 */
export function computeSpreads(quotes: VenueQuote[], amountBrl: number, gasBrl: number): Spread[] {
  const q = new Map(quotes.map((x) => [x.venueId, x]));
  const out: Spread[] = [];

  for (const from of venues) {
    for (const to of venues) {
      if (from.id === to.id) continue;

      const qf = q.get(from.id);
      const qt = q.get(to.id);
      if (!qf?.ok || !qt?.ok || qf.effAsk <= 0 || qt.effBid <= 0) continue;

      out.push(leg(from, to, qf, qt, amountBrl, gasBrl));
    }
  }

  return out;
}

function leg(
  from: VenueDef,
  to: VenueDef,
  qf: VenueQuote,
  qt: VenueQuote,
  amountBrl: number,
  gasBrl: number,
): Spread {
  const askFrom = qf.effAsk;
  const bidTo = qt.effBid;

  // Quanto USDT o aporte compra na origem, já descontada a taxa de negociação.
  const usdtGross = amountBrl / askFrom;
  const tradeFeeFromUsdt = usdtGross * from.takerFee;

  // Saque: exchange cobra taxa fixa em USDT; DEX cobra gás, contabilizado à parte.
  const withdrawFeeUsdt = from.withdrawFeeUsdt;

  const usdtArriving = usdtGross - tradeFeeFromUsdt - withdrawFeeUsdt;
  const brlGrossAtDest = usdtArriving * bidTo;
  const tradeFeeToBrl = brlGrossAtDest * to.takerFee;

  // Gás só entra quando alguma ponta é on-chain: swap na DEX e/ou transferência.
  const legsOnChain = (from.kind === 'dex' ? 1 : 0) + (to.kind === 'dex' ? 1 : 0);
  const gasCost = gasBrl * legsOnChain;

  const netBrl = brlGrossAtDest - tradeFeeToBrl - gasCost;

  const tradeFeeFromBrl = tradeFeeFromUsdt * bidTo;
  const withdrawFeeBrl = withdrawFeeUsdt * bidTo;

  const grossPct = (bidTo / askFrom - 1) * 100;
  const netPct = (netBrl / amountBrl - 1) * 100;

  return {
    fromId: from.id,
    toId: to.id,
    askFrom,
    bidTo,
    grossPct,
    // Derivada da diferença: assim bruto − taxas = líquido sempre fecha.
    feesPct: grossPct - netPct,
    netPct,
    profitBrl: netBrl - amountBrl,
    tradeFeeFromBrl,
    tradeFeeToBrl,
    withdrawFeeBrl,
    gasBrl: gasCost,
    depthOk: qf.askDepthOk && qt.bidDepthOk,
  };
}

export function venueLabel(id: string): string {
  return byId.get(id)?.label ?? id;
}

export function isOpportunity(s: Spread): boolean {
  return s.netPct >= config.opportunityThresholdPct && s.depthOk;
}
