import { Pool, PoolClient } from 'pg';
import { pool } from '../lib/db';
import { generateSecret, secretToHash, bufToHex, generateSwapId } from '../lib/crypto';
import { notificationService } from './notification.service';
import { OrderDirection, OrderRow, OrderStatus } from '../types/order.types';
import { config } from '../config';

/**
 * Matching Engine
 *
 * Race-condition-safe order matching using PostgreSQL advisory locks
 * and SELECT ... FOR UPDATE SKIP LOCKED.
 *
 * Flow:
 *   1. Incoming (taker) order is placed.
 *   2. Engine acquires a pg_advisory_xact_lock to serialise matching
 *      across all concurrent requests.
 *   3. Within that lock, it selects the best-priced funded maker
 *      orders on the opposite side, locking each row with
 *      FOR UPDATE SKIP LOCKED so any concurrent matcher that
 *      somehow slips past the advisory lock still cannot touch
 *      the same row.
 *   4. For each match it:
 *        a. Computes fill quantity (min of remaining on both sides).
 *        b. Updates filled_btq + status on both orders.
 *        c. Inserts a trade record.
 *        d. Creates a swap record linking the two orders.
 *   5. Commits the whole batch atomically.
 *
 * The advisory lock key is a fixed integer so only ONE matching
 * session runs at a time across the entire cluster.  This is the
 * simplest correct approach; throughput is limited by commit
 * latency (~1-5 ms on local PG).  If throughput matters later,
 * switch to a partitioned-by-price-level scheme.
 */

const MATCHING_LOCK_KEY = 7_829_413;
const SELL_MATCH_MIN_BUY_WINDOW_SECONDS = 10 * 60;

interface MatchFill {
  makerOrder: OrderRow;
  makerOrderId: string;
  takerOrderId: string;
  makerUserId: string;
  takerUserId: string;
  swapId: string;
  takerSide: 'buy' | 'sell';
  fillBtq: number;
  fillUsdt: number;
  executionPrice: number;
}

interface MatchResult {
  fills: MatchFill[];
  remainingBtq: number;
  takerOrder: OrderRow;
}

export class MatchingService {

  /**
   * Called after a new taker order is inserted.
   * Returns the list of fills (may be empty if no matches).
   */
  async matchOrder(takerOrderId: string): Promise<MatchResult> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Serialise all matching globally
      await client.query('SELECT pg_advisory_xact_lock($1)', [MATCHING_LOCK_KEY]);

      // Re-read taker inside the lock
      const { rows: [taker] } = await client.query<OrderRow>(
        'SELECT * FROM orders WHERE id = $1 FOR UPDATE',
        [takerOrderId],
      );

      if (!taker) {
        await client.query('COMMIT');
        throw new Error(`Taker order ${takerOrderId} not found`);
      }

      console.log('[Matching] matchOrder start', {
        takerOrderId,
        takerUserId: taker.user_id,
        direction: taker.direction,
        status: taker.status,
        isFunded: taker.is_funded,
        price: taker.price_usdt,
        amount: taker.amount_btq,
        filled: taker.filled_btq,
      });

      if (taker.status !== OrderStatus.OPEN && taker.status !== OrderStatus.PARTIALLY_FILLED) {
        await client.query('COMMIT');
        return { fills: [], remainingBtq: 0, takerOrder: taker };
      }

      const fills = await this.executeFills(client, taker);

      await client.query('COMMIT');

      // Post-commit notifications
      if (fills.length > 0) {
        notificationService.emitTradeExecuted(fills.map((f) => ({
          price: f.executionPrice.toFixed(6),
          amount: f.fillBtq.toFixed(8),
          side: f.takerSide,
        })));
        for (const fill of fills) {
          notificationService.emitMatchActionRequired({
            swapId: fill.swapId,
            makerUserId: fill.makerUserId,
            takerUserId: fill.takerUserId,
            makerOrderId: fill.makerOrderId,
            takerOrderId: fill.takerOrderId,
            amountBtq: fill.fillBtq.toFixed(8),
            priceUsdt: fill.executionPrice.toFixed(6),
            side: fill.takerSide,
          });
          notificationService.emitOrderRefreshHint({
            userId: fill.makerUserId,
            reason: 'match_fill_created',
            orderId: fill.makerOrderId,
            swapId: fill.swapId,
          });
          notificationService.emitOrderRefreshHint({
            userId: fill.takerUserId,
            reason: 'match_fill_created',
            orderId: fill.takerOrderId,
            swapId: fill.swapId,
          });
        }
      }

      const updatedTaker = await this.getOrder(takerOrderId);
      return {
        fills,
        remainingBtq: parseFloat(updatedTaker!.amount_btq) - parseFloat(updatedTaker!.filled_btq),
        takerOrder: updatedTaker!,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async executeFills(client: PoolClient, taker: OrderRow): Promise<MatchFill[]> {
    const fills: MatchFill[] = [];
    let remainingBtq = parseFloat(taker.amount_btq) - parseFloat(taker.filled_btq);

    if (remainingBtq <= 0) return fills;

    const oppositeDir = taker.direction === OrderDirection.BUY
      ? OrderDirection.SELL
      : OrderDirection.BUY;

    // Price crossing condition:
    //   Buy taker: match sells whose price <= taker.price  (seller asking <= what buyer pays)
    //   Sell taker: match buys whose price >= taker.price  (buyer bidding >= what seller wants)
    const priceOp = taker.direction === OrderDirection.BUY ? '<=' : '>=';
    const priceSort = taker.direction === OrderDirection.BUY ? 'ASC' : 'DESC';

    // Fetch matching funded maker orders.
    // FOR UPDATE SKIP LOCKED ensures no two concurrent transactions
    // can claim the same maker order.
    const { rows: makers } = await client.query<OrderRow>(
      `SELECT * FROM orders
       WHERE direction = $1
         AND status IN ('open', 'partially_filled')
         AND is_funded = true
         AND (
           COALESCE(expires_at, created_at + ($4::text || ' seconds')::interval) >
             CASE
               WHEN $5 = 'sell'
                 THEN now() + ($6::text || ' seconds')::interval
               ELSE now()
             END
         )
         AND price_usdt ${priceOp} $2
         AND user_id != $3
       ORDER BY price_usdt ${priceSort}, created_at ASC
       FOR UPDATE SKIP LOCKED`,
      [
        oppositeDir,
        taker.price_usdt,
        taker.user_id,
        config.EVM_TIMELOCK_SECONDS,
        taker.direction,
        SELL_MATCH_MIN_BUY_WINDOW_SECONDS,
      ],
    );

    console.log('[Matching] candidate makers fetched', {
      takerOrderId: taker.id,
      candidateCount: makers.length,
      makerIds: makers.map((m) => m.id),
    });

    for (const maker of makers) {
      if (remainingBtq <= 1e-8) break;

      const makerRemaining = parseFloat(maker.amount_btq) - parseFloat(maker.filled_btq);
      if (makerRemaining <= 1e-8) continue;

      const fillBtq = Math.min(remainingBtq, makerRemaining);
      const executionPrice = parseFloat(maker.price_usdt);
      const fillUsdt = fillBtq * executionPrice;

      // Update maker order
      const makerNewFilled = parseFloat(maker.filled_btq) + fillBtq;
      const makerNewStatus = makerNewFilled >= parseFloat(maker.amount_btq) - 1e-8
        ? OrderStatus.FILLED
        : OrderStatus.PARTIALLY_FILLED;

      await client.query(
        `UPDATE orders SET filled_btq = $1, status = $2, updated_at = now()
         WHERE id = $3`,
        [makerNewFilled.toFixed(8), makerNewStatus, maker.id],
      );

      // Update taker order
      remainingBtq -= fillBtq;
      const takerNewFilled = parseFloat(taker.filled_btq) + (parseFloat(taker.amount_btq) - parseFloat(taker.filled_btq) - remainingBtq);
      const takerNewStatus = remainingBtq <= 1e-8
        ? OrderStatus.FILLED
        : OrderStatus.PARTIALLY_FILLED;

      await client.query(
        `UPDATE orders SET filled_btq = $1, status = $2, updated_at = now()
         WHERE id = $3`,
        [takerNewFilled.toFixed(8), takerNewStatus, taker.id],
      );

      // Determine swap direction from taker perspective
      const swapDirection = taker.direction === OrderDirection.BUY ? 'buy_btq' : 'sell_btq';
      const evmSwapId = generateSwapId();

      // If the maker already has a secret_hash (from their funded HTLC), reuse it.
      // Otherwise generate a new one for the swap.
      let secretHash: Buffer;
      let secret: Buffer | null = null;
      if (maker.secret_hash) {
        secretHash = maker.secret_hash as unknown as Buffer;
      } else {
        secret = generateSecret();
        secretHash = secretToHash(secret);
      }

      // Create swap
      const { rows: [swap] } = await client.query(
        `INSERT INTO swaps (
          order_id, user_id, direction,
          amount_btq, amount_usdt, price_usdt,
          secret_hash, secret, evm_htlc_swap_id,
          status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
        RETURNING id`,
        [
          taker.id,
          taker.user_id,
          swapDirection,
          fillBtq.toFixed(8),
          fillUsdt.toFixed(6),
          executionPrice.toFixed(6),
          secretHash,
          secret,
          evmSwapId,
        ],
      );

      // Link maker order to this swap
      await client.query(
        `UPDATE orders SET locked_by_swap_id = $1 WHERE id = $2`,
        [swap.id, maker.id],
      );

      // Record the trade
      await client.query(
        `INSERT INTO trades (
          swap_id, maker_order_id, taker_order_id,
          maker_user_id, taker_user_id,
          direction, price_usdt, amount_btq, amount_usdt
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          swap.id,
          maker.id,
          taker.id,
          maker.user_id,
          taker.user_id,
          taker.direction,
          executionPrice.toFixed(6),
          fillBtq.toFixed(8),
          fillUsdt.toFixed(6),
        ],
      );

      // Record swap event
      await client.query(
        `INSERT INTO swap_events (swap_id, to_status, event_type, metadata)
         VALUES ($1, 'pending', 'matched', $2)`,
        [
          swap.id,
          JSON.stringify({
            maker_order_id: maker.id,
            taker_order_id: taker.id,
            fill_btq: fillBtq.toFixed(8),
            fill_usdt: fillUsdt.toFixed(6),
            execution_price: executionPrice.toFixed(6),
          }),
        ],
      );

      fills.push({
        makerOrder: maker,
        makerOrderId: maker.id,
        takerOrderId: taker.id,
        makerUserId: maker.user_id,
        takerUserId: taker.user_id,
        swapId: swap.id,
        takerSide: taker.direction,
        fillBtq,
        fillUsdt,
        executionPrice,
      });
    }

    console.log('[Matching] fills complete', {
      takerOrderId: taker.id,
      fillCount: fills.length,
      filledBtq: fills.reduce((acc, f) => acc + f.fillBtq, 0).toFixed(8),
      remainingBtq: remainingBtq.toFixed(8),
    });

    return fills;
  }

  private async getOrder(orderId: string): Promise<OrderRow | null> {
    const { rows } = await pool.query<OrderRow>(
      'SELECT * FROM orders WHERE id = $1',
      [orderId],
    );
    return rows[0] ?? null;
  }

  /**
   * Returns candle data for the chart.
   * Aggregates trades into OHLCV buckets.
   */
  async getCandles(
    intervalSeconds: number = 3600,
    limit: number = 200,
  ): Promise<{
    time: number; open: number; high: number; low: number; close: number; volume: number;
  }[]> {
    const { rows } = await pool.query<{
      bucket: Date;
      open: string;
      high: string;
      low: string;
      close: string;
      volume: string;
    }>(
      `WITH buckets AS (
        SELECT
          to_timestamp(
            floor(extract(epoch FROM created_at) / $1) * $1
          ) AS bucket,
          price_usdt,
          amount_btq,
          created_at
        FROM trades
        ORDER BY created_at ASC
      )
      SELECT
        bucket,
        (array_agg(price_usdt ORDER BY created_at ASC))[1]::text  AS open,
        MAX(price_usdt)::text AS high,
        MIN(price_usdt)::text AS low,
        (array_agg(price_usdt ORDER BY created_at DESC))[1]::text AS close,
        SUM(amount_btq)::text AS volume
      FROM buckets
      GROUP BY bucket
      ORDER BY bucket DESC
      LIMIT $2`,
      [intervalSeconds, limit],
    );

    return rows.reverse().map((r) => ({
      time: Math.floor(new Date(r.bucket).getTime() / 1000),
      open: parseFloat(r.open),
      high: parseFloat(r.high),
      low: parseFloat(r.low),
      close: parseFloat(r.close),
      volume: parseFloat(r.volume),
    }));
  }

  /**
   * Returns recent trades for the trades panel.
   */
  async getRecentTrades(limit: number = 50): Promise<{
    id: string; price: string; amount: string; direction: string; created_at: Date;
  }[]> {
    const { rows } = await pool.query(
      `SELECT id, price_usdt AS price, amount_btq AS amount, direction, created_at
       FROM trades ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return rows;
  }
}

export const matchingService = new MatchingService();
