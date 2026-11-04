import { describe, it, expect, vi, beforeEach } from 'vitest';

const { redisSetexMock } = vi.hoisted(() => ({
  redisSetexMock: vi.fn(),
}));

vi.mock('ioredis', () => ({
  default: class RedisMock {
    setex = redisSetexMock;
    set = vi.fn();
    get = vi.fn();
    del = vi.fn();
  },
}));

import jwt from 'jsonwebtoken';
import { authService } from '../src/services/auth.service';

describe('authService.logout', () => {
  beforeEach(() => {
    redisSetexMock.mockReset();
  });

  it('stores revoked token with ttl in unified keyspace', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const decodeSpy = vi.spyOn(jwt, 'decode').mockReturnValue({ exp: nowSec + 120 } as any);

    await authService.logout('abc.token.value');

    expect(redisSetexMock).toHaveBeenCalledTimes(1);
    expect(redisSetexMock).toHaveBeenCalledWith(
      'btq:revoked_token:abc.token.value',
      expect.any(Number),
      '1',
    );

    decodeSpy.mockRestore();
  });
});
