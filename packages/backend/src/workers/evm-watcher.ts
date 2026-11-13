import { config } from '../config';
import { evmChain } from '../chains/evm';
import { db, many } from '../lib/db';
import { createLogger } from '../lib/logger';
import { onEvmClaimed, onEvmLockConfirmations, onEvmLockup, onEvmRefunded } from '../domain/settlement';
import type { SwapRow } from '../domain/types';
import { getCursor, setCursor } from './cursors';

const log = createLogger('evm-watcher');

export interface EvmWatcherStatus {
  head: number;
  cursor: number;
  lag: number;
  lastTickAt: number;
}

export const evmStatus: EvmWatcherStatus = { head: 0, cursor: 0, lag: 0, lastTickAt: 0 };

export async function evmTick(btqTip: () => Promise<number>): Promise<void> {
  const evm = evmChain();
  const head = await evm.blockNumber();
  const nowSec = await evm.latestTimestamp();
  const cur = await getCursor('evm');
  let from = cur ? cur.height + 1 : Math.max(0, head - 5000);
  while (from <= head) {
    const to = Math.min(head, from + config().EVM_LOG_RANGE - 1);
    const events = await evm.logs(from, to);
    for (const ev of events) {
      try {
        if (ev.kind === 'lockup') {
          await onEvmLockup(ev, head, nowSec);
        } else if (ev.kind === 'claimed') {
          const inst = await evm.instance(ev.agreementId);
          await onEvmClaimed(ev.agreementId, ev.txHash, inst.key);
        } else if (ev.kind === 'redeemed') {
          await onEvmRefunded(ev.agreementId, ev.txHash);
        }
      } catch (err) {
        log.error('event handling failed', { kind: ev.kind, tx: ev.txHash, err: (err as Error).message });
        throw err; // do not advance the cursor past an unprocessed event
      }
    }
    await setCursor('evm', to, null);
    from = to + 1;
  }

  // confirmations for locks we have already accepted
  const confirming = await many<SwapRow>(db(), `SELECT * FROM swaps WHERE status = 'buyer_lock_confirming' AND evm_lock_block IS NOT NULL`);
  if (confirming.length) {
    const tip = await btqTip();
    for (const s of confirming) {
      const receipt = await evm.receipt(s.evm_lock_tx!);
      if (!receipt) {
        log.warn('accepted EVM lock tx no longer found (reorg?)', { swap: s.short_id, tx: s.evm_lock_tx });
        continue;
      }
      await onEvmLockConfirmations(s.id, Math.max(0, head - receipt.blockNumber + 1), tip);
    }
  }

  evmStatus.head = head;
  evmStatus.cursor = head;
  evmStatus.lag = 0;
  evmStatus.lastTickAt = Date.now();
}
