import { getMany } from '../lib/db';
import { swapService } from '../services/swap.service';
import { evmService } from '../services/evm.service';
import { notificationService } from '../services/notification.service';
import { bufToHex } from '../lib/crypto';
import { SwapDirection, SwapRow, SwapStatus, TERMINAL_STATUSES } from '../types/swap.types';

const POLL_INTERVAL_MS = 45_000;

export class ReconciliationWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  start(): void {
    if (this.timer) return;
    console.log('[Reconcile] Starting poll loop');
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    this.poll();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log('[Reconcile] Stopped');
  }

  private async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const swaps = await getMany<SwapRow>(
        `SELECT *
         FROM swaps
         WHERE evm_htlc_swap_id IS NOT NULL
           AND status NOT IN ('completed', 'refunded', 'expired', 'failed')`,
      );
      for (const swap of swaps) {
        await this.reconcileSwap(swap);
      }
    } catch (err) {
      console.error('[Reconcile] Poll error:', err);
    } finally {
      this.running = false;
    }
  }

  private async reconcileSwap(swap: SwapRow): Promise<void> {
    if (!swap.evm_htlc_swap_id || TERMINAL_STATUSES.includes(swap.status)) return;
    const evmSwapIdHex = '0x' + bufToHex(swap.evm_htlc_swap_id);

    try {
      const evmSwap = await evmService.getSwap(evmSwapIdHex);

      // OPEN state: make sure DB is advanced to the expected waiting state.
      if (evmSwap.state === 1) {
        if (swap.direction === SwapDirection.BUY_BTQ && swap.status === SwapStatus.AWAITING_EVM_LOCK) {
          await swapService.verifyEvmLock(swap.id);
          notificationService.emitOrderRefreshHint({
            userId: swap.user_id,
            reason: 'reconciliation_evm_lock_verified',
            swapId: swap.id,
          });
          return;
        }
        if (swap.direction === SwapDirection.SELL_BTQ && swap.status === SwapStatus.EVM_HTLC_CREATED) {
          await swapService.markAwaitingUserUsdtClaim(swap.id);
          notificationService.emitOrderRefreshHint({
            userId: swap.user_id,
            reason: 'reconciliation_user_claim_ready',
            swapId: swap.id,
          });
          return;
        }
      }

      // CLOSED state: recover missed claim events by pulling secret from chain logs.
      if (
        evmSwap.state === 2
        && swap.direction === SwapDirection.SELL_BTQ
        && (swap.status === SwapStatus.EVM_HTLC_CREATED || swap.status === SwapStatus.AWAITING_USER_USDT_CLAIM)
      ) {
        const secret = await evmService.getSecretFromClaim(evmSwapIdHex);
        if (secret) {
          await swapService.handleUserClaimedUsdt(swap.id, secret);
          notificationService.emitOrderRefreshHint({
            userId: swap.user_id,
            reason: 'reconciliation_claim_detected',
            swapId: swap.id,
          });
        }
        return;
      }

      // EXPIRED state: if still non-terminal in DB, force terminal status.
      if (evmSwap.state === 3 && !TERMINAL_STATUSES.includes(swap.status)) {
        await swapService.expireSwap(swap.id);
        notificationService.emitOrderRefreshHint({
          userId: swap.user_id,
          reason: 'reconciliation_swap_expired',
          swapId: swap.id,
        });
      }
    } catch (err) {
      console.error(`[Reconcile] Swap ${swap.id} reconciliation error:`, err);
    }
  }
}

export const reconciliationWorker = new ReconciliationWorker();
