import { beforeAll, describe, expect, it } from 'vitest';

beforeAll(() => {
  Object.assign(process.env, {
    DATABASE_URL: 'postgres://x:y@127.0.0.1:1/z', ADMIN_TOKEN: 'a'.repeat(24), SESSION_SECRET: 's'.repeat(32),
    BTQ_RPC_URL: 'http://127.0.0.1:1', BTQ_RPC_USER: 'u', BTQ_RPC_PASS: 'p', PLATFORM_HTLC_SEED: '11'.repeat(32), PLATFORM_SECRET_KEY: '22'.repeat(32),
    EVM_RPC_URL: 'http://127.0.0.1:2', EVM_CHAIN_ID: '31337', EVM_PRIVATE_KEY: '0x' + '33'.repeat(32), BTQ_NETWORK: 'regtest',
  });
});

describe('public EVM RPC batch check', async () => {
  const { checkRpcBatch } = await import('../src/routes/rpc');

  it('rejects null, primitive and array entries without touching them', () => {
    for (const body of [null, [null], [1], ['eth_chainId'], [[]], [{ method: 'eth_chainId' }, null]]) {
      const r = checkRpcBatch(body);
      expect('batch' in r).toBe(false);
    }
  });

  it('rejects methods outside the whitelist', () => {
    const r = checkRpcBatch([{ id: 7, method: 'eth_chainId' }, { id: 8, method: 'anvil_setBalance' }]);
    expect(r).toMatchObject({ status: 200, id: 8, error: { code: -32601 } });
  });

  it('rejects empty and oversized batches', () => {
    expect(checkRpcBatch([])).toMatchObject({ status: 400 });
    expect(checkRpcBatch(Array.from({ length: 21 }, () => ({ method: 'eth_chainId' })))).toMatchObject({ status: 400 });
  });

  it('passes a whitelisted single request and batch', () => {
    expect(checkRpcBatch({ id: 1, method: 'eth_chainId' })).toEqual({ batch: [{ id: 1, method: 'eth_chainId' }] });
    expect(checkRpcBatch([{ id: 1, method: 'eth_blockNumber' }, { id: 2, method: 'eth_accounts' }])).toHaveProperty('batch');
  });
});
