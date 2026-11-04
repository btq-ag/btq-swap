import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createServer } from 'node:http';
import { config } from './config';
import { errorHandler } from './middleware/errorHandler';
import { generalLimiter } from './middleware/rateLimiter';
import { requestLogger } from './middleware/requestLogger';
import { initSocketIO } from './lib/websocket';

import healthRoutes from './routes/health.routes';
import authRoutes from './routes/auth.routes';
import userRoutes from './routes/user.routes';
import swapRoutes from './routes/swap.routes';
import orderRoutes from './routes/order.routes';
import adminRoutes from './routes/admin.routes';
import telemetryRoutes from './routes/telemetry.routes';

import { btqMonitorWorker } from './workers/btqMonitor.worker';
import { evmMonitorWorker } from './workers/evmMonitor.worker';
import { swapProcessorWorker } from './workers/swapProcessor.worker';
import { refundCheckerWorker } from './workers/refundChecker.worker';
import { reconciliationWorker } from './workers/reconciliation.worker';

const app = express();
const httpServer = createServer(app);

initSocketIO(httpServer);

app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: config.CORS_ORIGIN, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(requestLogger);
app.use(generalLimiter);

app.use('/api', healthRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/swaps', swapRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api', telemetryRoutes);

app.use(errorHandler);

function startWorkers(): void {
  btqMonitorWorker.start();
  evmMonitorWorker.start();
  swapProcessorWorker.start();
  refundCheckerWorker.start();
  reconciliationWorker.start();
}

function stopWorkers(): void {
  btqMonitorWorker.stop();
  evmMonitorWorker.stop();
  swapProcessorWorker.stop();
  refundCheckerWorker.stop();
  reconciliationWorker.stop();
}

httpServer.listen(config.PORT, () => {
  console.log(`[Server] BTQ Swap backend running on port ${config.PORT}`);
  console.log(`[Server] Environment: ${config.NODE_ENV}`);
  startWorkers();
});

const shutdown = (signal: string) => {
  console.log(`\n[Server] ${signal} received, shutting down gracefully...`);
  stopWorkers();
  httpServer.close(() => {
    console.log('[Server] HTTP server closed');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('[Server] Forced shutdown after timeout');
    process.exit(1);
  }, 10_000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export { app, httpServer };
