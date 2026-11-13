import { config } from '../config';
import { evmChain } from '../chains/evm';
import { db, many, one, tx, type Queryable } from '../lib/db';
import { writeAudit } from './audit';
import { DomainError } from './errors';
import { assertCanTrade, getPlatformUser, getUserById } from './identity';
import { mmHeadroom, platformCanFill } from './inventory';
import { fromUnits, minBig, toUnits, usdtUnitsFor } from './money';
import { getSettings } from './settings';
import { createSwapForFill } from './settlement';
import type { OrderRow, Side, SwapRow, UserRow } from './types';

const MATCH_LOCK_KEY = 7_829_413;
export const MARKET_BUY_PRICE = '999999999.000000';
export const MARKET_SELL_PRICE = '0.000001';

export interface PlaceOrderInput {
  side: Side;
  amountBtq: string;
  price: string; // decimal or 'market'
  isMm?: boolean;
  actor?: string;
}

export interface PlaceOrderResult {
  order: OrderRow;
  swaps: SwapRow[];
  remainderCancelled: boolean;
}

function normalizeAmount(v: string): bigint {
  let sats: bigint;
  try {
    sats = toUnits(v, 8);
  } catch {
    throw new DomainError('VALIDATION', 'Amount must be a positive number with at most 8 decimals.');
  }
  if (sats <= 0n) throw new DomainError('VALIDATION', 'Amount must be greater than zero.');
  return sats;
}

function normalizePrice(v: string): string {
  try {
    const micro = toUnits(v, 6);
    if (micro <= 0n) throw new Error('zero');
    return fromUnits(micro, 6);
  } catch {
    throw new DomainError('VALIDATION', 'Price must be a positive number with at most 6 decimals, or "market".');
  }
}

async function matchTaker(c: Queryable, taker: OrderRow, takerUser: UserRow, onlyMakerId?: string): Promise<SwapRow[]> {
  await c.query('SELECT pg_advisory_xact_lock($1)', [MATCH_LOCK_KEY]);
  const fresh = await one<OrderRow>(c, 'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [taker.id]);
  if (!fresh || !['open', 'partially_filled'].includes(fresh.status)) return [];
  let remaining = toUnits(fresh.amount_btq, 8) - toUnits(fresh.filled_btq, 8);
  if (remaining <= 0n) return [];

  const opposite: Side = fresh.side === 'buy' ? 'sell' : 'buy';
  const makers = await many<OrderRow>(
    c,
    `SELECT * FROM orders
      WHERE side = $1 AND status IN ('open', 'partially_filled') AND user_id <> $2
        AND (CASE WHEN $1 = 'sell' THEN price_usdt <= $3 ELSE price_usdt >= $3 END)
        AND ($4::uuid IS NULL OR id = $4::uuid)
      ORDER BY CASE WHEN $1 = 'sell' THEN price_usdt END ASC,
               CASE WHEN $1 = 'buy' THEN price_usdt END DESC,
               created_at ASC
      FOR UPDATE SKIP LOCKED`,
    [opposite, fresh.user_id, fresh.price_usdt, onlyMakerId ?? null],
  );

  const { htlc, token } = evmChain().addresses();
  const swaps: SwapRow[] = [];
  let takerFilled = toUnits(fresh.filled_btq, 8);
  for (const maker of makers) {
    if (remaining <= 0n) break;
    const makerUser = await getUserById(maker.user_id, c);
    if (!makerUser || makerUser.is_banned) continue;
    try {
      assertCanTrade(makerUser, (await getSettings(c)).settlement_rail);
    } catch {
      continue;
    }
    const makerRemaining = toUnits(maker.amount_btq, 8) - toUnits(maker.filled_btq, 8);
    if (makerRemaining <= 0n) continue;
    let fill = minBig(remaining, makerRemaining);
    const price = maker.price_usdt;
    if (makerUser.is_platform && !(await platformCanFill(maker.side, fill, price, c))) continue;
    if (takerUser.is_platform && !(await platformCanFill(fresh.side, fill, price, c))) break;
    if (usdtUnitsFor(fill, price, config().USDT_DECIMALS) <= 0n) continue;

    const swap = await createSwapForFill(c, {
      makerOrder: maker,
      takerOrder: fresh,
      maker: makerUser,
      taker: takerUser,
      fillSats: fill,
      priceUsdt: price,
      evm: { chainId: config().EVM_CHAIN_ID, htlc, token },
    });
    if (!swap) continue;
    swaps.push(swap);

    const makerFilled = toUnits(maker.filled_btq, 8) + fill;
    await c.query(
      `UPDATE orders SET filled_btq = $2, status = $3, updated_at = now() WHERE id = $1`,
      [maker.id, fromUnits(makerFilled, 8), makerFilled >= toUnits(maker.amount_btq, 8) ? 'filled' : 'partially_filled'],
    );
    takerFilled += fill;
    remaining -= fill;
    await c.query(
      `INSERT INTO trades (swap_id, maker_order_id, taker_order_id, maker_user_id, taker_user_id, taker_side, price_usdt, amount_btq, amount_usdt)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [swap.id, maker.id, fresh.id, maker.user_id, fresh.user_id, fresh.side, price, swap.amount_btq, swap.amount_usdt],
    );
    fill = 0n;
  }

  let status: OrderRow['status'] = takerFilled >= toUnits(fresh.amount_btq, 8) ? 'filled' : takerFilled > 0n ? 'partially_filled' : 'open';
  if (status !== 'filled' && fresh.tif === 'ioc') status = 'cancelled';
  await c.query('UPDATE orders SET filled_btq = $2, status = $3, updated_at = now() WHERE id = $1', [fresh.id, fromUnits(takerFilled, 8), status]);
  return swaps;
}

export async function placeOrder(userId: string, input: PlaceOrderInput): Promise<PlaceOrderResult> {
  const user = await getUserById(userId);
  if (!user) throw new DomainError('NOT_REGISTERED', 'Run `/swap start` first.');
  const settings = await getSettings();
  assertCanTrade(user, settings.settlement_rail);
  if (settings.book_paused) throw new DomainError('BOOK_PAUSED', 'The order book is paused by the operator. Try again later.');
  if (input.isMm && !user.is_platform) throw new DomainError('FORBIDDEN', 'Only the platform posts market-maker orders.');
  if (user.is_platform && !input.isMm) throw new DomainError('FORBIDDEN', 'Platform orders must be market-maker orders.');

  const sats = normalizeAmount(input.amountBtq);
  const min = toUnits(settings.min_order_btq, 8);
  const max = toUnits(input.isMm ? settings.mm_max_order_btq : settings.max_order_btq, 8);
  if (sats < min) throw new DomainError('VALIDATION', `Minimum order is ${settings.min_order_btq} BTQ.`);
  if (sats > max) throw new DomainError('VALIDATION', `Maximum order is ${fromUnits(max, 8, true)} BTQ.`);

  const market = input.price.trim().toLowerCase() === 'market';
  if (market && input.isMm) throw new DomainError('VALIDATION', 'Market-maker orders must have a price.');
  const price = market ? (input.side === 'buy' ? MARKET_BUY_PRICE : MARKET_SELL_PRICE) : normalizePrice(input.price);

  if (input.isMm) {
    const notional = usdtUnitsFor(sats, price, config().USDT_DECIMALS);
    if (notional > toUnits(settings.mm_max_notional_usdt, config().USDT_DECIMALS)) {
      throw new DomainError('VALIDATION', `Order exceeds the MM notional cap of ${settings.mm_max_notional_usdt} USDT.`);
    }
    const head = await mmHeadroom();
    if (!head) throw new DomainError('INSUFFICIENT_INVENTORY', 'Platform inventory is unknown; try again in a moment.');
    if (input.side === 'sell' && head.askSats < sats) {
      throw new DomainError('INSUFFICIENT_INVENTORY', `Platform BTQ headroom is ${fromUnits(head.askSats > 0n ? head.askSats : 0n, 8)} BTQ.`);
    }
    if (input.side === 'buy' && head.bidUnits < notional) {
      throw new DomainError('INSUFFICIENT_INVENTORY', `Platform USDT headroom is ${fromUnits(head.bidUnits > 0n ? head.bidUnits : 0n, config().USDT_DECIMALS)} USDT.`);
    }
  }

  return tx(async (c) => {
    const order = await one<OrderRow>(
      c,
      `INSERT INTO orders (user_id, side, price_usdt, amount_btq, is_mm, tif) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [user.id, input.side, price, fromUnits(sats, 8), !!input.isMm, market ? 'ioc' : 'gtc'],
    );
    const swaps = await matchTaker(c, order!, user);
    const final = await one<OrderRow>(c, 'SELECT * FROM orders WHERE id = $1', [order!.id]);
    if (input.isMm) await writeAudit(c, input.actor ?? 'admin', 'mm.post', order!.id, { side: input.side, price, amountBtq: order!.amount_btq });
    return { order: final!, swaps, remainderCancelled: final!.status === 'cancelled' };
  });
}

/** Take one specific resting order (IOC at that order's price, matched only against it). */
export async function takeOrder(userId: string, orderRef: string, amountBtq: string): Promise<PlaceOrderResult> {
  const user = await getUserById(userId);
  if (!user) throw new DomainError('NOT_REGISTERED', 'Run `/swap start` first.');
  const settings = await getSettings();
  assertCanTrade(user, settings.settlement_rail);
  if (settings.book_paused) throw new DomainError('BOOK_PAUSED', 'The order book is paused by the operator. Try again later.');
  const maker = await getOrder(orderRef);
  if (!maker || !['open', 'partially_filled'].includes(maker.status)) throw new DomainError('NOT_FOUND', `Order #${orderRef} is not on the book.`);
  if (maker.user_id === user.id) throw new DomainError('VALIDATION', 'You cannot take your own order.');
  const sats = normalizeAmount(amountBtq);
  const remaining = toUnits(maker.amount_btq, 8) - toUnits(maker.filled_btq, 8);
  if (sats > remaining) throw new DomainError('VALIDATION', `Only ${fromUnits(remaining, 8)} BTQ is left on order #${maker.short_id}.`);
  if (sats < toUnits(settings.min_order_btq, 8) && sats !== remaining) throw new DomainError('VALIDATION', `Minimum take is ${settings.min_order_btq} BTQ.`);
  const side: Side = maker.side === 'sell' ? 'buy' : 'sell';
  return tx(async (c) => {
    const order = await one<OrderRow>(
      c,
      `INSERT INTO orders (user_id, side, price_usdt, amount_btq, is_mm, tif) VALUES ($1, $2, $3, $4, false, 'ioc') RETURNING *`,
      [user.id, side, maker.price_usdt, fromUnits(sats, 8)],
    );
    const swaps = await matchTaker(c, order!, user, maker.id);
    const final = await one<OrderRow>(c, 'SELECT * FROM orders WHERE id = $1', [order!.id]);
    return { order: final!, swaps, remainderCancelled: final!.status === 'cancelled' };
  });
}

export async function getOrder(ref: string, q: Queryable = db()): Promise<OrderRow | null> {
  const s = ref.trim().replace(/^#/, '');
  if (/^\d+$/.test(s)) return one<OrderRow>(q, 'SELECT * FROM orders WHERE short_id = $1', [s]);
  if (/^[0-9a-f-]{36}$/i.test(s)) return one<OrderRow>(q, 'SELECT * FROM orders WHERE id = $1', [s]);
  return null;
}

export async function cancelOrder(userId: string, ref: string, actor?: string): Promise<OrderRow> {
  return tx(async (c) => {
    const o = await getOrder(ref, c);
    if (!o || o.user_id !== userId) throw new DomainError('NOT_FOUND', 'No order with that id.');
    const locked = await one<OrderRow>(c, 'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [o.id]);
    if (!locked || !['open', 'partially_filled', 'paused'].includes(locked.status)) {
      throw new DomainError('CONFLICT', `Order #${o.short_id} is ${locked?.status ?? 'gone'} and cannot be cancelled.`);
    }
    const updated = await one<OrderRow>(c, `UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = $1 RETURNING *`, [o.id]);
    if (actor) await writeAudit(c, actor, 'order.cancel', o.id);
    return updated!;
  });
}

export async function ordersForUser(userId: string, opts: { openOnly?: boolean; limit?: number } = {}): Promise<OrderRow[]> {
  return many<OrderRow>(
    db(),
    `SELECT * FROM orders WHERE user_id = $1 ${opts.openOnly ? `AND status IN ('open','partially_filled','paused')` : ''}
     ORDER BY created_at DESC LIMIT $2`,
    [userId, opts.limit ?? 25],
  );
}

export interface BookLevel {
  price: string;
  amountBtq: string;
  orders: number;
  mm: boolean;
}

export interface PublicOrder {
  orderNo: number;
  side: Side;
  price: string;
  remainingBtq: string;
  mm: boolean;
}

export interface PublicBook {
  bids: BookLevel[];
  asks: BookLevel[];
  topBids: PublicOrder[];
  topAsks: PublicOrder[];
  bestBid: string | null;
  bestAsk: string | null;
  paused: boolean;
}

/** Aggregated price levels only: no ids, keys, hashes or addresses. */
export async function publicBook(depth = 10): Promise<PublicBook> {
  const rows = await many<{ side: Side; price: string; amount: string; n: string; mm: boolean }>(
    db(),
    `SELECT side, price_usdt::text AS price, SUM(amount_btq - filled_btq)::text AS amount, COUNT(*)::text AS n, bool_or(is_mm) AS mm
       FROM orders WHERE status IN ('open', 'partially_filled') AND tif = 'gtc'
      GROUP BY side, price_usdt`,
  );
  const lvl = (r: (typeof rows)[number]): BookLevel => ({ price: r.price, amountBtq: r.amount, orders: Number(r.n), mm: r.mm });
  const bids = rows.filter((r) => r.side === 'buy').sort((a, b) => Number(b.price) - Number(a.price)).slice(0, depth).map(lvl);
  const asks = rows.filter((r) => r.side === 'sell').sort((a, b) => Number(a.price) - Number(b.price)).slice(0, depth).map(lvl);
  const settings = await getSettings();
  const top = await many<{ short_id: string; side: Side; price_usdt: string; remaining: string; is_mm: boolean }>(
    db(),
    `(SELECT short_id, side, price_usdt::text, (amount_btq - filled_btq)::text AS remaining, is_mm FROM orders
       WHERE status IN ('open','partially_filled') AND tif = 'gtc' AND side = 'sell' ORDER BY price_usdt ASC, created_at ASC LIMIT $1)
     UNION ALL
     (SELECT short_id, side, price_usdt::text, (amount_btq - filled_btq)::text AS remaining, is_mm FROM orders
       WHERE status IN ('open','partially_filled') AND tif = 'gtc' AND side = 'buy' ORDER BY price_usdt DESC, created_at ASC LIMIT $1)`,
    [depth],
  );
  const po = (r: (typeof top)[number]): PublicOrder => ({ orderNo: Number(r.short_id), side: r.side, price: r.price_usdt, remainingBtq: r.remaining, mm: r.is_mm });
  return {
    bids,
    asks,
    topBids: top.filter((r) => r.side === 'buy').map(po),
    topAsks: top.filter((r) => r.side === 'sell').map(po),
    bestBid: bids[0]?.price ?? null,
    bestAsk: asks[0]?.price ?? null,
    paused: settings.book_paused,
  };
}

// ── operator (MM desk) ──

export async function postMmOrder(input: { side: Side; price: string; amountBtq: string }, actor: string): Promise<PlaceOrderResult> {
  const platform = await getPlatformUser();
  return placeOrder(platform.id, { ...input, isMm: true, actor });
}

export async function setMmOrderPaused(ref: string, paused: boolean, actor: string): Promise<OrderRow> {
  const platform = await getPlatformUser();
  const res = await tx(async (c) => {
    const o = await getOrder(ref, c);
    if (!o || o.user_id !== platform.id) throw new DomainError('NOT_FOUND', 'No MM order with that id.');
    const from = paused ? ['open', 'partially_filled'] : ['paused'];
    const to = paused ? 'paused' : toUnits(o.filled_btq, 8) > 0n ? 'partially_filled' : 'open';
    const updated = await one<OrderRow>(c, `UPDATE orders SET status = $2, updated_at = now() WHERE id = $1 AND status = ANY($3) RETURNING *`, [o.id, to, from]);
    if (!updated) throw new DomainError('CONFLICT', `Order #${o.short_id} is ${o.status}.`);
    await writeAudit(c, actor, paused ? 'mm.pause' : 'mm.resume', o.id);
    return updated;
  });
  if (!paused) await rematch(res.id);
  return res;
}

export async function repriceMmOrder(ref: string, price: string, actor: string): Promise<OrderRow> {
  const platform = await getPlatformUser();
  const p = normalizePrice(price);
  const res = await tx(async (c) => {
    const o = await getOrder(ref, c);
    if (!o || o.user_id !== platform.id) throw new DomainError('NOT_FOUND', 'No MM order with that id.');
    const updated = await one<OrderRow>(
      c,
      `UPDATE orders SET price_usdt = $2, created_at = now(), updated_at = now() WHERE id = $1 AND status IN ('open','partially_filled','paused') RETURNING *`,
      [o.id, p],
    );
    if (!updated) throw new DomainError('CONFLICT', `Order #${o.short_id} is ${o.status}.`);
    await writeAudit(c, actor, 'mm.reprice', o.id, { from: o.price_usdt, to: p });
    return updated;
  });
  await rematch(res.id);
  return res;
}

export async function cancelMmOrder(ref: string, actor: string): Promise<OrderRow> {
  const platform = await getPlatformUser();
  return cancelOrder(platform.id, ref, actor);
}

/** Run matching for an existing resting order (after resume/reprice). */
export async function rematch(orderId: string): Promise<SwapRow[]> {
  return tx(async (c) => {
    const o = await one<OrderRow>(c, 'SELECT * FROM orders WHERE id = $1', [orderId]);
    if (!o) return [];
    const u = await getUserById(o.user_id, c);
    if (!u) return [];
    return matchTaker(c, o, u);
  });
}

export async function mmOrders(): Promise<OrderRow[]> {
  return many<OrderRow>(db(), `SELECT o.* FROM orders o JOIN users u ON u.id = o.user_id AND u.is_platform ORDER BY o.created_at DESC LIMIT 100`);
}
