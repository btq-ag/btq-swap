import { PublicKey, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { successfulInstructions } from '../chains/solana-receipts';
import { config } from '../config';
import { agreementId, buildHtlcTransaction, htlcAddress } from '../chains/solana-htlc';
import { withSolana } from '../chains/solana';
import { db, one, tx, type Queryable } from '../lib/db';
import { DomainError } from './errors';
import { hashOwnerConflict } from './funding';
import { getSwap } from './settlement';
import type { SwapRow } from './types';

export type SolanaAction = 'lock' | 'withdraw' | 'refund';
export interface EscrowTerms { partyA:string; partyB:string; mint:string; amount:string; secretHash:string; deadline:number }
export interface SolanaEscrow {
  id:string; swap_id:string; program_id:string; address:string; agreement_id:string; terms:EscrowTerms;
  retired:boolean; vault:string|null; lock_signature:string|null; lock_time:string|null; settlement_signature:string|null; settlement_kind:'withdraw'|'refund'|null;
  preimage:string|null; scan_until:string|null; scan_before:string|null; scan_head:string|null;
}

/** Also enroll already accepted legacy escrows; no heuristic matching of buyer/seller/amount. */
export async function ensureSolanaEscrow(c:Queryable, s:SwapRow, terms:EscrowTerms):Promise<SolanaEscrow> {
  const id=agreementId(new PublicKey(terms.partyA),new PublicKey(terms.partyB),new PublicKey(terms.mint),BigInt(terms.amount),Buffer.from(terms.secretHash,'hex'),BigInt(terms.deadline));
  if(s.evm_agreement_id && s.evm_agreement_id!==id.toString('hex')) throw new DomainError('CONFLICT','The escrow does not match the recorded agreement.');
  const address=htlcAddress(new PublicKey(s.evm_htlc_contract),id).toBase58();
  await c.query(`INSERT INTO solana_escrows (swap_id,program_id,address,agreement_id,terms) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT DO NOTHING`,[s.id,s.evm_htlc_contract,address,id.toString('hex'),JSON.stringify(terms)]);
  const saved=(await one<SolanaEscrow>(c,'SELECT * FROM solana_escrows WHERE swap_id=$1',[s.id]))!;
  if(!saved) throw new DomainError('CONFLICT','This escrow is already bound to another swap.');
  if(saved.agreement_id!==id.toString('hex') || saved.program_id!==s.evm_htlc_contract) throw new DomainError('CONFLICT','This swap already has a different escrow intent.');
  return saved;
}

export async function prepareSolanaTransaction(userId:string, ref:string, action:SolanaAction, secretHashHex?:string):Promise<{tx:string;preparationId:string;signed:boolean}> {
  // Keep the row locked until the exact message and immutable escrow binding are stored.
  return tx(async c=>{
    const s=await getSwap(ref,c);
    if(!s || s.settlement_rail!=='solana') throw new DomainError('NOT_FOUND','That swap is not on Solana.');
    await c.query('SELECT id FROM swaps WHERE id=$1 FOR UPDATE',[s.id]);
    const swap=(await getSwap(s.id,c))!;
    const actor=action==='withdraw'?swap.seller_user_id:swap.buyer_user_id;
    if(userId!==actor) throw new DomainError('FORBIDDEN','This step belongs to the other party.');
    if(!swap.buyer_sol || !swap.seller_sol) throw new DomainError('VALIDATION','This swap has no Solana wallets.');
    let escrow=await one<SolanaEscrow>(c,'SELECT * FROM solana_escrows WHERE swap_id=$1',[swap.id]);
    if(action==='lock') {
      if(swap.status!=='awaiting_buyer_lock' || swap.evm_agreement_id || swap.buyer_lock_by.getTime()<=Date.now()) throw new DomainError('CONFLICT','This swap is no longer accepting a new lock.');
      if(!secretHashHex || !/^[a-f0-9]{64}$/i.test(secretHashHex)) throw new DomainError('VALIDATION','The secret hash must be 32 bytes of hex.');
      if(swap.secret_hash && swap.secret_hash!==secretHashHex.toLowerCase()) throw new DomainError('CONFLICT','The secret hash does not match this swap.');
      const terms:EscrowTerms={partyA:swap.buyer_sol,partyB:swap.seller_sol,mint:swap.evm_token,amount:swap.amount_usdt_units,
        secretHash:secretHashHex.toLowerCase(),deadline:escrow?.terms.deadline??Math.floor(Date.now()/1000)+config().SWAP_EVM_LOCK_DURATION_SEC};
      escrow=await ensureSolanaEscrow(c,swap,terms);
      const prior=await one<{id:string;signature:string;signed_tx:string}>(c,"SELECT * FROM solana_preparations WHERE escrow_id=$1 AND action='lock' AND signature IS NOT NULL AND NOT superseded",[escrow.id]);
      if(prior) {
        const status=await withSolana(connection=>connection.getSignatureStatuses([prior.signature],{searchTransactionHistory:true})).catch(()=>null);
        // A null history response is not proof of absence (RPC archives can be incomplete).
        // Only a positively observed finalized failure makes another signed lock safe.
        if(status?.value[0]?.confirmationStatus==='finalized' && status.value[0].err) {
          await c.query('UPDATE solana_preparations SET superseded=true WHERE id=$1',[prior.id]);
        } else return {tx:prior.signed_tx,preparationId:prior.id,signed:true};
      }
      if(escrow.terms.secretHash!==terms.secretHash || await hashOwnerConflict(c,terms.secretHash,swap,escrow.agreement_id)) throw new DomainError('CONFLICT','This secret hash is already bound to another lock.');
    } else if(!escrow) {
      if(!swap.secret_hash || !swap.evm_deadline) throw new DomainError('CONFLICT','The Solana lock is not recorded yet.');
      escrow=await ensureSolanaEscrow(c,swap,{partyA:swap.buyer_sol,partyB:swap.seller_sol,mint:swap.evm_token,amount:swap.amount_usdt_units,
        secretHash:swap.secret_hash,deadline:Math.floor(swap.evm_deadline.getTime()/1000)});
    }
    if(escrow.retired || escrow.settlement_signature || swap.evm_claim_tx || swap.evm_refund_tx) throw new DomainError('CONFLICT','This escrow is already settled.');
    if(action==='withdraw' && !swap.revealed_preimage) throw new DomainError('CONFLICT','The secret is not public yet. Claim the BTQ first.');
    const terms=escrow.terms;
    const transaction=await withSolana(connection=>buildHtlcTransaction({connection,programId:new PublicKey(escrow!.program_id),mint:new PublicKey(terms.mint),
      feePayer:new PublicKey(action==='withdraw'?terms.partyB:terms.partyA),action,partyA:new PublicKey(terms.partyA),partyB:new PublicKey(terms.partyB),
      amount:BigInt(terms.amount),secretHash:Buffer.from(terms.secretHash,'hex'),deadline:BigInt(terms.deadline),vaultAddress:escrow!.vault?new PublicKey(escrow!.vault):undefined,preimage:action==='withdraw'?Buffer.from(swap.revealed_preimage!,'hex'):undefined}));
    const prepared=await one<{id:string}>(c,`INSERT INTO solana_preparations (escrow_id,swap_id,user_id,action,message)
      VALUES ($1,$2,$3,$4,$5) RETURNING id`,[escrow.id,swap.id,userId,action,transaction.serializeMessage().toString('base64')]);
    return {tx:transaction.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64'),preparationId:prepared!.id,signed:false};
  });
}

export async function submitSolanaTransaction(userId:string,ref:string,preparationId:string,signedTx:string):Promise<{signature:string}> {
  let transaction:Transaction;
  try {transaction=Transaction.from(Buffer.from(signedTx,'base64'));if(!transaction.verifySignatures()) throw new Error('signature');}
  catch {throw new DomainError('VALIDATION','The transaction must contain all required valid signatures.');}
  const signature=bs58.encode(transaction.signature!);
  const swapId=await tx(async c=>{
    const swap=await getSwap(ref,c);
    if(!swap || swap.settlement_rail!=='solana' || (swap.buyer_user_id!==userId && swap.seller_user_id!==userId)) throw new DomainError('NOT_FOUND','That swap is not available.');
    // Serialize all preparations for a swap before taking any preparation row lock.
    await c.query('SELECT id FROM swaps WHERE id=$1 FOR UPDATE',[swap.id]);
    const preparation=await one<{escrow_id:string;message:string;user_id:string;swap_id:string;action:SolanaAction;signature:string|null;superseded:boolean;expires_at:Date}>(c,'SELECT * FROM solana_preparations WHERE id=$1 FOR UPDATE',[preparationId]);
    if(!preparation || preparation.user_id!==userId || preparation.swap_id!==swap.id) throw new DomainError('FORBIDDEN','This transaction preparation belongs to another swap or user.');
    if(preparation.superseded) throw new DomainError('CONFLICT','This failed preparation was replaced. Prepare the transaction again.');
    if(transaction.serializeMessage().toString('base64')!==preparation.message) throw new DomainError('VALIDATION','The signed transaction differs from the prepared swap transaction.');
    if(preparation.signature && preparation.signature!==signature) throw new DomainError('CONFLICT','This preparation was already submitted with a different signature.');
    if(!preparation.signature && preparation.expires_at.getTime()<=Date.now()) throw new DomainError('CONFLICT','The transaction preparation expired. Prepare it again.');
    if(preparation.action==='lock' && !preparation.signature) {
      const current=(await getSwap(swap.id,c))!;
      if(current.status!=='awaiting_buyer_lock' || current.evm_agreement_id || current.buyer_lock_by.getTime()<=Date.now()) throw new DomainError('CONFLICT','This swap is no longer accepting a new lock.');
      if(await one(c,"SELECT id FROM solana_preparations WHERE escrow_id=$1 AND action='lock' AND signature IS NOT NULL AND NOT superseded AND id<>$2",[preparation.escrow_id,preparationId])) throw new DomainError('CONFLICT','Another lock transaction was already submitted for this escrow.');
    }
    // Persist before broadcasting: an RPC timeout must not make the signed transaction untraceable.
    await c.query('UPDATE solana_preparations SET signature=$2,signed_tx=$3 WHERE id=$1',[preparationId,signature,signedTx]);
    return swap.id;
  });
  await withSolana(async connection=>{
    const observed=(await connection.getSignatureStatuses([signature],{searchTransactionHistory:true})).value[0];
    if(observed?.confirmationStatus==='finalized' && observed.err) throw new DomainError('VALIDATION','The Solana transaction failed. Prepare a replacement transaction.');
    if(observed && !observed.err && ['confirmed','finalized'].includes(observed.confirmationStatus??'')) return;
    const sent=await connection.sendRawTransaction(transaction.serialize(),{skipPreflight:false});
    if(sent!==signature) throw new Error('Solana RPC returned a different transaction signature');
    const result=await connection.confirmTransaction(signature,'confirmed');
    if(result.value.err) throw new DomainError('VALIDATION',`The Solana transaction failed: ${JSON.stringify(result.value.err)}`);
  });
  const {refreshSolanaSwap}=await import('../workers/solana-watcher');
  await refreshSolanaSwap(swapId);
  return {signature};
}

/** Explicit receipt import for wallets funded before the intent protocol was deployed. No transaction is relayed. */
export async function recoverSolanaLock(userId:string,ref:string,signature:string):Promise<{agreementId:string;address:string}> {
  if(!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature) || bs58.decode(signature).length!==64) throw new DomainError('VALIDATION','Enter a valid Solana transaction signature.');
  const snapshot=await getSwap(ref);
  if(!snapshot || snapshot.settlement_rail!=='solana' || snapshot.buyer_user_id!==userId) throw new DomainError('NOT_FOUND','That buyer swap is not available.');
  const receipt=await withSolana(connection=>connection.getTransaction(signature,{commitment:'finalized',maxSupportedTransactionVersion:0}));
  if(!receipt?.meta || receipt.meta.err || receipt.blockTime===null || receipt.blockTime===undefined) throw new DomainError('CONFLICT','A successful finalized lock receipt is required.');
  const keys=receipt.transaction.message.getAccountKeys({accountKeysFromLookups:receipt.meta.loadedAddresses});
  const candidates:EscrowTerms[]=[];
  for(const ix of successfulInstructions(receipt)) {
    const a=ix.accountKeyIndexes.map(i=>keys.get(i)?.toBase58());const d=Buffer.from(ix.data);
    if(keys.get(ix.programIdIndex)?.toBase58()!==snapshot.evm_htlc_contract || d.length!==81 || d[0]!==0 || a[0]!==snapshot.buyer_sol ||
      !receipt.transaction.message.isAccountSigner(ix.accountKeyIndexes[0]!) || a[4]!==TOKEN_PROGRAM_ID.toBase58() || a[6]!==snapshot.evm_token ||
      new PublicKey(d.subarray(1,33)).toBase58()!==snapshot.seller_sol || d.readBigUInt64LE(73)!==BigInt(snapshot.amount_usdt_units) ||
      d.readBigUInt64LE(65)>BigInt(Number.MAX_SAFE_INTEGER)) continue;
    const terms:EscrowTerms={partyA:a[0]!,partyB:snapshot.seller_sol!,mint:snapshot.evm_token,amount:snapshot.amount_usdt_units,
      secretHash:d.subarray(33,65).toString('hex'),deadline:Number(d.readBigUInt64LE(65))};
    const id=agreementId(new PublicKey(terms.partyA),new PublicKey(terms.partyB),new PublicKey(terms.mint),BigInt(terms.amount),Buffer.from(terms.secretHash,'hex'),BigInt(terms.deadline));
    if(a[1]===htlcAddress(new PublicKey(snapshot.evm_htlc_contract),id).toBase58()) candidates.push(terms);
  }
  if(candidates.length!==1) throw new DomainError('VALIDATION','The receipt must contain exactly one lock matching this swap and its buyer.');
  const escrow=await tx(async c=>{
    await c.query('SELECT id FROM swaps WHERE id=$1 FOR UPDATE',[snapshot.id]);const swap=(await getSwap(snapshot.id,c))!;
    const saved=await ensureSolanaEscrow(c,swap,candidates[0]!);
    if(await hashOwnerConflict(c,candidates[0]!.secretHash,swap,saved.agreement_id)) throw new DomainError('CONFLICT','That secret hash is already bound to another lock.');
    return saved;
  });
  const {refreshSolanaSwap}=await import('../workers/solana-watcher');
  await refreshSolanaSwap(snapshot.id); // Full finalized history, including any spend, must precede funding instructions.
  return {agreementId:escrow.agreement_id,address:escrow.address};
}
