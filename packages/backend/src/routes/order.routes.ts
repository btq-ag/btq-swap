import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { swapLimiter } from '../middleware/rateLimiter';
import { orderService, FundOrderInput } from '../services/order.service';
import { swapService } from '../services/swap.service';
import { matchingService } from '../services/matching.service';
import { OrderDirection, OrderStatus } from '../types/order.types';
import { getOne } from '../lib/db';
import { bufToHex } from '../lib/crypto';
import { pathParam } from '../lib/pathParam';

const router = Router();

const createOrderSchema = z.object({
  direction: z.nativeEnum(OrderDirection),
  amount_btq: z.string().regex(/^\d+(\.\d{1,8})?$/),
  price_usdt: z.string().regex(/^\d+(\.\d{1,6})?$/),
  funded: z.boolean().optional(),
});

router.post('/', authMiddleware, swapLimiter, async (req: Request, res: Response) => {
  try {
    const input = createOrderSchema.parse(req.body);
    const { order, fills } = await orderService.placeOrder(
      req.user!.userId,
      input,
      input.funded ?? false,
    );
    res.status(201).json({ order, fills });
  } catch (err) {
    const message = err instanceof z.ZodError
      ? err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')
      : (err as Error).message;
    res.status(400).json({ error: message });
  }
});

const fundOrderSchema = z.object({
  secret_hash: z.string().min(1),
  btq_htlc_txid: z.string().min(1),
  btq_htlc_vout: z.number().int().min(0),
  user_dilithium_pubkey: z.string().optional(),
  user_btq_address: z.string().optional(),
});
const sellFundingCommandsSchema = z.object({
  secret_hash: z.string().min(1),
  timelock_minutes: z.coerce.number().int().min(1).max(10080),
});
const confirmBtqClaimSchema = z.object({
  btq_claim_txid: z.string().min(1),
});

async function resolveLinkedSwapIdForOrder(orderId: string, lockedBySwapId: string | null): Promise<string | null> {
  if (lockedBySwapId) return lockedBySwapId;
  const row = await getOne<{ id: string }>(
    `SELECT id FROM swaps
     WHERE order_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [orderId],
  );
  return row?.id ?? null;
}

async function resolveLatestCounterpartyOrder(orderId: string): Promise<{
  orderId: string;
  isFunded: boolean;
  btqHtlcTxid: string | null;
  btqHtlcVout: number | null;
  userDilithiumPubkey: string | null;
  userBtqAddress: string | null;
} | null> {
  const trade = await getOne<{ counterparty_order_id: string }>(
    `SELECT CASE
        WHEN maker_order_id = $1 THEN taker_order_id
        ELSE maker_order_id
      END AS counterparty_order_id
     FROM trades
     WHERE maker_order_id = $1 OR taker_order_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [orderId],
  );
  if (!trade?.counterparty_order_id) return null;
  const cp = await getOne<{
    id: string;
    is_funded: boolean;
    btq_htlc_txid: string | null;
    btq_htlc_vout: number | null;
    user_dilithium_pubkey: string | null;
    user_btq_address: string | null;
  }>(
    `SELECT id, is_funded, btq_htlc_txid, btq_htlc_vout, user_dilithium_pubkey, user_btq_address
     FROM orders
     WHERE id = $1`,
    [trade.counterparty_order_id],
  );
  if (!cp) return null;
  return {
    orderId: cp.id,
    isFunded: cp.is_funded,
    btqHtlcTxid: cp.btq_htlc_txid,
    btqHtlcVout: cp.btq_htlc_vout,
    userDilithiumPubkey: cp.user_dilithium_pubkey,
    userBtqAddress: cp.user_btq_address,
  };
}

router.post('/:id/fund', authMiddleware, async (req: Request, res: Response) => {
  console.log(`[Orders] POST /:id/fund`, {
    orderId: pathParam(req.params.id),
    userId: req.user?.userId,
    body: req.body,
  });
  try {
    const input = fundOrderSchema.parse(req.body) as FundOrderInput;
    const { order, fills } = await orderService.fundOrder(
      pathParam(req.params.id),
      req.user!.userId,
      input,
    );
    console.log(`[Orders] Fund success`, { orderId: pathParam(req.params.id), fills });
    res.json({ order, fills });
  } catch (err) {
    const message = err instanceof z.ZodError
      ? err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')
      : (err as Error).message;
    console.error(`[Orders] Fund error`, { orderId: pathParam(req.params.id), error: message });
    res.status(400).json({ error: message });
  }
});

router.get('/:id/sell-funding-context', authMiddleware, async (req: Request, res: Response) => {
  try {
    const context = await orderService.getSellFundingContext(pathParam(req.params.id), req.user!.userId);
    res.json({ context });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.get('/:id/sell-funding-commands', authMiddleware, async (req: Request, res: Response) => {
  try {
    const query = sellFundingCommandsSchema.parse(req.query);
    const commands = await orderService.getSellFundingCommands(
      pathParam(req.params.id),
      req.user!.userId,
      query.secret_hash,
      query.timelock_minutes,
    );
    res.json({ commands });
  } catch (err) {
    const message = err instanceof z.ZodError
      ? err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')
      : (err as Error).message;
    res.status(400).json({ error: message });
  }
});

router.get('/:id/funding-status', authMiddleware, async (req: Request, res: Response) => {
  try {
    const status = await orderService.getOrderFundingStatus(pathParam(req.params.id), req.user!.userId);
    res.json({ status });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.get('/:id/settlement', authMiddleware, async (req: Request, res: Response) => {
  try {
    const order = await orderService.getOrder(pathParam(req.params.id));
    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    if (order.user_id !== req.user!.userId && req.user!.role !== 'admin') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    const swapId = await resolveLinkedSwapIdForOrder(order.id, order.locked_by_swap_id);
    if (!swapId) {
      res.json({ settlement: { swapId: null, swap: null, commands: null } });
      return;
    }
    const swap = await swapService.getSwapWithEvents(swapId);
    if (!swap) {
      res.json({ settlement: { swapId, swap: null, commands: null } });
      return;
    }
    let commands: Record<string, string> | null = null;
    try {
      commands = await swapService.getCliCommands(swapId);
    } catch {
      commands = null;
    }
    const evmSwapIdHex = swap.evm_htlc_swap_id ? `0x${bufToHex(swap.evm_htlc_swap_id)}` : null;
    const counterparty = await resolveLatestCounterpartyOrder(order.id);
    const effectiveStatus = (
      swap.status === 'awaiting_user_btq_htlc' &&
      order.direction === 'buy' &&
      !!counterparty?.isFunded &&
      !!counterparty.btqHtlcTxid
    )
      ? 'awaiting_user_btq_claim'
      : swap.status;
    res.json({
      settlement: {
        swapId,
        swap: {
          id: swap.id,
          status: effectiveStatus,
          rawStatus: swap.status,
          direction: swap.direction,
          btq_claim_txid: swap.btq_claim_txid,
          evm_htlc_tx_hash: swap.evm_htlc_tx_hash,
          evmSwapIdHex,
          counterparty,
          events: swap.events,
        },
        commands,
      },
    });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.post('/:id/confirm-btq-claim', authMiddleware, async (req: Request, res: Response) => {
  try {
    const parsed = confirmBtqClaimSchema.parse(req.body);
    const order = await orderService.getOrder(pathParam(req.params.id));
    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    if (order.user_id !== req.user!.userId && req.user!.role !== 'admin') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    const swapId = await resolveLinkedSwapIdForOrder(order.id, order.locked_by_swap_id);
    if (!swapId) {
      res.status(400).json({ error: 'No linked swap found for this order' });
      return;
    }
    const swap = await swapService.confirmUserBtqClaim(swapId, {
      swap_id: swapId,
      btq_claim_txid: parsed.btq_claim_txid,
    });
    res.json({ swap });
  } catch (err) {
    const message = err instanceof z.ZodError
      ? err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')
      : (err as Error).message;
    res.status(400).json({ error: message });
  }
});

router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const status = req.query.status as OrderStatus | undefined;
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const orders = await orderService.getUserOrders(req.user!.userId, status, limit, offset);
    res.json({ orders });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/orderbook', async (_req: Request, res: Response) => {
  try {
    console.log('[Orders] GET /orderbook request');
    const orderbook = await orderService.getOrderbook();
    res.json({ orderbook });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/orderbook/orders', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    console.log('[Orders] GET /orderbook/orders request', { limit });
    const orders = await orderService.getPublicFundedOrders(limit);
    console.log('[Orders] GET /orderbook/orders response', { count: orders.length });
    res.json({ orders });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/orderbook/orders/:id', async (req: Request, res: Response) => {
  try {
    console.log('[Orders] GET /orderbook/orders/:id request', { orderId: pathParam(req.params.id) });
    const order = await orderService.getPublicFundedOrder(pathParam(req.params.id));
    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    res.json({ order });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/trades', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const trades = await matchingService.getRecentTrades(limit);
    res.json({ trades });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/candles', async (req: Request, res: Response) => {
  try {
    const interval = parseInt(req.query.interval as string) || 3600;
    const limit = parseInt(req.query.limit as string) || 200;
    const candles = await matchingService.getCandles(interval, limit);
    res.json({ candles });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    const order = await orderService.getOrder(pathParam(req.params.id));
    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    if (order.user_id !== req.user!.userId && req.user!.role !== 'admin') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    res.json({ order });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post('/:id/cancel', authMiddleware, async (req: Request, res: Response) => {
  try {
    const order = await orderService.cancelOrder(pathParam(req.params.id), req.user!.userId);
    res.json({ order });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

export default router;
