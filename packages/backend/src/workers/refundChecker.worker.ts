import { getMany } from '../lib/db';
import { SwapRow, SwapStatus, SwapDirection, TERMINAL_STATUSES } from '../types/swap.types';
import { swapService } from '../services/swap.service';
import { evmService } from '../services/evm.service';
import { btqService } from '../services/btq.service';
import { config } from '../config';
import { bufToHex } from '../lib/crypto';

const POLL_INTERVAL_MS = 60_000;

export class RefundCheckerWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  start(): void {
    if (this.timer) return;
    console.log('[RefundChecker] Starting poll loop');
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    this.poll();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log('[RefundChecker] Stopped');
  }

  private async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      await this.checkExpiredEvmHtlcs();
      await this.checkExpiredBtqHtlcs();
      await this.checkStaleSwaps();
    } catch {
      // External services unavailable — skip silently
    } finally {
      this.running = false;
    }
  }

  private async checkExpiredEvmHtlcs(): Promise<void> {
    const swaps = await getMany<SwapRow>(
      `SELECT * FROM swaps
       WHERE evm_htlc_swap_id IS NOT NULL
         AND timelock_evm < now()
         AND status NOT IN ('completed', 'refunded', 'expired', 'failed')
         AND evm_refund_tx_hash IS NULL`,
    );

    for (const swap of swaps) {
      try {
        const evmSwapIdHex = '0x' + bufToHex(swap.evm_htlc_swap_id!);
        const evmSwap = await evmService.getSwap(evmSwapIdHex);

        if (evmSwap.state === 1) {
          // OPEN — can refund
          const shouldPlatformRefund =
            (swap.direction === SwapDirection.SELL_BTQ && swap.btq_htlc_created_by === 'platform') ||
            (swap.direction === SwapDirection.BUY_BTQ);

          if (shouldPlatformRefund) {
            console.log(`[RefundChecker] Refunding expired EVM HTLC for swap ${swap.id}`);
            const txHash = await evmService.refundSwap(evmSwapIdHex);
            await swapService.refundSwap(swap.id, `EVM HTLC expired, refunded: ${txHash}`);
          } else {
            await swapService.expireSwap(swap.id);
          }
        }
      } catch (err) {
        console.error(`[RefundChecker] Error refunding EVM HTLC for swap ${swap.id}:`, err);
      }
    }
  }

  private async checkExpiredBtqHtlcs(): Promise<void> {
    let currentBlock: number;
    try {
      currentBlock = await btqService.getBlockCount();
    } catch {
      return; // btq-core not available
    }

    const swaps = await getMany<SwapRow>(
      `SELECT * FROM swaps
       WHERE btq_htlc_txid IS NOT NULL
         AND timelock_btq <= $1
         AND status NOT IN ('completed', 'refunded', 'expired', 'failed')
         AND btq_refund_txid IS NULL`,
      [currentBlock],
    );

    for (const swap of swaps) {
      try {
        const platformCreated = swap.btq_htlc_created_by === 'platform';

        if (platformCreated && swap.refund_leaf_hex && swap.control_block_hex) {
          console.log(`[RefundChecker] Refunding expired BTQ HTLC for swap ${swap.id}`);
          const refundTxid = await btqService.refundHtlc(
            swap.btq_htlc_txid!,
            swap.btq_htlc_vout!,
            config.PLATFORM_BTQ_ADDRESS,
            10,
            swap.refund_leaf_hex,
            swap.control_block_hex,
          );
          await swapService.refundSwap(swap.id, `BTQ HTLC expired, refunded: ${refundTxid}`);
        } else {
          await swapService.expireSwap(swap.id);
        }
      } catch (err) {
        console.error(`[RefundChecker] Error refunding BTQ HTLC for swap ${swap.id}:`, err);
      }
    }
  }

  private async checkStaleSwaps(): Promise<void> {
    // Only expire swaps from explicit waiting states with chain-backed deadlines.
    let currentBlock: number | null = null;
    try {
      currentBlock = await btqService.getBlockCount();
    } catch {
      currentBlock = null;
    }

    const swaps = await getMany<SwapRow>(
      `SELECT * FROM swaps
       WHERE status IN (
         'awaiting_evm_lock',
         'awaiting_user_btq_claim',
         'awaiting_user_btq_htlc',
         'awaiting_user_usdt_claim'
       )`,
    );

    for (const swap of swaps) {
      try {
        const evmDeadlineExpired = !!swap.timelock_evm && swap.timelock_evm.getTime() <= Date.now();
        const btqDeadlineExpired = currentBlock !== null
          && typeof swap.timelock_btq === 'number'
          && swap.timelock_btq <= currentBlock;
        const shouldExpire = evmDeadlineExpired || btqDeadlineExpired;

        if (!shouldExpire) continue;
        console.log(`[RefundChecker] Expiring deadline-reached swap ${swap.id} in status ${swap.status}`);
        await swapService.expireSwap(swap.id);
      } catch (err) {
        console.error(`[RefundChecker] Error expiring stale swap ${swap.id}:`, err);
      }
    }
  }
}

export const refundCheckerWorker = new RefundCheckerWorker();
