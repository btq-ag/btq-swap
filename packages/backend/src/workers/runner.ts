import { config } from '../config';
import { btqChain } from '../chains/btq';
import { createLogger } from '../lib/logger';
import { setBtqTipProvider } from '../domain/settlement';
import { btqStatus, btqTick, processLockHints } from './btq-watcher';
import { evmTick } from './evm-watcher';
import { solanaTick } from './solana-watcher';
import { feedTick } from './feed';
import { notifierTick } from './notifier';
import { platformTick } from './platform-agent';

const log = createLogger('runner');

export interface RunnerHandle {
  stop(): Promise<void>;
}

/**
 * Two serialized loops:
 *  - settlement: BTQ watcher → EVM watcher → lock hints → platform agent (order matters: observe, then act)
 *  - comms: outbox DMs + Discord feed (slow network I/O never delays settlement)
 */
export function startWorkers(): RunnerHandle {
  let stopped = false;
  setBtqTipProvider(async () => (await btqChain().tip()).height);

  const loop = async (name: string, everyMs: number, fn: () => Promise<void>) => {
    while (!stopped) {
      const started = Date.now();
      try {
        await fn();
      } catch (err) {
        log.error(`${name} tick failed`, { err: (err as Error).message });
      }
      const wait = Math.max(200, everyMs - (Date.now() - started));
      await new Promise((r) => setTimeout(r, wait));
    }
  };

  const settlement = loop('settlement', config().WORKER_TICK_MS, async () => {
    const tip = await btqTick();
    await evmTick(async () => btqStatus.tip || tip);
    await solanaTick();
    await processLockHints();
    await platformTick(tip);
  });
  const comms = loop('comms', 2500, async () => {
    await notifierTick();
    await feedTick();
  });

  log.info('workers started', { tickMs: config().WORKER_TICK_MS });
  return {
    async stop() {
      stopped = true;
      await Promise.race([Promise.all([settlement, comms]), new Promise((r) => setTimeout(r, 5000))]);
    },
  };
}
