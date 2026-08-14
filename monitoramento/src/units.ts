/** Conversões decimal <-> unidades mínimas, sem depender de ethers. */

export function toRaw(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount < 0) throw new Error(`valor inválido: ${amount}`);

  // toFixed evita notação científica, que quebraria o split.
  const [intPart, fracPart = ''] = amount.toFixed(decimals).split('.');
  const frac = fracPart.padEnd(decimals, '0').slice(0, decimals);
  return BigInt(intPart + frac);
}

export function fromRaw(raw: bigint, decimals: number): number {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;

  const value = Number(whole) + Number(frac) / Number(base);
  return negative ? -value : value;
}
