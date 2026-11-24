import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bytesToHex, createHtlc, hashPreimage, signerFromSeed } from '@btq-swap/htlc';
import type { SwapRow } from '../src/domain/types';

const f = vi.hoisted(() => ({ rows: [] as SwapRow[], rpc: vi.fn(), tip: vi.fn(), broadcast: vi.fn(),
  address: vi.fn(), claimAction: vi.fn(), signer: vi.fn(), htlc: vi.fn(), event: vi.fn(), query: vi.fn() }));
vi.mock('../src/chains/btq', () => ({ btqChain: () => ({ rpc: { call: f.rpc }, tip: f.tip, broadcast: f.broadcast, platformAddress: f.address }) }));
vi.mock('../src/chains/evm', () => ({ evmChain: () => ({ latestTimestamp: async () => 1_800_000_000 }) }));
vi.mock('../src/domain/inventory', () => ({ refreshInventory: async () => {} }));
vi.mock('../src/domain/identity', () => ({ getPlatformUser: async () => ({ id: 'platform' }) }));
vi.mock('../src/domain/runtime', () => ({ platformHtlcSigner: f.signer }));
vi.mock('../src/domain/settlement', () => ({ claimAction: f.claimAction, htlcForSwap: f.htlc, recordEvent: f.event }));
vi.mock('../src/lib/db', () => ({ db: () => ({ query: f.query }), many: async () => f.rows, one: async () => ({ n: '0' }) }));
vi.mock('../src/lib/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('../src/lib/crypto', () => ({ decryptSecret: () => Buffer.alloc(32, 7) }));
vi.mock('../src/config', () => ({ config: () => ({ BTQ_MIN_CONFIRMATIONS: 6, BTQ_FEE_RATE_SAT_VB: 2, PLATFORM_SECRET_KEY: '' }) }));

import { platformTick } from '../src/workers/platform-agent';

describe('platform secret disclosure guard (#7)', () => {
  const signer = signerFromSeed(new Uint8Array(32).fill(1));
  const htlc = createHtlc('regtest', { secretHash: hashPreimage(new Uint8Array(32).fill(7)),
    claimPubkey: signer.publicKey, refundPubkey: signer.publicKey, refundLocktime: 106 });
  const output = () => ({ bestblock: 'canonical', confirmations: 6, value: 1, scriptPubKey: { hex: bytesToHex(htlc.scriptPubKey) } });
  beforeEach(() => {
    vi.resetAllMocks();
    f.rows = [{ id: 'swap', short_id: '1', buyer_user_id: 'platform', status: 'awaiting_buyer_claim',
      btq_lock_txid: 'ab'.repeat(32), btq_lock_vout: 0, btq_lock_sats: '100000000', btq_lock_confs: 999 } as SwapRow];
    f.rpc.mockResolvedValue(output()); f.tip.mockResolvedValue({ height: 100, hash: 'canonical' });
    f.htlc.mockReturnValue(htlc); f.claimAction.mockResolvedValue(true); f.signer.mockReturnValue(signer);
    f.address.mockResolvedValue(htlc.address); f.broadcast.mockResolvedValue('txid');
  });
  it.each(['missing', 'underconfirmed', 'wrong script', 'wrong value', 'changed tip', 'late', 'invalid confirmations', 'rpc failure'])(
    'does not reserve an action or sign on %s evidence', async scenario => {
      const out = output();
      if (scenario === 'missing') f.rpc.mockResolvedValue(null);
      if (scenario === 'underconfirmed') f.rpc.mockResolvedValue({ ...out, confirmations: 5 });
      if (scenario === 'wrong script') f.rpc.mockResolvedValue({ ...out, scriptPubKey: { hex: '00' } });
      if (scenario === 'wrong value') f.rpc.mockResolvedValue({ ...out, value: 0.9 });
      if (scenario === 'changed tip') f.tip.mockResolvedValue({ height: 100, hash: 'new' });
      if (scenario === 'late') f.tip.mockResolvedValue({ height: 101, hash: 'canonical' });
      if (scenario === 'invalid confirmations') f.rpc.mockResolvedValue({ ...out, confirmations: NaN });
      if (scenario === 'rpc failure') f.rpc.mockRejectedValue(new Error('unavailable'));
      for (let i = 0; i < 6; i++) await platformTick(1);
      expect(f.claimAction).not.toHaveBeenCalled(); expect(f.signer).not.toHaveBeenCalled(); expect(f.broadcast).not.toHaveBeenCalled();
    });
  it('uses current own-node evidence and permits the exact safety-margin boundary', async () => {
    await platformTick(999); // ignored for claim authorization
    expect(f.rpc).toHaveBeenCalledWith('gettxout', ['ab'.repeat(32), 0, true]);
    expect(f.claimAction).toHaveBeenCalledTimes(1); expect(f.broadcast).toHaveBeenCalledTimes(1);
  });
  it('can claim after repeated underconfirmation without exhausting attempts', async () => {
    f.rpc.mockResolvedValue({ ...output(), confirmations: 0 });
    for (let i = 0; i < 6; i++) await platformTick(100);
    f.rpc.mockResolvedValue(output());
    await platformTick(100);
    expect(f.claimAction).toHaveBeenCalledTimes(1); expect(f.broadcast).toHaveBeenCalledTimes(1);
  });
  it('rechecks after wallet/DB waits and releases the attempt if the safety window closed', async () => {
    f.tip.mockResolvedValueOnce({ height: 100, hash: 'canonical' }).mockResolvedValue({ height: 106, hash: 'canonical' });
    await platformTick(100);
    expect(f.signer).not.toHaveBeenCalled(); expect(f.broadcast).not.toHaveBeenCalled();
    expect(f.query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM swap_events'), ['btq_claim:swap:0']);
    expect(f.event).not.toHaveBeenCalled();
  });
  it('does not spend broadcast attempts on wallet address RPC failures', async () => {
    f.address.mockRejectedValue(new Error('wallet unavailable'));
    for (let i = 0; i < 6; i++) await platformTick(100);
    expect(f.claimAction).not.toHaveBeenCalled(); expect(f.event).not.toHaveBeenCalled();
    f.address.mockResolvedValue(htlc.address);
    await platformTick(100);
    expect(f.broadcast).toHaveBeenCalledTimes(1);
  });
});
