/** Tiny BTQ Core JSON-RPC client (no wallet state; pass `wallet` to target /wallet/<name>). */
export interface BtqRpcOptions {
  url: string; // e.g. http://127.0.0.1:18443
  user: string;
  pass: string;
  wallet?: string;
  timeoutMs?: number;
}

export class BtqRpcError extends Error {
  constructor(public readonly code: number, message: string, public readonly method: string) {
    super(`BTQ RPC ${method} failed (${code}): ${message}`);
    this.name = 'BtqRpcError';
  }
}

export class BtqRpc {
  private id = 0;
  constructor(private readonly opts: BtqRpcOptions) {}

  withWallet(wallet: string | undefined): BtqRpc {
    return new BtqRpc({ ...this.opts, wallet });
  }

  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const base = this.opts.url.replace(/\/+$/, '');
    const url = this.opts.wallet ? `${base}/wallet/${encodeURIComponent(this.opts.wallet)}` : base;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 30_000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Basic ' + Buffer.from(`${this.opts.user}:${this.opts.pass}`).toString('base64'),
        },
        body: JSON.stringify({ jsonrpc: '1.0', id: ++this.id, method, params }),
        signal: controller.signal,
      });
      const text = await res.text();
      let body: { result?: T; error?: { code: number; message: string } | null };
      try {
        body = JSON.parse(text);
      } catch {
        throw new BtqRpcError(res.status, `HTTP ${res.status}: ${text.slice(0, 200)}`, method);
      }
      if (body.error) throw new BtqRpcError(body.error.code, body.error.message, method);
      return body.result as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

export const SATS_PER_BTQ = 100_000_000n;

/** Convert a BTQ decimal amount (number or string, max 8 dp) to integer sats without float error. */
export function btqToSats(amount: number | string): bigint {
  const s = typeof amount === 'number' ? amount.toFixed(8) : amount.trim();
  if (!/^\d+(\.\d{1,8})?$/.test(s)) throw new Error(`invalid BTQ amount: ${amount}`);
  const [whole, frac = ''] = s.split('.');
  return BigInt(whole!) * SATS_PER_BTQ + BigInt((frac + '00000000').slice(0, 8));
}

export function satsToBtq(sats: bigint): string {
  const neg = sats < 0n;
  const v = neg ? -sats : sats;
  const whole = v / SATS_PER_BTQ;
  const frac = (v % SATS_PER_BTQ).toString().padStart(8, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}
