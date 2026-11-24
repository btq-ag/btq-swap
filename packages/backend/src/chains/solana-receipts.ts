import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { PublicKey, type VersionedTransactionResponse } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import type { SolanaEscrow } from '../domain/solana-transactions';

export type ReceiptAction={kind:'lock'|'withdraw'|'refund';preimage?:string;vault:string};

type Compiled = { programIdIndex:number; accountKeyIndexes:number[]; data:Uint8Array };

/** Solana aborts the entire transaction on CPI error (solana-cpi 2.1.0 invoke contract).
 * Successful transaction metadata therefore proves executed inner instructions, even when logs truncate.
 */
export function successfulInstructions(r:VersionedTransactionResponse):Compiled[] {
  return r.transaction.message.compiledInstructions.flatMap((ix,index)=>[
    ix,...(r.meta?.innerInstructions?.find(group=>group.index===index)?.instructions??[]).map(inner=>({
      programIdIndex:inner.programIdIndex,accountKeyIndexes:inner.accounts,data:bs58.decode(inner.data),
    })),
  ]);
}

/** Require successful finalized transaction metadata for direct and CPI instructions. */
export function solanaReceiptActions(r:VersionedTransactionResponse,e:SolanaEscrow):ReceiptAction[] {
  if(!r.meta || r.meta.err) return [];
  const keys=r.transaction.message.getAccountKeys({accountKeysFromLookups:r.meta.loadedAddresses});
  const actions:ReceiptAction[]=[];const t=e.terms;
  for(const ix of successfulInstructions(r)) {
    if(keys.get(ix.programIdIndex)?.toBase58()!==e.program_id) continue;
    const a=ix.accountKeyIndexes.map(i=>keys.get(i)?.toBase58());const d=Buffer.from(ix.data);
    if(a[1]!==e.address || a[4]!==TOKEN_PROGRAM_ID.toBase58() || !a[2]) continue;
    if(d[0]===0 && d.length===81 && a[0]===t.partyA && a[6]===t.mint &&
      new PublicKey(d.subarray(1,33)).toBase58()===t.partyB && d.subarray(33,65).toString('hex')===t.secretHash &&
      d.readBigUInt64LE(65)===BigInt(t.deadline) && d.readBigUInt64LE(73)===BigInt(t.amount) && a[3]) {
      actions.push({kind:'lock',vault:a[3]});
    } else if(d[0]===1 && d.length===33 && a[0]===t.partyB && createHash('sha256').update(d.subarray(1)).digest('hex')===t.secretHash) {
      actions.push({kind:'withdraw',preimage:d.subarray(1).toString('hex'),vault:a[2]});
    } else if(d[0]===2 && d.length===1 && a[0]===t.partyA) actions.push({kind:'refund',vault:a[2]});
  }
  return actions;
}
