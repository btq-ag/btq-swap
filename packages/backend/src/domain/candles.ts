import { db, many } from '../lib/db';

const ALLOWED = new Set([1, 5, 15, 60]);

export interface Candle {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
  n: number;
}

/** OHLC buckets from matched trades. `t` is the bucket start in unix seconds. */
export async function publicCandles(intervalSec: number, limit = 180): Promise<{ intervalSec: number; candles: Candle[] }> {
  const step = ALLOWED.has(intervalSec) ? intervalSec : 5;
  const cap = Math.min(Math.max(limit, 1), 500);
  const rows = await many<{ t: string; o: string; h: string; l: string; c: string; v: string; n: string }>(
    db(),
    `SELECT
       (floor(extract(epoch FROM created_at))::bigint / $1::int) * $1::int AS t,
       (array_agg(price_usdt::text ORDER BY created_at ASC, id ASC))[1] AS o,
       max(price_usdt)::text AS h,
       min(price_usdt)::text AS l,
       (array_agg(price_usdt::text ORDER BY created_at DESC, id DESC))[1] AS c,
       sum(amount_btq)::text AS v,
       count(*)::text AS n
     FROM trades
     WHERE created_at > now() - interval '24 hours'
     GROUP BY 1
     ORDER BY 1 DESC
     LIMIT $2`,
    [step, cap],
  );
  const candles = rows.reverse().map((r) => ({ t: Number(r.t), o: r.o, h: r.h, l: r.l, c: r.c, v: r.v, n: Number(r.n) }));
  return { intervalSec: step, candles };
}
