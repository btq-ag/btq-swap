import { Router, Request, Response } from 'express';
import { z } from 'zod';

const router = Router();

const telemetrySchema = z.object({
  event: z.string().min(2).max(100),
  payload: z.record(z.unknown()).optional(),
  ts: z.string().optional(),
});

router.post('/telemetry', async (req: Request, res: Response) => {
  try {
    const data = telemetrySchema.parse(req.body);
    // Keep telemetry lightweight for MVP: log structured events for later ingestion.
    console.log('[Telemetry]', JSON.stringify({
      event: data.event,
      payload: data.payload ?? {},
      ts: data.ts ?? new Date().toISOString(),
      requestId: req.requestId ?? null,
      userId: req.user?.userId ?? null,
    }));
    res.status(202).json({ accepted: true });
  } catch (err) {
    const message = err instanceof z.ZodError
      ? err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')
      : (err as Error).message;
    res.status(400).json({ error: message });
  }
});

export default router;
