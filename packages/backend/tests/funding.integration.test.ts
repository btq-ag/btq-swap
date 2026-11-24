import { describe, expect, it } from 'vitest';
import { computeAgreementId, newPreimage, swapBindingAsset } from '@btq-swap/htlc';
import { db } from '../src/lib/db';
import { getSwap, onBtqLockOutput, onEvmLockup, setBtqTipProvider, type LockupObservation } from '../src/domain/settlement';
import { databaseEnabled, testDatabase, testSwap } from './database';
import type { SwapRow } from '../src/domain/types';

describe.skipIf(!databaseEnabled)('funding identity and recovery (#10, #15)', () => {
  testDatabase();
  function lock(s: SwapRow, hash = newPreimage().secretHashHex): LockupObservation {
    const p = { partyA: s.buyer_eth, partyB: s.seller_eth, erc20Contract: s.evm_token, tokenAmount: 1_000_000n,
      secretlock: `0x${hash}`, deadline: Math.floor(Date.now()/1000)+86400, otherNetwork: 'btq:regtest',
      otherAsset: swapBindingAsset(s.id), otherAmount: 100_000_000n };
    return { ...p, agreementId: computeAgreementId(p), txHash: '0x'+'a'.repeat(64), blockNumber: 10 };
  }
  it('accepts one concurrent use of a hash and rejects the other without aborting its handler', async () => {
    setBtqTipProvider(async () => 100);
    const a = await testSwap(); const b = await testSwap(); const hash = newPreimage().secretHashHex;
    await Promise.all([a,b].map(s => onEvmLockup(lock(s,hash), 21, Math.floor(Date.now()/1000))));
    const swaps = await Promise.all([getSwap(a.id), getSwap(b.id)]);
    expect(swaps.filter(s => s!.secret_hash === hash)).toHaveLength(1);
    const rejected = await db().query('SELECT * FROM swap_locks WHERE swap_id = ANY($1::uuid[]) AND reason IS NOT NULL', [[a.id,b.id]]);
    expect(rejected.rows).toHaveLength(1); expect(rejected.rows[0].reason).toMatch(/already used/);
  });
  it('keeps rejected EVM agreement details alongside a subsequent accepted lock', async () => {
    setBtqTipProvider(async () => 100);
    const s = await testSwap(); const bad = lock(s); bad.tokenAmount = 1n; bad.agreementId = computeAgreementId(bad);
    await onEvmLockup(bad, 10, Math.floor(Date.now()/1000));
    const good = lock(s); await onEvmLockup(good, 10, Math.floor(Date.now()/1000));
    await onEvmLockup(bad, 10, Math.floor(Date.now()/1000));
    expect((await getSwap(s.id))!.evm_agreement_id).toBe(good.agreementId);
    const rows = (await db().query('SELECT * FROM swap_locks WHERE swap_id=$1', [s.id])).rows;
    expect(rows).toHaveLength(2);
    expect(rows.find(r => r.lock_id === bad.agreementId).metadata.tokenAmount).toBe('1');
  });
  it('does not let arbitrary on-chain labels poison the watcher transaction', async () => {
    const s = await testSwap(); const bad = lock(s); bad.otherNetwork = 'evil\u0000label'; bad.agreementId = computeAgreementId(bad);
    await expect(onEvmLockup(bad, 10, Math.floor(Date.now()/1000))).resolves.toBeUndefined();
    const row = (await db().query('SELECT reason FROM swap_locks WHERE swap_id=$1', [s.id])).rows[0];
    expect(row.reason).toMatch(/otherNetwork/);
  });
  it('rejects reuse of the hash of a rejected escrow, including another lock for the same swap', async () => {
    const a = await testSwap(); const hash = newPreimage().secretHashHex;
    const bad = lock(a, hash); bad.tokenAmount = 1n; bad.agreementId = computeAgreementId(bad);
    await onEvmLockup(bad, 10, Math.floor(Date.now()/1000));
    await onEvmLockup(lock(a, hash), 10, Math.floor(Date.now()/1000));
    const b = await testSwap(); await onEvmLockup(lock(b, hash), 10, Math.floor(Date.now()/1000));
    expect((await getSwap(a.id))!.evm_agreement_id).toBeNull(); expect((await getSwap(b.id))!.evm_agreement_id).toBeNull();
  });
  it('preserves every underpaid/late/extra BTQ output and gives an outpoint only one owner', async () => {
    const s = await testSwap({ status:'awaiting_seller_lock', secret_hash:newPreimage().secretHashHex, btq_refund_locktime:200 });
    const id = 'ab'.repeat(32);
    await onBtqLockOutput(s.id, { txid:id,vout:0,sats:100n,height:null },100);
    await onBtqLockOutput(s.id, { txid:id,vout:1,sats:100_000_000n,height:null },100);
    await onBtqLockOutput(s.id, { txid:id,vout:2,sats:100_000_000n,height:null },100);
    await onBtqLockOutput(s.id, { txid:id,vout:0,sats:100n,height:null },100);
    const rows = (await db().query('SELECT * FROM swap_locks WHERE swap_id=$1 ORDER BY lock_id', [s.id])).rows;
    expect(rows).toHaveLength(3); expect(rows[0].metadata.valueSats).toBe('100');
    expect(rows[0].metadata.htlc.refundLocktime).toBe(200); expect(rows[1].reason).toBeNull();
    const other = await testSwap({ status:'awaiting_seller_lock', secret_hash:newPreimage().secretHashHex, btq_refund_locktime:200 });
    await onBtqLockOutput(other.id, { txid:id,vout:1,sats:100_000_000n,height:null },100);
    expect((await getSwap(other.id))!.btq_lock_txid).toBeNull();
    expect((await getSwap(s.id))!.btq_lock_vout).toBe(1);
  });
});
