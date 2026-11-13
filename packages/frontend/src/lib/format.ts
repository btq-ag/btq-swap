const PRICE_DP = 6;
const BTQ_DP = 8;
const USDT_DP = 6;

export function toUnits(value: string, decimals: number): bigint {
  const s = value.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('Enter a number.');
  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals && /[1-9]/.test(frac.slice(decimals))) throw new Error('Too many decimals.');
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

export function fromUnits(units: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = (units / base).toString();
  const frac = (units % base).toString().padStart(decimals, '0');
  return `${whole}.${frac}`;
}

/** Drop trailing zeros, keep at least `minDp` decimal places. */
export function trim(value: string, minDp = 2): string {
  const [whole, frac = ''] = value.split('.');
  const cut = frac.replace(/0+$/, '');
  const shown = cut.length >= minDp ? cut : frac.slice(0, Math.max(minDp, cut.length)).padEnd(minDp, '0');
  return shown ? `${whole}.${shown}` : whole;
}

export function priceText(value: string | null | undefined): string {
  if (!value) return '—';
  try {
    return trim(fromUnits(toUnits(value, PRICE_DP), PRICE_DP), 2);
  } catch {
    return value;
  }
}

export function btqText(value: string | null | undefined): string {
  if (!value) return '—';
  try {
    return trim(fromUnits(toUnits(value, BTQ_DP), BTQ_DP), 2);
  } catch {
    return value;
  }
}

/** Floor of amount × price, displayed in USDT. */
export function quoteUsdt(amountBtq: string, price: string): string {
  const sats = toUnits(amountBtq, BTQ_DP);
  const micro = toUnits(price, PRICE_DP);
  const units = (sats * micro * 10n ** BigInt(USDT_DP)) / (10n ** BigInt(BTQ_DP) * 10n ** BigInt(PRICE_DP));
  return trim(fromUnits(units, USDT_DP), 2);
}

export function spreadBps(bid: string | null, ask: string | null): string | null {
  if (!bid || !ask) return null;
  const b = toUnits(bid, PRICE_DP);
  const a = toUnits(ask, PRICE_DP);
  if (b <= 0n || a <= b) return null;
  const mid = (a + b) / 2n;
  return ((a - b) * 10000n / mid).toString();
}

export function shortAddr(value: string | null | undefined): string {
  if (!value) return '';
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
