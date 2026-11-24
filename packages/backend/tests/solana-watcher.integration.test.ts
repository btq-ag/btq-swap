import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Keypair, PublicKey, Transaction, TransactionInstruction, type VersionedTransactionResponse } from '@solana/web3.js';
import { AccountLayout, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';
import { db } from '../src/lib/db';
import { getSwap, setBtqTipProvider } from '../src/domain/settlement';
import { ensureSolanaEscrow, recoverSolanaLock, prepareSolanaTransaction, type SolanaEscrow } from '../src/domain/solana-transactions';
import { buildHtlcTransaction } from '../src/chains/solana-htlc';
import { databaseEnabled, testDatabase, testSwap } from './database';
const rpc=vi.hoisted(()=>({getLatestBlockhash:vi.fn(),getSignaturesForAddress:vi.fn(),getTransaction:vi.fn(),getMultipleAccountsInfoAndContext:vi.fn(),getSlot:vi.fn(),getBlockTime:vi.fn()}));
vi.mock('../src/chains/solana',()=>({withSolana:async(fn:Function)=>fn(rpc),solanaProgramAddress:()=> 'configured'}));
import { refreshSolanaSwap, solanaTick, solanaReceiptActions } from '../src/workers/solana-watcher';

describe.skipIf(!databaseEnabled)('durable Solana settlement receipts (#8, #16)',()=>{
  testDatabase();
  let history:Map<string,Array<{signature:string;slot:number;blockTime:number;err:null}>>,receipts:Map<string,VersionedTransactionResponse>,accounts:Map<string,any>;
  beforeEach(async()=>{
    await db().query('TRUNCATE users CASCADE');vi.resetAllMocks();history=new Map();receipts=new Map();accounts=new Map();
    rpc.getLatestBlockhash.mockResolvedValue({blockhash:Keypair.generate().publicKey.toBase58()});rpc.getSlot.mockResolvedValue(100);
    rpc.getSignaturesForAddress.mockImplementation(async(address:PublicKey,options:{limit:number;before?:string;until?:string})=>{
      const all=history.get(address.toBase58())??[];const start=options.before?all.findIndex(x=>x.signature===options.before)+1:0;
      const end=options.until?all.findIndex(x=>x.signature===options.until):all.length;
      return all.slice(start,end<0?all.length:end).slice(0,options.limit);
    });
    rpc.getTransaction.mockImplementation(async(sig:string)=>receipts.get(sig)??null);
    rpc.getMultipleAccountsInfoAndContext.mockImplementation(async(keys:PublicKey[])=>({context:{slot:100},value:keys.map(k=>accounts.get(k.toBase58())??null)}));
    setBtqTipProvider(async()=>100);
  });
  async function fixture(preimage=Buffer.from(Keypair.generate().secretKey.subarray(0,32))) {
    const buyer=Keypair.generate(),seller=Keypair.generate(),mint=Keypair.generate().publicKey,programId=Keypair.generate().publicKey;
    const s=await testSwap({settlement_rail:'solana',evm_chain_id:0,buyer_sol:buyer.publicKey.toBase58(),seller_sol:seller.publicKey.toBase58(),evm_htlc_contract:programId.toBase58(),evm_token:mint.toBase58()});
    const deadline=Math.floor(Date.now()/1000)+86400,secretHash=createHash('sha256').update(preimage).digest();
    const e=await ensureSolanaEscrow(db(),s,{partyA:s.buyer_sol!,partyB:s.seller_sol!,mint:s.evm_token,amount:s.amount_usdt_units,deadline,secretHash:secretHash.toString('hex')});
    const args={connection:rpc as never,partyA:buyer.publicKey,partyB:seller.publicKey,mint,programId,amount:BigInt(s.amount_usdt_units),deadline:BigInt(deadline),secretHash,preimage};
    const build=async(action:'lock'|'withdraw'|'refund')=>{
      const t=await buildHtlcTransaction({...args,action,feePayer:action==='withdraw'?seller.publicKey:buyer.publicKey});t.sign(action==='withdraw'?seller:buyer);return t;
    };
    const add=(t:Transaction,slot:number,err:unknown=null)=>{
      const signature=bs58.encode(t.signature!);const blockTime=Math.floor(Date.now()/1000);
      const list=history.get(e.address)??[];list.unshift({signature,slot,blockTime,err:err as null});history.set(e.address,list);
      receipts.set(signature,{slot,blockTime,transaction:{message:t.compileMessage(),signatures:[signature]},meta:{err,innerInstructions:[],logMessages:[]}} as unknown as VersionedTransactionResponse);
      return signature;
    };
    const live=()=>{
      const data=Buffer.alloc(179);data[0]=2;buyer.publicKey.toBuffer().copy(data,1);seller.publicKey.toBuffer().copy(data,33);mint.toBuffer().copy(data,65);secretHash.copy(data,97);data.writeBigUInt64LE(BigInt(deadline),129);data.writeBigUInt64LE(BigInt(s.amount_usdt_units),137);
      const vault=getAssociatedTokenAddressSync(mint,new PublicKey(e.address),true);const token=Buffer.alloc(AccountLayout.span);
      AccountLayout.encode({mint,owner:new PublicKey(e.address),amount:BigInt(s.amount_usdt_units),delegateOption:0,delegate:PublicKey.default,state:1,isNativeOption:0,isNative:0n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default},token);
      accounts.set(e.address,{data,owner:programId,lamports:100,executable:false});accounts.set(vault.toBase58(),{data:token,owner:TOKEN_PROGRAM_ID,lamports:100,executable:false});
    };
    return {s,e,buyer,seller,preimage,build,add,live};
  }
  it('admits only its bound live funded escrow and skips unrelated account history',async()=>{
    const f=await fixture();const other=await fixture();const sig=f.add(await f.build('lock'),80);f.live();
    await refreshSolanaSwap(f.s.id);
    expect((await getSwap(f.s.id))!.status).toBe('awaiting_seller_lock');expect((await getSwap(f.s.id))!.evm_lock_tx).toBe(sig);
    expect((await getSwap(other.s.id))!.evm_agreement_id).toBeNull();
    expect(rpc.getSignaturesForAddress.mock.calls.every(([key])=>key.toBase58()===f.e.address)).toBe(true);
  });
  it('recovers a zero preimage after closure without ever requesting BTQ funding for the spent lock',async()=>{
    const f=await fixture(Buffer.alloc(32));f.add(await f.build('lock'),80);const spent=f.add(await f.build('withdraw'),81);
    await refreshSolanaSwap(f.s.id);const s=(await getSwap(f.s.id))!;
    expect(s.evm_claim_tx).toBe(spent);expect(s.revealed_preimage).toBe('00'.repeat(32));expect(s.btq_htlc_spk).toBeNull();
    expect((await db().query("SELECT id FROM swap_events WHERE swap_id=$1 AND to_status='awaiting_seller_lock'",[s.id])).rows).toHaveLength(0);
    rpc.getSignaturesForAddress.mockClear();await solanaTick();expect(rpc.getSignaturesForAddress).not.toHaveBeenCalled();
  });
  it('recovers a closed refund and never treats a recreated agreement as a new lock',async()=>{
    const f=await fixture();f.add(await f.build('lock'),80);const refunded=f.add(await f.build('refund'),81);
    // A separately signed later incarnation has the same address and immutable terms.
    rpc.getLatestBlockhash.mockResolvedValue({blockhash:Keypair.generate().publicKey.toBase58()});f.add(await f.build('lock'),82);f.live();
    await refreshSolanaSwap(f.s.id);const s=(await getSwap(f.s.id))!;
    expect(s.evm_refund_tx).toBe(refunded);expect(s.status).toBe('refunded');expect(s.btq_htlc_spk).toBeNull();
  });
  it('persists bounded backwards pagination and resumes without losing the original lock',async()=>{
    const f=await fixture();f.add(await f.build('lock'),1);f.live();
    for(let i=2;i<=52;i++) {const signature=`unrelated-${i}`;history.get(f.e.address)!.unshift({signature,slot:i,blockTime:1,err:null});receipts.set(signature,{slot:i,meta:{err:null},transaction:{message:new Transaction({feePayer:f.buyer.publicKey,recentBlockhash:Keypair.generate().publicKey.toBase58()}).add(new TransactionInstruction({programId:PublicKey.default,keys:[],data:Buffer.alloc(0)})).compileMessage(),signatures:[signature]}} as never);}
    await refreshSolanaSwap(f.s.id);expect(rpc.getTransaction).toHaveBeenCalledTimes(50);expect((await getSwap(f.s.id))!.evm_agreement_id).toBeNull();
    expect((await db().query('SELECT scan_before FROM solana_escrows WHERE id=$1',[f.e.id])).rows[0].scan_before).toBeTruthy();
    await refreshSolanaSwap(f.s.id);expect((await getSwap(f.s.id))!.evm_agreement_id).toBe(f.e.agreement_id);
  });
  it('does not admit a live account from a newer incarnation while the receipt snapshot is incomplete',async()=>{
    const f=await fixture();f.add(await f.build('lock'),80);f.live();
    const base=rpc.getSignaturesForAddress.getMockImplementation()!;
    rpc.getSignaturesForAddress.mockImplementation(async(...args:any[])=>args[1].limit===1?[{signature:'newer-transaction',slot:101,err:null}]:base(...args));
    await refreshSolanaSwap(f.s.id);expect((await getSwap(f.s.id))!.evm_agreement_id).toBeNull();
  });
  it('keeps missing receipts retryable and rejects failed transactions and insufficient vaults',async()=>{
    const f=await fixture();const id=f.add(await f.build('lock'),80);f.live();const saved=receipts.get(id)!;receipts.delete(id);
    await expect(refreshSolanaSwap(f.s.id)).rejects.toThrow(/unavailable/);expect((await db().query('SELECT scan_until FROM solana_escrows WHERE id=$1',[f.e.id])).rows[0].scan_until).toBeNull();
    receipts.set(id,saved);for(const [key,info] of accounts) if(key!==f.e.address) info.data.writeBigUInt64LE(0n,64);
    await refreshSolanaSwap(f.s.id);expect((await getSwap(f.s.id))!.evm_agreement_id).toBeNull();
    const failed={...saved,meta:{...saved.meta,err:{InstructionError:[1,'InvalidArgument']}}};expect(solanaReceiptActions(failed as never,f.e)).toEqual([]);
  });
  it('does not reopen a rejected lock on later polls',async()=>{
    const f=await fixture();f.add(await f.build('lock'),80);f.live();await db().query("UPDATE swaps SET buyer_lock_by=now()-interval '1 minute' WHERE id=$1",[f.s.id]);
    await refreshSolanaSwap(f.s.id);await refreshSolanaSwap(f.s.id);expect((await getSwap(f.s.id))!.status).toBe('awaiting_buyer_refund');
  });
  it.each(['live','spent','late'])('imports a pre-upgrade %s v1 lock without any preparation or accepted agreement',async kind=>{
    const f=await fixture();await db().query('DELETE FROM solana_escrows WHERE id=$1',[f.e.id]);
    const old=await f.build('lock');old.instructions[0]!.data=Buffer.alloc(0);old.sign(f.buyer);const signature=f.add(old,80);
    if(kind==='spent') f.add(await f.build('withdraw'),81);
    else {f.live();accounts.get(f.e.address).data[0]=1;}
    if(kind==='late') await db().query("UPDATE swaps SET buyer_lock_by=now()-interval '1 minute',status='expired' WHERE id=$1",[f.s.id]);
    await recoverSolanaLock(f.s.buyer_user_id,f.s.id,signature);const s=(await getSwap(f.s.id))!;
    expect(s.evm_agreement_id).toBe(f.e.agreement_id);
    expect(s.status).toBe(kind==='live'?'awaiting_seller_lock':kind==='spent'?'awaiting_seller_claim':'awaiting_buyer_refund');
    if(kind!=='live') expect(s.btq_htlc_spk).toBeNull();
    if(kind==='late') expect((await prepareSolanaTransaction(f.s.buyer_user_id,s.id,'refund')).preparationId).toBeTruthy();
    expect((await db().query('SELECT lock_id FROM secret_hash_uses WHERE swap_id=$1',[s.id])).rows).toHaveLength(1);
  });
  it('rejects unauthorized and non-lock legacy imports without changing the binding',async()=>{
    const f=await fixture();await db().query('DELETE FROM solana_escrows WHERE id=$1',[f.e.id]);const signature=f.add(await f.build('lock'),80);
    await expect(recoverSolanaLock(f.s.seller_user_id,f.s.id,signature)).rejects.toThrow(/not available/);
    const nonlock=f.add(await f.build('withdraw'),81);
    await expect(recoverSolanaLock(f.s.buyer_user_id,f.s.id,nonlock)).rejects.toThrow(/exactly one lock/);
    expect((await db().query('SELECT id FROM solana_escrows WHERE swap_id=$1',[f.s.id])).rows).toHaveLength(0);
  });
  it('retires unfunded intents only after the finalized clock passes their deadline',async()=>{
    const f=await fixture();await db().query("UPDATE solana_escrows SET terms=jsonb_set(terms,'{deadline}',to_jsonb(1::int)) WHERE id=$1",[f.e.id]);
    rpc.getBlockTime.mockResolvedValue(null);await refreshSolanaSwap(f.s.id);
    expect((await db().query('SELECT retired FROM solana_escrows WHERE id=$1',[f.e.id])).rows[0].retired).toBe(false);
    rpc.getBlockTime.mockResolvedValue(2);await refreshSolanaSwap(f.s.id);
    expect((await db().query('SELECT retired FROM solana_escrows WHERE id=$1',[f.e.id])).rows[0].retired).toBe(true);
    rpc.getSignaturesForAddress.mockClear();await solanaTick();expect(rpc.getSignaturesForAddress).not.toHaveBeenCalled();
  });
  it.each(['withdraw','refund'] as const)('records a valid legacy %s using another escrow-owned token vault',async action=>{
    const f=await fixture();f.add(await f.build('lock'),80);f.live();accounts.get(f.e.address).data[0]=1;
    await refreshSolanaSwap(f.s.id);
    const spend=await f.build(action);spend.instructions.at(-1)!.keys[2]!.pubkey=Keypair.generate().publicKey;
    spend.sign(action==='withdraw'?f.seller:f.buyer);const signature=f.add(spend,81);
    accounts.get(f.e.address).data[145]=action==='withdraw'?1:2;
    await refreshSolanaSwap(f.s.id);const s=(await getSwap(f.s.id))!;
    expect(action==='withdraw'?s.evm_claim_tx:s.evm_refund_tx).toBe(signature);
    if(action==='withdraw') expect(s.revealed_preimage).toBe(f.preimage.toString('hex'));
  });
  it('recognizes successful CPI spends without logs and rejects a failed enclosing transaction',async()=>{
    const f=await fixture(Buffer.alloc(32));const direct=(await f.build('withdraw')).instructions.at(-1)!;
    const wrapper=Keypair.generate().publicKey,middle=Keypair.generate().publicKey;
    const outer=new Transaction({feePayer:f.seller.publicKey,recentBlockhash:Keypair.generate().publicKey.toBase58()}).add(new TransactionInstruction({programId:wrapper,keys:[...direct.keys,{pubkey:direct.programId,isWritable:false,isSigner:false},{pubkey:middle,isWritable:false,isSigner:false}],data:Buffer.alloc(0)}));
    const message=outer.compileMessage();const index=(key:PublicKey)=>message.accountKeys.findIndex(k=>k.equals(key));
    const inner={programIdIndex:index(direct.programId),accounts:direct.keys.map(k=>index(k.pubkey)),data:bs58.encode(direct.data)};
    const response={transaction:{message,signatures:[]},meta:{err:null,innerInstructions:[{index:0,instructions:[inner]}],logMessages:[`Program ${wrapper} invoke [1]`,`Program ${direct.programId} invoke [2]`,`Program ${direct.programId} success`,`Program ${wrapper} success`]}} as unknown as VersionedTransactionResponse;
    expect(solanaReceiptActions(response,f.e)).toMatchObject([{kind:'withdraw',preimage:'00'.repeat(32)}]);
    response.meta!.logMessages=null;
    expect(solanaReceiptActions(response,f.e)).toMatchObject([{kind:'withdraw',preimage:'00'.repeat(32)}]);
    response.meta!.err={InstructionError:[0,'InvalidArgument']};
    expect(solanaReceiptActions(response,f.e)).toEqual([]);
  });
});
