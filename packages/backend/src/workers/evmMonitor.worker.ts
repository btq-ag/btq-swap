import { ethers } from 'ethers';
import { getMany, getOne } from '../lib/db';
import { SwapRow, SwapStatus, SwapDirection } from '../types/swap.types';
import { evmService } from '../services/evm.service';
import { swapService } from '../services/swap.service';
import { bufToHex } from '../lib/crypto';

export class EvmMonitorWorker {
  private active = false;

  start(): void {
    if (this.active) return;

    const htlcAddr = process.env.HTLC_CONTRACT_ADDRESS || '';
    if (!htlcAddr || htlcAddr === '0x0000000000000000000000000000000000000000') {
      console.log('[EvmMonitor] HTLC contract not configured — skipping event listeners');
      return;
    }

    this.active = true;
    console.log('[EvmMonitor] Starting event listeners');

    try {
      evmService.onSwapCreated(
        async (swapId, initiator, recipient, token, amount, hashlock, timelock) => {
          try {
            await this.handleSwapCreated(swapId, initiator, recipient, token, amount, hashlock, timelock);
          } catch (err) {
            console.error('[EvmMonitor] SwapCreated handler error:', err);
          }
        },
      );

      evmService.onSwapClaimed(async (swapId, secret) => {
        try {
          await this.handleSwapClaimed(swapId, secret);
        } catch (err) {
          console.error('[EvmMonitor] SwapClaimed handler error:', err);
        }
      });

      evmService.onSwapRefunded(async (swapId) => {
        try {
          await this.handleSwapRefunded(swapId);
        } catch (err) {
          console.error('[EvmMonitor] SwapRefunded handler error:', err);
        }
      });
    } catch {
      console.log('[EvmMonitor] EVM RPC not available — event listeners deferred');
      this.active = false;
    }
  }

  stop(): void {
    if (!this.active) return;
    evmService.removeAllListeners();
    this.active = false;
    console.log('[EvmMonitor] Stopped');
  }

  private async handleSwapCreated(
    evmSwapId: string,
    _initiator: string,
    _recipient: string,
    _token: string,
    _amount: bigint,
    _hashlock: string,
    _timelock: bigint,
  ): Promise<void> {
    const swapIdBuf = Buffer.from(evmSwapId.replace('0x', ''), 'hex');

    const swap = await getOne<SwapRow>(
      'SELECT * FROM swaps WHERE evm_htlc_swap_id = $1',
      [swapIdBuf],
    );

    if (!swap) return;

    if (swap.direction === SwapDirection.BUY_BTQ && swap.status === SwapStatus.AWAITING_EVM_LOCK) {
      console.log(`[EvmMonitor] EVM HTLC created for buy_btq swap ${swap.id}`);
      await swapService.verifyEvmLock(swap.id);
    }
  }

  private async handleSwapClaimed(evmSwapId: string, secret: string): Promise<void> {
    const swapIdBuf = Buffer.from(evmSwapId.replace('0x', ''), 'hex');

    const swap = await getOne<SwapRow>(
      'SELECT * FROM swaps WHERE evm_htlc_swap_id = $1',
      [swapIdBuf],
    );

    if (!swap) return;

    if (
      swap.direction === SwapDirection.SELL_BTQ &&
      (swap.status === SwapStatus.AWAITING_USER_USDT_CLAIM ||
        swap.status === SwapStatus.EVM_HTLC_CREATED)
    ) {
      console.log(`[EvmMonitor] User claimed USDT for sell_btq swap ${swap.id}, secret revealed`);
      await swapService.handleUserClaimedUsdt(swap.id, secret);
    }
  }

  private async handleSwapRefunded(evmSwapId: string): Promise<void> {
    const swapIdBuf = Buffer.from(evmSwapId.replace('0x', ''), 'hex');

    const swap = await getOne<SwapRow>(
      'SELECT * FROM swaps WHERE evm_htlc_swap_id = $1',
      [swapIdBuf],
    );

    if (!swap) return;

    console.log(`[EvmMonitor] EVM HTLC refunded for swap ${swap.id}`);
    await swapService.refundSwap(swap.id, 'EVM HTLC refunded on-chain');
  }
}

export const evmMonitorWorker = new EvmMonitorWorker();
