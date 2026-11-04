import { getMany } from '../lib/db';
import { SwapRow, SwapStatus, SwapDirection } from '../types/swap.types';
import { btqService } from '../services/btq.service';
import { swapService } from '../services/swap.service';

const POLL_INTERVAL_MS = 30_000;
const REQUIRED_CONFIRMATIONS = 1;

export class BtqMonitorWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  start(): void {
    if (this.timer) return;
    console.log('[BtqMonitor] Starting poll loop');
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    this.poll();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log('[BtqMonitor] Stopped');
  }

  private async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      await this.checkBtqHtlcConfirmations();
      await this.checkBtqClaimTransactions();
    } catch {
      // btq-core not available — skip silently
    } finally {
      this.running = false;
    }
  }

  private async checkBtqHtlcConfirmations(): Promise<void> {
    const swaps = await getMany<SwapRow>(
      `SELECT * FROM swaps
       WHERE status = $1 AND btq_htlc_txid IS NOT NULL AND direction = $2`,
      [SwapStatus.BTQ_HTLC_VERIFIED, SwapDirection.SELL_BTQ],
    );

    for (const swap of swaps) {
      try {
        const confs = await btqService.getTransactionConfirmations(swap.btq_htlc_txid!);
        if (confs >= REQUIRED_CONFIRMATIONS) {
          await swapService.confirmBtqHtlc(swap.id, confs);
          console.log(`[BtqMonitor] Swap ${swap.id} BTQ HTLC confirmed (${confs} confs)`);
        }
      } catch (err) {
        console.error(`[BtqMonitor] Error checking confs for swap ${swap.id}:`, err);
      }
    }
  }

  private async checkBtqClaimTransactions(): Promise<void> {
    const swaps = await getMany<SwapRow>(
      `SELECT * FROM swaps
       WHERE status = $1 AND btq_htlc_txid IS NOT NULL`,
      [SwapStatus.AWAITING_USER_BTQ_CLAIM],
    );

    for (const swap of swaps) {
      try {
        const utxos = await btqService.listUnspent(0, 9999999);
        const htlcSpent = !(utxos as any[]).some(
          (u: any) => u.txid === swap.btq_htlc_txid && u.vout === swap.btq_htlc_vout,
        );

        if (htlcSpent) {
          console.log(`[BtqMonitor] Swap ${swap.id} BTQ HTLC spent — user likely claimed`);
          await swapService.confirmUserBtqClaim(swap.id, {
            swap_id: swap.id,
            btq_claim_txid: 'detected-on-chain',
          });
        }
      } catch (err) {
        console.error(`[BtqMonitor] Error checking claim for swap ${swap.id}:`, err);
      }
    }
  }
}

export const btqMonitorWorker = new BtqMonitorWorker();
