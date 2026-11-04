import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { swapLimiter } from '../middleware/rateLimiter';
import { swapService } from '../services/swap.service';
import { SwapDirection } from '../types/swap.types';

const router = Router();

router.use(authMiddleware);

async function assertSwapAccess(req: Request, res: Response): Promise<boolean> {
  const swapId = typeof req.params.id === 'string' ? req.params.id : req.params.id?.[0];
  if (!swapId) {
    res.status(400).json({ error: 'Invalid swap id' });
    return false;
  }
  const swap = await swapService.getSwap(swapId);
  if (!swap) {
    res.status(404).json({ error: 'Swap not found' });
    return false;
  }
  if (swap.user_id !== req.user!.userId && req.user!.role !== 'admin') {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  return true;
}

const createSwapSchema = z.object({
  direction: z.nativeEnum(SwapDirection),
  amount_btq: z.string().regex(/^\d+(\.\d{1,8})?$/),
  user_dilithium_pubkey: z.string().optional(),
  user_btq_address: z.string().optional(),
});

router.post('/', swapLimiter, async (req: Request, res: Response) => {
  try {
    const input = createSwapSchema.parse(req.body);
    const swap = await swapService.createSwap(req.user!.userId, input);
    res.status(201).json({ swap });
  } catch (err) {
    const message = err instanceof z.ZodError
      ? err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')
      : (err as Error).message;
    res.status(400).json({ error: message });
  }
});

router.get('/', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const swaps = await swapService.getUserSwaps(req.user!.userId, limit, offset);
    res.json({ swaps });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const swapId = typeof req.params.id === 'string' ? req.params.id : req.params.id?.[0];
    if (!swapId) {
      res.status(400).json({ error: 'Invalid swap id' });
      return;
    }
    const swap = await swapService.getSwapWithEvents(swapId);
    if (!swap) {
      res.status(404).json({ error: 'Swap not found' });
      return;
    }
    if (swap.user_id !== req.user!.userId && req.user!.role !== 'admin') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    res.json({ swap });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

const submitBtqHtlcSchema = z.object({
  btq_htlc_txid: z.string().length(64),
  btq_htlc_vout: z.number().int().min(0),
  btq_merkle_root: z.string().min(1),
  claim_leaf_hex: z.string().min(1),
  refund_leaf_hex: z.string().min(1),
  control_block_hex: z.string().min(1),
});

router.post('/:id/submit-btq-htlc', async (req: Request, res: Response) => {
  try {
    const allowed = await assertSwapAccess(req, res);
    if (!allowed) return;
    const input = submitBtqHtlcSchema.parse(req.body);
    const swapId = typeof req.params.id === 'string' ? req.params.id : req.params.id?.[0];
    if (!swapId) {
      res.status(400).json({ error: 'Invalid swap id' });
      return;
    }
    const swap = await swapService.submitUserBtqHtlc({
      swap_id: swapId,
      ...input,
    });
    res.json({ swap });
  } catch (err) {
    const message = err instanceof z.ZodError
      ? err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')
      : (err as Error).message;
    res.status(400).json({ error: message });
  }
});

const confirmBtqClaimSchema = z.object({
  btq_claim_txid: z.string().min(1),
});

router.post('/:id/confirm-btq-claim', async (req: Request, res: Response) => {
  try {
    const allowed = await assertSwapAccess(req, res);
    if (!allowed) return;
    const input = confirmBtqClaimSchema.parse(req.body);
    const swapId = typeof req.params.id === 'string' ? req.params.id : req.params.id?.[0];
    if (!swapId) {
      res.status(400).json({ error: 'Invalid swap id' });
      return;
    }
    const swap = await swapService.confirmUserBtqClaim(swapId, {
      swap_id: swapId,
      btq_claim_txid: input.btq_claim_txid,
    });
    res.json({ swap });
  } catch (err) {
    const message = err instanceof z.ZodError
      ? err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')
      : (err as Error).message;
    res.status(400).json({ error: message });
  }
});

router.get('/:id/cli-commands', async (req: Request, res: Response) => {
  try {
    const allowed = await assertSwapAccess(req, res);
    if (!allowed) return;
    const swapId = typeof req.params.id === 'string' ? req.params.id : req.params.id?.[0];
    if (!swapId) {
      res.status(400).json({ error: 'Invalid swap id' });
      return;
    }
    const commands = await swapService.getCliCommands(swapId);
    res.json({ commands });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
