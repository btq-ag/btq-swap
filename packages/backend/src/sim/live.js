/**
 * Continuous DEX flow. Runs until SIGINT/SIGTERM.
 * Each wave is 50–1000 simulated people placing a random size
 * at a random price within 5% of the last trade (or the book mid).
 *
 *   node /app/packages/backend/live.js
 */
const crypto = require('node:crypto');
const { Keypair } = require('@solana/web3.js');
const { db, closePool } = require('/app/packages/backend/dist/lib/db');
const { placeOrder } = require('/app/packages/backend/dist/domain/book');
const { resolveEvmAddresses } = require('/app/packages/backend/dist/domain/runtime');

const IN_FLIGHT = Number(process.env.LIVE_IN_FLIGHT ?? '24');
let stop = false;
process.on('SIGINT', () => { stop = true; });
process.on('SIGTERM', () => { stop = true; });

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function solanaAddress(tag) {
  const seed = crypto.createHash('sha256').update(`btq-swap-sol:${tag}`).digest();
  return Keypair.fromSeed(seed).publicKey.toBase58();
}

function hex(n, bytes) {
  let out = '';
  let i = 0;
  while (out.length < bytes * 2) {
    out += crypto.createHash('sha256').update(`live:${n}:${i}`).digest('hex');
    i++;
  }
  return out.slice(0, bytes * 2);
}

async function pool(n, limit, fn) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, n) }, async () => {
    while (cursor < n && !stop) {
      const i = cursor++;
      await fn(i);
    }
  });
  await Promise.all(workers);
}

async function backfillSolana() {
  const missing = await db().query(
    `SELECT id, discord_id FROM users WHERE is_simulated = true AND is_platform = false AND sol_address IS NULL`,
  );
  for (let i = 0; i < missing.rows.length; i += 200) {
    const part = missing.rows.slice(i, i + 200);
    await db().query(
      `UPDATE users u SET sol_address = v.sol
         FROM (SELECT unnest($1::uuid[]) AS id, unnest($2::text[]) AS sol) v
        WHERE u.id = v.id AND u.sol_address IS NULL`,
      [part.map((r) => r.id), part.map((r) => solanaAddress(r.discord_id || r.id))],
    );
  }
  if (process.env.SOLANA_PLATFORM_SECRET) {
    const raw = process.env.SOLANA_PLATFORM_SECRET.trim();
    const loaded = require('bs58');
    const decode = loaded.decode || loaded.default.decode;
    const secret = raw.startsWith('[') ? Uint8Array.from(JSON.parse(raw)) : decode(raw);
    const address = Keypair.fromSecretKey(secret).publicKey.toBase58();
    await db().query(`UPDATE users SET sol_address = $1 WHERE is_platform = true AND sol_address IS DISTINCT FROM $1`, [address]);
  }
}

async function ensurePeople() {
  await backfillSolana();
  const have = await db().query(
    `SELECT id FROM users
      WHERE is_simulated = true AND is_banned = false
        AND eth_address IS NOT NULL AND dilithium_pubkey IS NOT NULL AND tos_accepted_at IS NOT NULL
        AND is_platform = false`,
  );
  if (have.rows.length >= 1000) return have.rows.map((r) => r.id);
  const rows = [];
  for (let i = 0; i < 1000; i++) {
    rows.push({
      id: crypto.randomUUID(),
      discordId: `live:${String(i).padStart(4, '0')}`,
      eth: '0x' + hex(i, 20),
      sol: solanaAddress(`live:${String(i).padStart(4, '0')}`),
      pubkey: hex(80000 + i, 1312),
      btq: 'qcrt1live' + hex(i, 12),
    });
  }
  for (let i = 0; i < rows.length; i += 100) {
    const part = rows.slice(i, i + 100);
    const values = [];
    const params = [];
    part.forEach((u, n) => {
      const b = n * 6;
      values.push(`($${b + 1}, $${b + 2}, true, $${b + 3}, now(), $${b + 4}, $${b + 5}, $${b + 6}, now(), now(), '2026-11-12', false)`);
      params.push(u.id, u.discordId, u.eth, u.sol, u.pubkey, u.btq);
    });
    await db().query(
      `INSERT INTO users (id, discord_id, is_simulated, eth_address, eth_verified_at, sol_address, dilithium_pubkey, btq_address, btq_pubkey_verified_at, tos_accepted_at, tos_version, notifications_enabled)
       VALUES ${values.join(',')}
       ON CONFLICT (discord_id) DO UPDATE SET sol_address = COALESCE(users.sol_address, EXCLUDED.sol_address)`,
      params,
    );
  }
  const again = await db().query(
    `SELECT id FROM users WHERE discord_id LIKE 'live:%' OR (is_simulated = true AND eth_address IS NOT NULL AND dilithium_pubkey IS NOT NULL AND tos_accepted_at IS NOT NULL AND is_platform = false)`,
  );
  return again.rows.map((r) => r.id);
}

async function actualMicro() {
  const trade = await db().query(`SELECT price_usdt::text AS price FROM trades ORDER BY created_at DESC LIMIT 1`);
  if (trade.rows[0]?.price) return Math.round(Number(trade.rows[0].price) * 1e6);
  const book = await db().query(
    `SELECT
       (SELECT price_usdt::text FROM orders WHERE side = 'buy' AND status IN ('open','partially_filled') AND tif = 'gtc' ORDER BY price_usdt DESC LIMIT 1) AS bid,
       (SELECT price_usdt::text FROM orders WHERE side = 'sell' AND status IN ('open','partially_filled') AND tif = 'gtc' ORDER BY price_usdt ASC LIMIT 1) AS ask`,
  );
  const bid = book.rows[0]?.bid ? Math.round(Number(book.rows[0].bid) * 1e6) : 0;
  const ask = book.rows[0]?.ask ? Math.round(Number(book.rows[0].ask) * 1e6) : 0;
  if (bid && ask) return Math.round((bid + ask) / 2);
  return bid || ask || 2_500_000;
}

function makeRegime(bullish, reason) {
  const minutes = crypto.randomInt(1, 21);
  const strength = 62 + crypto.randomInt(0, 24);
  return {
    bullish,
    minutes,
    buyPct: bullish ? strength : 100 - strength,
    until: Date.now() + minutes * 60_000,
    reason: reason || '',
  };
}

function nextRegime() {
  return makeRegime(crypto.randomInt(0, 2) === 0, '');
}

async function restingSides() {
  const r = await db().query(
    `SELECT
       COUNT(*) FILTER (WHERE side = 'buy')::int AS buys,
       COUNT(*) FILTER (WHERE side = 'sell')::int AS sells
     FROM orders
     WHERE status IN ('open','partially_filled') AND tif = 'gtc' AND amount_btq > filled_btq`,
  );
  return { buys: Number(r.rows[0].buys), sells: Number(r.rows[0].sells) };
}

/** A book with only asks needs buyers. A book with only bids needs sellers. */
function forcedByBook(sides) {
  if (sides.sells > 0 && sides.buys === 0) return makeRegime(true, 'only sell orders');
  if (sides.buys > 0 && sides.sells === 0) return makeRegime(false, 'only buy orders');
  return null;
}

async function reconcileRegime(regime) {
  const sides = await restingSides();
  let next = regime;
  let changed = '';
  if (Date.now() >= regime.until) {
    next = nextRegime();
    changed = 'rolled';
  }
  const forced = forcedByBook(sides);
  if (forced && forced.bullish !== next.bullish) {
    return { regime: forced, sides, changed: 'flipped' };
  }
  return { regime: next, sides, changed };
}

function logRegime(regime, sides) {
  const why = regime.reason ? ` because ${regime.reason}` : '';
  const book = ` (bids ${sides.buys}, asks ${sides.sells})`;
  console.log(`regime ${regime.bullish ? 'bullish' : 'bearish'} for ${regime.minutes} min, buy chance ${regime.buyPct}%${why}${book}`);
}

function orderAround(mid, regime) {
  const side = crypto.randomInt(0, 100) < regime.buyPct ? 'buy' : 'sell';
  // Stay inside ±5% of the last price, but lean through the spread in the regime's direction.
  let lo = -500;
  let hi = 500;
  if (regime.bullish && side === 'buy') lo = -80;
  if (regime.bullish && side === 'sell') hi = 180;
  if (!regime.bullish && side === 'sell') hi = 80;
  if (!regime.bullish && side === 'buy') lo = -180;
  const bps = crypto.randomInt(lo, hi + 1);
  const price = Math.max(1, Math.round((mid * (10000 + bps)) / 10000));
  const unit = crypto.randomInt(0, 1_000_000) / 1_000_000;
  const size = Math.max(0.1, Math.round(0.1 * Math.pow(40, unit) * 10) / 10);
  return { side, price: (price / 1e6).toFixed(6), amountBtq: size.toFixed(1) };
}

async function trimFarOrders(mid) {
  const low = (Math.round(mid * 0.92) / 1e6).toFixed(6);
  const high = (Math.round(mid * 1.08) / 1e6).toFixed(6);
  await db().query(
    `UPDATE orders o SET status = 'cancelled', updated_at = now()
       FROM users u
      WHERE o.user_id = u.id AND u.is_simulated = true AND o.is_mm = false
        AND o.status IN ('open','partially_filled')
        AND (o.price_usdt < $1 OR o.price_usdt > $2)`,
    [low, high],
  );
}

async function main() {
  await resolveEvmAddresses();
  const people = await ensurePeople();
  if (people.length < 50) throw new Error('not enough simulated users');
  console.log(`live market running with ${people.length} people. stop with SIGTERM`);
  let wave = 0;
  let regime = nextRegime();
  {
    const opening = await reconcileRegime(regime);
    regime = opening.regime;
    logRegime(regime, opening.sides);
  }
  while (!stop) {
    const step = await reconcileRegime(regime);
    if (step.changed) logRegime(step.regime, step.sides);
    regime = step.regime;
    wave++;
    const mid = await actualMicro();
    const n = crypto.randomInt(50, 1001);
    let placed = 0;
    let trades = 0;
    let failed = 0;
    await pool(n, IN_FLIGHT, async () => {
      const userId = people[crypto.randomInt(0, people.length)];
      const order = orderAround(mid, regime);
      try {
        const result = await placeOrder(userId, order);
        placed++;
        trades += result.swaps.length;
      } catch (err) {
        failed++;
        if (failed <= 3) console.error('order failed', err.message);
      }
    });
    if (wave % 4 === 0) await trimFarOrders(mid).catch((err) => console.error('trim failed', err.message));
    console.log(`wave ${wave}: ${regime.bullish ? 'bull' : 'bear'} ${n} people around ${(mid / 1e6).toFixed(4)}, placed ${placed}, trades ${trades}, failed ${failed}, bids ${step.sides.buys}, asks ${step.sides.sells}`);
    const pause = crypto.randomInt(1200, 4001);
    const end = Date.now() + pause;
    while (!stop && Date.now() < end) await sleep(200);
  }
  console.log('stopped');
  await closePool();
}

main().catch(async (err) => {
  console.error(err);
  try { await closePool(); } catch { /* already closed */ }
  process.exit(1);
});
