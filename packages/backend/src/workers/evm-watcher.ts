import { decodeHtlcLog, type HtlcEvent } from '@btq-swap/htlc';
import { config } from '../config';
import { evmChain } from '../chains/evm';
import { db, many, one } from '../lib/db';
import { onEvmClaimed, onEvmLockup, onEvmRefunded, onPendingEvmSpend, reconcileEvmObservation, runDeadlines } from '../domain/settlement';
import type { SwapRow } from '../domain/types';
import { canonicalCursor, setCursor } from './cursors';

export interface EvmWatcherStatus { head: number; cursor: number; lag: number; lastTickAt: number }
export const evmStatus: EvmWatcherStatus = { head: 0, cursor: 0, lag: 0, lastTickAt: 0 };

export async function evmTick(btqTip: () => Promise<number>): Promise<void> {
  const evm = evmChain();
  const head = await evm.blockNumber();
  const nowSec = (await evm.block(head)).timestamp;
  const safeHead = head - config().EVM_MIN_CONFIRMATIONS + 1;
  // Revalidate accepted evidence even after settlement. Receipt absence is not positive confirmation.
  const observed = await many<SwapRow>(db(), `SELECT * FROM swaps WHERE settlement_rail = 'evm'
    AND evm_chain_id = $1 AND evm_lock_tx IS NOT NULL`, [config().EVM_CHAIN_ID]);
  for (const s of observed) {
    for (const leg of ['lock', 'claim', 'refund'] as const) {
      const txid = s[`evm_${leg}_tx`] ?? (leg === 'lock' ? null : s[`evm_pending_${leg}_tx`]); if (!txid) continue;
      const receipt = await evm.receipt(txid);
      let proof: { height: number; hash: string; confirmations: number } | null = null;
      if (receipt?.status === 1 && receipt.blockNumber <= head) {
        const block = await evm.block(receipt.blockNumber);
        const expectedKind = leg === 'lock' ? 'lockup' : leg === 'claim' ? 'claimed' : 'redeemed';
        const event = receipt.logs.filter(l => l.address.toLowerCase() === s.evm_htlc_contract.toLowerCase())
          .map(decodeHtlcLog).find(e => e?.kind === expectedKind && e.agreementId === s.evm_agreement_id);
        if (receipt.blockHash === block.hash && event) proof = { height: receipt.blockNumber, hash: block.hash, confirmations: head - receipt.blockNumber + 1 };
      }
      await reconcileEvmObservation(s.id, leg, proof);
      if (leg !== 'lock' && proof && proof.confirmations >= config().EVM_MIN_CONFIRMATIONS && !s[`evm_${leg}_tx`]) {
        if (leg === 'claim') await onEvmClaimed(s.evm_agreement_id!, txid, (await evm.instance(s.evm_agreement_id!)).key, proof);
        else await onEvmRefunded(s.evm_agreement_id!, txid, proof);
      }
    }
  }
  async function applyEvent(ev:HtlcEvent):Promise<void> {
    const block=await evm.block(ev.blockNumber);
    if(!ev.blockHash || ev.blockHash!==block.hash) throw new Error('EVM branch changed during log scan');
    if(ev.kind==='lockup') {await onEvmLockup({...ev,blockTimestamp:block.timestamp},head,nowSec);return;}
    if(!await one(db(), "SELECT id FROM swaps WHERE settlement_rail='evm' AND evm_chain_id=$1 AND evm_agreement_id=$2",[config().EVM_CHAIN_ID,ev.agreementId])) return;
    const mature=head-ev.blockNumber+1>=config().EVM_MIN_CONFIRMATIONS;
    if(ev.kind==='claimed') {
      // The contract never deletes/reuses an agreement. The current public key is hash-checked;
      // only canonical event evidence establishes settlement. No archive-state RPC is needed.
      const key=(await evm.instance(ev.agreementId)).key;
      if(mature) await onEvmClaimed(ev.agreementId,ev.txHash,key,{height:ev.blockNumber,hash:block.hash});
      else await onPendingEvmSpend(ev.agreementId,'claim',ev.txHash,key);
    } else if(mature) await onEvmRefunded(ev.agreementId,ev.txHash,{height:ev.blockNumber,hash:block.hash});
    else await onPendingEvmSpend(ev.agreementId,'refund',ev.txHash);
  }
  // A legacy unhashed cursor cannot prove an ancestor. Replay fully, with bounded work per tick.
  const cur=await canonicalCursor('evm',safeHead,async h=>(await evm.block(h)).hash,Math.max(-1,safeHead-5000));
  let from=cur.height+1;
  for(let range=0;from<=safeHead && range<20;range++) {
    const to=Math.min(safeHead,from+config().EVM_LOG_RANGE-1);const anchor=await evm.block(to);
    for(const ev of await evm.logs(from,to)) await applyEvent(ev);
    if((await evm.block(to)).hash!==anchor.hash) throw new Error('EVM branch changed during log scan');
    await setCursor('evm',to,anchor.hash);from=to+1;
  }
  // Keep recent events actionable while a legacy/deep-fork history replay catches up, including min=1.
  const tailFrom=from<=safeHead?Math.max(from,head-Math.min(5000,20*config().EVM_LOG_RANGE)):safeHead+1;
  for(let start=tailFrom;start<=head;start+=config().EVM_LOG_RANGE) {
    const end=Math.min(head,start+config().EVM_LOG_RANGE-1);
    for(const ev of await evm.logs(start,end)) await applyEvent(ev);
  }
  await runDeadlines(await btqTip());
  evmStatus.head = head;
  evmStatus.cursor = from - 1;
  evmStatus.lag = Math.max(0, head - evmStatus.cursor);
  evmStatus.lastTickAt = Date.now();
}
