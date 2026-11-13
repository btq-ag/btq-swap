import rateLimit from 'express-rate-limit';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { bearer, beginBtq, beginEvm, beginSol, completeBtq, completeEvm, completeSol, deskProfile, deskTake, lockPlan, noteBtqLock, prepareSolTx, submitSolTx, userFromToken } from '../domain/desk';
import type { WalletProof } from '../domain/desk-proof';
import { config } from '../config';
import { btqChain } from '../chains/btq';
import { evmChain } from '../chains/evm';
import { safeEqual } from '../lib/crypto';
import { db } from '../lib/db';
import { publicBook } from '../domain/book';
import { publicCandles } from '../domain/candles';
import { cliDescriptor, monitorState, publicSwapDetail, searchSwaps, type SwapFilter } from '../domain/monitor';
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
    res.set('Cache-Control', 'no-store');
    res.json(await publicBook(20));
  } catch (err) {
    next(err);
  }
});

publicRoutes.get('/public/candles', async (req, res, next) => {
  try {
    const interval = Number(req.query.interval ?? '5');
    const limit = Number(req.query.limit ?? '180');
    res.set('Cache-Control', 'no-store');
    res.json(await publicCandles(Number.isFinite(interval) ? interval : 5, Number.isFinite(limit) ? limit : 180));
  } catch (err) {
    next(err);
  }
});

publicRoutes.get('/public/swaps', async (req, res, next) => {
  try {
    const filter = String(req.query.filter ?? 'all');
    const allowed = ['active', 'completed', 'refunds', 'all'];
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const page = Number(req.query.page ?? '1');
    const limit = Number(req.query.limit ?? '8');
    res.set('Cache-Control', 'no-store');
    res.json(await searchSwaps(q, (allowed.includes(filter) ? filter : 'all') as SwapFilter, Number.isFinite(page) ? page : 1, Number.isFinite(limit) ? limit : 8));
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

const deskLimit = rateLimit({ windowMs: 60_000, max: 40, standardHeaders: true, legacyHeaders: false });
const proofSchema = z.object({
  scheme: z.string(),
  version: z.number(),
  origin: z.string(),
  network: z.string(),
  address: z.string(),
  message: z.string(),
  publicKey: z.string(),
  signature: z.string(),
});

publicRoutes.post('/public/desk/evm/start', deskLimit, async (req, res, next) => {
  try {
    const body = z.object({ address: z.string(), acceptTos: z.literal(true) }).parse(req.body);
    res.json(await beginEvm(body.address, true));
  } catch (err) {
    next(err);
  }
});

publicRoutes.post('/public/desk/evm/finish', deskLimit, async (req, res, next) => {
  try {
    const body = z.object({ address: z.string(), signature: z.string() }).parse(req.body);
    res.json(await completeEvm(body.address, body.signature));
  } catch (err) {
    next(err);
  }
});

async function optionalDeskUser(header: string | undefined) {
  try {
    return await userFromToken(bearer(header));
  } catch {
    return null;
  }
}

publicRoutes.post('/public/desk/sol/start', deskLimit, async (req, res, next) => {
  try {
    const body = z.object({ address: z.string(), acceptTos: z.literal(true) }).parse(req.body);
    res.json(await beginSol(body.address, true, await optionalDeskUser(req.header('authorization'))));
  } catch (err) {
    next(err);
  }
});

publicRoutes.post('/public/desk/sol/finish', deskLimit, async (req, res, next) => {
  try {
    const body = z.object({ address: z.string(), signature: z.string() }).parse(req.body);
    const session = await optionalDeskUser(req.header('authorization'));
    const done = await completeSol(body.address, body.signature, session);
    if (done.token) res.json(done);
    else res.json({ profile: done.profile });
  } catch (err) {
    next(err);
  }
});

publicRoutes.post('/public/desk/swaps/:ref/sol/prepare', deskLimit, async (req, res, next) => {
  try {
    const user = await userFromToken(bearer(req.header('authorization')));
    const body = z.object({ action: z.enum(['lock', 'withdraw', 'refund']), secretHash: z.string().optional() }).parse(req.body);
    res.json(await prepareSolTx(user, String(req.params.ref), body.action, body.secretHash));
  } catch (err) {
    next(err);
  }
});

publicRoutes.post('/public/desk/swaps/:ref/sol/submit', deskLimit, async (req, res, next) => {
  try {
    await userFromToken(bearer(req.header('authorization')));
    const body = z.object({ signedTx: z.string() }).parse(req.body);
    res.json(await submitSolTx(body.signedTx));
  } catch (err) {
    next(err);
  }
});

publicRoutes.get('/public/desk/me', async (req, res, next) => {
  try {
    const user = await userFromToken(bearer(req.header('authorization')));
    res.json({ profile: deskProfile(user) });
  } catch (err) {
    next(err);
  }
});

publicRoutes.post('/public/desk/btq/start', deskLimit, async (req, res, next) => {
  try {
    const user = await userFromToken(bearer(req.header('authorization')));
    res.json(await beginBtq(user));
  } catch (err) {
    next(err);
  }
});

publicRoutes.post('/public/desk/btq/finish', deskLimit, async (req, res, next) => {
  try {
    const user = await userFromToken(bearer(req.header('authorization')));
    const proof = proofSchema.parse(req.body) as WalletProof;
    res.json({ profile: await completeBtq(user, proof, req.header('origin') ?? '') });
  } catch (err) {
    next(err);
  }
});

publicRoutes.post('/public/desk/take', deskLimit, async (req, res, next) => {
  try {
    const user = await userFromToken(bearer(req.header('authorization')));
    const body = z.object({ orderNo: z.number().int().positive(), amountBtq: z.string() }).parse(req.body);
    const swap = await deskTake(user, body.orderNo, body.amountBtq);
    const role = swap.buyer_user_id === user.id ? 'buyer' : 'seller';
    res.status(201).json({
      shortId: Number(swap.short_id),
      status: swap.status,
      role,
      price: swap.price_usdt,
      amountBtq: swap.amount_btq,
      amountUsdt: swap.amount_usdt,
    });
  } catch (err) {
    next(err);
  }
});

publicRoutes.get('/public/desk/swaps/:ref/plan', async (req, res, next) => {
  try {
    const user = await userFromToken(bearer(req.header('authorization')));
    res.json(await lockPlan(user, String(req.params.ref)));
  } catch (err) {
    next(err);
  }
});

publicRoutes.post('/public/desk/swaps/:ref/btq-lock', deskLimit, async (req, res, next) => {
  try {
    const user = await userFromToken(bearer(req.header('authorization')));
    const body = z.object({ txid: z.string() }).parse(req.body);
    await noteBtqLock(user, String(req.params.ref), body.txid);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
