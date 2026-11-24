import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { newPreimage } from '@btq-swap/htlc';
import { db } from '../src/lib/db';
import { databaseEnabled, testDatabase, testSwap } from './database';
const rpc=vi.hoisted(()=>({getLatestBlockhash:vi.fn(),getSignatureStatuses:vi.fn(),sendRawTransaction:vi.fn(),confirmTransaction:vi.fn(),refresh:vi.fn()}));
vi.mock('../src/chains/solana',()=>({withSolana:async(fn:Function)=>fn(rpc)}));
vi.mock('../src/workers/solana-watcher',()=>({refreshSolanaSwap:rpc.refresh}));
import { prepareSolanaTransaction, submitSolanaTransaction } from '../src/domain/solana-transactions';

describe.skipIf(!databaseEnabled)('authorized Solana relay (#8)',()=>{
  testDatabase();
  beforeEach(async()=>{
    await db().query('TRUNCATE users CASCADE');vi.resetAllMocks();
    rpc.getLatestBlockhash.mockResolvedValue({blockhash:Keypair.generate().publicKey.toBase58()});
    rpc.sendRawTransaction.mockImplementation(async(raw:Buffer)=>bs58.encode(Transaction.from(raw).signature!));
    rpc.getSignatureStatuses.mockResolvedValue({value:[null]});
    rpc.confirmTransaction.mockResolvedValue({value:{err:null}});
  });
  async function fixture() {
    const buyer=Keypair.generate(),seller=Keypair.generate();
    const s=await testSwap({settlement_rail:'solana',evm_chain_id:0,buyer_sol:buyer.publicKey.toBase58(),seller_sol:seller.publicKey.toBase58(),
      evm_htlc_contract:Keypair.generate().publicKey.toBase58(),evm_token:Keypair.generate().publicKey.toBase58()});
    const hash=newPreimage().secretHashHex;
    const p=await prepareSolanaTransaction(s.buyer_user_id,s.id,'lock',hash);
    const transaction=Transaction.from(Buffer.from(p.tx,'base64'));transaction.sign(buyer);
    return {s,buyer,seller,hash,p,transaction,encoded:transaction.serialize().toString('base64')};
  }
  it('stores a durable signature before sending and refreshes only the named swap',async()=>{
    const f=await fixture();const sig=bs58.encode(f.transaction.signature!);
    rpc.sendRawTransaction.mockImplementation(async()=>{
      expect((await db().query('SELECT signature,signed_tx FROM solana_preparations WHERE id=$1',[f.p.preparationId])).rows[0]).toEqual({signature:sig,signed_tx:f.encoded});return sig;
    });
    expect(await submitSolanaTransaction(f.s.buyer_user_id,f.s.short_id,f.p.preparationId,f.encoded)).toEqual({signature:sig});
    expect(rpc.refresh).toHaveBeenCalledOnce();expect(rpc.refresh).toHaveBeenCalledWith(f.s.id);
    expect(f.transaction.instructions.at(-1)!.programId.toBase58()).toBe(f.s.evm_htlc_contract);
    expect(f.transaction.instructions[0]!.data[0]).toBe(1); // Idempotent ATA creation, including prefunded system accounts.
  });
  it('refuses other users, another swap reference, and wrong action roles before relay',async()=>{
    const f=await fixture();const other=await testSwap({settlement_rail:'solana',buyer_user_id:f.s.buyer_user_id});
    await expect(submitSolanaTransaction(f.s.seller_user_id,f.s.id,f.p.preparationId,f.encoded)).rejects.toThrow(/another swap or user/);
    await expect(submitSolanaTransaction(f.s.buyer_user_id,other.id,f.p.preparationId,f.encoded)).rejects.toThrow(/another swap or user/);
    await expect(prepareSolanaTransaction(f.s.seller_user_id,f.s.id,'lock',f.hash)).rejects.toThrow(/other party/);
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  });
  it.each(['extra instruction','program','blockhash','action'])('refuses a validly re-signed transaction with an altered %s',async change=>{
    const f=await fixture();const t=f.transaction;
    if(change==='extra instruction') t.add(SystemProgram.transfer({fromPubkey:f.buyer.publicKey,toPubkey:f.seller.publicKey,lamports:1}));
    if(change==='program') t.instructions.at(-1)!.programId=SystemProgram.programId;
    if(change==='blockhash') t.recentBlockhash=Keypair.generate().publicKey.toBase58();
    if(change==='action') t.instructions.at(-1)!.data=Buffer.from([2]);
    t.sign(f.buyer);
    await expect(submitSolanaTransaction(f.s.buyer_user_id,f.s.id,f.p.preparationId,t.serialize().toString('base64'))).rejects.toThrow(/differs/);
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  });
  it('refuses unsigned, malformed, expired preparations, and a consumed hash on another swap',async()=>{
    const f=await fixture();
    await expect(submitSolanaTransaction(f.s.buyer_user_id,f.s.id,f.p.preparationId,f.p.tx)).rejects.toThrow(/valid signatures/);
    await expect(submitSolanaTransaction(f.s.buyer_user_id,f.s.id,f.p.preparationId,'broken')).rejects.toThrow(/valid signatures/);
    await db().query("UPDATE solana_preparations SET expires_at=now()-interval '1 second' WHERE id=$1",[f.p.preparationId]);
    await expect(submitSolanaTransaction(f.s.buyer_user_id,f.s.id,f.p.preparationId,f.encoded)).rejects.toThrow(/expired/);
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  });
  it('keeps the signature after an RPC failure and permits idempotent retry of the exact bytes',async()=>{
    const f=await fixture();rpc.sendRawTransaction.mockRejectedValueOnce(new Error('timeout'));
    await expect(submitSolanaTransaction(f.s.buyer_user_id,f.s.id,f.p.preparationId,f.encoded)).rejects.toThrow('timeout');
    expect((await db().query('SELECT signature FROM solana_preparations WHERE id=$1',[f.p.preparationId])).rows[0].signature).toBeTruthy();
    await submitSolanaTransaction(f.s.buyer_user_id,f.s.id,f.p.preparationId,f.encoded);expect(rpc.refresh).toHaveBeenCalledOnce();
  });
  it('returns the exact signed transaction to a reloaded browser after an ambiguous timeout',async()=>{
    const f=await fixture();rpc.sendRawTransaction.mockRejectedValueOnce(new Error('timeout'));
    await expect(submitSolanaTransaction(f.s.buyer_user_id,f.s.id,f.p.preparationId,f.encoded)).rejects.toThrow('timeout');
    const retry=await prepareSolanaTransaction(f.s.buyer_user_id,f.s.id,'lock',f.hash);
    expect(retry).toEqual({tx:f.encoded,preparationId:f.p.preparationId,signed:true});
    await submitSolanaTransaction(f.s.buyer_user_id,f.s.id,retry.preparationId,retry.tx);
    expect(rpc.sendRawTransaction).toHaveBeenCalledTimes(2);
  });
  it('replaces only a finalized failed attempt and refuses its stale submission',async()=>{
    const f=await fixture();await submitSolanaTransaction(f.s.buyer_user_id,f.s.id,f.p.preparationId,f.encoded);
    rpc.getSignatureStatuses.mockResolvedValue({value:[{confirmationStatus:'finalized',err:{InstructionError:[0,'InsufficientFunds']}}]});
    rpc.getLatestBlockhash.mockResolvedValue({blockhash:Keypair.generate().publicKey.toBase58()});
    const retry=await prepareSolanaTransaction(f.s.buyer_user_id,f.s.id,'lock',f.hash);
    expect(retry.signed).toBe(false);expect(retry.preparationId).not.toBe(f.p.preparationId);
    await expect(submitSolanaTransaction(f.s.buyer_user_id,f.s.id,f.p.preparationId,f.encoded)).rejects.toThrow(/replaced/);
    const signed=Transaction.from(Buffer.from(retry.tx,'base64'));signed.sign(f.buyer);
    rpc.getSignatureStatuses.mockResolvedValue({value:[null]});
    await submitSolanaTransaction(f.s.buyer_user_id,f.s.id,retry.preparationId,signed.serialize().toString('base64'));
    expect(rpc.sendRawTransaction).toHaveBeenCalledTimes(2);
  });
  it.each(['null','rpc failure','unfinalized failure','finalized success'])('never replaces an ambiguous or successful lock: %s',async kind=>{
    const f=await fixture();await submitSolanaTransaction(f.s.buyer_user_id,f.s.id,f.p.preparationId,f.encoded);
    if(kind==='rpc failure') rpc.getSignatureStatuses.mockRejectedValue(new Error('archive down'));
    else rpc.getSignatureStatuses.mockResolvedValue({value:[kind==='null'?null:{confirmationStatus:kind==='finalized success'?'finalized':'confirmed',err:kind==='finalized success'?null:{InstructionError:[0,'InvalidArgument']}}]});
    await db().query("UPDATE solana_preparations SET expires_at=now()-interval '1 minute' WHERE id=$1",[f.p.preparationId]);
    expect(await prepareSolanaTransaction(f.s.buyer_user_id,f.s.id,'lock',f.hash)).toEqual({tx:f.encoded,preparationId:f.p.preparationId,signed:true});
  });
  it('refreshes a previously confirmed transaction without rebroadcasting expired bytes',async()=>{
    const f=await fixture();rpc.getSignatureStatuses.mockResolvedValue({value:[{confirmationStatus:'finalized',err:null}]});
    await submitSolanaTransaction(f.s.buyer_user_id,f.s.id,f.p.preparationId,f.encoded);
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();expect(rpc.refresh).toHaveBeenCalledOnce();
  });
  it('treats an on-chain instruction failure as failure and does not run a refresh',async()=>{
    const f=await fixture();rpc.confirmTransaction.mockResolvedValue({value:{err:{InstructionError:[1,'InvalidArgument']}}});
    await expect(submitSolanaTransaction(f.s.buyer_user_id,f.s.id,f.p.preparationId,f.encoded)).rejects.toThrow(/transaction failed/);
    expect(rpc.refresh).not.toHaveBeenCalled();
  });
  it('accepts only one of two concurrent prepared lock submissions for the same escrow',async()=>{
    const f=await fixture();rpc.getLatestBlockhash.mockResolvedValue({blockhash:Keypair.generate().publicKey.toBase58()});
    const second=await prepareSolanaTransaction(f.s.buyer_user_id,f.s.id,'lock',f.hash);
    const signed=Transaction.from(Buffer.from(second.tx,'base64'));signed.sign(f.buyer);
    const results=await Promise.allSettled([
      submitSolanaTransaction(f.s.buyer_user_id,f.s.id,f.p.preparationId,f.encoded),
      submitSolanaTransaction(f.s.buyer_user_id,f.s.id,second.preparationId,signed.serialize().toString('base64')),
    ]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(rpc.sendRawTransaction).toHaveBeenCalledOnce();
    const retry=await prepareSolanaTransaction(f.s.buyer_user_id,f.s.id,'lock',f.hash);
    expect(retry.signed).toBe(true);expect([f.p.preparationId,second.preparationId]).toContain(retry.preparationId);
  });
  it('does not relay a first lock submission after its swap window closes',async()=>{
    const f=await fixture();await db().query("UPDATE swaps SET buyer_lock_by=now()-interval '1 second' WHERE id=$1",[f.s.id]);
    await expect(submitSolanaTransaction(f.s.buyer_user_id,f.s.id,f.p.preparationId,f.encoded)).rejects.toThrow(/no longer accepting/);
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  });
  it('keeps one immutable intent across repeated preparations and rejects hash replacement',async()=>{
    const f=await fixture();await prepareSolanaTransaction(f.s.buyer_user_id,f.s.id,'lock',f.hash);
    expect((await db().query('SELECT id FROM solana_escrows WHERE swap_id=$1',[f.s.id])).rows).toHaveLength(1);
    await expect(prepareSolanaTransaction(f.s.buyer_user_id,f.s.id,'lock',newPreimage().secretHashHex)).rejects.toThrow(/different escrow/);
    const other=await testSwap({settlement_rail:'solana',evm_chain_id:0,buyer_sol:f.s.buyer_sol,seller_sol:f.s.seller_sol,evm_htlc_contract:f.s.evm_htlc_contract,evm_token:f.s.evm_token});
    await expect(prepareSolanaTransaction(other.buyer_user_id,other.id,'lock',f.hash)).rejects.toThrow();
  });
});
