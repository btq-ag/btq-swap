import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeAgreementId, htlcInterface, newPreimage, swapBindingAsset, type HtlcEvent } from '@btq-swap/htlc';
import { db } from '../src/lib/db';
import { config, sellerTimeBudgetSec } from '../src/config';
import { getSwap, setBtqTipProvider } from '../src/domain/settlement';
import { databaseEnabled, testDatabase, testSwap } from './database';
const node = vi.hoisted(() => ({ blockNumber:vi.fn(), block:vi.fn(), receipt:vi.fn(), logs:vi.fn(), instance:vi.fn() }));
vi.mock('../src/chains/evm', () => ({ evmChain:()=>node }));
import { evmTick, evmStatus } from '../src/workers/evm-watcher';
import { canonicalCursor, getCursor, setCursor } from '../src/workers/cursors';

describe.skipIf(!databaseEnabled)('canonical EVM settlement (#6)', () => {
  testDatabase();
  let head:number, fork:number, now:number, events:HtlcEvent[], receipts:Map<string,unknown>;
  const hash=(h:number)=>`${h>=fork?'fork':'block'}${h}`;
  beforeEach(async()=>{
    await db().query('TRUNCATE users CASCADE; TRUNCATE chain_cursors,chain_checkpoints');
    vi.resetAllMocks();head=100;fork=Infinity;now=Math.floor(Date.now()/1000);events=[];receipts=new Map();
    node.blockNumber.mockImplementation(async()=>head);
    node.block.mockImplementation(async(h:number)=>({hash:hash(h),timestamp:now}));
    node.receipt.mockImplementation(async(id:string)=>receipts.get(id)??null);
    node.logs.mockImplementation(async(a:number,b:number)=>events.filter(e=>e.blockNumber>=a&&e.blockNumber<=b));
    setBtqTipProvider(async()=>100);
    await setCursor('evm',80,hash(80));
  });
  async function fixture(blockNumber=85) {
    const secret=newPreimage();const s=await testSwap();
    const p={partyA:s.buyer_eth,partyB:s.seller_eth,erc20Contract:s.evm_token,tokenAmount:BigInt(s.amount_usdt_units),
      secretlock:'0x'+secret.secretHashHex,deadline:now+sellerTimeBudgetSec()+300,otherNetwork:'btq:regtest',otherAsset:swapBindingAsset(s.id),otherAmount:BigInt(s.amount_sats)};
    const id=computeAgreementId(p);
    const lock:HtlcEvent={...p,kind:'lockup',agreementId:id,txHash:'lock',blockNumber,blockHash:hash(blockNumber),logIndex:0};
    function add(event:HtlcEvent) {
      events.push(event);
      const name=event.kind==='lockup'?'HTLCERC20Lockup':event.kind==='claimed'?'HTLCERC20Claimed':'HTLCERC20Redeemed';
      const args=event.kind==='lockup'?[id,p.partyA,p.partyB,p.secretlock,p.deadline,p.tokenAmount,p.erc20Contract,p.otherNetwork,p.otherAsset,p.otherAmount]:[id];
      const encoded=htlcInterface.encodeEventLog(htlcInterface.getEvent(name)!,args);
      receipts.set(event.txHash,{status:1,blockNumber:event.blockNumber,blockHash:event.blockHash,logs:[{...encoded,address:s.evm_htlc_contract,transactionHash:event.txHash,blockNumber:event.blockNumber,blockHash:event.blockHash,index:0}]});
    }
    add(lock);node.instance.mockResolvedValue({key:'0x'+secret.preimageHex});
    return {s,secret,id,lock,add};
  }
  const tick=()=>evmTick(async()=>100);
  it('tracks head locks without expiring them, then enables funding at the confirmation boundary',async()=>{
    const f=await fixture(100);
    await db().query('UPDATE swaps SET buyer_lock_by=$2 WHERE id=$1',[f.s.id,new Date(now*1000)]);
    await tick();let s=(await getSwap(f.s.id))!;
    expect(s.status).toBe('buyer_lock_confirming');expect(s.evm_lock_confs).toBe(1);expect(s.btq_htlc_spk).toBeNull();
    head=100+config().EVM_MIN_CONFIRMATIONS-1;await tick();s=(await getSwap(f.s.id))!;
    expect(s.status).toBe('awaiting_seller_lock');expect(s.btq_htlc_spk).toBeTruthy();
  });
  it('preserves a head claim seen in the same catch-up tick as its mature lock',async()=>{
    const f=await fixture();f.add({kind:'claimed',agreementId:f.id,txHash:'claim',blockNumber:100,blockHash:hash(100),logIndex:0});
    await tick();expect((await getSwap(f.s.id))!.revealed_preimage).toBe(f.secret.preimageHex);
    fork=100;events=events.filter(e=>e.kind==='lockup');receipts.delete('claim');await tick();
    expect((await getSwap(f.s.id))!.revealed_preimage).toBe(f.secret.preimageHex);
  });
  it('rebinds a replacement transaction for the same agreement after a deep fork',async()=>{
    const f=await fixture(85);await tick();const script=(await getSwap(f.s.id))!.btq_htlc_spk;
    fork=85;events=[];receipts.clear();f.add({...f.lock,txHash:'replacement',blockNumber:86,blockHash:hash(86)});
    head=101;await tick();await tick();const s=(await getSwap(f.s.id))!;
    expect(s.evm_lock_tx).toBe('replacement');expect(s.evm_lock_confs).toBe(16);expect(s.evm_lock_block_hash).toBe(hash(86));expect(s.btq_htlc_spk).toBe(script);
  });
  it.each(['claimed','redeemed'] as const)('does not finalize a head %s event and recovers after receipt absence',async kind=>{
    const f=await fixture();await tick();
    if(kind==='claimed') await db().query("UPDATE swaps SET btq_lock_txid='fund',btq_lock_vout=0,btq_lock_sats=amount_sats,btq_claim_txid='btq-claim' WHERE id=$1",[f.s.id]);
    f.add({kind,agreementId:f.id,txHash:'spend',blockNumber:100,blockHash:hash(100),logIndex:0});
    await tick();let s=(await getSwap(f.s.id))!;const leg=kind==='claimed'?'claim':'refund';
    expect(s[`evm_${leg}_tx`]).toBeNull();expect(s.status).not.toBe('completed');expect(s.status).not.toBe('refunded');
    if(kind==='claimed') expect(s.revealed_preimage).toBe(f.secret.preimageHex);
    head=100+config().EVM_MIN_CONFIRMATIONS-1;await tick();expect((await getSwap(f.s.id))![`evm_${leg}_tx`]).toBe('spend');
    const receipt=receipts.get('spend');receipts.delete('spend');await tick();s=(await getSwap(f.s.id))!;
    expect(s[`evm_${leg}_tx`]).toBeNull();expect(s.completed_at).toBeNull();
    receipts.set('spend',receipt);await tick();s=(await getSwap(f.s.id))!;
    expect(s[`evm_${leg}_tx`]).toBe('spend');expect(s.status).toBe(kind==='claimed'?'completed':'refunded');
  });
  it('rechecks terminal settlements, retains public secrets, and releases an orphaned platform action',async()=>{
    const f=await fixture();await tick();
    await db().query("UPDATE swaps SET btq_lock_txid='fund',btq_lock_vout=0,btq_lock_sats=amount_sats,btq_claim_txid='btq-claim' WHERE id=$1",[f.s.id]);
    f.add({kind:'claimed',agreementId:f.id,txHash:'claim',blockNumber:91,blockHash:hash(91),logIndex:0});await tick();
    // The cursor already passed block 91: a platform candidate is independently reconciled.
    await db().query("UPDATE swaps SET evm_pending_claim_tx='claim' WHERE id=$1",[f.s.id]);head=102;await tick();
    expect((await getSwap(f.s.id))!.status).toBe('completed');
    await db().query("INSERT INTO swap_events (swap_id,event_type,action_key,metadata) VALUES ($1,'platform_action','once','{\"kind\":\"evm_claim\"}')",[f.s.id]);
    fork=91;events=events.filter(e=>e.kind==='lockup');head=101;await tick();const s=(await getSwap(f.s.id))!;
    expect(s.evm_claim_tx).toBeNull();expect(s.revealed_preimage).toBe(f.secret.preimageHex);expect(s.status).toBe('awaiting_seller_claim');expect(s.completed_at).toBeNull();
    expect((await db().query("SELECT action_key FROM swap_events WHERE event_type='platform_action'")).rows[0].action_key).toBeNull();
  });
  it('routes an unconfirmed lock to refund when its safe funding budget runs out',async()=>{
    const f=await fixture(100);await tick();
    await db().query('UPDATE swaps SET evm_deadline=$2 WHERE id=$1',[f.s.id,new Date(Date.now()+sellerTimeBudgetSec()*1000)]);
    events=[];await tick();expect((await getSwap(f.s.id))!.status).toBe('awaiting_buyer_refund');
    expect((await db().query('SELECT no_show_count FROM users WHERE id=$1',[f.s.buyer_user_id])).rows[0].no_show_count).toBe(0);
  });
  it('bounds legacy unhashed-cursor replay, ignores unrelated old claims, and still handles the live tail',async()=>{
    const f=await fixture(99990);head=100000;
    await db().query('TRUNCATE chain_cursors,chain_checkpoints');await setCursor('evm',90000,null);
    events.unshift({kind:'claimed',agreementId:'0x'+'99'.repeat(32),txHash:'unrelated-old-claim',blockNumber:10,blockHash:hash(10),logIndex:0});
    node.instance.mockImplementation(async(_id:string,blockTag?:number)=>{if(blockTag!==undefined) throw new Error('historical state pruned');return {key:f.secret.preimageHex};});
    await tick();expect((await getSwap(f.s.id))!.evm_agreement_id).toBe(f.id);
    expect(evmStatus.cursor).toBe(20*config().EVM_LOG_RANGE-1);expect(evmStatus.lag).toBeGreaterThan(0);
    expect(node.logs.mock.calls.length).toBeLessThanOrEqual(24);expect(node.instance).not.toHaveBeenCalled();
  });
  it('finds a common ancestor across head retreat and falls back to genesis without one',async()=>{
    await setCursor('evm',85,hash(85));await setCursor('evm',90,hash(90));
    expect((await canonicalCursor('evm',87,async h=>hash(h),0)).height).toBe(85);
    fork=0;expect((await canonicalCursor('evm',87,async h=>hash(h),0)).height).toBe(-1);
    expect(await getCursor('evm')).toEqual({height:-1,hash:null});
  });
});
