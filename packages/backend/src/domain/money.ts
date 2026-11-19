/** Exact decimal ↔ integer-unit conversions (no floats anywhere near amounts). */

export function toUnits(value: string, decimals: number): bigint {
  const s = value.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`invalid decimal "${value}"`);
  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals) {
    if (/[1-9]/.test(frac.slice(decimals))) throw new Error(`"${value}" has more than ${decimals} decimals`);
  }
  return BigInt(whole!) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

export function fromUnits(units: bigint, decimals: number, trim = false): string {
  const neg = units < 0n;
  const v = neg ? -units : units;
  const base = 10n ** BigInt(decimals);
  const whole = (v / base).toString();
  let frac = (v % base).toString().padStart(decimals, '0');
  if (trim) frac = frac.replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${decimals > 0 && frac.length ? '.' + frac : ''}`;
}

export const BTQ_DECIMALS = 8;
export const PRICE_DECIMALS = 6;

/** USDT units owed for `sats` of BTQ at `price` USDT/BTQ (floor), for a token with `tokenDecimals`. */
export function usdtUnitsFor(sats: bigint, price: string, tokenDecimals: number): bigint {
  const priceMicro = toUnits(price, PRICE_DECIMALS);
  const scale = 10n ** BigInt(tokenDecimals);
  return (sats * priceMicro * scale) / (10n ** BigInt(BTQ_DECIMALS) * 10n ** BigInt(PRICE_DECIMALS));
}

export function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
