import { solanaReceiptActions, type ReceiptAction } from '../chains/solana-receipts';
export { solanaReceiptActions } from '../chains/solana-receipts';
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, unpackAccount } from '@solana/spl-token';
import { parseSolHtlcState } from '../chains/solana-htlc';
import { solanaProgramAddress, withSolana } from '../chains/solana';
import { createLogger } from '../lib/logger';
import { db, many, one, tx } from '../lib/db';
import { observeSolanaAccount } from '../domain/settlement';
import { ensureSolanaEscrow, type SolanaEscrow } from '../domain/solana-transactions';
import type { SwapRow } from '../domain/types';

const log=createLogger('solana-watcher');
const HISTORY_PAGE=50;
const ESCROWS_PER_TICK=40;
export const solanaStatus={slot:0,lastTickAt:0,reachable:false};
async function pollEscrow(connection:Connection,id:string):Promise<void> {
  await tx(async c=>{
    // Targeted API refreshes and the worker may run concurrently. One scan owns this escrow.
    if(!(await one<{locked:boolean}>(c,'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 1)) AS locked',[id]))!.locked) return;
    const e=(await one<SolanaEscrow>(c,'SELECT * FROM solana_escrows WHERE id=$1 FOR UPDATE',[id]))!;
    if(e.retired || e.settlement_signature) return;
    const page=await connection.getSignaturesForAddress(new PublicKey(e.address),
      {limit:HISTORY_PAGE,before:e.scan_before??undefined,until:e.scan_until??undefined},'finalized');
    const scanHead=e.scan_head??page[0]?.signature??null;
    for(const sig of page) {
      if(await one(c,'SELECT id FROM solana_receipts WHERE escrow_id=$1 AND signature=$2',[id,sig.signature])) continue;
      let actions:ReceiptAction[]=[];
      if(!sig.err) {
        const receipt=await connection.getTransaction(sig.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});
        if(!receipt) throw new Error(`Finalized Solana receipt ${sig.signature} is unavailable; keeping history cursor`);
        actions=solanaReceiptActions(receipt,e);
      }
      if(!actions.length) continue; // Unrelated transactions do not grow the durable settlement backlog.
      await c.query(`INSERT INTO solana_receipts (escrow_id,signature,slot,block_time,actions) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (escrow_id,signature) DO NOTHING`,[id,sig.signature,sig.slot,sig.blockTime,JSON.stringify(actions)]);
    }
    await c.query('UPDATE solana_escrows SET last_polled_at=clock_timestamp(),scan_head=$2,scan_before=$3 WHERE id=$1',
      [id,scanHead,page.length===HISTORY_PAGE?page[page.length-1]!.signature:null]);
    if(page.length===HISTORY_PAGE) return; // bounded work; finish this snapshot on a later tick
    // One valid escrow lifetime has one lock and one terminal spend. Ignore later re-creations.
    const receipts=await many<{id:string;signature:string;slot:string;block_time:string|null;actions:ReceiptAction[]}>(c,
      'SELECT * FROM solana_receipts WHERE escrow_id=$1 AND NOT processed ORDER BY id DESC LIMIT 2',[id]);
    let vault=e.vault;
    for(const receipt of receipts) {
      for(const action of receipt.actions) {
        if(e.settlement_signature) break; // A closed address can be re-created; never reinterpret its next incarnation.
        if(action.kind==='lock' && !e.lock_signature) {
          if(receipt.block_time===null) throw new Error('Solana lock receipt has no block time');
          e.lock_signature=receipt.signature;e.lock_time=receipt.block_time;vault=action.vault;
        } else if(action.kind!=='lock' && e.lock_signature) {
          e.settlement_signature=receipt.signature;e.settlement_kind=action.kind;e.preimage=action.preimage??null;
        }
      }
    }
    await c.query(`UPDATE solana_escrows SET lock_signature=$2,lock_time=$3,settlement_signature=$4,settlement_kind=$5,
      preimage=$6,vault=$7,scan_until=$8,scan_head=NULL,scan_before=NULL WHERE id=$1`,
      [id,e.lock_signature,e.lock_time,e.settlement_signature,e.settlement_kind,e.preimage,vault,scanHead??e.scan_until]);
    if(e.lock_signature) {
      let live=!!e.settlement_signature;
      if(!live && vault) {
        const snapshot=await connection.getMultipleAccountsInfoAndContext([new PublicKey(e.address),new PublicKey(vault)],{commitment:'finalized'});
        const [account,info]=snapshot.value;
        const state=account?.owner.toBase58()===e.program_id?parseSolHtlcState(Buffer.from(account.data)):null;
        if(state && info) {
          const token=unpackAccount(new PublicKey(vault),info,TOKEN_PROGRAM_ID);
          live=state.partyA.toBase58()===e.terms.partyA && state.partyB.toBase58()===e.terms.partyB && state.mint.toBase58()===e.terms.mint &&
            state.secretHash.toString('hex')===e.terms.secretHash && state.amount===BigInt(e.terms.amount) && state.deadline===BigInt(e.terms.deadline) &&
            !state.withdrawn && !state.refunded && token.owner.toBase58()===e.address && token.mint.toBase58()===e.terms.mint && token.amount>=BigInt(e.terms.amount) && !token.isFrozen;
          // v2 always uses the canonical ATA; v1 is bound to the vault authenticated by its actual lock receipt.
          if(account!.data[0]===2 && vault!==getAssociatedTokenAddressSync(new PublicKey(e.terms.mint),new PublicKey(e.address),true).toBase58()) live=false;
        }
        const latest=await connection.getSignaturesForAddress(new PublicKey(e.address),{limit:1,minContextSlot:snapshot.context.slot},'finalized');
        if(latest[0]?.signature!==(scanHead??e.scan_until)) live=false; // Finish catching up before trusting a potentially re-created account.
      }
      if(live) await observeSolanaAccount(e.swap_id,{partyA:e.terms.partyA,partyB:e.terms.partyB,mint:e.terms.mint,
        secretHashHex:e.terms.secretHash,deadline:e.terms.deadline,amount:BigInt(e.terms.amount),agreementHex:e.agreement_id,
        signature:e.lock_signature,lockTime:Number(e.lock_time),withdrawn:e.settlement_kind==='withdraw',refunded:e.settlement_kind==='refund',
        preimageHex:e.preimage??'',settlementSignature:e.settlement_signature},c);
    }
    if(!e.lock_signature && Date.now()>=e.terms.deadline*1000) {
      const slot=await connection.getSlot('finalized');
      const time=await connection.getBlockTime(slot);
      const latest=await connection.getSignaturesForAddress(new PublicKey(e.address),{limit:1,minContextSlot:slot},'finalized');
      if(time!==null && time>=e.terms.deadline && (latest[0]?.signature??null)===(scanHead??e.scan_until)) {
        await c.query('UPDATE solana_escrows SET retired=true WHERE id=$1',[id]);
      }
    }
    await c.query('UPDATE solana_receipts SET processed=true WHERE id=ANY($1::bigint[])',[receipts.map(r=>r.id)]);
  });
}

export async function refreshSolanaSwap(swapId:string):Promise<void> {
  const escrow=await one<{id:string}>(db(),'SELECT id FROM solana_escrows WHERE swap_id=$1',[swapId]);
  if(escrow) await withSolana(connection=>pollEscrow(connection,escrow.id));
}

export async function solanaTick():Promise<void> {
  if(!solanaProgramAddress()) {solanaStatus.reachable=false;return;}
  // One-time enrollment of accepted legacy swaps; pending swaps are enrolled before preparation.
  const legacy=await many<SwapRow>(db(),`SELECT s.* FROM swaps s WHERE settlement_rail='solana' AND evm_agreement_id IS NOT NULL AND evm_claim_tx IS NULL AND evm_refund_tx IS NULL
    AND NOT EXISTS (SELECT 1 FROM solana_escrows e WHERE e.swap_id=s.id) LIMIT $1`,[ESCROWS_PER_TICK]);
  for(const s of legacy) await ensureSolanaEscrow(db(),s,{partyA:s.buyer_sol!,partyB:s.seller_sol!,mint:s.evm_token,amount:s.amount_usdt_units,
    secretHash:s.secret_hash!,deadline:Math.floor(s.evm_deadline!.getTime()/1000)});
  const escrows=await many<{id:string}>(db(),`SELECT id FROM solana_escrows WHERE settlement_signature IS NULL AND NOT retired
    ORDER BY last_polled_at,id LIMIT $1`,[ESCROWS_PER_TICK]);
  solanaStatus.slot=await withSolana(connection=>connection.getSlot('finalized'));
  solanaStatus.lastTickAt=Date.now();solanaStatus.reachable=true;
  for(const e of escrows) {
    try {await withSolana(connection=>pollEscrow(connection,e.id));}
    catch(err) {log.error('solana escrow scan deferred',{escrow:e.id,err:(err as Error).message});
      await db().query('UPDATE solana_escrows SET last_polled_at=clock_timestamp() WHERE id=$1',[e.id]);}
  }
}
