#!/usr/bin/env node
/**
 * Market-maker reconcile plan. No network and no floats.
 *
 *   node docs/sops/scripts/mm-quote.mjs <duty.json> <overview.json> <orders.json>
 *   node docs/sops/scripts/mm-quote.mjs --self-check
 *
 * duty:     { mid, spreadPct, clipBtq, usdtDecimals? }
 * overview: admin GET /overview
 * orders:   admin GET /mm/orders  ({ orders }) or a bare array
 *
 * Exit 0 with a plan. Exit 2 when the duty file is unsafe to trade on.
 */
const PRICE_DP = 6;
const BTQ_DP = 8;

function fail(message) {
  const err = new Error(message);
  err.status = 2;
  throw err;
}

function toUnits(value, decimals) {
  const s = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`invalid decimal "${value}"`);
  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals && /[1-9]/.test(frac.slice(decimals))) {
    throw new Error(`"${value}" has more than ${decimals} decimals`);
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

function fromUnits(units, decimals) {
  const base = 10n ** BigInt(decimals);
  const whole = (units / base).toString();
  const frac = (units % base).toString().padStart(decimals, '0');
  return `${whole}.${frac}`;
}

function min(a, b) {
  return a < b ? a : b;
}

function priceEq(a, b) {
  return toUnits(a, PRICE_DP) === toUnits(b, PRICE_DP);
}

function remainingSats(order) {
  const left = toUnits(order.amount_btq, BTQ_DP) - toUnits(order.filled_btq, BTQ_DP);
  return left > 0n ? left : 0n;
}

function usdtFor(sats, priceMicro, tokenDecimals) {
  const scale = 10n ** BigInt(tokenDecimals);
  return (sats * priceMicro * scale) / (10n ** BigInt(BTQ_DP) * 10n ** BigInt(PRICE_DP));
}

function satsForUsdt(units, priceMicro, tokenDecimals) {
  const scale = 10n ** BigInt(tokenDecimals);
  if (priceMicro <= 0n) return 0n;
  return (units * 10n ** BigInt(BTQ_DP) * 10n ** BigInt(PRICE_DP)) / (priceMicro * scale);
}

function plan(duty, overview, ordersDoc) {
  if (!duty?.mid || !duty?.spreadPct || !duty?.clipBtq) fail('duty file needs mid, spreadPct, and clipBtq');
  const settings = overview?.settings ?? {};
  const inv = overview?.inventory;
  if (!inv) fail('overview has no inventory');
  const tokenDp = Number(duty.usdtDecimals ?? 6);
  const minSpread = toUnits(settings.mm_min_spread_pct ?? '0.5', 2);
  const spread = toUnits(duty.spreadPct, 2);
  if (spread < minSpread) fail(`spread ${duty.spreadPct}% is under the floor ${settings.mm_min_spread_pct ?? '0.5'}%`);
  const halfBps = spread / 2n;
  const mid = toUnits(duty.mid, PRICE_DP);
  if (mid <= 0n || halfBps <= 0n || halfBps >= 10000n) fail('mid and spread must be positive and the half-spread must be under 100%');
  const bidMicro = (mid * (10000n - halfBps)) / 10000n;
  const askMicro = (mid * (10000n + halfBps) + 9999n) / 10000n;
  if (bidMicro <= 0n || askMicro <= bidMicro) fail('computed bid/ask collapsed');
  const bid = fromUnits(bidMicro, PRICE_DP);
  const ask = fromUnits(askMicro, PRICE_DP);

  const orders = Array.isArray(ordersDoc) ? ordersDoc : ordersDoc?.orders ?? [];
  const live = orders.filter((o) => ['open', 'partially_filled', 'paused'].includes(o.status));
  const clip = toUnits(duty.clipBtq, BTQ_DP);
  const minOrder = toUnits(settings.min_order_btq ?? '0.1', BTQ_DP);
  const maxOrder = toUnits(settings.mm_max_order_btq ?? '500', BTQ_DP);
  const maxNotional = toUnits(settings.mm_max_notional_usdt ?? '100000', tokenDp);

  const sellFund = nonNeg(toUnits(inv.btq ?? '0', BTQ_DP) - toUnits(inv.btqCommitted ?? '0', BTQ_DP));
  const buyUsdt = nonNeg(toUnits(inv.usdt ?? '0', tokenDp) - toUnits(inv.usdtCommitted ?? '0', tokenDp));

  const sellTarget = capped(clip, sellFund, maxOrder, maxNotional, askMicro, tokenDp);
  const buyTarget = capped(clip, satsForUsdt(buyUsdt, bidMicro, tokenDp), maxOrder, maxNotional, bidMicro, tokenDp);

  const paused = settings.book_paused === true;
  const actions = paused ? [] : [...sideActions('sell', ask, sellTarget, live, minOrder), ...sideActions('buy', bid, buyTarget, live, minOrder)];

  return {
    mid: fromUnits(mid, PRICE_DP),
    spreadPct: duty.spreadPct,
    bid,
    ask,
    paused,
    sellTarget: fromUnits(sellTarget, BTQ_DP),
    buyTarget: fromUnits(buyTarget, BTQ_DP),
    actions,
    quote: {
      buyBtq: { price: ask, volumeBtq: fromUnits(resting(live, 'sell', ask), BTQ_DP) },
      sellBtq: { price: bid, volumeBtq: fromUnits(resting(live, 'buy', bid), BTQ_DP) },
    },
  };
}

function nonNeg(n) {
  return n > 0n ? n : 0n;
}

function capped(clip, fundable, maxOrder, maxNotional, priceMicro, tokenDp) {
  let size = min(clip, min(fundable, maxOrder));
  if (usdtFor(size, priceMicro, tokenDp) > maxNotional) size = satsForUsdt(maxNotional, priceMicro, tokenDp);
  return size > 0n ? size : 0n;
}

function resting(live, side, price) {
  return live
    .filter((o) => o.side === side && o.status !== 'paused' && priceEq(o.price_usdt, price))
    .reduce((sum, o) => sum + remainingSats(o), 0n);
}

function sideActions(side, price, target, live, minOrder) {
  const mine = live.filter((o) => o.side === side);
  const keepers = mine.filter((o) => o.status !== 'paused' && priceEq(o.price_usdt, price));
  const have = keepers.reduce((sum, o) => sum + remainingSats(o), 0n);
  const wrong = mine.length - keepers.length;
  const closeEnough = wrong === 0 && have <= target && have * 5n >= target * 4n && (target === 0n || have >= minOrder);
  if (closeEnough) return [];
  const actions = mine.map((o) => ({ op: 'cancel', ref: String(o.short_id), side, reason: `replace ${o.price_usdt} remaining ${fromUnits(remainingSats(o), BTQ_DP)}` }));
  if (target >= minOrder) actions.push({ op: 'post', side, price, amountBtq: fromUnits(target, BTQ_DP) });
  return actions;
}

function selfCheck() {
  const duty = { mid: '2.50', spreadPct: '2', clipBtq: '100' };
  const overview = {
    settings: { book_paused: false, mm_min_spread_pct: '0.5', min_order_btq: '0.1', mm_max_order_btq: '500', mm_max_notional_usdt: '100000' },
    inventory: { btq: '1000.00000000', btqCommitted: '0.00000000', usdt: '100000.000000', usdtCommitted: '0.000000' },
  };
  const empty = plan(duty, overview, { orders: [] });
  assert(empty.bid === '2.475000' && empty.ask === '2.525000', JSON.stringify(empty));
  assert(empty.actions.length === 2, 'expected two posts');

  const seeded = plan(duty, overview, {
    orders: [
      { short_id: '1', side: 'sell', price_usdt: '2.550000', amount_btq: '100.00000000', filled_btq: '0.00000000', status: 'open' },
      { short_id: '2', side: 'buy', price_usdt: '2.450000', amount_btq: '100.00000000', filled_btq: '0.00000000', status: 'open' },
    ],
  });
  assert(seeded.actions.filter((a) => a.op === 'cancel').length === 2, 'seeded prices must be replaced');
  assert(seeded.actions.filter((a) => a.op === 'post').every((a) => a.price === '2.475000' || a.price === '2.525000'), 'posts at the 2% quote');

  const healthy = plan(duty, overview, {
    orders: [
      { short_id: '3', side: 'sell', price_usdt: '2.525000', amount_btq: '100.00000000', filled_btq: '10.00000000', status: 'partially_filled' },
      { short_id: '4', side: 'buy', price_usdt: '2.475000', amount_btq: '100.00000000', filled_btq: '0.00000000', status: 'open' },
    ],
  });
  assert(healthy.actions.length === 0, '90 and 100 at the right prices stay up');

  const thin = plan(duty, { ...overview, inventory: { ...overview.inventory, btq: '0.05000000' } }, { orders: [] });
  assert(!thin.actions.some((a) => a.side === 'sell'), 'a side under the minimum is not posted');
  assert(thin.actions.some((a) => a.side === 'buy' && a.op === 'post'), 'the funded side still posts');

  const paused = plan(duty, { ...overview, settings: { ...overview.settings, book_paused: true } }, { orders: [] });
  assert(paused.actions.length === 0 && paused.paused === true, 'a paused book is left alone');

  let rejected = false;
  try {
    plan({ ...duty, spreadPct: '0.4' }, overview, { orders: [] });
  } catch (err) {
    rejected = err.status === 2;
  }
  assert(rejected, 'a spread under the floor must be rejected');
  process.stdout.write('mm-quote self-check ok\n');
}

function assert(cond, message) {
  if (!cond) {
    process.stderr.write(`self-check failed: ${message}\n`);
    process.exit(1);
  }
}

if (process.argv.includes('--self-check')) {
  selfCheck();
} else {
  try {
    const [dutyPath, overviewPath, ordersPath] = process.argv.slice(2);
    if (!dutyPath || !overviewPath || !ordersPath) fail('usage: mm-quote.mjs <duty.json> <overview.json> <orders.json>');
    const { readFileSync } = await import('node:fs');
    const out = plan(JSON.parse(readFileSync(dutyPath, 'utf8')), JSON.parse(readFileSync(overviewPath, 'utf8')), JSON.parse(readFileSync(ordersPath, 'utf8')));
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } catch (err) {
    if (err.status === 2) {
      process.stdout.write(JSON.stringify({ error: err.message }) + '\n');
      process.exit(2);
    }
    throw err;
  }
}
