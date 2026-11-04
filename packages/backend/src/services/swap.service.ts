import { v4 as uuidv4 } from 'uuid';
import { ethers } from 'ethers';
import { query, getOne, getMany, withTransaction } from '../lib/db';
import { config } from '../config';
import {
  SwapRow,
  SwapStatus,
  SwapDirection,
  CreateSwapInput,
  SubmitBtqHtlcInput,
  ConfirmBtqClaimInput,
  SwapEventRow,
  SwapWithEvents,
  TERMINAL_STATUSES,
} from '../types/swap.types';
import { generateSecret, secretToHash, bufToHex, hexToBuf, generateSwapId } from '../lib/crypto';
import { btqService } from './btq.service';
import { evmService } from './evm.service';
import { priceService } from './price.service';
import { scriptBuilderService } from './scriptBuilder.service';
import { notificationService } from './notification.service';

export class SwapService {
  // ─── Swap CRUD ────────────────────────────────────────────────

  async getSwap(swapId: string): Promise<SwapRow | null> {
    return getOne<SwapRow>('SELECT * FROM swaps WHERE id = $1', [swapId]);
  }

  async getSwapWithEvents(swapId: string): Promise<SwapWithEvents | null> {
    const swap = await this.getSwap(swapId);
    if (!swap) return null;

    const events = await getMany<SwapEventRow>(
      'SELECT * FROM swap_events WHERE swap_id = $1 ORDER BY created_at ASC',
      [swapId],
    );

    return { ...swap, events };
  }

  async getUserSwaps(userId: string, limit = 50, offset = 0): Promise<SwapRow[]> {
    return getMany<SwapRow>(
      `SELECT * FROM swaps WHERE user_id = $1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    );
  }

  async getSwapsByStatus(status: SwapStatus): Promise<SwapRow[]> {
    return getMany<SwapRow>(
      'SELECT * FROM swaps WHERE status = $1 ORDER BY created_at ASC',
      [status],
    );
  }

  async getAllSwaps(limit = 50, offset = 0, status?: SwapStatus): Promise<SwapRow[]> {
    if (status) {
      return getMany<SwapRow>(
        `SELECT * FROM swaps WHERE status = $1
         ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [status, limit, offset],
      );
    }
    return getMany<SwapRow>(
      'SELECT * FROM swaps ORDER BY created_at DESC LIMIT $1 OFFSET $2',
      [limit, offset],
    );
  }

  // ─── State Transition Helper ──────────────────────────────────

  private async transition(
    swapId: string,
    fromStatus: SwapStatus | SwapStatus[],
    toStatus: SwapStatus,
    eventType: string,
    updates: Record<string, unknown> = {},
    metadata: Record<string, unknown> = {},
  ): Promise<SwapRow> {
    return withTransaction(async (txQuery) => {
      const swap = await getOne<SwapRow>(
        'SELECT * FROM swaps WHERE id = $1 FOR UPDATE',
        [swapId],
      );

      if (!swap) throw new Error(`Swap ${swapId} not found`);

      const validFrom = Array.isArray(fromStatus) ? fromStatus : [fromStatus];
      if (!validFrom.includes(swap.status)) {
        throw new Error(
          `Invalid transition: ${swap.status} → ${toStatus} (expected from: ${validFrom.join('|')})`,
        );
      }

      const setClauses: string[] = ['status = $2', 'updated_at = now()'];
      const values: unknown[] = [swapId, toStatus];
      let paramIdx = 3;

      if (TERMINAL_STATUSES.includes(toStatus)) {
        setClauses.push('completed_at = now()');
      }

      for (const [key, val] of Object.entries(updates)) {
        setClauses.push(`${key} = $${paramIdx}`);
        values.push(val);
        paramIdx++;
      }

      const updated = await txQuery<SwapRow>(
        `UPDATE swaps SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
        values,
      );

      await txQuery(
        `INSERT INTO swap_events (swap_id, from_status, to_status, event_type, metadata)
         VALUES ($1, $2, $3, $4, $5)`,
        [swapId, swap.status, toStatus, eventType, JSON.stringify(metadata)],
      );

      const result = updated.rows[0];
      notificationService.emitSwapUpdate(result);
      return result;
    });
  }

  // ─── Create Swap ──────────────────────────────────────────────

  async createSwap(userId: string, input: CreateSwapInput): Promise<SwapRow> {
    const paused = await priceService.isSwapsPaused();
    if (paused) throw new Error('Swaps are currently paused');

    const minBtq = parseFloat(await priceService.getMinSwapBtq());
    const maxBtq = parseFloat(await priceService.getMaxSwapBtq());
    const amountBtq = parseFloat(input.amount_btq);

    if (amountBtq < minBtq || amountBtq > maxBtq) {
      throw new Error(`Amount must be between ${minBtq} and ${maxBtq} BTQ`);
    }

    if (input.direction === SwapDirection.BUY_BTQ && !input.user_dilithium_pubkey) {
      throw new Error('user_dilithium_pubkey required for buy_btq');
    }

    const price = await priceService.getPriceForDirection(input.direction);
    const amountUsdt = (amountBtq * parseFloat(price)).toFixed(6);

    const secret = generateSecret();
    const secretHash = secretToHash(secret);
    const evmSwapId = generateSwapId();

    const currentBlock = await btqService.getBlockCount();
    const timelockBtq = currentBlock + config.BTQ_TIMELOCK_BLOCKS;
    const timelockEvm = new Date(Date.now() + config.EVM_TIMELOCK_SECONDS * 1000);

    const initialStatus = input.direction === SwapDirection.BUY_BTQ
      ? SwapStatus.PENDING
      : SwapStatus.PENDING;

    const swap = await withTransaction(async (txQuery) => {
      const inserted = await txQuery<SwapRow>(
        `INSERT INTO swaps (
          user_id, direction, amount_btq, amount_usdt, price_usdt,
          secret_hash, secret, timelock_btq, timelock_evm,
          user_dilithium_pubkey, user_btq_address,
          evm_htlc_swap_id, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING *`,
        [
          userId,
          input.direction,
          input.amount_btq,
          amountUsdt,
          price,
          secretHash,
          secret,
          timelockBtq,
          timelockEvm,
          input.user_dilithium_pubkey ?? null,
          input.user_btq_address ?? null,
          evmSwapId,
          initialStatus,
        ],
      );
      const row = inserted.rows[0];
      await txQuery(
        `INSERT INTO swap_events (swap_id, to_status, event_type, metadata)
         VALUES ($1, $2, $3, $4)`,
        [row.id, initialStatus, 'swap_created', JSON.stringify({ direction: input.direction })],
      );
      return row;
    });

    notificationService.emitSwapCreated(swap);

    try {
      if (input.direction === SwapDirection.BUY_BTQ) {
        await this.initBuyBtqFlow(swap);
      } else {
        await this.initSellBtqFlow(swap);
      }
    } catch (err) {
      await this.failSwap(swap.id, `initialization_failed: ${(err as Error).message}`);
      throw err;
    }

    return (await this.getSwap(swap.id))!;
  }

  // ─── Buy-BTQ Flow ─────────────────────────────────────────────
  // Platform creates BTQ HTLC → User locks USDT on EVM → Platform claims USDT
  // → Secret revealed → User claims BTQ

  private async initBuyBtqFlow(swap: SwapRow): Promise<void> {
    const userPubkey = swap.user_dilithium_pubkey;
    if (!userPubkey) {
      throw new Error('user_dilithium_pubkey required for buy_btq');
    }

    const platformPubkey = config.PLATFORM_DILITHIUM_PUBKEY;
    const params = {
      secretHash: swap.secret_hash!,
      claimPubkey: userPubkey,
      refundPubkey: platformPubkey,
      timelockBlocks: swap.timelock_btq!,
    };

    const { claimLeaf, refundLeaf } = scriptBuilderService.buildLeaves(params);

    const p2mrAddress = await btqService.createHtlcAddress(
      claimLeaf,
      refundLeaf,
      swap.id,
    );

    const txid = await btqService.fundHtlc(p2mrAddress, parseFloat(swap.amount_btq));

    await this.transition(
      swap.id,
      SwapStatus.PENDING,
      SwapStatus.BTQ_HTLC_CREATED,
      'platform_created_btq_htlc',
      {
        btq_htlc_txid: txid,
        btq_htlc_vout: 0,
        btq_htlc_created_by: 'platform',
        btq_merkle_root: p2mrAddress,
        claim_leaf_hex: claimLeaf.script,
        refund_leaf_hex: refundLeaf.script,
      },
      { p2mrAddress, txid },
    );

    await this.transition(
      swap.id,
      SwapStatus.BTQ_HTLC_CREATED,
      SwapStatus.AWAITING_EVM_LOCK,
      'awaiting_user_evm_lock',
      {},
      { evmSwapId: bufToHex(swap.evm_htlc_swap_id!) },
    );
  }

  async verifyEvmLock(swapId: string): Promise<SwapRow> {
    const swap = await this.getSwap(swapId);
    if (!swap) throw new Error('Swap not found');
    if (swap.direction !== SwapDirection.BUY_BTQ) {
      throw new Error('verifyEvmLock only applies to buy_btq swaps');
    }

    const evmSwapIdHex = '0x' + bufToHex(swap.evm_htlc_swap_id!);
    const evmSwap = await evmService.getSwap(evmSwapIdHex);

    if (evmSwap.state !== 1) {
      throw new Error('EVM HTLC is not in OPEN state');
    }

    const expectedHashlock = '0x' + bufToHex(swap.secret_hash!);
    if (evmSwap.hashlock !== expectedHashlock) {
      throw new Error('EVM HTLC hashlock does not match');
    }

    const expectedAmount = ethers.parseUnits(swap.amount_usdt, 6);
    if (evmSwap.amount < expectedAmount) {
      throw new Error('EVM HTLC amount insufficient');
    }

    return this.transition(
      swapId,
      SwapStatus.AWAITING_EVM_LOCK,
      SwapStatus.EVM_HTLC_VERIFIED,
      'evm_htlc_verified',
      { evm_htlc_tx_hash: swap.evm_htlc_tx_hash },
      { evmState: evmSwap },
    );
  }

  async platformClaimUsdt(swapId: string): Promise<SwapRow> {
    const swap = await this.getSwap(swapId);
    if (!swap) throw new Error('Swap not found');

    await this.transition(
      swapId,
      SwapStatus.EVM_HTLC_VERIFIED,
      SwapStatus.PLATFORM_CLAIMING_USDT,
      'platform_claiming_usdt',
    );

    const evmSwapIdHex = '0x' + bufToHex(swap.evm_htlc_swap_id!);
    const secretHex = '0x' + bufToHex(swap.secret!);

    const claimTxHash = await evmService.claimSwap(evmSwapIdHex, secretHex);

    await this.transition(
      swapId,
      SwapStatus.PLATFORM_CLAIMING_USDT,
      SwapStatus.SECRET_REVEALED,
      'secret_revealed_on_evm',
      { evm_claim_tx_hash: claimTxHash },
      { claimTxHash, secret: bufToHex(swap.secret!) },
    );

    return this.transition(
      swapId,
      SwapStatus.SECRET_REVEALED,
      SwapStatus.AWAITING_USER_BTQ_CLAIM,
      'awaiting_user_btq_claim',
    );
  }

  async confirmUserBtqClaim(swapId: string, input: ConfirmBtqClaimInput): Promise<SwapRow> {
    return this.transition(
      swapId,
      SwapStatus.AWAITING_USER_BTQ_CLAIM,
      SwapStatus.COMPLETED,
      'user_claimed_btq',
      { btq_claim_txid: input.btq_claim_txid },
      { claimTxid: input.btq_claim_txid },
    );
  }

  // ─── Sell-BTQ Flow ────────────────────────────────────────────
  // User creates BTQ HTLC → Platform verifies → Platform locks USDT on EVM
  // → User claims USDT (reveals secret) → Platform claims BTQ

  private async initSellBtqFlow(swap: SwapRow): Promise<void> {
    await this.transition(
      swap.id,
      SwapStatus.PENDING,
      SwapStatus.AWAITING_USER_BTQ_HTLC,
      'awaiting_user_btq_htlc',
      {},
      {
        secretHash: bufToHex(swap.secret_hash!),
        timelockBtq: swap.timelock_btq,
        platformPubkey: config.PLATFORM_DILITHIUM_PUBKEY,
      },
    );
  }

  async submitUserBtqHtlc(input: SubmitBtqHtlcInput): Promise<SwapRow> {
    const swap = await this.getSwap(input.swap_id);
    if (!swap) throw new Error('Swap not found');
    if (swap.direction !== SwapDirection.SELL_BTQ) {
      throw new Error('submitUserBtqHtlc only applies to sell_btq swaps');
    }

    const tx = await btqService.getRawTransaction(input.btq_htlc_txid, true);
    if (typeof tx === 'string') {
      throw new Error('BTQ HTLC transaction was returned as raw hex, expected decoded tx');
    }
    const fundedOutput = tx.vout.find((o) => o.n === input.btq_htlc_vout);
    if (!fundedOutput) {
      throw new Error(`BTQ HTLC output vout=${input.btq_htlc_vout} not found`);
    }
    if (fundedOutput.value + 1e-8 < parseFloat(swap.amount_btq)) {
      throw new Error('BTQ HTLC output amount is lower than expected swap amount');
    }
    if (!fundedOutput.scriptPubKey?.address) {
      throw new Error('BTQ HTLC output address is missing from decoded transaction');
    }
    if (fundedOutput.scriptPubKey.address !== input.btq_merkle_root) {
      throw new Error('BTQ HTLC output address does not match provided lock address');
    }
    if (!swap.user_dilithium_pubkey) {
      throw new Error('user_dilithium_pubkey is required before submitting BTQ lock');
    }
    const expectedLeaves = scriptBuilderService.buildLeaves({
      secretHash: swap.secret_hash!,
      claimPubkey: config.PLATFORM_DILITHIUM_PUBKEY,
      refundPubkey: swap.user_dilithium_pubkey,
      timelockBlocks: swap.timelock_btq!,
    });
    const expectedClaim = expectedLeaves.claimLeaf.script.toLowerCase();
    const expectedRefund = expectedLeaves.refundLeaf.script.toLowerCase();
    if (input.claim_leaf_hex.toLowerCase() !== expectedClaim) {
      throw new Error('BTQ claim leaf does not match the expected swap parameters');
    }
    if (input.refund_leaf_hex.toLowerCase() !== expectedRefund) {
      throw new Error('BTQ refund leaf does not match the expected swap parameters');
    }

    return this.transition(
      input.swap_id,
      SwapStatus.AWAITING_USER_BTQ_HTLC,
      SwapStatus.BTQ_HTLC_VERIFIED,
      'user_submitted_btq_htlc',
      {
        btq_htlc_txid: input.btq_htlc_txid,
        btq_htlc_vout: input.btq_htlc_vout,
        btq_htlc_created_by: 'user',
        btq_merkle_root: input.btq_merkle_root,
        claim_leaf_hex: input.claim_leaf_hex,
        refund_leaf_hex: input.refund_leaf_hex,
        control_block_hex: input.control_block_hex,
      },
      { txid: input.btq_htlc_txid, vout: input.btq_htlc_vout },
    );
  }

  async confirmBtqHtlc(swapId: string, confirmations: number): Promise<SwapRow> {
    const swap = await this.getSwap(swapId);
    if (!swap) throw new Error('Swap not found');

    await query(
      'UPDATE swaps SET btq_htlc_confs = $1, updated_at = now() WHERE id = $2',
      [confirmations, swapId],
    );

    if (swap.status === SwapStatus.BTQ_HTLC_VERIFIED && confirmations >= 1) {
      return this.transition(
        swapId,
        SwapStatus.BTQ_HTLC_VERIFIED,
        SwapStatus.BTQ_HTLC_CONFIRMED,
        'btq_htlc_confirmed',
        { btq_htlc_confs: confirmations },
        { confirmations },
      );
    }

    return (await this.getSwap(swapId))!;
  }

  async platformLockUsdt(swapId: string): Promise<SwapRow> {
    const swap = await this.getSwap(swapId);
    if (!swap) throw new Error('Swap not found');

    await this.transition(
      swapId,
      SwapStatus.BTQ_HTLC_CONFIRMED,
      SwapStatus.PLATFORM_LOCKING_USDT,
      'platform_locking_usdt',
    );

    const evmSwapIdHex = '0x' + bufToHex(swap.evm_htlc_swap_id!);
    const secretHashHex = '0x' + bufToHex(swap.secret_hash!);
    const user = await getOne<{ eth_address: string }>(
      'SELECT eth_address FROM users WHERE id = $1',
      [swap.user_id],
    );

    if (!user) throw new Error('User not found');

    const amount = ethers.parseUnits(swap.amount_usdt, 6);

    await evmService.approveToken(
      config.USDT_TOKEN_ADDRESS,
      config.HTLC_CONTRACT_ADDRESS,
      amount,
    );

    const txHash = await evmService.createSwapERC20(
      evmSwapIdHex,
      user.eth_address,
      config.USDT_TOKEN_ADDRESS,
      amount,
      secretHashHex,
      config.EVM_TIMELOCK_SECONDS,
    );

    return this.transition(
      swapId,
      SwapStatus.PLATFORM_LOCKING_USDT,
      SwapStatus.EVM_HTLC_CREATED,
      'platform_created_evm_htlc',
      { evm_htlc_tx_hash: txHash },
      { txHash },
    );
  }

  async markAwaitingUserUsdtClaim(swapId: string): Promise<SwapRow> {
    return this.transition(
      swapId,
      SwapStatus.EVM_HTLC_CREATED,
      SwapStatus.AWAITING_USER_USDT_CLAIM,
      'awaiting_user_usdt_claim',
    );
  }

  async handleUserClaimedUsdt(swapId: string, secret: string): Promise<SwapRow> {
    const swap = await this.getSwap(swapId);
    if (!swap) throw new Error('Swap not found');

    await this.transition(
      swapId,
      [SwapStatus.AWAITING_USER_USDT_CLAIM, SwapStatus.EVM_HTLC_CREATED],
      SwapStatus.USER_CLAIMED_USDT,
      'user_claimed_usdt',
      { secret: hexToBuf(secret.replace('0x', '')) },
      { secret },
    );

    return this.transition(
      swapId,
      SwapStatus.USER_CLAIMED_USDT,
      SwapStatus.AWAITING_USER_BTQ_CLAIM,
      'awaiting_user_btq_claim_after_secret_reveal',
      {},
      { secret },
    );
  }

  private async platformClaimBtq(swapId: string, secretHex: string): Promise<SwapRow> {
    const swap = await this.getSwap(swapId);
    if (!swap) throw new Error('Swap not found');

    await this.transition(
      swapId,
      SwapStatus.USER_CLAIMED_USDT,
      SwapStatus.PLATFORM_CLAIMING_BTQ,
      'platform_claiming_btq',
    );

    const cleanSecret = secretHex.replace('0x', '');

    const claimTxid = await btqService.claimHtlc(
      swap.btq_htlc_txid!,
      swap.btq_htlc_vout!,
      config.PLATFORM_BTQ_ADDRESS,
      10,
      cleanSecret,
      swap.claim_leaf_hex!,
      swap.control_block_hex!,
    );

    return this.transition(
      swapId,
      SwapStatus.PLATFORM_CLAIMING_BTQ,
      SwapStatus.COMPLETED,
      'platform_claimed_btq',
      { btq_claim_txid: claimTxid },
      { claimTxid },
    );
  }

  // ─── Refund / Failure ─────────────────────────────────────────

  async refundSwap(swapId: string, reason: string): Promise<SwapRow> {
    const swap = await this.getSwap(swapId);
    if (!swap) throw new Error('Swap not found');

    if (TERMINAL_STATUSES.includes(swap.status)) {
      throw new Error('Swap is already in a terminal state');
    }

    const result = await this.transition(
      swapId,
      swap.status,
      SwapStatus.REFUNDED,
      'swap_refunded',
      { error_message: reason },
      { reason },
    );

    notificationService.emitSwapFailed(result, reason);
    return result;
  }

  async failSwap(swapId: string, reason: string): Promise<SwapRow> {
    const swap = await this.getSwap(swapId);
    if (!swap) throw new Error('Swap not found');

    if (TERMINAL_STATUSES.includes(swap.status)) {
      throw new Error('Swap is already in a terminal state');
    }

    const result = await this.transition(
      swapId,
      swap.status,
      SwapStatus.FAILED,
      'swap_failed',
      { error_message: reason },
      { reason },
    );

    notificationService.emitSwapFailed(result, reason);
    return result;
  }

  async expireSwap(swapId: string): Promise<SwapRow> {
    const swap = await this.getSwap(swapId);
    if (!swap) throw new Error('Swap not found');

    if (TERMINAL_STATUSES.includes(swap.status)) {
      throw new Error('Swap is already in a terminal state');
    }

    const result = await this.transition(
      swapId,
      swap.status,
      SwapStatus.EXPIRED,
      'swap_expired',
      { error_message: 'Timelock expired' },
      {},
    );

    notificationService.emitSwapFailed(result, 'Timelock expired');
    return result;
  }

  // ─── Process Matched Swap (from order matching) ──────────

  async processMatchedSwap(swapId: string): Promise<void> {
    const swap = await this.getSwap(swapId);
    if (!swap || swap.status !== SwapStatus.PENDING || !swap.order_id) return;

    if (swap.direction === SwapDirection.BUY_BTQ) {
      await this.initBuyBtqFlow(swap);
    } else {
      await this.initSellBtqFlow(swap);
    }
  }

  // ─── EVM Event Tracking ───────────────────────────────────────

  async updateEvmTxHash(swapId: string, txHash: string): Promise<void> {
    await query(
      'UPDATE swaps SET evm_htlc_tx_hash = $1, updated_at = now() WHERE id = $2',
      [txHash, swapId],
    );
  }

  // ─── CLI Commands Generation ──────────────────────────────────

  async getCliCommands(swapId: string): Promise<Record<string, string>> {
    const swap = await this.getSwap(swapId);
    if (!swap) throw new Error('Swap not found');

    if (swap.status === SwapStatus.AWAITING_USER_BTQ_CLAIM && swap.btq_htlc_txid && swap.secret) {
      return scriptBuilderService.generateClaimCommands(
        swap.btq_htlc_txid,
        swap.btq_htlc_vout ?? 0,
        swap.user_btq_address ?? '<your_btq_address>',
        10,
        bufToHex(swap.secret),
        swap.claim_leaf_hex ?? '',
        swap.control_block_hex ?? '',
      );
    }

    if (swap.direction === SwapDirection.SELL_BTQ && swap.status === SwapStatus.AWAITING_USER_BTQ_HTLC) {
      const platformPubkey = config.PLATFORM_DILITHIUM_PUBKEY;
      const userPubkey = swap.user_dilithium_pubkey ?? '<your_dilithium_pubkey>';

      const params = {
        secretHash: swap.secret_hash!,
        claimPubkey: platformPubkey,
        refundPubkey: userPubkey,
        timelockBlocks: swap.timelock_btq!,
      };

      const { claimLeaf, refundLeaf } = scriptBuilderService.buildLeaves(params);
      const leavesJson = JSON.stringify([claimLeaf, refundLeaf]);

      return {
        createAddress: `btq-cli getnewp2mraddress '${leavesJson}' "htlc-${swap.id}"`,
        sendToAddress: `btq-cli sendtoaddress <p2mr_address> ${swap.amount_btq}`,
      };
    }

    return {};
  }

  // ─── Admin ────────────────────────────────────────────────────

  async addAdminNote(swapId: string, note: string): Promise<SwapRow> {
    const result = await getOne<SwapRow>(
      `UPDATE swaps SET admin_notes = COALESCE(admin_notes || E'\n', '') || $1, updated_at = now()
       WHERE id = $2 RETURNING *`,
      [note, swapId],
    );
    if (!result) throw new Error('Swap not found');
    return result;
  }
}

export const swapService = new SwapService();
