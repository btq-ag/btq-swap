/** Regtest block clock: one block every BTQ_TARGET_BLOCK_SEC so CLTV timelocks advance in real time. */
import { config } from '../config';
import { btqChain } from '../chains/btq';
import { createLogger } from '../lib/logger';

const log = createLogger('miner');

async function main(): Promise<void> {
  const c = config();
  if (!c.DEVNET) throw new Error('miner only runs with DEVNET=1');
  const btq = btqChain();
  for (;;) {
    try {
      const w = await btq.ensureWallet(c.BTQ_PLATFORM_WALLET);
      const addr = await w.call<string>('getnewaddress', ['coinbase']);
      for (;;) {
        await w.call('generatetoaddress', [1, addr]);
        const tip = await btq.tip();
        if (tip.height % 20 === 0) log.info('block', { height: tip.height });
        await new Promise((r) => setTimeout(r, c.BTQ_TARGET_BLOCK_SEC * 1000));
      }
    } catch (err) {
      log.warn('mining failed, retrying', { err: (err as Error).message });
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

main().catch((err) => {
  console.error('[miner] fatal', err);
  process.exit(1);
});
