import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { getOne, query } from '../lib/db';
import { btqService } from '../services/btq.service';

const router = Router();

router.use(authMiddleware);

router.get('/profile', async (req: Request, res: Response) => {
  try {
    const user = await getOne(
      'SELECT id, eth_address, btq_address, dilithium_pubkey, role, created_at FROM users WHERE id = $1',
      [req.user!.userId],
    );
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/btq-balance', async (req: Request, res: Response) => {
  try {
    console.log('[UserRoutes] /user/btq-balance request', {
      userId: req.user!.userId,
    });
    const user = await getOne<{ btq_address: string | null }>(
      'SELECT btq_address FROM users WHERE id = $1',
      [req.user!.userId],
    );
    const address = user?.btq_address?.trim() ?? '';
    if (!address) {
      console.log('[UserRoutes] /user/btq-balance no configured address', {
        userId: req.user!.userId,
      });
      res.json({ configured: false, available: false, balance: null });
      return;
    }
    const balance = await btqService.getAddressBalance(address);
    console.log('[UserRoutes] /user/btq-balance response', {
      userId: req.user!.userId,
      address,
      available: balance !== null,
      balance,
    });
    res.json({
      configured: true,
      available: balance !== null,
      address,
      balance,
    });
  } catch (err) {
    console.error('[UserRoutes] /user/btq-balance unexpected error', {
      userId: req.user?.userId ?? null,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(200).json({ configured: true, available: false, balance: null });
  }
});

const dilithiumSchema = z.object({
  dilithium_pubkey: z.string().min(10),
});

router.put('/dilithium-pubkey', async (req: Request, res: Response) => {
  try {
    const { dilithium_pubkey } = dilithiumSchema.parse(req.body);
    const user = await getOne(
      `UPDATE users SET dilithium_pubkey = $1 WHERE id = $2 RETURNING id, eth_address, btq_address, dilithium_pubkey, role`,
      [dilithium_pubkey, req.user!.userId],
    );
    res.json({ user });
  } catch (err) {
    const message = err instanceof z.ZodError
      ? err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')
      : (err as Error).message;
    res.status(400).json({ error: message });
  }
});

const btqAddressSchema = z.object({
  btq_address: z.string().min(10),
});

router.put('/btq-address', async (req: Request, res: Response) => {
  try {
    const { btq_address } = btqAddressSchema.parse(req.body);
    const user = await getOne(
      `UPDATE users SET btq_address = $1 WHERE id = $2 RETURNING id, eth_address, btq_address, dilithium_pubkey, role`,
      [btq_address, req.user!.userId],
    );
    res.json({ user });
  } catch (err) {
    const message = err instanceof z.ZodError
      ? err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')
      : (err as Error).message;
    res.status(400).json({ error: message });
  }
});

export default router;
