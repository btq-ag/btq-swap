import { buildClaimTx, buildRefundTx, btqNetworkTag, swapBindingAsset, claimRefusal, DEFAULT_CLAIM_MARGIN_BLOCKS, bytesToHex, btqToSats } from '@btq-swap/htlc';
import { config } from '../config';
import { btqChain } from '../chains/btq';
import { evmChain } from '../chains/evm';
import { buildHtlcTransaction } from '../chains/solana-htlc';
import { platformSolanaKeypair, solanaMint, solanaProgramId, withSolana } from '../chains/solana';
import { PublicKey } from '@solana/web3.js';
import { decryptSecret } from '../lib/crypto';
import { db, many, one } from '../lib/db';
import { createLogger } from '../lib/logger';
import { getPlatformUser } from '../domain/identity';
import { refreshInventory } from '../domain/inventory';
import { platformHtlcSigner } from '../domain/runtime';
import { claimAction, htlcForSwap, recordEvent } from '../domain/settlement';
import type { SwapRow } from '../domain/types';

const log = createLogger('platform-agent');
const MAX_ATTEMPTS = 5;
class DeferredAction extends Error {}

/** Read our node immediately before authorizing disclosure of the platform's secret. */
export async function platformClaimRefusal(s: SwapRow): Promise<string | null> {
  const btq = btqChain();
  const [output, tip] = await Promise.all([
    btq.rpc.call<{ bestblock: string; confirmations: number; value: number; scriptPubKey: { hex: string } } | null>(
      'gettxout', [s.btq_lock_txid, s.btq_lock_vout, true]),
    btq.tip(),
  ]);
  if (!output) return 'the funding output is missing or already spent';
  if (output.bestblock !== tip.hash) return 'the chain changed while checking funding; retry next tick';
  const htlc = htlcForSwap(s);
  if (output.scriptPubKey?.hex?.toLowerCase() !== bytesToHex(htlc.scriptPubKey)) return 'the funding output has the wrong HTLC script';
  if (!Number.isFinite(output.value) || btqToSats(output.value.toFixed(8)) !== BigInt(s.btq_lock_sats!)) return 'the funding output has the wrong value';
  return claimRefusal({ lockConfirmations: output.confirmations, minConfirmations: config().BTQ_MIN_CONFIRMATIONS,
    tipHeight: tip.height, refundLocktime: htlc.refundLocktime, marginBlocks: DEFAULT_CLAIM_MARGIN_BLOCKS });
}

async function attemptNo(swapId: string, kind: string): Promise<number> {
  const r = await one<{ n: string }>(
    db(),
    `SELECT COUNT(*)::text AS n FROM swap_events WHERE swap_id = $1 AND event_type = 'platform_action_failed' AND metadata->>'kind' = $2`,
    [swapId, kind],
  );
  return Number(r?.n ?? '0');
}

/** Run a side-effecting platform action at most once per attempt; failures allow bounded retries. */
async function once(s: SwapRow, kind: string, fn: () => Promise<Record<string, unknown>>): Promise<void> {
  const attempt = await attemptNo(s.id, kind);
  if (attempt >= MAX_ATTEMPTS) return;
  const key = `${kind}:${s.id}:${attempt}`;
  if (!(await claimAction(s.id, key, { kind, attempt }))) return;
  try {
    const meta = await fn();
    await recordEvent(db(), s.id, `platform_${kind}`, meta, { actor: 'platform' });
    log.info(`swap #${s.short_id}: ${kind} done`, meta);
  } catch (err) {
    if (err instanceof DeferredAction) {
      // No transaction was signed or sent. Release only this attempt's reservation.
      await db().query(`DELETE FROM swap_events WHERE action_key = $1 AND event_type = 'platform_action'`, [key]);
      log.info(`swap #${s.short_id}: ${kind} deferred`, { reason: err.message });
      return;
    }
    log.error(`swap #${s.short_id}: ${kind} failed`, { err: (err as Error).message, attempt });
    await recordEvent(db(), s.id, 'platform_action_failed', { kind, attempt, error: (err as Error).message }, { actor: 'platform' });
  }
}

async function platformSolana(s: SwapRow, action: 'lock' | 'withdraw' | 'refund'): Promise<string> {
  const key = platformSolanaKeypair();
  const deadline = action === 'lock'
    ? BigInt(Math.floor(Date.now() / 1000) + config().SWAP_EVM_LOCK_DURATION_SEC)
    : BigInt(Math.floor(new Date(s.evm_deadline!).getTime() / 1000));
  const sig = await withSolana(async (connection) => {
    const tx = await buildHtlcTransaction({
      connection,
      programId: solanaProgramId(),
      mint: solanaMint(),
      feePayer: key.publicKey,
      action,
      partyA: new PublicKey(s.buyer_sol!),
      partyB: new PublicKey(s.seller_sol!),
      amount: BigInt(s.amount_usdt_units),
      secretHash: Buffer.from(s.secret_hash!, 'hex'),
      deadline,
      preimage: action === 'withdraw' ? Buffer.from(s.revealed_preimage!, 'hex') : undefined,
    });
    tx.partialSign(key);
    const sent = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction(sent, 'confirmed');
    return sent;
  });
  return sig;
}

export async function platformTick(tip: number): Promise<void> {
  await refreshInventory().catch((err) => log.warn('inventory refresh failed', { err: (err as Error).message }));
  const platform = await getPlatformUser();
  const swaps = await many<SwapRow>(
    db(),
    `SELECT * FROM swaps WHERE (buyer_user_id = $1 OR seller_user_id = $1)
       AND status NOT IN ('completed','expired','refunded','failed') ORDER BY created_at`,
    [platform.id],
  );
  if (!swaps.length) return;
  const evm = evmChain();
  const btq = btqChain();
  const chainNow = await evm.latestTimestamp();

  for (const s of swaps) {
    const isBuyer = s.buyer_user_id === platform.id;
    try {
      if (isBuyer && s.status === 'awaiting_buyer_lock' && !s.evm_agreement_id && s.settlement_rail === 'solana') {
        await once(s, 'solana_lock', async () => ({ signature: await platformSolana(s, 'lock') }));
      } else if (isBuyer && s.status === 'awaiting_buyer_lock' && !s.evm_agreement_id) {
        await once(s, 'evm_lock', async () => {
          const r = await evm.platformLock({
            partyB: s.seller_eth,
            secretlock: `0x${s.secret_hash}`,
            deadline: chainNow + config().SWAP_EVM_LOCK_DURATION_SEC,
            erc20Contract: s.evm_token,
            tokenAmount: BigInt(s.amount_usdt_units),
            otherNetwork: btqNetworkTag(s.btq_network),
            otherAsset: swapBindingAsset(s.id),
            otherAmount: BigInt(s.amount_sats),
          });
          return { agreementId: r.agreementId, txHash: r.txHash };
        });
      } else if (!isBuyer && s.status === 'awaiting_seller_lock' && !s.btq_lock_txid && s.btq_htlc_address) {
        await once(s, 'btq_lock', async () => {
          const txid = await btq.platformSend(s.btq_htlc_address!, BigInt(s.amount_sats), `swap ${s.short_id}`);
          return { txid, address: s.btq_htlc_address };
        });
      } else if (isBuyer && s.status === 'awaiting_buyer_claim' && s.btq_lock_txid && !s.btq_claim_txid) {
        // Waiting for safe evidence is not a broadcast attempt and must not consume the action key.
        const refusal = await platformClaimRefusal(s);
        if (refusal) {
          log.info(`swap #${s.short_id}: BTQ claim deferred`, { reason: refusal });
          continue;
        }
        const dest = await btq.platformAddress('swap-claims');
        await once(s, 'btq_claim', async () => {
          // Database and wallet RPC work above can cross the refund-height boundary.
          try {
            const refusal = await platformClaimRefusal(s);
            if (refusal) throw new DeferredAction(refusal);
          } catch (err) {
            throw new DeferredAction((err as Error).message);
          }
          const preimage = decryptSecret(s.platform_secret_enc!, config().PLATFORM_SECRET_KEY);
          const signed = buildClaimTx({
            htlc: htlcForSwap(s),
            outpoint: { txid: s.btq_lock_txid!, vout: s.btq_lock_vout!, valueSats: BigInt(s.btq_lock_sats!) },
            destination: dest,
            preimage: new Uint8Array(preimage),
            signer: platformHtlcSigner(),
            feeRateSatVb: config().BTQ_FEE_RATE_SAT_VB,
          });
          const txid = await btq.broadcast(signed.hex);
          return { txid, feeSats: signed.feeSats.toString(), to: dest };
        });
      } else if (!isBuyer && s.status === 'awaiting_seller_claim' && s.revealed_preimage && s.evm_agreement_id && !s.evm_claim_tx && s.settlement_rail === 'solana') {
        await once(s, 'solana_claim', async () => ({ signature: await platformSolana(s, 'withdraw') }));
      } else if (!isBuyer && s.status === 'awaiting_seller_claim' && s.revealed_preimage && s.evm_agreement_id && !s.evm_claim_tx) {
        await once(s, 'evm_claim', async () => ({ txHash: await evm.platformWithdraw(s.evm_agreement_id!, s.revealed_preimage!) }));
      } else if (!isBuyer && s.status === 'awaiting_refunds' && s.btq_lock_txid && !s.btq_claim_txid && !s.btq_refund_txid && tip >= (s.btq_refund_locktime ?? Infinity)) {
        await once(s, 'btq_refund', async () => {
          const dest = await btq.platformAddress('swap-refunds');
          const signed = buildRefundTx({
            htlc: htlcForSwap(s),
            outpoint: { txid: s.btq_lock_txid!, vout: s.btq_lock_vout!, valueSats: BigInt(s.btq_lock_sats!) },
            destination: dest,
            signer: platformHtlcSigner(),
            feeRateSatVb: config().BTQ_FEE_RATE_SAT_VB,
          });
          const txid = await btq.broadcast(signed.hex);
          return { txid, feeSats: signed.feeSats.toString(), to: dest };
        });
      } else if (
        isBuyer &&
        ['awaiting_buyer_refund', 'awaiting_refunds'].includes(s.status) &&
        s.evm_agreement_id && !s.evm_refund_tx && !s.evm_claim_tx &&
        s.evm_deadline && chainNow >= Math.floor(s.evm_deadline.getTime() / 1000) &&
        s.settlement_rail === 'solana'
      ) {
        await once(s, 'solana_refund', async () => ({ signature: await platformSolana(s, 'refund') }));
      } else if (
        isBuyer &&
        ['awaiting_buyer_refund', 'awaiting_refunds'].includes(s.status) &&
        s.evm_agreement_id && !s.evm_refund_tx && !s.evm_claim_tx &&
        s.evm_deadline && chainNow >= Math.floor(s.evm_deadline.getTime() / 1000)
      ) {
        await once(s, 'evm_refund', async () => ({ txHash: await evm.platformRefund(s.evm_agreement_id!) }));
      }
    } catch (err) {
      log.error(`swap #${s.short_id}: agent error`, { err: (err as Error).message });
    }
  }
}
