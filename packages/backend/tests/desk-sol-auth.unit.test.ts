import { beforeAll, describe, expect, it } from 'vitest';

beforeAll(() => {
  Object.assign(process.env, {
    DATABASE_URL: 'postgres://x:y@127.0.0.1:1/z', ADMIN_TOKEN: 'a'.repeat(24), SESSION_SECRET: 's'.repeat(32),
    BTQ_RPC_URL: 'http://127.0.0.1:1', BTQ_RPC_USER: 'u', BTQ_RPC_PASS: 'p', PLATFORM_HTLC_SEED: '11'.repeat(32), PLATFORM_SECRET_KEY: '22'.repeat(32),
    EVM_RPC_URL: 'http://127.0.0.1:2', EVM_CHAIN_ID: '31337', EVM_PRIVATE_KEY: '0x' + '33'.repeat(32), BTQ_NETWORK: 'regtest',
  });
});

describe('Solana desk sign-in through the synthetic id', async () => {
  const { solIdFallbackAllowed } = await import('../src/domain/desk');
  const A = 'Bm1Z7pKq4yB2hR8vXc3dNfLwTg5sJ6uA9eQ1oVrYiPk';
  const B = 'Cx8W2nLp5zD3jS9tYb4eMgKvRh6uF7aQ2wP1oXcZiNd';

  it('allows the first wallet before any wallet is linked', () => {
    expect(solIdFallbackAllowed({ sol_address: null }, A)).toBe(true);
  });

  it('allows the first wallet while it is still the linked one', () => {
    expect(solIdFallbackAllowed({ sol_address: A }, A)).toBe(true);
  });

  it('refuses the first wallet once another wallet replaced it', () => {
    expect(solIdFallbackAllowed({ sol_address: B }, A)).toBe(false);
  });
});
