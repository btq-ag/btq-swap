import { Router, Request, Response } from 'express';
import Redis from 'ioredis';
import { pool } from '../lib/db';
import { config } from '../config';
import { priceService } from '../services/price.service';
import { orderService } from '../services/order.service';
import { pathParam } from '../lib/pathParam';

const router = Router();

router.get('/health', async (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

router.get('/health/deep', async (req: Request, res: Response) => {
  if (config.HEALTH_DEEP_TOKEN) {
    const supplied = req.header('x-health-token');
    if (supplied !== config.HEALTH_DEEP_TOKEN) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
  }

  const checks: Record<string, string> = {};

  try {
    await pool.query('SELECT 1');
    checks.database = 'ok';
  } catch {
    checks.database = 'error';
  }

  try {
    const redisClient = new Redis(config.REDIS_URL);
    await redisClient.ping();
    checks.redis = 'ok';
    redisClient.disconnect();
  } catch {
    checks.redis = 'error';
  }

  try {
    const { btqRpc } = await import('../lib/btqRpc');
    await btqRpc.call('getblockcount');
    checks.btq_node = 'ok';
  } catch {
    checks.btq_node = 'unreachable';
  }

  const allOk = Object.values(checks).every((v) => v === 'ok');

  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'healthy' : 'degraded',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    checks,
  });
});

router.get('/price', async (_req: Request, res: Response) => {
  try {
    const bid = await priceService.getBidPrice();
    const ask = await priceService.getAskPrice();
    res.json({ bid, ask, pair: 'BTQ/USDT' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/orderbook', async (_req: Request, res: Response) => {
  try {
    const orderbook = await orderService.getOrderbook();
    res.json({ orderbook });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Public funded-order feed used by the trading UI details panel.
router.get('/orderbook/orders', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const orders = await orderService.getPublicFundedOrders(limit);
    res.json({ orders });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/orderbook/orders/:id', async (req: Request, res: Response) => {
  try {
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

export default router;
