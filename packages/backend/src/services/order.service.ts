import { query, getOne, getMany, withTransaction } from '../lib/db';
import { config } from '../config';
import { ethers } from 'ethers';
import {
  OrderRow,
  OrderStatus,
  OrderDirection,
  CreateOrderInput,
  Orderbook,
  OrderbookEntry,
} from '../types/order.types';
import { matchingService } from './matching.service';
import { notificationService } from './notification.service';
import { btqService } from './btq.service';
import { scriptBuilderService } from './scriptBuilder.service';

export interface FundOrderInput {
  secret_hash: string;
  btq_htlc_txid: string;
  btq_htlc_vout: number;
  user_dilithium_pubkey?: string;
  user_btq_address?: string;
}

interface VerifiedFundingData {
  secretHashHex: string;
  fundingTxid: string;
  vout: number | null;
  expiresAt: Date | null;
}

export interface PublicFundedOrder {
  id: string;
  direction: OrderDirection;
  status: OrderStatus;
  price_usdt: string;
  amount_btq: string;
  filled_btq: string;
  remaining_btq: string;
  is_funded: boolean;
  secret_hash_hex: string | null;
  btq_htlc_txid: string | null;
  btq_htlc_vout: number | null;
  user_dilithium_pubkey: string | null;
  user_btq_address: string | null;
  created_at: Date;
  expires_at: Date | null;
}

export interface SellFundingCommands {
  timelockBlocks: number;
  counterpartyDilithiumPubkey: string;
  refundDilithiumPubkey: string;
  claimLeafHex: string;
  refundLeafHex: string;
  createAddressCommand: string;
  listP2mrCommand: string;
  sendToAddressCommand: string;
  verifyTxCommand: string;
}

export interface OrderFundingStatus {
  orderId: string;
  direction: OrderDirection;
  status: OrderStatus;
  isFunded: boolean;
  txid: string | null;
  submittedVout: number | null;
  inspectedAt: string;
  btq?: {
    txFound: boolean;
    confirmations: number;
    expectedAmountBtq: number;
    resolvedVout: number | null;
    outputValueBtq: number | null;
    outputType: string | null;
    outputAddress: string | null;
    isP2mrOutput: boolean;
    amountSufficient: boolean;
    verified: boolean;
    reason: string;
  };
  evm?: {
    txFound: boolean;
    txSuccess: boolean;
    blockNumber: number | null;
    confirmations: number;
    agreementId: string | null;
    partyA: string | null;
    partyB: string | null;
    secretlock: string | null;
    deadline: number | null;
    expiresAt: string | null;
    tokenAmount: string | null;
    tokenContract: string | null;
    htlcContract: string;
    verified: boolean;
    reason: string;
  };
}

export class OrderService {
  private readonly SELL_FUNDING_MIN_BUY_WINDOW_MS = 10 * 60_000;
  private readonly htlcLockupEventIface = new ethers.Interface([
    'event HTLCERC20Lockup(bytes32 indexed agreementId, address indexed partyA, address indexed partyB, bytes32 secretlock, uint32 deadline, uint256 tokenAmount, address erc20Contract, string otherNetwork, string otherAsset, uint256 otherAmount)',
  ]);

  /**
   * Place a new order AND attempt to match it immediately.
   *
   * If the order is_funded (e.g. market-maker or pre-funded), matching
   * runs in the same call.  Otherwise the order sits on the book until
   * the user calls fundOrder().
   */
  async placeOrder(
    userId: string,
    input: CreateOrderInput,
    funded = false,
  ): Promise<{ order: OrderRow; fills: number }> {
    const amountUsdt = (parseFloat(input.amount_btq) * parseFloat(input.price_usdt)).toFixed(6);

    const row = await getOne<OrderRow>(
      `INSERT INTO orders (user_id, direction, amount_btq, price_usdt, amount_usdt, is_funded)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [userId, input.direction, input.amount_btq, input.price_usdt, amountUsdt, funded],
    );

    const order = row!;

    if (funded) {
      await query(
        `UPDATE orders
         SET expires_at = now() + ($1::text || ' seconds')::interval,
             updated_at = now()
         WHERE id = $2`,
        [config.EVM_TIMELOCK_SECONDS, order.id],
      );
    }

    // Attempt matching if this order is funded
    let fillCount = 0;
    if (funded) {
      const result = await matchingService.matchOrder(order.id);
      fillCount = result.fills.length;
    }

    // Broadcast orderbook update
    const book = await this.getOrderbook();
    notificationService.emitOrderbookUpdate(book);

    const updated = await this.getOrder(order.id);
    return { order: updated!, fills: fillCount };
  }

  /**
   * Mark an order as funded (user has locked BTQ in a P2MR HTLC)
   * and immediately attempt matching.
   */
  async fundOrder(orderId: string, userId: string, input: FundOrderInput): Promise<{ order: OrderRow; fills: number }> {
    const order = await getOne<OrderRow>(
      'SELECT * FROM orders WHERE id = $1',
      [orderId],
    );

    console.log('[OrderService] fundOrder', {
      orderId,
      userId,
      orderExists: !!order,
      orderUserId: order?.user_id,
      orderStatus: order?.status,
      isFunded: order?.is_funded,
      inputHash: input.secret_hash?.slice(0, 16) + '...',
      inputTxid: input.btq_htlc_txid?.slice(0, 16) + '...',
    });

    if (!order) throw new Error('Order not found');
    if (order.user_id !== userId) throw new Error(`Unauthorized (order.user_id=${order.user_id}, userId=${userId})`);
    if (order.is_funded) throw new Error('Order is already funded');
    if (order.status !== 'open' && order.status !== 'partially_filled') {
      throw new Error(`Order is not open (status: ${order.status})`);
    }
    if (order.direction === OrderDirection.SELL) {
      await this.ensureSellFundingWithinBuyWindow(order);
    }
    const userBtqProfile = await this.getUserBtqProfile(userId);
    const resolvedDilithiumPubkey = input.user_dilithium_pubkey ?? userBtqProfile?.dilithium_pubkey ?? null;
    const resolvedBtqAddress = input.user_btq_address ?? userBtqProfile?.btq_address ?? null;

    const verified = await this.verifyFundingOnChain(order, userId, input);
    console.log('[OrderService] verified funding payload', {
      orderId,
      direction: order.direction,
      fundingTxid: verified.fundingTxid,
      vout: verified.vout,
      secretHashPrefix: verified.secretHashHex.slice(0, 16),
      expiresAt: verified.expiresAt?.toISOString() ?? null,
    });

    await query(
      `UPDATE orders SET
        is_funded = true,
        expires_at = COALESCE($6, expires_at, now() + ($7::text || ' seconds')::interval),
        secret_hash = $1,
        btq_htlc_txid = $2,
        btq_htlc_vout = $3,
        user_dilithium_pubkey = COALESCE($4, user_dilithium_pubkey),
        user_btq_address = COALESCE($5, user_btq_address),
        updated_at = now()
       WHERE id = $8`,
      [
        Buffer.from(verified.secretHashHex, 'hex'),
        verified.fundingTxid,
        verified.vout,
        resolvedDilithiumPubkey,
        resolvedBtqAddress,
        verified.expiresAt,
        config.EVM_TIMELOCK_SECONDS,
        orderId,
      ],
    );

    // Now attempt matching
    const result = await matchingService.matchOrder(orderId);

    const book = await this.getOrderbook();
    console.log('[OrderService] post-funding orderbook snapshot', {
      orderId,
      fills: result.fills.length,
      bidLevels: book.bids.length,
      askLevels: book.asks.length,
      topBid: book.bids[0]?.price ?? null,
      topAsk: book.asks[0]?.price ?? null,
    });
    notificationService.emitOrderbookUpdate(book);
    notificationService.emitOrderRefreshHint({
      userId,
      reason: 'order_funded',
      orderId,
    });

    const updated = await this.getOrder(orderId);
    return { order: updated!, fills: result.fills.length };
  }

  private async ensureSellFundingWithinBuyWindow(order: OrderRow): Promise<void> {
    const bestBuy = await this.getBestMatchingFundedBuy(order);

    if (!bestBuy) {
      throw new Error('No active funded buy order is available yet for this sell order');
    }

    const expiresMs = bestBuy.expires_at ? new Date(bestBuy.expires_at).getTime() : NaN;
    const remainingMs = expiresMs - Date.now();
    if (!Number.isFinite(expiresMs) || remainingMs <= 0) {
      throw new Error('Matching buy order timelock has already expired');
    }
    if (remainingMs < this.SELL_FUNDING_MIN_BUY_WINDOW_MS) {
      throw new Error('Matching buy order timelock is too close to expiry; wait for a fresher buy order');
    }
  }

  async getSellFundingContext(orderId: string, userId: string): Promise<{
    buyOrderId: string;
    counterpartyDilithiumPubkey: string;
    buyExpiresAt: Date | null;
    remainingMs: number;
    minRequiredMs: number;
  }> {
    const order = await getOne<OrderRow>('SELECT * FROM orders WHERE id = $1', [orderId]);
    if (!order) throw new Error('Order not found');
    if (order.user_id !== userId) throw new Error('Unauthorized');
    if (order.direction !== OrderDirection.SELL) {
      throw new Error('Funding context is only available for sell orders');
    }
    if (order.is_funded) {
      throw new Error('Order is already funded');
    }
    if (order.status !== OrderStatus.OPEN && order.status !== OrderStatus.PARTIALLY_FILLED) {
      throw new Error(`Order is not open (status: ${order.status})`);
    }

    const bestBuy = await this.getBestMatchingFundedBuy(order);
    if (!bestBuy) {
      throw new Error('No active funded buy order is available yet for this sell order');
    }

    const expiresMs = bestBuy.expires_at ? new Date(bestBuy.expires_at).getTime() : NaN;
    const remainingMs = expiresMs - Date.now();
    if (!Number.isFinite(expiresMs) || remainingMs <= 0) {
      throw new Error('Matching buy order timelock has already expired');
    }
    if (remainingMs < this.SELL_FUNDING_MIN_BUY_WINDOW_MS) {
      throw new Error('Matching buy order timelock is too close to expiry; wait for a fresher buy order');
    }
    if (!bestBuy.user_dilithium_pubkey?.trim()) {
      throw new Error('Matching buy order is missing BTQ claim pubkey; buyer must configure BTQ wallet first');
    }

    return {
      buyOrderId: bestBuy.id,
      counterpartyDilithiumPubkey: bestBuy.user_dilithium_pubkey.trim(),
      buyExpiresAt: bestBuy.expires_at,
      remainingMs,
      minRequiredMs: this.SELL_FUNDING_MIN_BUY_WINDOW_MS,
    };
  }

  async getSellFundingCommands(
    orderId: string,
    userId: string,
    secretHashHex: string,
    timelockMinutes: number,
  ): Promise<SellFundingCommands> {
    const normalizedHash = secretHashHex.replace(/^0x/, '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(normalizedHash)) {
      throw new Error('Invalid secret hash: expected 32-byte hex');
    }
    const order = await getOne<OrderRow>('SELECT * FROM orders WHERE id = $1', [orderId]);
    if (!order) throw new Error('Order not found');
    if (order.user_id !== userId) throw new Error('Unauthorized');
    if (order.direction !== OrderDirection.SELL) {
      throw new Error('Funding commands are only available for sell orders');
    }

    const context = await this.getSellFundingContext(orderId, userId);
    const userBtqProfile = await this.getUserBtqProfile(userId);
    const refundPubkey = userBtqProfile?.dilithium_pubkey?.trim();
    if (!refundPubkey) {
      throw new Error('Your BTQ Dilithium pubkey is missing; configure BTQ wallet first');
    }

    const timelockBlocks = Math.min(10080, Math.max(1, Math.floor(timelockMinutes)));
    const { claimLeaf, refundLeaf } = scriptBuilderService.buildLeaves({
      secretHash: Buffer.from(normalizedHash, 'hex'),
      claimPubkey: context.counterpartyDilithiumPubkey,
      refundPubkey,
      timelockBlocks,
    });
    const leavesJson = JSON.stringify([claimLeaf, refundLeaf]);

    return {
      timelockBlocks,
      counterpartyDilithiumPubkey: context.counterpartyDilithiumPubkey,
      refundDilithiumPubkey: refundPubkey,
      claimLeafHex: claimLeaf.script,
      refundLeafHex: refundLeaf.script,
      createAddressCommand: `btq-cli -regtest -rpcwallet=swap-wallet getnewp2mraddress '${leavesJson}' "order-${order.id}"`,
      listP2mrCommand: 'btq-cli -regtest -rpcwallet=swap-wallet listp2mr',
      sendToAddressCommand: `btq-cli -regtest -rpcwallet=swap-wallet -named sendtoaddress address="<p2mr_address_from_step1>" amount=${order.amount_btq} fee_rate=1`,
      verifyTxCommand: 'btq-cli -regtest getrawtransaction <txid_from_step3> true',
    };
  }

  async getOrderFundingStatus(orderId: string, userId: string): Promise<OrderFundingStatus> {
    const order = await getOne<OrderRow>('SELECT * FROM orders WHERE id = $1', [orderId]);
    if (!order) throw new Error('Order not found');
    if (order.user_id !== userId) throw new Error('Unauthorized');

    const inspectedAt = new Date().toISOString();
    const base: OrderFundingStatus = {
      orderId: order.id,
      direction: order.direction,
      status: order.status,
      isFunded: order.is_funded,
      txid: order.btq_htlc_txid,
      submittedVout: order.btq_htlc_vout,
      inspectedAt,
    };

    if (!order.is_funded || !order.btq_htlc_txid) {
      return {
        ...base,
        btq: {
          txFound: false,
          confirmations: 0,
          expectedAmountBtq: Number(order.amount_btq),
          resolvedVout: null,
          outputValueBtq: null,
          outputType: null,
          outputAddress: null,
          isP2mrOutput: false,
          amountSufficient: false,
          verified: false,
          reason: 'Order is not funded yet',
        },
      };
    }

    if (order.direction === OrderDirection.BUY || order.btq_htlc_txid.startsWith('0x')) {
      const provider = new ethers.JsonRpcProvider(config.EVM_RPC_URL);
      try {
        const txHash = order.btq_htlc_txid.startsWith('0x')
          ? order.btq_htlc_txid
          : `0x${order.btq_htlc_txid}`;
        const [receipt, latestBlock] = await Promise.all([
          provider.getTransactionReceipt(txHash),
          provider.getBlockNumber(),
        ]);
        if (!receipt) {
          return {
            ...base,
            evm: {
              txFound: false,
              txSuccess: false,
              blockNumber: null,
              confirmations: 0,
              agreementId: null,
              partyA: null,
              partyB: null,
              secretlock: null,
              deadline: null,
              expiresAt: null,
              tokenAmount: null,
              tokenContract: null,
              htlcContract: config.HTLC_CONTRACT_ADDRESS,
              verified: false,
              reason: 'EVM funding tx not found on chain yet',
            },
          };
        }

        let parsedLockup: ethers.LogDescription | null = null;
        for (const rawLog of receipt.logs) {
          if (rawLog.address.toLowerCase() !== config.HTLC_CONTRACT_ADDRESS.toLowerCase()) continue;
          try {
            const parsed = this.htlcLockupEventIface.parseLog(rawLog);
            if (parsed && parsed.name === 'HTLCERC20Lockup') {
              parsedLockup = parsed;
              break;
            }
          } catch {
            // ignore non-lockup logs
          }
        }

        const confirmations = receipt.blockNumber
          ? Math.max(0, Number(latestBlock) - Number(receipt.blockNumber) + 1)
          : 0;
        const txSuccess = Number(receipt.status) === 1;
        const deadline = parsedLockup ? Number(parsedLockup.args.deadline) : null;
        const expiresAt = deadline && Number.isFinite(deadline) && deadline > 0
          ? new Date(deadline * 1000).toISOString()
          : null;
        const tokenAmount = parsedLockup ? parsedLockup.args.tokenAmount.toString() : null;
        const tokenContract = parsedLockup ? String(parsedLockup.args.erc20Contract) : null;

        return {
          ...base,
          evm: {
            txFound: true,
            txSuccess,
            blockNumber: receipt.blockNumber ? Number(receipt.blockNumber) : null,
            confirmations,
            agreementId: parsedLockup ? String(parsedLockup.args.agreementId) : null,
            partyA: parsedLockup ? String(parsedLockup.args.partyA) : null,
            partyB: parsedLockup ? String(parsedLockup.args.partyB) : null,
            secretlock: parsedLockup ? String(parsedLockup.args.secretlock) : null,
            deadline,
            expiresAt,
            tokenAmount,
            tokenContract,
            htlcContract: config.HTLC_CONTRACT_ADDRESS,
            verified: txSuccess && !!parsedLockup,
            reason: !txSuccess
              ? 'EVM funding tx reverted'
              : parsedLockup
                ? 'EVM USDT HTLC lockup verified on-chain'
                : 'EVM tx found but HTLC lockup event was not detected',
          },
        };
      } catch (err) {
        return {
          ...base,
          evm: {
            txFound: false,
            txSuccess: false,
            blockNumber: null,
            confirmations: 0,
            agreementId: null,
            partyA: null,
            partyB: null,
            secretlock: null,
            deadline: null,
            expiresAt: null,
            tokenAmount: null,
            tokenContract: null,
            htlcContract: config.HTLC_CONTRACT_ADDRESS,
            verified: false,
            reason: err instanceof Error ? err.message : 'Failed to inspect EVM funding transaction',
          },
        };
      }
    }

    try {
      const tx = await btqService.getRawTransaction(order.btq_htlc_txid, true);
      if (typeof tx === 'string') {
        return {
          ...base,
          btq: {
            txFound: false,
            confirmations: 0,
            expectedAmountBtq: Number(order.amount_btq),
            resolvedVout: null,
            outputValueBtq: null,
            outputType: null,
            outputAddress: null,
            isP2mrOutput: false,
            amountSufficient: false,
            verified: false,
            reason: 'BTQ transaction decode returned raw hex',
          },
        };
      }

      const expectedAmount = Number(order.amount_btq);
      const isP2mrOutput = (outputType?: string): boolean => (
        outputType === 'witness_v2_p2mr' || outputType === 'witness_v1_p2mr' || outputType === 'p2mr'
      );
      const requestedOutput = typeof order.btq_htlc_vout === 'number'
        ? tx.vout.find((o) => o.n === order.btq_htlc_vout)
        : undefined;
      const resolvedOutput = (requestedOutput && isP2mrOutput(requestedOutput.scriptPubKey?.type) && requestedOutput.value + 1e-8 >= expectedAmount)
        ? requestedOutput
        : tx.vout.find((o) => isP2mrOutput(o.scriptPubKey?.type) && o.value + 1e-8 >= expectedAmount);
      const outputType = resolvedOutput?.scriptPubKey?.type ?? null;
      const outputValue = resolvedOutput?.value ?? null;
      const outputAddress = resolvedOutput?.scriptPubKey?.address ?? null;
      const p2mr = isP2mrOutput(outputType ?? undefined);
      const sufficient = outputValue !== null ? outputValue + 1e-8 >= expectedAmount : false;
      const verified = !!resolvedOutput && p2mr && sufficient;

      return {
        ...base,
        btq: {
          txFound: true,
          confirmations: tx.confirmations ?? 0,
          expectedAmountBtq: expectedAmount,
          resolvedVout: resolvedOutput?.n ?? null,
          outputValueBtq: outputValue,
          outputType,
          outputAddress,
          isP2mrOutput: p2mr,
          amountSufficient: sufficient,
          verified,
          reason: verified
            ? 'BTQ funding output verified on-chain'
            : 'No qualifying P2MR output found with required amount',
        },
      };
    } catch (err) {
      return {
        ...base,
        btq: {
          txFound: false,
          confirmations: 0,
          expectedAmountBtq: Number(order.amount_btq),
          resolvedVout: null,
          outputValueBtq: null,
          outputType: null,
          outputAddress: null,
          isP2mrOutput: false,
          amountSufficient: false,
          verified: false,
          reason: err instanceof Error ? err.message : 'Failed to inspect BTQ transaction',
        },
      };
    }
  }

  private async getBestMatchingFundedBuy(order: OrderRow): Promise<{
    id: string;
    expires_at: Date | null;
    created_at: Date;
    user_dilithium_pubkey: string | null;
  } | null> {
    return getOne<{ id: string; expires_at: Date | null; created_at: Date; user_dilithium_pubkey: string | null }>(
      `SELECT o.id,
              COALESCE(o.expires_at, o.created_at + ($2::text || ' seconds')::interval) AS expires_at,
              o.created_at,
              COALESCE(NULLIF(o.user_dilithium_pubkey, ''), NULLIF(u.dilithium_pubkey, '')) AS user_dilithium_pubkey
       FROM orders o
       LEFT JOIN users u ON u.id = o.user_id
       WHERE o.direction = 'buy'
         AND o.status IN ('open', 'partially_filled')
         AND o.is_funded = true
         AND o.price_usdt >= $1
       ORDER BY o.price_usdt DESC, o.created_at ASC
       LIMIT 1`,
      [order.price_usdt, config.EVM_TIMELOCK_SECONDS],
    );
  }

  private async getUserBtqProfile(userId: string): Promise<{ dilithium_pubkey: string | null; btq_address: string | null } | null> {
    return getOne<{ dilithium_pubkey: string | null; btq_address: string | null }>(
      'SELECT dilithium_pubkey, btq_address FROM users WHERE id = $1',
      [userId],
    );
  }

  async cancelOrder(orderId: string, userId: string): Promise<OrderRow> {
    const order = await getOne<OrderRow>(
      'SELECT * FROM orders WHERE id = $1',
      [orderId],
    );

    if (!order) throw new Error('Order not found');
    if (order.user_id !== userId) throw new Error('Unauthorized');
    if (order.status !== 'open' && order.status !== 'partially_filled') {
      throw new Error(`Order cannot be cancelled (status: ${order.status})`);
    }

    const updated = await getOne<OrderRow>(
      `UPDATE orders SET status = 'cancelled', updated_at = now()
       WHERE id = $1 RETURNING *`,
      [orderId],
    );

    const book = await this.getOrderbook();
    notificationService.emitOrderbookUpdate(book);

    return updated!;
  }

  async getOrder(orderId: string): Promise<OrderRow | null> {
    return getOne<OrderRow>(
      `SELECT
         *,
         COALESCE(
           expires_at,
           CASE
             WHEN is_funded = true AND direction = 'buy'
               THEN created_at + ($2::text || ' seconds')::interval
             ELSE NULL
           END
         ) AS expires_at
       FROM orders
       WHERE id = $1`,
      [orderId, config.EVM_TIMELOCK_SECONDS],
    );
  }

  async getUserOrders(
    userId: string,
    status?: OrderStatus,
    limit = 50,
    offset = 0,
  ): Promise<OrderRow[]> {
    let orders: OrderRow[];
    if (status) {
      orders = await getMany<OrderRow>(
        `SELECT * FROM orders WHERE user_id = $1 AND status = $2
         ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
        [userId, status, limit, offset],
      );
    } else {
      orders = await getMany<OrderRow>(
        `SELECT * FROM orders WHERE user_id = $1
         ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [userId, limit, offset],
      );
    }
    return this.ensureExpiryForFundedEvmOrders(orders);
  }

  async getOrderbook(): Promise<Orderbook> {
    const [eligibleCount, excludedUnfundedCount, excludedStatusCount] = await Promise.all([
      getOne<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM orders
         WHERE status IN ('open', 'partially_filled')
           AND is_funded = true`,
      ),
      getOne<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM orders
         WHERE status IN ('open', 'partially_filled')
           AND is_funded = false`,
      ),
      getOne<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM orders
         WHERE status NOT IN ('open', 'partially_filled')`,
      ),
    ]);

    const bids = await getMany<OrderbookEntry>(
      `SELECT price_usdt AS price,
              SUM(amount_btq - filled_btq)::text AS amount_btq,
              SUM((amount_btq - filled_btq) * price_usdt)::text AS total_usdt,
              COUNT(*)::integer AS order_count
       FROM orders
       WHERE direction = 'buy'
         AND status IN ('open', 'partially_filled')
         AND is_funded = true
       GROUP BY price_usdt
       ORDER BY price_usdt DESC
       LIMIT 50`,
    );

    const asks = await getMany<OrderbookEntry>(
      `SELECT price_usdt AS price,
              SUM(amount_btq - filled_btq)::text AS amount_btq,
              SUM((amount_btq - filled_btq) * price_usdt)::text AS total_usdt,
              COUNT(*)::integer AS order_count
       FROM orders
       WHERE direction = 'sell'
         AND status IN ('open', 'partially_filled')
       GROUP BY price_usdt
       ORDER BY price_usdt ASC
       LIMIT 50`,
    );

    const bestBid = bids.length > 0 ? parseFloat(bids[0].price) : null;
    const bestAsk = asks.length > 0 ? parseFloat(asks[0].price) : null;
    const spread = bestBid !== null && bestAsk !== null
      ? (bestAsk - bestBid).toFixed(6)
      : null;

    console.log('[OrderService] getOrderbook summary', {
      eligibleFundedOpen: Number(eligibleCount?.count ?? 0),
      excludedUnfundedOpen: Number(excludedUnfundedCount?.count ?? 0),
      excludedClosedStatus: Number(excludedStatusCount?.count ?? 0),
      bidLevels: bids.length,
      askLevels: asks.length,
      bestBid,
      bestAsk,
      spread,
    });

    return { bids, asks, spread };
  }

  async getPublicFundedOrders(limit = 50): Promise<PublicFundedOrder[]> {
    return getMany<PublicFundedOrder>(
      `SELECT
         id, direction, status, price_usdt, amount_btq, filled_btq,
         (amount_btq - filled_btq)::text AS remaining_btq,
         is_funded,
         CASE WHEN secret_hash IS NOT NULL THEN encode(secret_hash, 'hex') ELSE NULL END AS secret_hash_hex,
         btq_htlc_txid, btq_htlc_vout, user_dilithium_pubkey, user_btq_address,
         created_at,
         COALESCE(expires_at, created_at + ($1::text || ' seconds')::interval) AS expires_at
       FROM orders
       WHERE status IN ('open', 'partially_filled')
         AND is_funded = true
       ORDER BY created_at DESC
       LIMIT $2`,
      [config.EVM_TIMELOCK_SECONDS, limit],
    );
  }

  async getPublicFundedOrder(orderId: string): Promise<PublicFundedOrder | null> {
    return getOne<PublicFundedOrder>(
      `SELECT
         id, direction, status, price_usdt, amount_btq, filled_btq,
         (amount_btq - filled_btq)::text AS remaining_btq,
         is_funded,
         CASE WHEN secret_hash IS NOT NULL THEN encode(secret_hash, 'hex') ELSE NULL END AS secret_hash_hex,
         btq_htlc_txid, btq_htlc_vout, user_dilithium_pubkey, user_btq_address,
         created_at,
         COALESCE(expires_at, created_at + ($2::text || ' seconds')::interval) AS expires_at
       FROM orders
       WHERE id = $1
         AND status IN ('open', 'partially_filled')
         AND is_funded = true`,
      [orderId, config.EVM_TIMELOCK_SECONDS],
    );
  }

  private async verifyFundingOnChain(
    order: OrderRow,
    userId: string,
    input: FundOrderInput,
  ): Promise<VerifiedFundingData> {
    if (order.direction === OrderDirection.BUY) {
      return this.verifyBuyOrderFundingOnEvm(order, userId, input);
    }
    return this.verifySellOrderFundingOnBtq(order, input);
  }

  private async verifyBuyOrderFundingOnEvm(
    order: OrderRow,
    userId: string,
    input: FundOrderInput,
  ): Promise<VerifiedFundingData> {
    const provider = new ethers.JsonRpcProvider(config.EVM_RPC_URL);
    const txHash = input.btq_htlc_txid.startsWith('0x')
      ? input.btq_htlc_txid
      : `0x${input.btq_htlc_txid}`;

    const [receipt, tx, user] = await Promise.all([
      provider.getTransactionReceipt(txHash),
      provider.getTransaction(txHash),
      getOne<{ eth_address: string }>('SELECT eth_address FROM users WHERE id = $1', [userId]),
    ]);

    if (!receipt || Number(receipt.status) !== 1) {
      throw new Error('EVM funding transaction not found or not successful on-chain');
    }
    if (!tx) {
      throw new Error('Unable to read EVM transaction details from chain');
    }
    if (!user) {
      throw new Error('Funding user not found');
    }

    const expectedSender = user.eth_address.toLowerCase();
    if ((tx.from ?? '').toLowerCase() !== expectedSender) {
      throw new Error('EVM funding tx sender does not match authenticated user');
    }

    let parsedLockup: ethers.LogDescription | null = null;
    for (const rawLog of receipt.logs) {
      if (rawLog.address.toLowerCase() !== config.HTLC_CONTRACT_ADDRESS.toLowerCase()) continue;
      try {
        const parsed = this.htlcLockupEventIface.parseLog(rawLog);
        if (parsed && parsed.name === 'HTLCERC20Lockup') {
          parsedLockup = parsed;
          break;
        }
      } catch {
        // ignore unrelated logs
      }
    }

    if (!parsedLockup) {
      throw new Error('EVM funding tx does not contain HTLC lockup event');
    }

    const eventPartyA = String(parsedLockup.args.partyA).toLowerCase();
    const eventSecretlock = String(parsedLockup.args.secretlock).replace(/^0x/, '').toLowerCase();
    const eventDeadline = Number(parsedLockup.args.deadline);
    const eventTokenAmount = BigInt(parsedLockup.args.tokenAmount.toString());
    const eventTokenContract = String(parsedLockup.args.erc20Contract).toLowerCase();

    if (eventPartyA !== expectedSender) {
      throw new Error('HTLC lockup partyA does not match authenticated user');
    }
    if (eventTokenContract !== config.USDT_TOKEN_ADDRESS.toLowerCase()) {
      throw new Error('HTLC lockup token does not match configured USDT token');
    }

    const expectedAmount = ethers.parseUnits(order.amount_usdt, 6);
    if (eventTokenAmount < expectedAmount) {
      throw new Error('HTLC lockup amount is less than required order amount');
    }

    if (input.secret_hash.replace(/^0x/, '').toLowerCase() !== eventSecretlock) {
      throw new Error('Provided secret hash does not match on-chain HTLC hashlock');
    }

    const expiresAt = Number.isFinite(eventDeadline) && eventDeadline > 0
      ? new Date(eventDeadline * 1000)
      : null;

    console.log('[OrderService] EVM funding verified from chain', {
      orderId: order.id,
      txHash,
      partyA: eventPartyA,
      eventSecretlockPrefix: eventSecretlock.slice(0, 16),
      eventDeadline,
      eventTokenAmount: eventTokenAmount.toString(),
      expectedAmount: expectedAmount.toString(),
    });

    return {
      secretHashHex: eventSecretlock,
      fundingTxid: txHash,
      vout: null,
      expiresAt,
    };
  }

  private async verifySellOrderFundingOnBtq(
    order: OrderRow,
    input: FundOrderInput,
  ): Promise<VerifiedFundingData> {
    const tx = await btqService.getRawTransaction(input.btq_htlc_txid, true);
    if (typeof tx === 'string') {
      throw new Error('BTQ funding tx was returned as raw hex, expected decoded tx');
    }
    if (!Array.isArray(tx.vout) || tx.vout.length === 0) {
      throw new Error('BTQ funding tx has no outputs');
    }

    const expectedAmount = parseFloat(order.amount_btq);
    const isP2mrOutput = (output: { scriptPubKey?: { type?: string } | null }): boolean => {
      const outputType = output.scriptPubKey?.type;
      return outputType === 'witness_v2_p2mr' || outputType === 'witness_v1_p2mr' || outputType === 'p2mr';
    };
    const hasSufficientAmount = (output: { value: number }): boolean => output.value + 1e-8 >= expectedAmount;

    const requestedOutput = tx.vout.find((o) => o.n === input.btq_htlc_vout);
    const resolvedOutput = (requestedOutput && isP2mrOutput(requestedOutput) && hasSufficientAmount(requestedOutput))
      ? requestedOutput
      : tx.vout.find((o) => isP2mrOutput(o) && hasSufficientAmount(o));

    if (!resolvedOutput) {
      if (!requestedOutput) {
        throw new Error(`BTQ funding tx output vout=${input.btq_htlc_vout} not found`);
      }
      throw new Error(
        `BTQ funding output does not satisfy requirements (submitted vout=${input.btq_htlc_vout}, value=${requestedOutput.value}, type=${requestedOutput.scriptPubKey?.type ?? 'unknown'}, expected_amount=${expectedAmount})`,
      );
    }
    if (!resolvedOutput.scriptPubKey?.address) {
      throw new Error('BTQ funding output address missing from decoded transaction');
    }
    if (resolvedOutput.n !== input.btq_htlc_vout) {
      console.warn('[OrderService] BTQ funding vout auto-corrected', {
        orderId: order.id,
        txid: tx.txid,
        submittedVout: input.btq_htlc_vout,
        resolvedVout: resolvedOutput.n,
      });
    }

    console.log('[OrderService] BTQ funding verified from chain', {
      orderId: order.id,
      txid: tx.txid,
      vout: resolvedOutput.n,
      outputValue: resolvedOutput.value,
      expectedAmount,
      confirmations: tx.confirmations ?? 0,
      outputType: resolvedOutput.scriptPubKey.type,
      outputAddress: resolvedOutput.scriptPubKey.address,
    });

    return {
      secretHashHex: input.secret_hash.replace(/^0x/, '').toLowerCase(),
      fundingTxid: tx.txid,
      vout: resolvedOutput.n,
      expiresAt: null,
    };
  }

  private async ensureExpiryForFundedEvmOrders(orders: OrderRow[]): Promise<OrderRow[]> {
    if (!orders.length) return orders;

    const provider = new ethers.JsonRpcProvider(config.EVM_RPC_URL);
    const normalized: OrderRow[] = [];

    for (const order of orders) {
      let next = order;
      const isFundedBuy = order.is_funded && order.direction === OrderDirection.BUY;
      const hasEvmTx = typeof order.btq_htlc_txid === 'string' && order.btq_htlc_txid.startsWith('0x');

      if (isFundedBuy && hasEvmTx) {
        if (!order.expires_at) {
          try {
            const receipt = await provider.getTransactionReceipt(order.btq_htlc_txid!);
            if (receipt) {
              for (const rawLog of receipt.logs) {
                if (rawLog.address.toLowerCase() !== config.HTLC_CONTRACT_ADDRESS.toLowerCase()) continue;
                try {
                  const parsed = this.htlcLockupEventIface.parseLog(rawLog);
                  if (parsed && parsed.name === 'HTLCERC20Lockup') {
                    const deadline = Number(parsed.args.deadline);
                    if (Number.isFinite(deadline) && deadline > 0) {
                      const expiresAt = new Date(deadline * 1000);
                      await query(
                        'UPDATE orders SET expires_at = $1, updated_at = now() WHERE id = $2',
                        [expiresAt, order.id],
                      );
                      next = { ...order, expires_at: expiresAt };
                    }
                    break;
                  }
                } catch {
                  // ignore non-lockup logs
                }
              }
            }
          } catch {
            // keep existing row if chain query fails
          }
        }

        if (!next.expires_at) {
          next = {
            ...next,
            expires_at: new Date(new Date(next.created_at).getTime() + config.EVM_TIMELOCK_SECONDS * 1000),
          };
        }
      }

      normalized.push(next);
    }

    return normalized;
  }
}

export const orderService = new OrderService();
