import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deskApi, deskToken, saveDeskToken } from '../../frontend/src/lib/deskApi';

describe('desk session recovery (#12, #13)', () => {
  let token: string | null;
  beforeEach(() => {
    token = null;
    vi.stubGlobal('sessionStorage', { getItem: () => token, setItem: (_: string, v: string) => { token = v; }, removeItem: () => { token = null; } });
  });
  afterEach(() => vi.unstubAllGlobals());
  it('sends the current session during EVM linking', async () => {
    saveDeskToken('a'.repeat(64));
    const fetch = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    await deskApi.evmStart('0x123');
    expect(fetch.mock.calls[0]![1].headers.authorization).toBe(`Bearer ${token}`);
  });
  it.each(['start', 'me'])('clears an expired session on %s, without retrying anonymously', async kind => {
    saveDeskToken('a'.repeat(64));
    const fetch = vi.fn().mockResolvedValue(new Response('{"error":"Session expired"}', { status: 401 }));
    vi.stubGlobal('fetch', fetch);
    await expect(kind === 'start' ? deskApi.evmStart('0x123') : deskApi.me()).rejects.toThrow('Session expired');
    expect(deskToken()).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('keeps the session when a challenge expires or the network fails', async () => {
    saveDeskToken('a'.repeat(64));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"challenge expired"}', { status: 400 })));
    await expect(deskApi.evmFinish('a', 's', 'id')).rejects.toThrow();
    expect(deskToken()).toBe('a'.repeat(64));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(deskApi.evmStart('a')).rejects.toThrow('offline');
    expect(deskToken()).toBe('a'.repeat(64));
  });
});
