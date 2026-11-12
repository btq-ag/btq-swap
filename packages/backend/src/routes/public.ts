import { Router, type Request, type Response } from 'express';
import { config } from '../config';
import { btqChain } from '../chains/btq';
import { evmChain } from '../chains/evm';
import { safeEqual } from '../lib/crypto';
import { db } from '../lib/db';
import { publicBook } from '../domain/book';
import { cliDescriptor, monitorState, publicSwapDetail } from '../domain/monitor';
import { btqStatus } from '../workers/btq-watcher';
import { evmStatus } from '../workers/evm-watcher';

export const publicRoutes = Router();

publicRoutes.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), time: new Date().toISOString() });
});

publicRoutes.get('/health/deep', async (req: Request, res: Response) => {
  const token = config().HEALTH_DEEP_TOKEN;
  const supplied = req.header('x-health-token') ?? '';
  if (!token || !safeEqual(supplied, token)) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  const checks: Record<string, string> = {};
  await db().query('SELECT 1').then(() => (checks.database = 'ok')).catch(() => (checks.database = 'error'));
  await btqChain().tip().then(() => (checks.btq_node = 'ok')).catch(() => (checks.btq_node = 'error'));
  await evmChain().blockNumber().then(() => (checks.evm_node = 'ok')).catch(() => (checks.evm_node = 'error'));
  const stale = (t: number) => (t && Date.now() - t < 60_000 ? 'ok' : 'stale');
  checks.btq_watcher = stale(btqStatus.lastTickAt);
  checks.evm_watcher = stale(evmStatus.lastTickAt);
  const ok = Object.values(checks).every((v) => v === 'ok');
  res.status(ok ? 200 : 503).json({ status: ok ? 'healthy' : 'degraded', checks });
});

publicRoutes.get('/public/monitor', async (_req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await monitorState());
  } catch (err) {
    next(err);
  }
});

publicRoutes.get('/public/book', async (_req, res, next) => {
  try {
    res.json(await publicBook(20));
  } catch (err) {
    next(err);
  }
});

publicRoutes.get('/public/swaps/:ref', async (req, res, next) => {
  try {
    const d = await publicSwapDetail(String(req.params.ref));
    if (!d) {
      res.status(404).json({ error: 'swap not found' });
      return;
    }
    res.json(d);
  } catch (err) {
    next(err);
  }
});

publicRoutes.get('/public/swaps/:ref/htlc', async (req, res, next) => {
  try {
    const d = await cliDescriptor(String(req.params.ref));
    if (!d) {
      res.status(404).json({ error: 'swap not found' });
      return;
    }
    res.json(d);
  } catch (err) {
    next(err);
  }
});
