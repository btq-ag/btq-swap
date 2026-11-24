/**
 * One thousand simulated users post a two-sided book, then trade through it.
 * Run inside the api container: node /tmp/crowd.js
 * Orders land on the live book the desk polls. They do not cross the market maker.
 */
const crypto = require('node:crypto');
const { db, closePool } = require('/app/packages/backend/dist/lib/db');
const { placeOrder } = require('/app/packages/backend/dist/domain/book');
const { resolveEvmAddresses } = require('/app/packages/backend/dist/domain/runtime');

const USERS = Number(process.env.CROWD_USERS ?? '1000');
const GAP_MS = Number(process.env.CROWD_GAP_MS ?? '40');
const HOLD_MS = Number(process.env.CROWD_HOLD_MS ?? '8000');
const SLICE = process.env.CROWD_SLICE ?? '4';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function hex(n, bytes) {
  let out = '';
  let i = 0;
  while (out.length < bytes * 2) {
    out += crypto.createHash('sha256').update(`crowd:${n}:${i}`).digest('hex');
    i++;
  }
  return out.slice(0, bytes * 2);
}

function levels(count, start, step, weights) {
  const out = [];
  weights.forEach((weight, i) => {
    const price = (start + step * i).toFixed(6);
    const size = (1.6 - i * 0.1).toFixed(1);
    for (let k = 0; k < weight; k++) out.push({ price, amountBtq: size });
  });
  if (out.length !== count) throw new Error(`expected ${count} orders, built ${out.length}`);
  return out;
}

async function insertUsers(rows) {
  const chunk = 100;
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const values = [];
    const params = [];
    part.forEach((u, n) => {
      const b = n * 5;
      values.push(`($${b + 1}, $${b + 2}, true, $${b + 3}, now(), $${b + 4}, $${b + 5}, now(), now(), '2026-11-12', false)`);
      params.push(u.id, u.discordId, u.eth, u.pubkey, u.btq);
    });
    await db().query(
      `INSERT INTO users (id, discord_id, is_simulated, eth_address, eth_verified_at, dilithium_pubkey, btq_address, btq_pubkey_verified_at, tos_accepted_at, tos_version, notifications_enabled)
       VALUES ${values.join(',')}
       ON CONFLICT (discord_id) DO NOTHING`,
      params,
    );
  }
}

async function main() {
  const contracts = await resolveEvmAddresses();
  console.log('contracts', contracts.htlc, contracts.token);
  const half = USERS / 2;
  const weights = [90, 80, 70, 60, 50, 40, 30, 24, 20, 16, 12, 8];
  if (weights.reduce((s, n) => s + n, 0) !== half) throw new Error('weights must sum to half the crowd');
  const asks = levels(half, 2.501, 0.004, weights);
  const bids = levels(half, 2.44, -0.02, weights);
  const makers = [];
  for (let i = 0; i < USERS; i++) {
    const discordId = `crowd:${String(i).padStart(4, '0')}`;
    makers.push({
      id: crypto.randomUUID(),
      discordId,
      eth: '0x' + hex(i, 20),
      pubkey: hex(10000 + i, 1312),
      btq: 'qcrt1crowd' + hex(i, 16),
      side: i < half ? 'sell' : 'buy',
      quote: i < half ? asks[i] : bids[i - half],
    });
  }
  const takers = Array.from({ length: 20 }, (_, i) => {
    const n = 5000 + i;
    return {
      id: crypto.randomUUID(),
      discordId: `crowd:taker:${i}`,
      eth: '0x' + hex(n, 20),
      pubkey: hex(20000 + i, 1312),
      btq: 'qcrt1taker' + hex(n, 16),
    };
  });

  console.log(`inserting ${makers.length + takers.length} users`);
  await insertUsers([...makers, ...takers]);
  await db().query(
    `UPDATE orders SET status = 'cancelled', updated_at = now()
      WHERE status IN ('open', 'partially_filled')
        AND user_id IN (SELECT id FROM users WHERE discord_id LIKE 'crowd:%')`,
  );
  const ids = await db().query('SELECT id, discord_id FROM users WHERE discord_id LIKE $1', ['crowd:%']);
  const byDiscord = new Map(ids.rows.map((r) => [r.discord_id, r.id]));

  console.log(`posting ${USERS} orders, ${GAP_MS}ms apart`);
  let posted = 0;
  const order = [...makers];
  // Interleave bids and asks so both sides of the chart grow together.
  order.sort((a, b) => (a.quote.price < b.quote.price ? -1 : 1));
  const interleaved = [];
  const sells = order.filter((u) => u.side === 'sell');
  const buys = order.filter((u) => u.side === 'buy');
  for (let i = 0; i < Math.max(sells.length, buys.length); i++) {
    if (sells[i]) interleaved.push(sells[i]);
    if (buys[i]) interleaved.push(buys[i]);
  }
  for (const u of interleaved) {
    const userId = byDiscord.get(u.discordId);
    if (!userId) throw new Error(`missing user ${u.discordId}`);
    try {
      await placeOrder(userId, { side: u.side, amountBtq: u.quote.amountBtq, price: u.quote.price });
      posted++;
      if (posted % 50 === 0) console.log(`posted ${posted}/${USERS}`);
    } catch (err) {
      console.error(`post failed ${u.discordId}`, err.message);
    }
    await sleep(GAP_MS);
  }
  console.log(`book is up (${posted} orders). holding ${HOLD_MS}ms`);
  await sleep(HOLD_MS);

  console.log('crossing the crowd asks into HTLC swaps, without touching the market maker');
  let swaps = 0;
  let takerN = 0;
  const askPrices = [...new Set(asks.map((a) => a.price))].sort();
  for (const price of askPrices) {
    const row = await db().query(
      `SELECT COALESCE(SUM(amount_btq - filled_btq), 0)::text AS left
         FROM orders o JOIN users u ON u.id = o.user_id
        WHERE o.side = 'sell' AND o.price_usdt = $1 AND o.status IN ('open','partially_filled') AND u.discord_id LIKE 'crowd:%'`,
      [price],
    );
    let left = Number(row.rows[0].left);
    while (left >= 0.1) {
      const taker = takers[takerN % takers.length];
      takerN++;
      const userId = byDiscord.get(taker.discordId);
      const amount = Math.min(Number(SLICE), Math.floor(left * 10) / 10);
      const size = amount >= 0.1 ? amount.toFixed(1) : left.toFixed(8);
      try {
        const result = await placeOrder(userId, { side: 'buy', amountBtq: size, price });
        swaps += result.swaps.length;
        left -= Number(size);
        if (swaps % 25 === 0) console.log(`htlc swaps ${swaps}, working ${price}`);
      } catch (err) {
        console.error(`take failed @ ${price}`, err.message);
        break;
      }
      await sleep(180);
    }
  }
  console.log(`done. posted ${posted} orders, opened ${swaps} HTLC swaps`);
  await closePool();
}

main().catch(async (err) => {
  console.error(err);
  try { await closePool(); } catch { /* already closed */ }
  process.exit(1);
});
