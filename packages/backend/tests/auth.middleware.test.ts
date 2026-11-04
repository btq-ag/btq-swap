import { describe, it, expect, vi, beforeEach } from 'vitest';

const { redisGetMock, jwtVerifyMock, getOneMock } = vi.hoisted(() => ({
  redisGetMock: vi.fn(),
  jwtVerifyMock: vi.fn(),
  getOneMock: vi.fn(),
}));

vi.mock('ioredis', () => ({
  default: class RedisMock {
    get = redisGetMock;
  },
}));

vi.mock('jsonwebtoken', () => ({
  default: {
    verify: jwtVerifyMock,
  },
}));

vi.mock('../src/lib/db', () => ({
  getOne: getOneMock,
}));

import { authMiddleware } from '../src/middleware/auth';

function createMockRes() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
}

describe('authMiddleware', () => {
  beforeEach(() => {
    redisGetMock.mockReset();
    jwtVerifyMock.mockReset();
    getOneMock.mockReset();
  });

  it('rejects revoked tokens', async () => {
    jwtVerifyMock.mockReturnValue({ userId: 'u1', ethAddress: '0xabc', role: 'user' });
    redisGetMock.mockResolvedValue('1');

    const req: any = { headers: { authorization: 'Bearer token123' } };
    const res = createMockRes();
    const next = vi.fn();

    authMiddleware(req, res as any, next);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('fails closed when revocation check is unavailable', async () => {
    jwtVerifyMock.mockReturnValue({ userId: 'u1', ethAddress: '0xabc', role: 'user' });
    redisGetMock.mockRejectedValue(new Error('redis down'));

    const req: any = { headers: { authorization: 'Bearer token123' } };
    const res = createMockRes();
    const next = vi.fn();

    authMiddleware(req, res as any, next);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects banned users', async () => {
    jwtVerifyMock.mockReturnValue({ userId: 'u1', ethAddress: '0xabc', role: 'user' });
    redisGetMock.mockResolvedValue(null);
    getOneMock.mockResolvedValue({ is_banned: true });

    const req: any = { headers: { authorization: 'Bearer token123' } };
    const res = createMockRes();
    const next = vi.fn();

    authMiddleware(req, res as any, next);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('allows active non-banned users', async () => {
    jwtVerifyMock.mockReturnValue({ userId: 'u1', ethAddress: '0xabc', role: 'user' });
    redisGetMock.mockResolvedValue(null);
    getOneMock.mockResolvedValue({ is_banned: false });

    const req: any = { headers: { authorization: 'Bearer token123' } };
    const res = createMockRes();
    const next = vi.fn();

    authMiddleware(req, res as any, next);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(req.user).toEqual({ userId: 'u1', ethAddress: '0xabc', role: 'user' });
    expect(next).toHaveBeenCalledTimes(1);
  });
});
