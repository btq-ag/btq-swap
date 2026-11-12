import {
  btqNetworkTag,
  bytesToHex,
  computeAgreementId,
  createHtlc,
  hexToBytes,
  inspectHtlcSpend,
  newPreimage,
  parseSwapBindingAsset,
  sha256Bytes,
  type HtlcDescriptor,
} from '@btq-swap/htlc';
import { config, sellerTimeBudgetSec } from '../config';
import { encryptSecret } from '../lib/crypto';
import { db, many, one, tx, type Queryable } from '../lib/db';
import { createLogger } from '../lib/logger';
import { DomainError } from './errors';
import { instructionFor, usdtDisplay } from './instructions';
import { fromUnits, usdtUnitsFor } from './money';
import { enqueueNotification } from './outbox';
import { STATUS_LABEL, TERMINAL_STATUSES, type OrderRow, type Role, type SwapRow, type SwapStatus, type UserRow } from './types';

const log = createLogger('settlement');

// ─────────────────────────── helpers ───────────────────────────

export function htlcForSwap(s: Pick<SwapRow, 'btq_network' | 'secret_hash' | 'buyer_btq_pubkey' | 'seller_btq_pubkey' | 'btq_refund_locktime'>): HtlcDescriptor {
  if (!s.secret_hash || !s.btq_refund_locktime) throw new Error('swap has no HTLC parameters yet');
  return createHtlc(s.btq_network as never, {
    secretHash: hexToBytes(s.secret_hash),
    claimPubkey: hexToBytes(s.buyer_btq_pubkey),
    refundPubkey: hexToBytes(s.seller_btq_pubkey),
    refundLocktime: s.btq_refund_locktime,
  });
}

async function lockSwap(c: Queryable, swapId: string): Promise<SwapRow | null> {
  return one<SwapRow>(c, 'SELECT * FROM swaps WHERE id = $1 FOR UPDATE', [swapId]);
}

export async function getSwap(idOrShort: string | number, q: Queryable = db()): Promise<SwapRow | null> {
  const s = String(idOrShort).trim().replace(/^#/, '');
  if (/^\d+$/.test(s)) return one<SwapRow>(q, 'SELECT * FROM swaps WHERE short_id = $1', [s]);
  if (/^[0-9a-f-]{36}$/i.test(s)) return one<SwapRow>(q, 'SELECT * FROM swaps WHERE id = $1', [s]);
  return null;
}

export async function recordEvent(
  c: Queryable,
  swapId: string,
  eventType: string,
  metadata: Record<string, unknown> = {},
  opts: { from?: SwapStatus | null; to?: SwapStatus | null; actor?: string; actionKey?: string } = {},
): Promise<boolean> {
  const r = await c.query(
    `INSERT INTO swap_events (swap_id, from_status, to_status, event_type, actor, action_key, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (action_key) DO NOTHING`,
    [swapId, opts.from ?? null, opts.to ?? null, eventType, opts.actor ?? 'system', opts.actionKey ?? null, JSON.stringify(metadata, (_, v) => (typeof v === 'bigint' ? v.toString() : v))],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Claim an idempotency key for a side-effecting action. Returns false if it was already taken. */
export async function claimAction(swapId: string, actionKey: string, metadata: Record<string, unknown> = {}): Promise<boolean> {
  return recordEvent(db(), swapId, 'platform_action', metadata, { actor: 'platform', actionKey });
}

async function notifyStatus(c: Queryable, s: SwapRow): Promise<void> {
  const kind = s.status === 'completed' ? 'swap_completed' : s.status === 'expired' ? 'swap_expired' : s.status === 'refunded' ? 'swap_refunded' : s.status === 'failed' ? 'swap_failed' : 'action_required';
  for (const [role, userId] of [['buyer', s.buyer_user_id], ['seller', s.seller_user_id]] as Array<[Role, string]>) {
    const ins = instructionFor(s, role);
    await enqueueNotification(c, {
      userId,
      swapId: s.id,
      kind,
      dedupeKey: `${kind}:${s.id}:${userId}:${s.status}`,
      payload: {
        title: `Swap #${s.short_id} — ${STATUS_LABEL[s.status]}`,
        body: `${ins.actionable ? '**Your move:** ' : ''}${ins.headline}\n${ins.detail}`,
        swapShortId: s.short_id,
        status: s.status,
        commands: ins.commands,
      },
    });
  }
}

/**
 * Guarded state transition. Returns the updated row, or null when the swap is not in an allowed
 * state (callers treat that as an idempotent no-op).
 */
export async function transition(
  c: Queryable,
  swapId: string,
  from: readonly SwapStatus[],
  to: SwapStatus,
  eventType: string,
  updates: Record<string, unknown> = {},
  metadata: Record<string, unknown> = {},
  actor = 'system',
): Promise<SwapRow | null> {
  const cur = await lockSwap(c, swapId);
  if (!cur || !from.includes(cur.status)) return null;
  const sets = ['status = $2', 'updated_at = now()'];
  const vals: unknown[] = [swapId, to];
  for (const [k, v] of Object.entries(updates)) {
    if (!/^[a-z_]+$/.test(k)) throw new Error(`bad column ${k}`);
    vals.push(v);
    sets.push(`${k} = $${vals.length}`);
  }
  if (TERMINAL_STATUSES.includes(to)) sets.push('completed_at = now()');
  const updated = await one<SwapRow>(c, `UPDATE swaps SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);
  await recordEvent(c, swapId, eventType, metadata, { from: cur.status, to, actor });
  if (updated && cur.status !== to) await notifyStatus(c, updated);
  log.info(`swap #${cur.short_id} ${cur.status} → ${to} (${eventType})`);
  return updated;
}

async function patch(c: Queryable, swapId: string, updates: Record<string, unknown>): Promise<SwapRow | null> {
  const sets = ['updated_at = now()'];
  const vals: unknown[] = [swapId];
  for (const [k, v] of Object.entries(updates)) {
    if (!/^[a-z_]+$/.test(k)) throw new Error(`bad column ${k}`);
    vals.push(v);
    sets.push(`${k} = $${vals.length}`);
  }
  return one<SwapRow>(c, `UPDATE swaps SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);
}

// ─────────────────────────── match → swap ───────────────────────────

export interface FillInput {
  makerOrder: OrderRow;
  takerOrder: OrderRow;
  maker: UserRow;
  taker: UserRow;
  fillSats: bigint;
  priceUsdt: string;
  evm: { chainId: number; htlc: string; token: string };
}

export async function createSwapForFill(c: Queryable, f: FillInput): Promise<SwapRow | null> {
  const takerBuys = f.takerOrder.side === 'buy';
  const buyer = takerBuys ? f.taker : f.maker;
  const seller = takerBuys ? f.maker : f.taker;
  if (!buyer.eth_address || !seller.eth_address || !buyer.dilithium_pubkey || !seller.dilithium_pubkey) {
    throw new DomainError('LINK_REQUIRED', 'both parties must have linked wallets');
  }
  const units = usdtUnitsFor(f.fillSats, f.priceUsdt, config().USDT_DECIMALS);
  if (units <= 0n) return null;

  let secretHash: string | null = null;
  let platformSecret: string | null = null;
  if (buyer.is_platform) {
    const p = newPreimage();
    secretHash = p.secretHashHex;
    platformSecret = encryptSecret(Buffer.from(p.preimage), config().PLATFORM_SECRET_KEY);
  }

  const swap = await one<SwapRow>(
    c,
    `INSERT INTO swaps (
       maker_order_id, taker_order_id, maker_user_id, taker_user_id, buyer_user_id, seller_user_id, status,
       amount_btq, amount_sats, price_usdt, amount_usdt, amount_usdt_units,
       buyer_eth, seller_eth, buyer_btq_pubkey, seller_btq_pubkey, buyer_btq_address, seller_btq_address,
       secret_hash, platform_secret_enc, evm_chain_id, evm_htlc_contract, evm_token, btq_network, buyer_lock_by
     ) VALUES ($1,$2,$3,$4,$5,$6,'awaiting_buyer_lock',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23, now() + ($24::text || ' seconds')::interval)
     RETURNING *`,
    [
      f.makerOrder.id, f.takerOrder.id, f.maker.id, f.taker.id, buyer.id, seller.id,
      fromUnits(f.fillSats, 8), f.fillSats.toString(), f.priceUsdt, fromUnits(units, config().USDT_DECIMALS), units.toString(),
      buyer.eth_address.toLowerCase(), seller.eth_address.toLowerCase(), buyer.dilithium_pubkey, seller.dilithium_pubkey, buyer.btq_address, seller.btq_address,
      secretHash, platformSecret, f.evm.chainId, f.evm.htlc.toLowerCase(), f.evm.token.toLowerCase(), config().BTQ_NETWORK, String(config().SWAP_BUYER_LOCK_WINDOW_SEC),
    ],
  );
  await recordEvent(c, swap!.id, 'matched', {
    makerOrder: f.makerOrder.short_id,
    takerOrder: f.takerOrder.short_id,
    fillBtq: swap!.amount_btq,
    price: f.priceUsdt,
    usdt: swap!.amount_usdt,
    buyerIsPlatform: buyer.is_platform,
    sellerIsPlatform: seller.is_platform,
  }, { to: 'awaiting_buyer_lock' });
  await notifyStatus(c, swap!);
  return swap;
}

// ─────────────────────────── EVM leg ───────────────────────────

export interface LockupObservation {
  agreementId: string;
  txHash: string;
  blockNumber: number;
  partyA: string;
  partyB: string;
  secretlock: string;
  deadline: number;
  erc20Contract: string;
  tokenAmount: bigint;
  otherNetwork: string;
  otherAsset: string;
  otherAmount: bigint;
}

export function validateLockup(s: SwapRow, ev: LockupObservation, nowSec: number): string | null {
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (!eq(ev.partyA, s.buyer_eth)) return `partyA ${ev.partyA} is not the buyer ${s.buyer_eth}`;
  if (!eq(ev.partyB, s.seller_eth)) return `partyB ${ev.partyB} is not the seller ${s.seller_eth}`;
  if (!eq(ev.erc20Contract, s.evm_token)) return 'wrong token contract';
  if (ev.tokenAmount < BigInt(s.amount_usdt_units)) return `amount ${ev.tokenAmount} < required ${s.amount_usdt_units}`;
  if (ev.otherNetwork !== btqNetworkTag(s.btq_network)) return `otherNetwork must be ${btqNetworkTag(s.btq_network)}`;
  if (ev.otherAmount !== BigInt(s.amount_sats)) return `otherAmount must be ${s.amount_sats}`;
  if (!/^0x[0-9a-f]{64}$/.test(ev.secretlock)) return 'invalid secretlock';
  const remaining = ev.deadline - nowSec;
  const needed = sellerTimeBudgetSec() + 60;
  if (remaining < needed) return `deadline leaves ${remaining}s, need at least ${needed}s`;
  if (remaining > config().SWAP_EVM_LOCK_MAX_DURATION_SEC + 120) return `deadline is too far in the future (${remaining}s)`;
  if (s.secret_hash && s.secret_hash !== ev.secretlock.slice(2)) return 'secretlock does not match the platform secret';
  const recomputed = computeAgreementId({ ...ev });
  if (recomputed !== ev.agreementId.toLowerCase()) return 'agreement id mismatch';
  return null;
}

export async function onEvmLockup(ev: LockupObservation, headBlock: number, nowSec: number): Promise<void> {
  const swapId = parseSwapBindingAsset(ev.otherAsset);
  if (!swapId) return;
  await tx(async (c) => {
    const s = await lockSwap(c, swapId);
    if (!s) return;
    if (s.evm_agreement_id) {
      if (s.evm_agreement_id !== ev.agreementId.toLowerCase()) {
        await recordEvent(c, s.id, 'evm_lock_ignored', { reason: 'swap already has a lock', agreementId: ev.agreementId, txHash: ev.txHash });
      }
      return;
    }
    if (s.status !== 'awaiting_buyer_lock') {
      await recordEvent(c, s.id, 'evm_lock_ignored', { reason: `swap is ${s.status}`, agreementId: ev.agreementId, txHash: ev.txHash });
      await enqueueNotification(c, {
        userId: s.buyer_user_id,
        swapId: s.id,
        kind: 'info',
        dedupeKey: `late_lock:${ev.agreementId}`,
        payload: { title: `Swap #${s.short_id}: lock not accepted`, body: `Your USDT lock arrived while the swap was ${STATUS_LABEL[s.status]}. Refund it after its deadline with \`btq-htlc evm refund\`.` },
      });
      return;
    }
    const problem = validateLockup(s, ev, nowSec);
    if (problem) {
      await recordEvent(c, s.id, 'evm_lock_rejected', { reason: problem, agreementId: ev.agreementId, txHash: ev.txHash });
      await enqueueNotification(c, {
        userId: s.buyer_user_id,
        swapId: s.id,
        kind: 'info',
        dedupeKey: `rejected_lock:${ev.agreementId}`,
        payload: { title: `Swap #${s.short_id}: USDT lock rejected`, body: `Reason: ${problem}. Refund that lock after its deadline; you can still lock correctly before the swap window closes.` },
      });
      return;
    }
    const confs = Math.max(0, headBlock - ev.blockNumber + 1);
    const updated = await transition(c, s.id, ['awaiting_buyer_lock'], 'buyer_lock_confirming', 'evm_locked', {
      secret_hash: ev.secretlock.slice(2),
      evm_agreement_id: ev.agreementId.toLowerCase(),
      evm_lock_tx: ev.txHash,
      evm_lock_block: ev.blockNumber,
      evm_deadline: new Date(ev.deadline * 1000),
      evm_lock_confs: confs,
    }, { agreementId: ev.agreementId, txHash: ev.txHash, deadline: ev.deadline, amount: ev.tokenAmount.toString() });
    if (updated && confs >= config().EVM_MIN_CONFIRMATIONS) await enterAwaitingSellerLock(c, updated, null);
  });
}

/** Called each tick for buyer_lock_confirming swaps. */
export async function onEvmLockConfirmations(swapId: string, confs: number, btqTip: number): Promise<void> {
  await tx(async (c) => {
    const s = await lockSwap(c, swapId);
    if (!s || s.status !== 'buyer_lock_confirming') return;
    if (confs !== s.evm_lock_confs) await patch(c, s.id, { evm_lock_confs: confs });
    if (confs >= config().EVM_MIN_CONFIRMATIONS) await enterAwaitingSellerLock(c, { ...s, evm_lock_confs: confs }, btqTip);
  });
}

async function enterAwaitingSellerLock(c: Queryable, s: SwapRow, btqTip: number | null): Promise<void> {
  const tip = btqTip ?? (await currentBtqTip());
  const deadlineMs = s.evm_deadline!.getTime();
  const sellerBy = Math.min(Date.now() + config().SWAP_SELLER_LOCK_WINDOW_SEC * 1000, deadlineMs - sellerTimeBudgetSec() * 1000);
  if (sellerBy - Date.now() < 30_000) {
    await transition(c, s.id, ['buyer_lock_confirming'], 'awaiting_buyer_refund', 'seller_time_budget_exhausted', { failure_reason: 'not enough time left on the USDT lock for the seller to lock safely' });
    return;
  }
  const locktime = tip + config().SWAP_BTQ_LOCK_BLOCKS;
  const htlc = htlcForSwap({ ...s, btq_refund_locktime: locktime });
  await transition(c, s.id, ['buyer_lock_confirming'], 'awaiting_seller_lock', 'evm_lock_confirmed', {
    evm_lock_confs: s.evm_lock_confs,
    btq_refund_locktime: locktime,
    btq_htlc_address: htlc.address,
    btq_htlc_spk: bytesToHex(htlc.scriptPubKey),
    seller_lock_by: new Date(sellerBy),
  }, { htlcAddress: htlc.address, refundLocktime: locktime, tip });
}

let tipProvider: (() => Promise<number>) | null = null;
export function setBtqTipProvider(fn: () => Promise<number>): void {
  tipProvider = fn;
}
async function currentBtqTip(): Promise<number> {
  if (!tipProvider) throw new Error('BTQ tip provider not set');
  return tipProvider();
}

export async function onEvmClaimed(agreementId: string, txHash: string, key: string): Promise<void> {
  await tx(async (c) => {
    const s = await one<SwapRow>(c, 'SELECT * FROM swaps WHERE evm_agreement_id = $1 FOR UPDATE', [agreementId.toLowerCase()]);
    if (!s || s.evm_claim_tx) return;
    const keyHex = key.replace(/^0x/, '').toLowerCase();
    if (!s.secret_hash || bytesToHex(sha256Bytes(hexToBytes(keyHex))) !== s.secret_hash) {
      await recordEvent(c, s.id, 'evm_claim_mismatch', { txHash });
      return;
    }
    const from = s.status;
    if (TERMINAL_STATUSES.includes(from)) {
      await patch(c, s.id, { evm_claim_tx: txHash });
      await recordEvent(c, s.id, 'evm_claimed_late', { txHash });
      return;
    }
    await transition(c, s.id, [from], 'completed', 'evm_claimed', { evm_claim_tx: txHash, revealed_preimage: s.revealed_preimage ?? keyHex }, { txHash });
  });
}

export async function onEvmRefunded(agreementId: string, txHash: string): Promise<void> {
  await tx(async (c) => {
    const s = await one<SwapRow>(c, 'SELECT * FROM swaps WHERE evm_agreement_id = $1 FOR UPDATE', [agreementId.toLowerCase()]);
    if (!s || s.evm_refund_tx) return;
    const updates = { evm_refund_tx: txHash };
    switch (s.status) {
      case 'awaiting_buyer_refund':
      case 'buyer_lock_confirming':
      case 'awaiting_seller_lock':
        await transition(c, s.id, [s.status], 'refunded', 'evm_refunded', updates, { txHash });
        return;
      case 'awaiting_refunds':
        if (!s.btq_lock_txid || s.btq_refund_txid) await transition(c, s.id, ['awaiting_refunds'], 'refunded', 'evm_refunded', updates, { txHash });
        else {
          await patch(c, s.id, updates);
          await recordEvent(c, s.id, 'evm_refunded', { txHash });
        }
        return;
      case 'awaiting_seller_claim':
        await transition(c, s.id, ['awaiting_seller_claim'], 'failed', 'evm_refunded_before_seller_claim', { ...updates, failure_reason: 'seller did not withdraw USDT before the deadline' }, { txHash });
        return;
      default:
        await patch(c, s.id, updates);
        await recordEvent(c, s.id, 'evm_refunded', { txHash, status: s.status });
    }
  });
}

// ─────────────────────────── BTQ leg ───────────────────────────

export async function onBtqLockOutput(swapId: string, o: { txid: string; vout: number; sats: bigint; height: number | null }, tip: number): Promise<void> {
  await tx(async (c) => {
    const s = await lockSwap(c, swapId);
    if (!s) return;
    if (s.btq_lock_txid) {
      if (s.btq_lock_txid === o.txid && s.btq_lock_vout === o.vout && o.height && !s.btq_lock_height) {
        await patch(c, s.id, { btq_lock_height: o.height });
      }
      return;
    }
    if (s.status !== 'awaiting_seller_lock') {
      await recordEvent(c, s.id, 'btq_lock_ignored', { reason: `swap is ${s.status}`, txid: o.txid, vout: o.vout });
      await enqueueNotification(c, {
        userId: s.seller_user_id,
        swapId: s.id,
        kind: 'info',
        dedupeKey: `late_btq:${o.txid}:${o.vout}`,
        payload: { title: `Swap #${s.short_id}: BTQ lock not accepted`, body: `Your BTQ arrived while the swap was ${STATUS_LABEL[s.status]}. Refund it after block ${s.btq_refund_locktime} with \`btq-htlc refund\`.` },
      });
      return;
    }
    if (o.sats < BigInt(s.amount_sats)) {
      await recordEvent(c, s.id, 'btq_lock_rejected', { reason: `amount ${o.sats} < ${s.amount_sats}`, txid: o.txid, vout: o.vout });
      return;
    }
    const confs = o.height ? tip - o.height + 1 : 0;
    const updated = await transition(c, s.id, ['awaiting_seller_lock'], 'seller_lock_confirming', 'btq_locked', {
      btq_lock_txid: o.txid,
      btq_lock_vout: o.vout,
      btq_lock_sats: o.sats.toString(),
      btq_lock_height: o.height,
      btq_lock_confs: Math.max(0, confs),
    }, { txid: o.txid, vout: o.vout, sats: o.sats.toString() });
    if (updated && confs >= config().BTQ_MIN_CONFIRMATIONS) {
      await transition(c, s.id, ['seller_lock_confirming'], 'awaiting_buyer_claim', 'btq_lock_confirmed', { btq_lock_confs: confs }, { confs });
    }
  });
}

export async function onBtqLockConfirmations(swapId: string, height: number | null, tip: number): Promise<void> {
  await tx(async (c) => {
    const s = await lockSwap(c, swapId);
    if (!s || s.status !== 'seller_lock_confirming') return;
    const h = height ?? s.btq_lock_height;
    const confs = h ? tip - h + 1 : 0;
    if (h !== s.btq_lock_height || confs !== s.btq_lock_confs) await patch(c, s.id, { btq_lock_height: h, btq_lock_confs: Math.max(0, confs) });
    if (confs >= config().BTQ_MIN_CONFIRMATIONS) {
      await transition(c, s.id, ['seller_lock_confirming'], 'awaiting_buyer_claim', 'btq_lock_confirmed', { btq_lock_confs: confs }, { confs });
    }
  });
}

export async function onBtqSpend(swapId: string, rawHex: string, spendTxid: string): Promise<void> {
  await tx(async (c) => {
    const s = await lockSwap(c, swapId);
    if (!s || !s.btq_lock_txid || s.btq_lock_vout === null) return;
    const info = inspectHtlcSpend(rawHex, { txid: s.btq_lock_txid, vout: s.btq_lock_vout }, htlcForSwap(s));
    if (!info) return;
    if (info.kind === 'claim' && !s.btq_claim_txid) {
      const preimage = bytesToHex(info.preimage!);
      if (bytesToHex(sha256Bytes(info.preimage!)) !== s.secret_hash) return; // inspect already checks; belt and braces
      if (['seller_lock_confirming', 'awaiting_buyer_claim', 'awaiting_refunds'].includes(s.status)) {
        await transition(c, s.id, [s.status], 'awaiting_seller_claim', 'btq_claimed', { btq_claim_txid: spendTxid, revealed_preimage: preimage }, { txid: spendTxid });
      } else {
        await patch(c, s.id, { btq_claim_txid: spendTxid, revealed_preimage: s.revealed_preimage ?? preimage });
        await recordEvent(c, s.id, 'btq_claimed', { txid: spendTxid, status: s.status });
      }
      return;
    }
    if (info.kind === 'refund' && !s.btq_refund_txid) {
      if (s.status === 'awaiting_refunds' && (s.evm_refund_tx || !s.evm_agreement_id)) {
        await transition(c, s.id, ['awaiting_refunds'], 'refunded', 'btq_refunded', { btq_refund_txid: spendTxid }, { txid: spendTxid });
      } else {
        await patch(c, s.id, { btq_refund_txid: spendTxid });
        await recordEvent(c, s.id, 'btq_refunded', { txid: spendTxid, status: s.status });
      }
    }
  });
}

// ─────────────────────────── deadlines ───────────────────────────

export async function runDeadlines(tip: number, nowMs = Date.now()): Promise<number> {
  let changed = 0;
  const due = await many<SwapRow>(
    db(),
    `SELECT * FROM swaps WHERE
       (status = 'awaiting_buyer_lock' AND buyer_lock_by < to_timestamp($1 / 1000.0))
    OR (status = 'awaiting_seller_lock' AND seller_lock_by < to_timestamp($1 / 1000.0))
    OR (status IN ('awaiting_buyer_claim', 'seller_lock_confirming') AND btq_refund_locktime <= $2)`,
    [nowMs, tip],
  );
  for (const s of due) {
    await tx(async (c) => {
      if (s.status === 'awaiting_buyer_lock') {
        const r = await transition(c, s.id, ['awaiting_buyer_lock'], 'expired', 'buyer_lock_window_passed', { failure_reason: 'buyer did not lock USDT in time' });
        if (r) {
          changed++;
          await c.query('UPDATE users SET no_show_count = no_show_count + 1 WHERE id = $1 AND is_platform = false', [s.buyer_user_id]);
        }
      } else if (s.status === 'awaiting_seller_lock') {
        const r = await transition(c, s.id, ['awaiting_seller_lock'], 'awaiting_buyer_refund', 'seller_lock_window_passed', { failure_reason: 'seller did not lock BTQ in time' });
        if (r) {
          changed++;
          await c.query('UPDATE users SET no_show_count = no_show_count + 1 WHERE id = $1 AND is_platform = false', [s.seller_user_id]);
        }
      } else {
        const r = await transition(c, s.id, ['awaiting_buyer_claim', 'seller_lock_confirming'], 'awaiting_refunds', 'btq_timelock_reached', { failure_reason: 'buyer did not claim BTQ before the timelock' }, { tip });
        if (r) changed++;
      }
    });
  }
  return changed;
}

// ─────────────────────────── queries ───────────────────────────

export async function swapsForUser(userId: string, opts: { activeOnly?: boolean; limit?: number } = {}): Promise<SwapRow[]> {
  return many<SwapRow>(
    db(),
    `SELECT * FROM swaps WHERE (buyer_user_id = $1 OR seller_user_id = $1)
       ${opts.activeOnly ? `AND status NOT IN ('completed','expired','refunded','failed')` : ''}
     ORDER BY created_at DESC LIMIT $2`,
    [userId, opts.limit ?? 25],
  );
}

/** Only the two parties (or an admin) may read a swap through user-facing surfaces. */
export async function swapForUser(userId: string, idOrShort: string | number): Promise<{ swap: SwapRow; role: Role }> {
  const s = await getSwap(idOrShort);
  if (!s) throw new DomainError('NOT_FOUND', 'No swap with that id.');
  const role: Role | null = s.buyer_user_id === userId ? 'buyer' : s.seller_user_id === userId ? 'seller' : null;
  if (!role) throw new DomainError('NOT_FOUND', 'No swap with that id.');
  return { swap: s, role };
}

export async function swapEvents(swapId: string, limit = 100): Promise<Array<{ id: string; event_type: string; from_status: string | null; to_status: string | null; actor: string; metadata: Record<string, unknown>; created_at: Date }>> {
  return many(db(), 'SELECT id, event_type, from_status, to_status, actor, metadata, created_at FROM swap_events WHERE swap_id = $1 ORDER BY id ASC LIMIT $2', [swapId, limit]);
}

/** A user may tell us their BTQ lock txid to speed up detection; we verify it on-chain via the watcher path. */
export async function hintBtqLock(userId: string, idOrShort: string, txid: string): Promise<SwapRow> {
  const { swap, role } = await swapForUser(userId, idOrShort);
  if (role !== 'seller') throw new DomainError('FORBIDDEN', 'Only the seller locks BTQ.');
  if (!/^[0-9a-f]{64}$/i.test(txid.trim())) throw new DomainError('VALIDATION', 'That is not a BTQ transaction id.');
  await recordEvent(db(), swap.id, 'btq_lock_hint', { txid: txid.trim().toLowerCase() }, { actor: `user:${userId}` });
  return swap;
}

export function summaryLine(s: SwapRow): string {
  return `#${s.short_id} · ${s.amount_btq} BTQ ⇄ ${usdtDisplay(s)} USDT @ ${s.price_usdt} · ${STATUS_LABEL[s.status]}`;
}
