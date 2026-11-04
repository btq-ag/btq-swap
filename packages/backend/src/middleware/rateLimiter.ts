import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import Redis from 'ioredis';
import type { Request } from 'express';
import { config } from '../config';

const redis = new Redis(config.REDIS_URL);

function clientKey(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  const source = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const ip = source?.split(',')[0]?.trim() || req.ip || 'unknown';
  return ip;
}

function makeStore(prefix: string): RedisStore {
  return new RedisStore({
    sendCommand: ((...args: string[]) =>
      redis.call(args[0], ...args.slice(1))) as any,
    prefix,
  });
}

export const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientKey,
  store: makeStore('rl:general:'),
  passOnStoreError: true,
  message: { error: 'Too many requests, please try again later.' },
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientKey,
  store: makeStore('rl:auth:'),
  passOnStoreError: true,
  message: { error: 'Too many auth attempts, please try again later.' },
});

export const swapLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientKey,
  store: makeStore('rl:swap:'),
  passOnStoreError: true,
  message: { error: 'Too many swap requests, slow down.' },
});
