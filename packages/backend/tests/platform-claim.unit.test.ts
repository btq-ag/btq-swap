import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bytesToHex, createHtlc, hashPreimage, signerFromSeed } from '@btq-swap/htlc';
import type { SwapRow } from '../src/domain/types';

const f = vi.hoisted(() => ({ rows: [] as SwapRow[], rpc: vi.fn(), tip: vi.fn(), broadcast: vi.fn(),
  wallet: vi.fn(), send: vi.fn(), previous: null as null | { metadata:{txid:string} }, withdraw: vi.fn(), address: vi.fn(), claimAction: vi.fn(), signer: vi.fn(), htlc: vi.fn(), event: vi.fn(), query: vi.fn() }));
vi.mock('../src/chains/btq', () => ({ btqChain: () => ({ rpc: { call: f.rpc }, tip: f.tip, broadcast: f.broadcast, platformAddress: f.address, platform:{call:f.wallet},platformSend:f.send }) }));
vi.mock('../src/chains/evm', () => ({ evmChain: () => ({ latestTimestamp: async () => 1_800_000_000, platformWithdraw:f.withdraw }) }));
vi.mock('../src/domain/inventory', () => ({ refreshInventory: async () => {} }));
vi.mock('../src/domain/identity', () => ({ getPlatformUser: async () => ({ id: 'platform' }) }));
vi.mock('../src/domain/runtime', () => ({ platformHtlcSigner: f.signer }));
vi.mock('../src/domain/settlement', () => ({ claimAction: f.claimAction, htlcForSwap: f.htlc, recordEvent: f.event }));
vi.mock('../src/lib/db', () => ({ db: () => ({ query: f.query }), many: async () => f.rows, one: async (_q: unknown, sql: string) => sql.includes('platform_btq_lock') ? f.previous : { n:'0' } }));
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
    vi.resetAllMocks(); f.previous=null;
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
  it('retries a lost buyer claim even though its secret is already public', async () => {
    Object.assign(f.rows[0]!,{status:'awaiting_seller_claim',revealed_preimage:'07'.repeat(32)});
    await platformTick(100);expect(f.broadcast).toHaveBeenCalledTimes(1);
  });
  it('rebroadcasts original wallet funding without creating a second payment', async () => {
    Object.assign(f.rows[0]!,{buyer_user_id:'buyer',seller_user_id:'platform',status:'awaiting_seller_lock',btq_lock_txid:null,btq_htlc_address:htlc.address});
    f.previous={metadata:{txid:'funding'}};f.wallet.mockResolvedValue({hex:'original-transaction'});
    await platformTick(100);expect(f.wallet).toHaveBeenCalledWith('gettransaction',['funding']);
    expect(f.broadcast).toHaveBeenCalledWith('original-transaction');expect(f.send).not.toHaveBeenCalled();expect(f.claimAction).not.toHaveBeenCalled();
  });
  it.each(['refunded','expired'])('does not let a %s stablecoin claim shadow a BTQ refund', async scenario => {
    Object.assign(f.rows[0]!,{buyer_user_id:'buyer',seller_user_id:'platform',status:'awaiting_refunds',revealed_preimage:'07'.repeat(32),
      evm_agreement_id:'agreement',evm_deadline:new Date((scenario==='expired'?1_799_999_999:1_800_000_100)*1000),
      evm_refund_tx:scenario==='refunded'?'refunded':null,btq_refund_locktime:106});
    await platformTick(106);expect(f.withdraw).not.toHaveBeenCalled();expect(f.broadcast).toHaveBeenCalledTimes(1);
    expect(f.event).toHaveBeenCalledWith(expect.anything(),'swap','platform_btq_refund',expect.anything(),expect.anything());
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
