import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authService } from '../services/auth.service';
import { authMiddleware } from '../middleware/auth';
import { authLimiter } from '../middleware/rateLimiter';

const router = Router();

router.get('/nonce', authLimiter, async (_req: Request, res: Response) => {
  try {
    const nonce = await authService.generateNonce();
    res.json({ nonce });
  } catch (err) {
    console.error('Nonce generation error:', err);
    res.status(500).json({ error: 'Failed to generate nonce' });
  }
});

const verifySchema = z.object({
  message: z.string().min(1),
  signature: z.string().min(1),
});

router.post('/verify', authLimiter, async (req: Request, res: Response) => {
  try {
    const input = verifySchema.parse(req.body);
    const { token, user } = await authService.verify(input.message, input.signature);
    res.json({
      token,
      user: {
        id: user.id,
        ethAddress: user.eth_address,
        role: user.role,
      },
    });
  } catch (err) {
    const message = err instanceof z.ZodError
      ? 'Invalid request body'
      : (err as Error).message;
    res.status(401).json({ error: message });
  }
});

router.post('/logout', authMiddleware, async (req: Request, res: Response) => {
  try {
    const token = req.headers.authorization?.slice(7);
    if (token) {
      await authService.logout(token);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Logout error:', err);
    res.status(500).json({ error: 'Logout failed' });
  }
});

export default router;
