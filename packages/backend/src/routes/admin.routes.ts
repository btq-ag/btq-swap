import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { adminAuthMiddleware } from '../middleware/adminAuth';
import { swapService } from '../services/swap.service';
import { priceService } from '../services/price.service';
import { analyticsService } from '../services/analytics.service';
import { btqService } from '../services/btq.service';
import { evmService } from '../services/evm.service';
import { config } from '../config';
import { getMany, getOne, query } from '../lib/db';
import { SwapStatus } from '../types/swap.types';
import { pathParam } from '../lib/pathParam';

const router = Router();

router.use(authMiddleware);
router.use(adminAuthMiddleware);

// ─── Dashboard ──────────────────────────────────────────────────

router.get('/dashboard', async (_req: Request, res: Response) => {
  try {
    const stats = await analyticsService.getDashboard();
    res.json({ stats });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/daily-stats', async (req: Request, res: Response) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    const stats = await analyticsService.getDailyStats(days);
    res.json({ stats });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── Swap Management ────────────────────────────────────────────

router.get('/swaps', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const status = req.query.status as SwapStatus | undefined;
    const swaps = await swapService.getAllSwaps(limit, offset, status);
    res.json({ swaps });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/swaps/:id', async (req: Request, res: Response) => {
  try {
    const swap = await swapService.getSwapWithEvents(pathParam(req.params.id));
    if (!swap) {
      res.status(404).json({ error: 'Swap not found' });
      return;
    }
    res.json({ swap });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

const refundSchema = z.object({
  reason: z.string().min(1),
});

router.post('/swaps/:id/refund', async (req: Request, res: Response) => {
  try {
    const { reason } = refundSchema.parse(req.body);
    const swap = await swapService.refundSwap(pathParam(req.params.id), reason);
    res.json({ swap });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.post('/swaps/:id/fail', async (req: Request, res: Response) => {
  try {
    const { reason } = refundSchema.parse(req.body);
    const swap = await swapService.failSwap(pathParam(req.params.id), reason);
    res.json({ swap });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

const adminNoteSchema = z.object({
  note: z.string().min(1),
});

router.post('/swaps/:id/note', async (req: Request, res: Response) => {
  try {
    const { note } = adminNoteSchema.parse(req.body);
    const swap = await swapService.addAdminNote(pathParam(req.params.id), note);
    res.json({ swap });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// ─── User Management ────────────────────────────────────────────

router.get('/users', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const users = await getMany(
      'SELECT id, eth_address, btq_address, role, is_banned, created_at, last_login_at FROM users ORDER BY created_at DESC LIMIT $1 OFFSET $2',
      [limit, offset],
    );
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

const banSchema = z.object({
  is_banned: z.boolean(),
});

router.patch('/users/:id/ban', async (req: Request, res: Response) => {
  try {
    const { is_banned } = banSchema.parse(req.body);
    const user = await getOne(
      'UPDATE users SET is_banned = $1 WHERE id = $2 RETURNING id, eth_address, is_banned',
      [is_banned, pathParam(req.params.id)],
    );
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json({ user });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

const roleSchema = z.object({
  role: z.enum(['user', 'admin']),
});

router.patch('/users/:id/role', async (req: Request, res: Response) => {
  try {
    const { role } = roleSchema.parse(req.body);
    const user = await getOne(
      'UPDATE users SET role = $1 WHERE id = $2 RETURNING id, eth_address, role',
      [role, pathParam(req.params.id)],
    );
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json({ user });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// ─── Config Management ──────────────────────────────────────────

router.get('/config', async (_req: Request, res: Response) => {
  try {
    const allConfig = await priceService.getAllConfig();
    res.json({ config: allConfig });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

const updateConfigSchema = z.object({
  key: z.string().min(1),
  value: z.unknown(),
});

router.put('/config', async (req: Request, res: Response) => {
  try {
    const { key, value } = updateConfigSchema.parse(req.body);
    await priceService.setConfig(key, value, req.user!.userId);
    res.json({ success: true, key, value });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// ─── Wallet Status ──────────────────────────────────────────────

router.get('/wallet', async (_req: Request, res: Response) => {
  try {
    const [btqWallet, ethBalance, usdtBalance] = await Promise.all([
      btqService.getWalletInfo(),
      evmService.getPlatformBalance(),
      evmService.getTokenBalance(config.USDT_TOKEN_ADDRESS),
    ]);

    res.json({
      btq: {
        balance: btqWallet.balance,
        unconfirmed: btqWallet.unconfirmed_balance,
        txcount: btqWallet.txcount,
      },
      evm: {
        address: await evmService.getPlatformAddress(),
        ethBalance,
        usdtBalance,
      },
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── System ─────────────────────────────────────────────────────

router.get('/system', async (_req: Request, res: Response) => {
  try {
    const [btqChain, blockCount] = await Promise.all([
      btqService.getBlockchainInfo(),
      btqService.getBlockCount(),
    ]);

    res.json({
      btqNode: {
        chain: btqChain.chain,
        blocks: blockCount,
        headers: btqChain.headers,
        difficulty: btqChain.difficulty,
      },
      evmChainId: config.EVM_CHAIN_ID,
      uptime: process.uptime(),
      nodeVersion: process.version,
      memoryUsage: process.memoryUsage(),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post('/refresh-stats', async (_req: Request, res: Response) => {
  try {
    await analyticsService.refreshDailyStats();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
