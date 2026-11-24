/**
 * Devnet bootstrap (idempotent): migrate, BTQ wallets + mature coins, deploy MockUSDT + HtlcERC20 on anvil,
 * platform user, seed MM quotes. Safe to run on every `docker compose up`.
 */
import path from 'node:path';
import { config } from '../config';
import { btqChain } from '../chains/btq';
import { EvmChain, evmChain } from '../chains/evm';

export const DEFAULT_FAUCET_KEY = '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6'; // anvil dev account #9
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

  // ── EVM: gas for the platform and faucet keys (devnet chain only: anvil_setBalance) ──
  const faucetAddress = new EvmChain({ url: c.EVM_RPC_URL, chainId: c.EVM_CHAIN_ID, privateKey: process.env.DEVNET_FAUCET_EVM_KEY ?? DEFAULT_FAUCET_KEY }).platformAddress;
  for (const addr of [evm.platformAddress, faucetAddress]) {
    if ((await evm.ethBalance(addr)) < 100n * 10n ** 18n) {
      await evm.provider.send('anvil_setBalance', [addr, '0x' + (10_000n * 10n ** 18n).toString(16)]);
      log.info('set devnet ETH balance', { addr });
    }
  }

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

  // ── devnet faucet (separate keys so simulations never race the platform agent's nonces/coins) ──
  const faucetKey = process.env.DEVNET_FAUCET_EVM_KEY ?? DEFAULT_FAUCET_KEY;
  const faucet = new EvmChain({ url: c.EVM_RPC_URL, chainId: c.EVM_CHAIN_ID, privateKey: faucetKey });
  faucet.setAddresses(addrs);
  const faucetUsdt = await evm.tokenBalance(faucet.platformAddress);
  if (faucetUsdt < 1_000_000n * 10n ** BigInt(c.USDT_DECIMALS)) {
    await evm.platformTransferToken(faucet.platformAddress, 10_000_000n * 10n ** BigInt(c.USDT_DECIMALS));
    log.info('funded devnet faucet with USDT', { faucet: faucet.platformAddress });
  }
  const fw = await btq.ensureWallet('faucet');
  for (let round = 0; round < 8; round++) {
    const b = await fw.call<{ mine: { trusted: number } }>('getbalances');
    if (b.mine.trusted >= Number(process.env.DEVNET_FAUCET_MIN_BTQ ?? '2000')) break;
    const a = await fw.call<string>('getnewaddress', ['coinbase']);
    log.info('mining 150 regtest blocks to the faucet wallet');
    await fw.call('generatetoaddress', [150, a]);
  }

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
