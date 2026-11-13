/**
 * Stress: 1000 funded users trade at once.
 * Run inside the api container: node /tmp/stress.js
 *
 * ETH is credited with anvil_setBalance. USDT is minted with automine on so
 * a thousand transfers do not wait out the 2s block clock. BTQ is one sendmany.
 * Orders are placed with 48 in flight so matching, trades, and the book are under load.
 */
const crypto = require('node:crypto');
const { Contract, JsonRpcProvider, Wallet } = require('ethers');
const { db, closePool } = require('/app/packages/backend/dist/lib/db');
const { placeOrder } = require('/app/packages/backend/dist/domain/book');
const { resolveEvmAddresses } = require('/app/packages/backend/dist/domain/runtime');
const { config } = require('/app/packages/backend/dist/config');
const { btqChain } = require('/app/packages/backend/dist/chains/btq');

const USERS = Number(process.env.STRESS_USERS ?? '1000');
const IN_FLIGHT = Number(process.env.STRESS_IN_FLIGHT ?? '48');
const USDT = 50_000_000n; // 50 USDT at 6 decimals

function hex(n, bytes) {
  let out = '';
  let i = 0;
  while (out.length < bytes * 2) {
    out += crypto.createHash('sha256').update(`stress:${n}:${i}`).digest('hex');
    i++;
  }
  return out.slice(0, bytes * 2);
}

async function pool(items, limit, fn) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
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
       ON CONFLICT (discord_id) DO UPDATE SET eth_address = EXCLUDED.eth_address, dilithium_pubkey = EXCLUDED.dilithium_pubkey, btq_address = EXCLUDED.btq_address`,
      params,
    );
  }
}

async function main() {
  const c = config();
  if (!c.DEVNET || c.BTQ_NETWORK !== 'regtest' || c.EVM_CHAIN_ID !== 31337) {
    throw new Error('stress runs only on the devnet');
  }
  const contracts = await resolveEvmAddresses();
  console.log('contracts', contracts.htlc, contracts.token);

  const half = USERS / 2;
  const people = Array.from({ length: USERS }, (_, i) => ({
    id: crypto.randomUUID(),
    discordId: `stress:${String(i).padStart(4, '0')}`,
    eth: '0x' + hex(i, 20),
    pubkey: hex(30000 + i, 1312),
    btq: '',
    side: i < half ? 'sell' : 'buy',
    price: (i < half ? 2.501 + (i % 12) * 0.004 : 2.44 - (i % 12) * 0.015).toFixed(6),
    amountBtq: '0.5',
  }));

  console.log('creating a BTQ wallet and 1000 addresses');
  const btq = btqChain();
  const stressWallet = await btq.ensureWallet('stress');
  for (const p of people) p.btq = await stressWallet.call('getnewaddress', [p.discordId]);

  console.log('crediting ETH');
  const provider = new JsonRpcProvider(c.EVM_RPC_URL);
  await pool(people, 40, async (p) => {
    await provider.send('anvil_setBalance', [p.eth, '0x' + (5n * 10n ** 18n).toString(16)]);
  });

  console.log('sending USDT from the faucet with automine');
  await provider.send('anvil_setIntervalMining', [0]);
  await provider.send('evm_setAutomine', [true]);
  try {
    const read = new Contract(contracts.token, ['function balanceOf(address) view returns (uint256)'], provider);
    const faucetKey = process.env.DEVNET_FAUCET_EVM_KEY;
    const platformKey = process.env.EVM_PRIVATE_KEY;
    let signer = new Wallet(faucetKey, provider);
    let bal = await read.balanceOf(signer.address);
    if (bal < USDT * BigInt(people.length)) {
      signer = new Wallet(platformKey, provider);
      bal = await read.balanceOf(signer.address);
    }
    console.log('usdt source', signer.address, bal.toString());
    if (bal < USDT * BigInt(people.length)) throw new Error('not enough USDT to fund the crowd');
    const token = new Contract(contracts.token, ['function transfer(address to, uint256 amount) returns (bool)'], signer);
    let nonce = await signer.getNonce();
    for (let i = 0; i < people.length; i++) {
      const tx = await token.transfer(people[i].eth, USDT, { nonce: nonce++ });
      await tx.wait();
      if ((i + 1) % 100 === 0) console.log(`funded USDT ${i + 1}/${people.length}`);
    }
  } finally {
    await provider.send('anvil_setIntervalMining', [2]).catch(() => undefined);
  }
  console.log('USDT minted');

  console.log('sending BTQ in one transaction');
  try {
    const fw = btq.wallet('faucet');
    const outputs = {};
    for (const p of people) outputs[p.btq] = 0.2;
    const txid = await fw.call('sendmany', ['', outputs, 0, 'stress fund']);
    console.log('BTQ funded', txid);
  } catch (err) {
    console.error('BTQ sendmany failed', err.message);
  }

  console.log(`inserting ${people.length} users`);
  await insertUsers(people);
  await db().query(
    `UPDATE orders SET status = 'cancelled', updated_at = now()
      WHERE status IN ('open','partially_filled')
        AND user_id IN (SELECT id FROM users WHERE discord_id LIKE 'crowd:%' OR discord_id LIKE 'stress:%')`,
  );
  const ids = await db().query(`SELECT id, discord_id FROM users WHERE discord_id LIKE 'stress:%'`);
  const byDiscord = new Map(ids.rows.map((r) => [r.discord_id, r.id]));

  console.log(`placing ${USERS} orders with ${IN_FLIGHT} in flight`);
  let posted = 0;
  let swaps = 0;
  let failed = 0;
  const sellers = people.filter((p) => p.side === 'sell');
  const buyers = people.filter((p) => p.side === 'buy');
  await pool(sellers, IN_FLIGHT, async (p) => {
    try {
      const result = await placeOrder(byDiscord.get(p.discordId), { side: 'sell', amountBtq: p.amountBtq, price: p.price });
      posted++;
      swaps += result.swaps.length;
    } catch (err) {
      failed++;
      if (failed < 8) console.error('sell failed', p.discordId, err.message);
    }
  });
  console.log(`asks resting: posted ${posted}, failed ${failed}. buyers crossing now`);
  await pool(buyers, IN_FLIGHT, async (p, i) => {
    const ask = sellers[i % sellers.length];
    try {
      const result = await placeOrder(byDiscord.get(p.discordId), { side: 'buy', amountBtq: p.amountBtq, price: ask.price });
      posted++;
      swaps += result.swaps.length;
      if (posted % 100 === 0) console.log(`progress posted ${posted} swaps ${swaps}`);
    } catch (err) {
      failed++;
      if (failed < 12) console.error('buy failed', p.discordId, err.message);
    }
  });

  const trades = await db().query(`SELECT count(*)::text AS n FROM trades WHERE created_at > now() - interval '10 minutes'`);
  console.log(`done. posted ${posted}, failed ${failed}, swaps this run ${swaps}, trades in the last 10 minutes ${trades.rows[0].n}`);
  await closePool();
}

main().catch(async (err) => {
  console.error(err);
  try { await closePool(); } catch { /* pool already closed */ }
  process.exit(1);
});
