import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BtqRpcError, buildClaimTx, buildRefundTx, bytesToHex, newPreimage, parseTx, signerFromSeed, txHex, txid, p2mrSighash, tapleafHash, concatBytes, SIGHASH_ALL, verifySignature } from '@btq-swap/htlc';
import { db } from '../src/lib/db';
import { getSwap, htlcForSwap, onEvmClaimed, recordEvent, setBtqTipProvider } from '../src/domain/settlement';
import { databaseEnabled, testDatabase, testSwap } from './database';
const node = vi.hoisted(() => ({ tip:vi.fn(), blockHash:vi.fn(), block:vi.fn(), mempoolTxids:vi.fn(), rawTx:vi.fn(), txConfirmations:vi.fn() }));
vi.mock('../src/chains/btq', async original => ({ ...await original<typeof import('../src/chains/btq')>(), btqChain:()=>node }));
import { btqTick, processLockHints } from '../src/workers/btq-watcher';
import { setCursor } from '../src/workers/cursors';

describe.skipIf(!databaseEnabled)('BTQ watcher recovery (#4, #5)', () => {
  testDatabase();
  let height:number, fork:number, mempool:string[];
  let raw:Map<string,string>, included:Map<number,string[]>, confirmed:Map<string,{ height:number; hash:string }>;
  const hash = (h:number) => `${h >= fork ? 'fork' : 'block'}${h}`;
  beforeEach(async () => {
    await db().query('TRUNCATE users CASCADE; TRUNCATE chain_cursors,chain_checkpoints');
    vi.resetAllMocks(); height=100; fork=Infinity; mempool=[]; raw=new Map(); included=new Map(); confirmed=new Map();
    node.tip.mockImplementation(async()=>({ height,hash:hash(height),time:1800000000 }));
    node.blockHash.mockImplementation(async(h:number)=>hash(h));
    node.mempoolTxids.mockImplementation(async()=>mempool);
    node.rawTx.mockImplementation(async(id:string)=>{ if (!raw.has(id)) throw new BtqRpcError(-5,'not found','getrawtransaction'); return raw.get(id); });
    node.txConfirmations.mockImplementation(async(id:string)=>{ const c=confirmed.get(id); return c && hash(c.height)===c.hash
      ? {height:c.height,blockhash:c.hash,confirmations:height-c.height+1} : {confirmations:0}; });
    node.block.mockImplementation(async(blockHash:string)=>{
      const h=Number(blockHash.replace(/\D/g,''));
      return {height:h,hash:blockHash,tx:(included.get(h)??[]).map(id=>{
        const hex=raw.get(id)!; const t=parseTx(hex);
        return {txid:id,hex,vin:t.inputs.map(i=>({txid:i.txid,vout:i.vout})),vout:t.outputs.map((o,n)=>({n,value:Number(o.valueSats)/1e8,scriptPubKey:{hex:bytesToHex(o.scriptPubKey)}}))};
      })};
    });
    setBtqTipProvider(async()=>height);
    await setCursor('btq',94,hash(94));
  });
  async function fixture(refundHeight=1000, mined=true) {
    const secret=newPreimage();
    const s=await testSwap({status:'awaiting_seller_lock',secret_hash:secret.secretHashHex,btq_refund_locktime:refundHeight,
      evm_agreement_id:'0x'+secret.secretHashHex,evm_lock_confs:12,evm_deadline:new Date(Date.now()+86400000)});
    const h=htlcForSwap(s);
    await db().query('UPDATE swaps SET btq_htlc_spk=$2,btq_htlc_address=$3 WHERE id=$1',[s.id,bytesToHex(h.scriptPubKey),h.address]);
    const fund=(prev='cd'.repeat(32))=>{
      const hex=txHex({version:2,locktime:0,inputs:[{txid:prev,vout:0,sequence:0xffffffff,scriptSig:new Uint8Array(),witness:[]}],outputs:[{valueSats:100000000n,scriptPubKey:h.scriptPubKey}]});
      const id=txid(parseTx(hex)); raw.set(id,hex); return id;
    };
    const funding=fund();
    if(mined) {included.set(95,[funding]);confirmed.set(funding,{height:95,hash:hash(95)});}
    const claim=buildClaimTx({htlc:h,outpoint:{txid:funding,vout:0,valueSats:100000000n},destination:'qcrt1qqzy9e9njkp0pw82ym7j8rnsq47wdye783wuarc',signer:signerFromSeed(new Uint8Array(32).fill(1)),preimage:secret.preimage});
    raw.set(claim.txid,claim.hex);
    return {s,h,secret,funding,fund,claim};
  }
  it('clears orphaned funding before scanning and accepts replacement funding',async()=>{
    const f=await fixture(); await btqTick(); expect((await getSwap(f.s.id))!.status).toBe('awaiting_buyer_claim');
    fork=95; height=101; included.clear();
    const replacement=f.fund('ef'.repeat(32)); included.set(95,[replacement]);confirmed.set(replacement,{height:95,hash:hash(95)});
    await btqTick(); const s=(await getSwap(f.s.id))!;
    expect(s.btq_lock_txid).toBe(replacement); expect(s.btq_lock_block_hash).toBe(hash(95)); expect(s.btq_lock_confs).toBe(7);
  });
  it('does not resurrect indexed orphan funding through a recent hint or reopen an elapsed deadline',async()=>{
    const f=await fixture(100); await btqTick();
    await recordEvent(db(),f.s.id,'btq_lock_hint',{txid:f.funding});
    await processLockHints(); expect((await getSwap(f.s.id))!.status).toBe('awaiting_refunds');
    fork=95;height=101;included.clear(); await btqTick();await processLockHints();
    expect((await getSwap(f.s.id))!.btq_lock_txid).toBeNull(); expect((await getSwap(f.s.id))!.btq_lock_confs).toBe(0);
  });
  it('discovers child-before-parent mempool claims and retains their secret after eviction',async()=>{
    const f=await fixture(1000,false); mempool=[f.claim.txid,f.funding]; await btqTick();
    let s=(await getSwap(f.s.id))!; expect(s.revealed_preimage).toBe(f.secret.preimageHex);expect(s.btq_claim_txid).toBeNull();expect(s.btq_pending_spend_txid).toBe(f.claim.txid);
    mempool=[f.funding];await btqTick();s=(await getSwap(f.s.id))!;
    expect(s.btq_pending_spend_txid).toBeNull();expect(s.revealed_preimage).toBe(f.secret.preimageHex);
  });
  it('keeps watching after a dropped mempool refund and learns the replacing claim',async()=>{
    const f=await fixture(100); await btqTick();
    const refund=buildRefundTx({htlc:f.h,outpoint:{txid:f.funding,vout:0,valueSats:100000000n},destination:'qcrt1qqzy9e9njkp0pw82ym7j8rnsq47wdye783wuarc',signer:signerFromSeed(new Uint8Array(32).fill(2))});
    raw.set(refund.txid,refund.hex);mempool=[refund.txid];await btqTick();
    expect((await getSwap(f.s.id))!.btq_refund_txid).toBeNull();
    mempool=[f.claim.txid];await btqTick();
    expect((await getSwap(f.s.id))!.revealed_preimage).toBe(f.secret.preimageHex);
  });
  it('uses the canonical witness when claim and refund share a transaction ID',async()=>{
    const f=await fixture(100);await btqTick();
    const refund=buildRefundTx({htlc:f.h,outpoint:{txid:f.funding,vout:0,valueSats:100000000n},destination:'qcrt1qqzy9e9njkp0pw82ym7j8rnsq47wdye783wuarc',signer:signerFromSeed(new Uint8Array(32).fill(2))});
    const claim=parseTx(refund.hex);const signer=signerFromSeed(new Uint8Array(32).fill(1));
    const msg=p2mrSighash({tx:claim,spent:[{valueSats:100000000n,scriptPubKey:f.h.scriptPubKey}],inputIndex:0,tapleafHash:tapleafHash(f.h.claimLeaf)});
    const sig=signer.sign(msg);expect(verifySignature(signer.publicKey,msg,sig)).toBe(true);
    claim.inputs[0]!.witness=[concatBytes(sig,Uint8Array.of(SIGHASH_ALL)),f.secret.preimage,f.h.claimLeaf,f.h.claimControlBlock];
    expect(txid(claim)).toBe(refund.txid);raw.set(refund.txid,txHex(claim));mempool=[refund.txid];await btqTick();
    raw.set(refund.txid,refund.hex);mempool=[];height=106;included.set(101,[refund.txid]);confirmed.set(refund.txid,{height:101,hash:hash(101)});await btqTick();
    const s=(await getSwap(f.s.id))!;expect(s.btq_refund_txid).toBe(refund.txid);expect(s.btq_claim_txid).toBeNull();expect(s.revealed_preimage).toBe(f.secret.preimageHex);
    expect(node.rawTx).toHaveBeenCalledWith(refund.txid,hash(101));
  });
  it('keeps refund recovery available after a public claim disappears and the refund confirms',async()=>{
    const f=await fixture(100);await btqTick();mempool=[f.claim.txid];await btqTick();
    const refund=buildRefundTx({htlc:f.h,outpoint:{txid:f.funding,vout:0,valueSats:100000000n},destination:'qcrt1qqzy9e9njkp0pw82ym7j8rnsq47wdye783wuarc',signer:signerFromSeed(new Uint8Array(32).fill(2))});
    raw.set(refund.txid,refund.hex);mempool=[];height=106;included.set(101,[refund.txid]);confirmed.set(refund.txid,{height:101,hash:hash(101)});await btqTick();
    const s=(await getSwap(f.s.id))!;expect(s.status).toBe('awaiting_refunds');expect(s.btq_refund_txid).toBe(refund.txid);expect(s.revealed_preimage).toBe(f.secret.preimageHex);
  });
  it('keeps the stablecoin claim actionable after a confirmed BTQ claim even beyond the BTQ refund height',async()=>{
    const f=await fixture(100);await btqTick();height=106;included.set(101,[f.claim.txid]);confirmed.set(f.claim.txid,{height:101,hash:hash(101)});
    await btqTick();expect((await getSwap(f.s.id))!.status).toBe('awaiting_seller_claim');
  });
  it('requires both confirmed legs and reopens completion after a claim reorg',async()=>{
    const f=await fixture();await btqTick();mempool=[f.claim.txid];await btqTick();
    await onEvmClaimed('0x'+f.secret.secretHashHex,'stable-claim',f.secret.preimageHex);
    expect((await getSwap(f.s.id))!.status).toBe('awaiting_seller_claim');
    height=106;mempool=[];included.set(101,[f.claim.txid]);confirmed.set(f.claim.txid,{height:101,hash:hash(101)});await btqTick();
    expect((await getSwap(f.s.id))!.status).toBe('completed');
    fork=101;height=107;included.delete(101);await btqTick();const s=(await getSwap(f.s.id))!;
    expect(s.status).toBe('awaiting_seller_claim');expect(s.completed_at).toBeNull();expect(s.evm_claim_tx).toBe('stable-claim');expect(s.revealed_preimage).toBe(f.secret.preimageHex);expect(s.btq_claim_txid).toBeNull();
    const notices=await db().query("SELECT id FROM notifications WHERE swap_id=$1 AND user_id=$2 AND payload->>'status'='awaiting_seller_claim'",[s.id,s.buyer_user_id]);
    expect(notices.rows).toHaveLength(2);
  });
});
