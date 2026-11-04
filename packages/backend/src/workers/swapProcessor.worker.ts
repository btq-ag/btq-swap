import { getMany, getOne, query } from '../lib/db';
import { SwapRow, SwapStatus, SwapDirection } from '../types/swap.types';
import { swapService } from '../services/swap.service';

const POLL_INTERVAL_MS = 15_000;
const ACTION_COOLDOWN_MS = 30_000;

interface WorkerActionRow {
  created_at: Date;
}

export class SwapProcessorWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  start(): void {
    if (this.timer) return;
    console.log('[SwapProcessor] Starting poll loop');
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    this.poll();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log('[SwapProcessor] Stopped');
  }

  private async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      await this.processMatchedSwaps();
      await this.processBuyBtqSwaps();
      await this.processSellBtqSwaps();
    } catch {
      // External services unavailable — skip silently
    } finally {
      this.running = false;
    }
  }

  private async processMatchedSwaps(): Promise<void> {
    const matched = await getMany<SwapRow>(
      `SELECT * FROM swaps WHERE status = 'pending' AND order_id IS NOT NULL`,
    );
    for (const swap of matched) {
      try {
        await swapService.processMatchedSwap(swap.id);
      } catch (err) {
        console.error(`[SwapProcessor] Failed to process matched swap ${swap.id}:`, err);
      }
    }
  }

  private async processBuyBtqSwaps(): Promise<void> {
    const verified = await getMany<SwapRow>(
      `SELECT * FROM swaps WHERE direction = $1 AND status = $2`,
      [SwapDirection.BUY_BTQ, SwapStatus.EVM_HTLC_VERIFIED],
    );

    for (const swap of verified) {
      try {
        const shouldRun = await this.shouldRunAction(swap, 'platform-claim-usdt');
        if (!shouldRun) continue;
        console.log(`[SwapProcessor] Claiming USDT for buy_btq swap ${swap.id}`);
        await swapService.platformClaimUsdt(swap.id);
      } catch (err) {
        console.error(`[SwapProcessor] Failed to claim USDT for swap ${swap.id}:`, err);
        await swapService.failSwap(swap.id, `Platform USDT claim failed: ${(err as Error).message}`);
      }
    }
  }

  private async processSellBtqSwaps(): Promise<void> {
    const confirmed = await getMany<SwapRow>(
      `SELECT * FROM swaps WHERE direction = $1 AND status = $2`,
      [SwapDirection.SELL_BTQ, SwapStatus.BTQ_HTLC_CONFIRMED],
    );

    for (const swap of confirmed) {
      try {
        const shouldRun = await this.shouldRunAction(swap, 'platform-lock-usdt');
        if (!shouldRun) continue;
        console.log(`[SwapProcessor] Locking USDT for sell_btq swap ${swap.id}`);
        await swapService.platformLockUsdt(swap.id);
      } catch (err) {
        console.error(`[SwapProcessor] Failed to lock USDT for swap ${swap.id}:`, err);
        await swapService.failSwap(swap.id, `Platform USDT lock failed: ${(err as Error).message}`);
      }
    }

    const evmCreated = await getMany<SwapRow>(
      `SELECT * FROM swaps WHERE direction = $1 AND status = $2`,
      [SwapDirection.SELL_BTQ, SwapStatus.EVM_HTLC_CREATED],
    );

    for (const swap of evmCreated) {
      try {
        const shouldRun = await this.shouldRunAction(swap, 'mark-awaiting-user-usdt-claim');
        if (!shouldRun) continue;
        await swapService.markAwaitingUserUsdtClaim(swap.id);
      } catch (err) {
        console.error(`[SwapProcessor] Failed to advance swap ${swap.id}:`, err);
      }
    }
  }

  private async shouldRunAction(swap: SwapRow, action: string): Promise<boolean> {
    const last = await getOne<WorkerActionRow>(
      `SELECT created_at
       FROM swap_events
       WHERE swap_id = $1
         AND event_type = 'worker_action'
         AND metadata->>'action' = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [swap.id, action],
    );

    if (last) {
      const ageMs = Date.now() - new Date(last.created_at).getTime();
      if (ageMs < ACTION_COOLDOWN_MS) {
        return false;
      }
    }

    await query(
      `INSERT INTO swap_events (swap_id, from_status, to_status, event_type, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [swap.id, swap.status, swap.status, 'worker_action', JSON.stringify({ action })],
    );
    return true;
  }
}

export const swapProcessorWorker = new SwapProcessorWorker();
