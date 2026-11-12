/**
 * Devnet bootstrap (idempotent): migrate, BTQ wallets + mature coins, deploy MockUSDT + HtlcERC20 on anvil,
 * platform user, seed MM quotes. Safe to run on every `docker compose up`.
 */
import path from 'node:path';
import { config } from '../config';
import { btqChain } from '../chains/btq';
import { evmChain } from '../chains/evm';
import { db, one, closePool } from '../lib/db';
import { createLogger } from '../lib/logger';
import { mmOrders, postMmOrder } from '../domain/book';
import { seedAdmins } from '../domain/identity';
import { refreshInventory } from '../domain/inventory';
import { ensurePlatformUser } from '../domain/platform';
import { adminDiscordIds } from '../config';

const log = createLogger('bootstrap');

async function waitFor(name: string, fn: () => Promise<unknown>, timeoutMs = 180_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fn();
      return;
    } catch (err) {
      if (Date.now() > end) throw new Error(`${name} not reachable: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

export async function bootstrap(): Promise<void> {
  const c = config();
  if (!c.DEVNET) throw new Error('bootstrap only runs with DEVNET=1');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { migrate } = require(path.join(__dirname, '..', '..', 'scripts', 'migrate.js')) as { migrate: (url: string) => Promise<number> };
  await migrate(c.DATABASE_URL);

  const btq = btqChain();
  const evm = evmChain();
  await waitFor('btqd', () => btq.tip());
  await waitFor('anvil', () => evm.blockNumber());

  // ── BTQ: platform wallet with mature coins ──
  await btq.ensureWallet(c.BTQ_PLATFORM_WALLET);
  const targetSats = BigInt(process.env.DEVNET_PLATFORM_MIN_BTQ ?? '1000') * 100_000_000n;
  for (let round = 0; round < 8 && (await btq.platformBalanceSats(1)) < targetSats; round++) {
    const addr = await btq.platformAddress('coinbase');
    log.info('mining 150 regtest blocks to the platform wallet (coinbase maturity is 100)');
    await btq.platform.call('generatetoaddress', [150, addr]);
  }
  log.info('platform BTQ balance', { btq: Number(await btq.platformBalanceSats(1)) / 1e8, height: (await btq.tip()).height });

  // ── EVM: contracts (redeploy if anvil lost its state) ──
  const prev = await one<{ value: { htlc: string; token: string } }>(db(), `SELECT value FROM devnet_state WHERE key = 'evm_contracts'`);
  let addrs = prev?.value ?? null;
  if (!addrs || !(await evm.hasCode(addrs.htlc)) || !(await evm.hasCode(addrs.token))) {
    log.info('deploying MockUSDT + HtlcERC20');
    addrs = await evm.deployDevContracts(50_000_000n * 10n ** BigInt(c.USDT_DECIMALS));
    await db().query(
      `INSERT INTO devnet_state (key, value) VALUES ('evm_contracts', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify({ ...addrs, deployedAt: new Date().toISOString(), deployer: evm.platformAddress })],
    );
    await db().query(`DELETE FROM chain_cursors WHERE chain = 'evm'`);
  }
  evm.setAddresses(addrs);
  log.info('EVM contracts', addrs);

  // ── platform identity + admins ──
  await ensurePlatformUser();
  await seedAdmins(adminDiscordIds());

  // ── MM quotes ──
  await refreshInventory();
  const open = (await mmOrders()).filter((o) => ['open', 'partially_filled'].includes(o.status));
  const size = process.env.DEVNET_MM_SIZE_BTQ ?? '100';
  const ask = process.env.DEVNET_MM_ASK ?? '2.55';
  const bid = process.env.DEVNET_MM_BID ?? '2.45';
  if (!open.some((o) => o.side === 'sell')) {
    await postMmOrder({ side: 'sell', price: ask, amountBtq: size }, 'bootstrap');
    log.info(`seeded MM ask ${size} @ ${ask}`);
  }
  if (!open.some((o) => o.side === 'buy')) {
    await postMmOrder({ side: 'buy', price: bid, amountBtq: size }, 'bootstrap');
    log.info(`seeded MM bid ${size} @ ${bid}`);
  }
  log.info('bootstrap complete');
}

if (require.main === module) {
  bootstrap()
    .then(() => closePool())
    .catch((err) => {
      console.error('[bootstrap] failed', err);
      process.exit(1);
    });
}
