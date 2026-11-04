import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import Redis from 'ioredis';
import { config } from '../config';
import { getOne } from '../lib/db';

const redis = new Redis(config.REDIS_URL);
const REVOKED_TOKEN_PREFIX = 'btq:revoked_token:';

export interface AuthPayload {
  userId: string;
  ethAddress: string;
  role: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload;
    }
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header' });
    return;
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, config.JWT_SECRET) as AuthPayload;

    redis.get(`${REVOKED_TOKEN_PREFIX}${token}`).then(async (isRevoked) => {
      if (isRevoked) {
        res.status(401).json({ error: 'Token has been revoked' });
        return;
      }
      const user = await getOne<{ is_banned: boolean }>(
        'SELECT is_banned FROM users WHERE id = $1',
        [payload.userId],
      );
      if (!user || user.is_banned) {
        res.status(403).json({ error: 'Account is banned' });
        return;
      }
      req.user = payload;
      next();
    }).catch(() => {
      res.status(503).json({ error: 'Authentication service unavailable' });
    });
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
