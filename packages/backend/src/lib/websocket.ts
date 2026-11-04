import { Server as HttpServer } from 'node:http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { getOne } from './db';

let io: Server | null = null;

interface JwtPayload {
  userId: string;
  ethAddress: string;
  role: string;
}

interface SwapOwnershipRow {
  user_id: string;
}

export function initSocketIO(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: {
      origin: config.CORS_ORIGIN,
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  io.use((socket: Socket, next) => {
    const token = socket.handshake.auth.token as string | undefined;
    if (!token) {
      return next(new Error('Authentication required'));
    }
    try {
      const payload = jwt.verify(token, config.JWT_SECRET) as JwtPayload;
      (socket as any).userId = payload.userId;
      (socket as any).ethAddress = payload.ethAddress;
      (socket as any).role = payload.role;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const userId = (socket as any).userId as string;
    socket.join(`user:${userId}`);

    socket.on('subscribe:swap', async (swapId: string) => {
      if (!swapId || typeof swapId !== 'string') return;
      const role = (socket as any).role as string;
      if (role === 'admin') {
        socket.join(`swap:${swapId}`);
        return;
      }

      try {
        const swap = await getOne<SwapOwnershipRow>('SELECT user_id FROM swaps WHERE id = $1', [swapId]);
        if (!swap || swap.user_id !== userId) {
          socket.emit('error', { message: 'Forbidden swap subscription' });
          return;
        }
        socket.join(`swap:${swapId}`);
      } catch {
        socket.emit('error', { message: 'Subscription failed' });
      }
    });

    socket.on('unsubscribe:swap', (swapId: string) => {
      if (!swapId || typeof swapId !== 'string') return;
      socket.leave(`swap:${swapId}`);
    });

    socket.on('subscribe:orderbook', () => {
      socket.join('orderbook');
    });

    socket.on('disconnect', () => {
      // cleanup handled by socket.io
    });
  });

  return io;
}

export function getIO(): Server {
  if (!io) {
    throw new Error('Socket.IO not initialized. Call initSocketIO first.');
  }
  return io;
}
