import { buildClaimTx, buildRefundTx, btqNetworkTag, swapBindingAsset } from '@btq-swap/htlc';
import { config } from '../config';
import { btqChain } from '../chains/btq';
import { evmChain } from '../chains/evm';
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
    log.error(`swap #${s.short_id}: ${kind} failed`, { err: (err as Error).message, attempt });
    await recordEvent(db(), s.id, 'platform_action_failed', { kind, attempt, error: (err as Error).message }, { actor: 'platform' });
  }
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
      if (isBuyer && s.status === 'awaiting_buyer_lock' && !s.evm_agreement_id) {
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
        await once(s, 'btq_claim', async () => {
          const preimage = decryptSecret(s.platform_secret_enc!, config().PLATFORM_SECRET_KEY);
          const dest = await btq.platformAddress('swap-claims');
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
        s.evm_deadline && chainNow >= Math.floor(s.evm_deadline.getTime() / 1000)
      ) {
        await once(s, 'evm_refund', async () => ({ txHash: await evm.platformRefund(s.evm_agreement_id!) }));
      }
    } catch (err) {
      log.error(`swap #${s.short_id}: agent error`, { err: (err as Error).message });
    }
  }
}
