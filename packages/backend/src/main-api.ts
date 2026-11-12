import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { ZodError } from 'zod';
import { adminDiscordIds, config } from './config';
import { closePool } from './lib/db';
import { createLogger } from './lib/logger';
import { isDomainError } from './domain/errors';
import { seedAdmins } from './domain/identity';
import { ensurePlatformUser } from './domain/platform';
import { resolveEvmAddresses } from './domain/runtime';
import { adminRoutes } from './routes/admin';
import { publicRoutes } from './routes/public';
import { startWorkers, type RunnerHandle } from './workers/runner';

const log = createLogger('api');

export function createApp(): express.Express {
  const app = express();
  if (config().TRUST_PROXY) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet());
  const origins = config().CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  app.use(cors({ origin: origins, credentials: true }));
  app.use(express.json({ limit: '256kb' }));
  app.use(rateLimit({ windowMs: 60_000, max: 600, standardHeaders: true, legacyHeaders: false }));
  app.use('/api', publicRoutes);
  app.use('/api/admin', adminRoutes);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (isDomainError(err)) {
      res.status(err.httpStatus).json({ error: err.message, code: err.code });
      return;
    }
    if (err instanceof ZodError) {
      res.status(400).json({ error: err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ') });
      return;
    }
    log.error('unhandled', { err: (err as Error).message });
    res.status(500).json({ error: 'internal error' });
  });
  return app;
}

async function main(): Promise<void> {
  const c = config();
  await resolveEvmAddresses({ waitMs: c.DEVNET ? 10 * 60_000 : 0 });
  await ensurePlatformUser();
  await seedAdmins(adminDiscordIds());
  const app = createApp();
  const server = app.listen(c.PORT, () => log.info(`API listening on :${c.PORT}`, { network: c.BTQ_NETWORK, chainId: c.EVM_CHAIN_ID }));
  let workers: RunnerHandle | null = null;
  if (c.WORKERS_ENABLED) workers = startWorkers();
  const shutdown = async (sig: string) => {
    log.info(`${sig} received, shutting down`);
    server.close();
    await workers?.stop();
    await closePool();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[api] fatal', err);
    process.exit(1);
  });
}
