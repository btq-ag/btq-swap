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
  UUID_RE,
  type HtlcDescriptor,
  toRecord,
} from '@btq-swap/htlc';
import { config, sellerTimeBudgetSec } from '../config';
import { encryptSecret } from '../lib/crypto';
import { db, many, one, tx, type Queryable } from '../lib/db';
import { createLogger } from '../lib/logger';
import { DomainError } from './errors';
import { hashOwnerConflict, rememberLock } from './funding';
import { getSettings } from './settings';
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
  if (UUID_RE.test(s)) return one<SwapRow>(q, 'SELECT * FROM swaps WHERE id = $1', [s]);
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
      dedupeKey: `${kind}:${s.id}:${userId}:${s.status}:${s.state_revision}`,
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
  const sets = ['status = $2', 'updated_at = now()', 'state_revision = state_revision + 1'];
  const vals: unknown[] = [swapId, to];
  for (const [k, v] of Object.entries(updates)) {
    if (!/^[a-z_]+$/.test(k)) throw new Error(`bad column ${k}`);
    vals.push(v);
    sets.push(`${k} = $${vals.length}`);
  }
  sets.push(TERMINAL_STATUSES.includes(to) ? 'completed_at = now()' : 'completed_at = NULL');
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

/** Recompute settlement from surviving evidence instead of restoring a stale cross-chain status snapshot. */
async function reconcileEvidence(c: Queryable, s: SwapRow, updates: Record<string, unknown>, event: string, btqTip?: number): Promise<void> {
  const next = { ...s, ...updates } as SwapRow;
  const refundOpen = next.btq_refund_locktime !== null && (btqTip ?? await currentBtqTip()) >= next.btq_refund_locktime;
  let status: SwapStatus;
  if (next.evm_claim_tx && next.btq_claim_txid) status = 'completed';
  else if ((next.evm_refund_tx && next.btq_claim_txid) || (next.evm_claim_tx && next.btq_refund_txid)) status = 'failed';
  else if (next.evm_refund_tx && (!next.btq_lock_txid || next.btq_refund_txid)) status = 'refunded';
  else if (next.revealed_preimage && !next.evm_claim_tx && !next.evm_refund_tx && !next.btq_refund_txid && (!refundOpen || !!next.btq_claim_txid) && next.evm_deadline && next.evm_deadline.getTime() > Date.now()) status = 'awaiting_seller_claim';
  else if (next.btq_refund_txid || next.evm_refund_tx || refundOpen || (!next.evm_claim_tx && next.evm_deadline && next.evm_deadline.getTime() <= Date.now())) status = 'awaiting_refunds';
  else if (next.revealed_preimage) status = 'awaiting_seller_claim';
  else if (next.evm_lock_confs < config().EVM_MIN_CONFIRMATIONS) status = next.evm_deadline && next.evm_deadline.getTime() - (sellerTimeBudgetSec() + 30) * 1000 <= Date.now() ? (next.btq_lock_txid ? 'awaiting_refunds' : 'awaiting_buyer_refund') : 'buyer_lock_confirming';
  else if (next.btq_lock_txid) status = next.btq_lock_confs >= config().BTQ_MIN_CONFIRMATIONS ? 'awaiting_buyer_claim' : 'seller_lock_confirming';
  else status = next.seller_lock_by && next.seller_lock_by.getTime() <= Date.now() ? 'awaiting_buyer_refund' : 'awaiting_seller_lock';
  if (status === s.status) await patch(c, s.id, updates);
  else await transition(c, s.id, [s.status], status, event, { ...updates, failure_reason: status === 'failed' ? 'the two chains settled different outcomes' : null });
}

async function releaseRecoveryAction(c: Queryable, s: SwapRow, kind: string): Promise<void> {
  // Keep the audit record, but permit a new attempt after a previously observed transaction disappears.
  await c.query(`UPDATE swap_events SET action_key = NULL WHERE swap_id = $1 AND event_type = 'platform_action' AND metadata->>'kind' = $2`, [s.id, kind]);
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
  const rail = (await getSettings(c)).settlement_rail;
  if (rail === 'solana') {
    if (!buyer.sol_address || !seller.sol_address || !buyer.dilithium_pubkey || !seller.dilithium_pubkey) {
      throw new DomainError('LINK_REQUIRED', 'both parties must have linked Solana and BTQ wallets');
    }
    if (!config().SOLANA_HTLC_PROGRAM_ID || !config().SOLANA_TOKEN_MINT) {
      throw new DomainError('VALIDATION', 'The Solana rail is not configured.');
    }
  } else if (!buyer.eth_address || !seller.eth_address || !buyer.dilithium_pubkey || !seller.dilithium_pubkey) {
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
       secret_hash, platform_secret_enc, evm_chain_id, evm_htlc_contract, evm_token, btq_network, buyer_lock_by,
       settlement_rail, buyer_sol, seller_sol
     ) VALUES ($1,$2,$3,$4,$5,$6,'awaiting_buyer_lock',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23, now() + ($24::text || ' seconds')::interval,$25,$26,$27)
     RETURNING *`,
    [
      f.makerOrder.id, f.takerOrder.id, f.maker.id, f.taker.id, buyer.id, seller.id,
      fromUnits(f.fillSats, 8), f.fillSats.toString(), f.priceUsdt, fromUnits(units, config().USDT_DECIMALS), units.toString(),
      (buyer.eth_address ?? buyer.sol_address ?? '').toLowerCase(), (seller.eth_address ?? seller.sol_address ?? '').toLowerCase(), buyer.dilithium_pubkey, seller.dilithium_pubkey, buyer.btq_address, seller.btq_address,
      secretHash, platformSecret,
      rail === 'solana' ? 0 : f.evm.chainId,
      rail === 'solana' ? config().SOLANA_HTLC_PROGRAM_ID : f.evm.htlc.toLowerCase(),
      rail === 'solana' ? config().SOLANA_TOKEN_MINT : f.evm.token.toLowerCase(),
      config().BTQ_NETWORK, String(config().SWAP_BUYER_LOCK_WINDOW_SEC),
      rail, buyer.sol_address, seller.sol_address,
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
  blockHash?: string;
  blockTimestamp?: number;
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
    if (s.settlement_rail !== 'evm') return;
    if (s.evm_agreement_id === ev.agreementId.toLowerCase()) {
      const updated = await patch(c, s.id, { evm_lock_tx: ev.txHash, evm_lock_block: ev.blockNumber,
        evm_lock_block_hash: ev.blockHash ?? null, evm_lock_confs: Math.max(0, headBlock - ev.blockNumber + 1) });
      if (updated!.status === 'buyer_lock_confirming' && updated!.evm_lock_confs >= config().EVM_MIN_CONFIRMATIONS) await enterAwaitingSellerLock(c, updated!, null);
      return;
    }
    const timely = (ev.blockTimestamp ?? nowSec) * 1000 <= s.buyer_lock_by.getTime();
    let problem = s.evm_agreement_id ? 'swap already has a lock' :
      !timely ? 'buyer lock window has closed' :
      !['awaiting_buyer_lock', 'expired'].includes(s.status) ? `swap is ${s.status}` : validateLockup(s, ev, nowSec);
    // An underpaid/rejected escrow can still disclose its preimage. Never reuse its hash for a new lock.
    // Only the bound buyer can reserve this swap's hash; an outsider's mislabeled transfer cannot claim it.
    if (ev.partyA.toLowerCase() === s.buyer_eth.toLowerCase() && await hashOwnerConflict(c, ev.secretlock.slice(2), s, ev.agreementId)) problem = 'secret hash was already used by another lock';
    // Keep the typed recovery fields; arbitrary on-chain labels can contain text PostgreSQL rejects.
    await rememberLock(c, s, 'evm', ev.agreementId, { agreementId: ev.agreementId, txHash: ev.txHash,
      blockNumber: ev.blockNumber, partyA: ev.partyA, partyB: ev.partyB, erc20Contract: ev.erc20Contract,
      secretHash: ev.secretlock, deadline: ev.deadline, tokenAmount: ev.tokenAmount.toString() }, problem);
    if (problem) {
      const fresh = await recordEvent(c, s.id, 'evm_lock_rejected', { reason: problem, agreementId: ev.agreementId, txHash: ev.txHash }, { actionKey: `rejected_evm:${s.id}:${ev.agreementId}` });
      if (fresh) await enqueueNotification(c, {
        userId: s.buyer_user_id, swapId: s.id, kind: 'info', dedupeKey: `rejected_lock:${ev.agreementId}`,
        payload: { title: `Swap #${s.short_id}: USDT lock rejected`, body: `Reason: ${problem}. Refund after its deadline with \`btq-htlc evm refund --swap ${s.short_id} --agreement-id ${ev.agreementId}\`.` },
      });
      return;
    }
    const confs = Math.max(0, headBlock - ev.blockNumber + 1);
    if (s.status === 'expired') await c.query('UPDATE users SET no_show_count = GREATEST(0, no_show_count - 1) WHERE id = $1', [s.buyer_user_id]);
    const updated = await transition(c, s.id, ['awaiting_buyer_lock', 'expired'], 'buyer_lock_confirming', 'evm_locked', {
      secret_hash: ev.secretlock.slice(2),
      evm_agreement_id: ev.agreementId.toLowerCase(),
      evm_lock_tx: ev.txHash,
      evm_lock_block: ev.blockNumber,
      evm_lock_block_hash: ev.blockHash ?? null,
      evm_deadline: new Date(ev.deadline * 1000),
      evm_lock_confs: confs,
    }, { agreementId: ev.agreementId, txHash: ev.txHash, deadline: ev.deadline, amount: ev.tokenAmount.toString() });
    if (updated && confs >= config().EVM_MIN_CONFIRMATIONS) await enterAwaitingSellerLock(c, updated, null);
  });
}

export interface SolanaLockObservation {
  partyA: string;
  partyB: string;
  mint: string;
  secretHashHex: string;
  deadline: number;
  amount: bigint;
  withdrawn: boolean;
  refunded: boolean;
  preimageHex: string;
  agreementHex: string;
  signature: string | null;
  lockTime: number;
  settlementSignature: string | null;
}

/**
 * The Solana escrow address is derived from the locked amount, and every later withdraw or refund
 * is built from the swap's amount. The amounts must match exactly, or the seller's claim targets
 * an escrow that does not exist.
 */
export function validateSolanaLock(s: Pick<SwapRow, 'amount_usdt_units' | 'secret_hash'>, input: Pick<SolanaLockObservation, 'amount' | 'deadline' | 'secretHashHex'>, nowSec: number): string | null {
  if (input.amount !== BigInt(s.amount_usdt_units)) return `amount ${input.amount} must equal ${s.amount_usdt_units}`;
  const remaining = input.deadline - nowSec;
  const needed = sellerTimeBudgetSec() + 60;
  if (remaining < needed) return `deadline leaves ${remaining}s, need at least ${needed}s`;
  if (remaining > config().SWAP_EVM_LOCK_MAX_DURATION_SEC + 120) return `deadline is too far in the future (${remaining}s)`;
  if (s.secret_hash && s.secret_hash !== input.secretHashHex) return 'secret hash does not match the platform secret';
  return null;
}

export async function observeSolanaAccount(swapId: string, input: SolanaLockObservation, q?: Queryable): Promise<void> {
  const apply = async (c: Queryable) => {
    const s = await lockSwap(c, swapId);
    if (!s || s.settlement_rail !== 'solana' || s.buyer_sol !== input.partyA || s.seller_sol !== input.partyB || s.evm_token !== input.mint) return;
    if (s.evm_agreement_id && s.evm_agreement_id !== input.agreementHex) return;
    const updates: Record<string, unknown> = { secret_hash: input.secretHashHex, evm_agreement_id: input.agreementHex,
      evm_lock_tx: input.signature, evm_deadline: new Date(input.deadline * 1000), evm_lock_confs: config().EVM_MIN_CONFIRMATIONS };
    if (!s.evm_agreement_id) {
      let problem = validateSolanaLock(s, input, input.lockTime);
      if (input.lockTime * 1000 > s.buyer_lock_by.getTime()) problem = 'buyer lock window has closed';
      if (await hashOwnerConflict(c, input.secretHashHex, s, input.agreementHex)) {
        await rememberLock(c, s, 'solana', input.agreementHex, { ...input, amount: input.amount.toString() }, 'secret hash was already used by another lock');
        await recordEvent(c, s.id, 'solana_lock_rejected', { agreementId: input.agreementHex, reason: 'secret hash was already used by another lock' }, { actionKey: `solana_rejected:${s.id}:${input.agreementHex}` });
        return;
      }
      await rememberLock(c, s, 'solana', input.agreementHex, { ...input, amount: input.amount.toString() }, problem);
      // Even an expired/rejected escrow remains bound and recoverable by its buyer.
      if (problem) updates.failure_reason = problem;
      if (input.refunded || input.withdrawn) {
        // Apply both finalized legs atomically: never ask for BTQ funding for a historical spent escrow.
      } else if (problem || input.deadline * 1000 - (sellerTimeBudgetSec() + 30) * 1000 <= Date.now()) {
        await transition(c, s.id, [s.status], 'awaiting_buyer_refund', 'solana_lock_rejected', updates); return;
      } else {
        if (s.status === 'expired') await c.query('UPDATE users SET no_show_count=GREATEST(0,no_show_count-1) WHERE id=$1',[s.buyer_user_id]);
        const updated = await transition(c, s.id, [s.status], 'buyer_lock_confirming', 'solana_locked', updates);
        if (updated) await enterAwaitingSellerLock(c, updated, null);
        return;
      }
    }
    if (!input.withdrawn && !input.refunded) { await patch(c, s.id, updates); return; }
    if (input.withdrawn && input.settlementSignature && /^[0-9a-f]{64}$/.test(input.preimageHex) && bytesToHex(sha256Bytes(hexToBytes(input.preimageHex))) === input.secretHashHex) {
      updates.evm_claim_tx = input.settlementSignature; updates.revealed_preimage = s.revealed_preimage ?? input.preimageHex;
    } else if (input.refunded && input.settlementSignature) updates.evm_refund_tx = input.settlementSignature;
    await reconcileEvidence(c, s, updates, input.withdrawn ? 'solana_claimed' : input.refunded ? 'solana_refunded' : 'solana_lock_observed');
  };
  if (q) await apply(q); else await tx(apply);
}

export async function onEvmLockConfirmations(swapId: string, confs: number, btqTip: number): Promise<void> {
  await tx(async (c) => {
    const s = await lockSwap(c, swapId);
    if (!s || s.status !== 'buyer_lock_confirming') return;
    if (confs !== s.evm_lock_confs) await patch(c, s.id, { evm_lock_confs: confs });
    if (confs >= config().EVM_MIN_CONFIRMATIONS) await enterAwaitingSellerLock(c, { ...s, evm_lock_confs: confs }, btqTip);
  });
}

async function enterAwaitingSellerLock(c: Queryable, s: SwapRow, btqTip: number | null): Promise<void> {
  if (s.btq_htlc_spk) { await reconcileEvidence(c, s, {}, 'evm_lock_reconfirmed'); return; }
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

export async function onEvmClaimed(agreementId: string, txHash: string, key: string, block?: { height: number; hash: string }): Promise<void> {
  await tx(async c => {
    const s = await one<SwapRow>(c, 'SELECT * FROM swaps WHERE evm_agreement_id = $1 FOR UPDATE', [agreementId.toLowerCase()]);
    if (!s) return;
    const keyHex = key.replace(/^0x/, '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(keyHex) || bytesToHex(sha256Bytes(hexToBytes(keyHex))) !== s.secret_hash) {
      await recordEvent(c, s.id, 'evm_claim_mismatch', { txHash }); return;
    }
    await reconcileEvidence(c, s, { evm_claim_tx: txHash, evm_claim_block: block?.height ?? null,
      evm_claim_block_hash: block?.hash ?? null, evm_pending_claim_tx: null, revealed_preimage: s.revealed_preimage ?? keyHex }, 'evm_claimed');
  });
}

export async function onEvmRefunded(agreementId: string, txHash: string, block?: { height: number; hash: string }): Promise<void> {
  await tx(async c => {
    const s = await one<SwapRow>(c, 'SELECT * FROM swaps WHERE evm_agreement_id = $1 FOR UPDATE', [agreementId.toLowerCase()]);
    if (!s) return;
    await reconcileEvidence(c, s, { evm_refund_tx: txHash, evm_refund_block: block?.height ?? null,
      evm_refund_block_hash: block?.hash ?? null, evm_pending_refund_tx: null }, 'evm_refunded');
  });
}

export async function onPendingEvmSpend(agreementId: string, kind: 'claim' | 'refund', txid: string, preimage?: string): Promise<void> {
  await tx(async c => {
    const s = await one<SwapRow>(c, 'SELECT * FROM swaps WHERE evm_agreement_id = $1 FOR UPDATE', [agreementId.toLowerCase()]);
    if (!s || s.settlement_rail !== 'evm' || s[`evm_${kind}_tx`]) return;
    const updates: Record<string, unknown> = { [`evm_pending_${kind}_tx`]: txid };
    const key = preimage?.replace(/^0x/, '').toLowerCase();
    if (key && /^[0-9a-f]{64}$/.test(key) && bytesToHex(sha256Bytes(hexToBytes(key))) === s.secret_hash) updates.revealed_preimage = s.revealed_preimage ?? key;
    await reconcileEvidence(c, s, updates, `evm_${kind}_pending`);
  });
}

/** An accepted agreement stays bound for recovery, but no action may rely on its orphaned confirmations. */
export async function reconcileEvmObservation(swapId: string, leg: 'lock' | 'claim' | 'refund', block: { height: number; hash: string; confirmations: number } | null): Promise<void> {
  await tx(async c => {
    const s = await lockSwap(c, swapId); if (!s || s.settlement_rail !== 'evm') return;
    if (leg === 'lock') {
      const updates = { evm_lock_block: block?.height ?? null, evm_lock_block_hash: block?.hash ?? null, evm_lock_confs: block?.confirmations ?? 0 };
      if (!block || block.confirmations < config().EVM_MIN_CONFIRMATIONS) await reconcileEvidence(c, s, updates, 'evm_lock_orphaned');
      else {
        const updated = await patch(c, s.id, updates);
        if (updated!.status === 'buyer_lock_confirming') await enterAwaitingSellerLock(c, updated!, null);
      }
    } else if (!block || block.confirmations < config().EVM_MIN_CONFIRMATIONS) {
      if (!block) await releaseRecoveryAction(c, s, `evm_${leg}`);
      await reconcileEvidence(c, s, { [`evm_${leg}_tx`]: null, [`evm_pending_${leg}_tx`]: s[`evm_${leg}_tx`] ?? s[`evm_pending_${leg}_tx`], [`evm_${leg}_block`]: null, [`evm_${leg}_block_hash`]: null }, `evm_${leg}_orphaned`);
    } else {
      await patch(c, s.id, { [`evm_${leg}_block`]: block.height, [`evm_${leg}_block_hash`]: block.hash });
    }
  });
}

// ─────────────────────────── BTQ leg ───────────────────────────

export async function onBtqLockOutput(swapId: string, o: { txid: string; vout: number; sats: bigint; height: number | null; blockHash?: string | null }, tip: number): Promise<void> {
  await tx(async (c) => {
    const s = await lockSwap(c, swapId);
    if (!s) return;
    if (s.btq_lock_txid === o.txid && s.btq_lock_vout === o.vout) {
      await reconcileEvidence(c, s, { btq_lock_height: o.blockHash ? o.height : null, btq_lock_block_hash: o.blockHash ?? null,
        btq_lock_confs: o.height !== null && o.blockHash ? Math.max(0, tip - o.height + 1) : 0 }, 'btq_lock_confirmations', tip);
      return;
    }
    const previous = await one(c, `SELECT 1 FROM swap_locks WHERE chain = 'btq' AND network = $1 AND lock_id = $2 AND swap_id = $3 AND (reason IS NULL OR metadata->>'accepted' = 'true')`, [s.btq_network, `${o.txid}:${o.vout}`, s.id]);
    let problem = s.btq_lock_txid ? 'swap already has a BTQ lock' : s.status !== 'awaiting_seller_lock' && !previous && !s.revealed_preimage ? `swap is ${s.status}` :
      o.sats < BigInt(s.amount_sats) ? `amount ${o.sats} < ${s.amount_sats}` : null;
    const owned = await rememberLock(c, s, 'btq', `${o.txid}:${o.vout}`, {
      txid: o.txid, vout: o.vout, valueSats: o.sats.toString(), htlc: toRecord(htlcForSwap(s)),
    }, problem);
    if (!owned) problem = 'funding output belongs to another swap';
    if (problem) {
      const fresh = await recordEvent(c, s.id, 'btq_lock_rejected', { reason: problem, txid: o.txid, vout: o.vout }, { actionKey: `rejected_btq:${s.id}:${o.txid}:${o.vout}` });
      if (fresh && owned) await enqueueNotification(c, {
        userId: s.seller_user_id, swapId: s.id, kind: 'info', dedupeKey: `rejected_btq:${o.txid}:${o.vout}`,
        payload: { title: `Swap #${s.short_id}: BTQ lock not accepted`, body: `Reason: ${problem}. Refund after block ${s.btq_refund_locktime} with \`btq-htlc refund --swap ${s.short_id} --outpoint ${o.txid}:${o.vout} --rpc <your-node>\`.` },
      });
      return;
    }
    const confs = o.height !== null && o.blockHash ? Math.max(0, tip - o.height + 1) : 0;
    const updated = await transition(c, s.id, [s.status], 'seller_lock_confirming', 'btq_locked', {
      btq_lock_txid: o.txid,
      btq_lock_vout: o.vout,
      btq_lock_sats: o.sats.toString(),
      btq_lock_height: o.blockHash ? o.height : null,
      btq_lock_block_hash: o.blockHash ?? null,
      btq_lock_confs: Math.max(0, confs),
    }, { txid: o.txid, vout: o.vout, sats: o.sats.toString() });
    if (updated) await reconcileEvidence(c, updated, {}, 'btq_lock_confirmed', tip);
  });
}

export async function onBtqLockConfirmations(swapId: string, block: { height: number; hash: string } | null, tip: number): Promise<void> {
  await tx(async c => {
    const s = await lockSwap(c, swapId); if (!s || !s.btq_lock_txid) return;
    const confs = block ? Math.max(0, tip - block.height + 1) : 0;
    await reconcileEvidence(c, s, { btq_lock_height: block?.height ?? null, btq_lock_block_hash: block?.hash ?? null,
      btq_lock_confs: confs }, 'btq_lock_confirmations', tip);
  });
}

export async function clearBtqObservation(swapId: string, leg: 'lock' | 'spend', tip?: number): Promise<void> {
  await tx(async c => {
    const s = await lockSwap(c, swapId); if (!s) return;
    await releaseRecoveryAction(c, s, 'btq_claim'); await releaseRecoveryAction(c, s, 'btq_refund');
    await reconcileEvidence(c, s, {
      ...(leg === 'lock' ? { btq_lock_txid: null, btq_lock_vout: null, btq_lock_sats: null, btq_lock_height: null,
        btq_lock_block_hash: null, btq_lock_confs: 0 } : {}),
      btq_claim_txid: null, btq_refund_txid: null, btq_pending_spend_txid: null, btq_pending_spend_kind: null,
      btq_spend_raw: null, btq_spend_height: null, btq_spend_block_hash: null,
    }, `btq_${leg}_orphaned`, tip);
  });
}

export async function onBtqSpend(swapId: string, rawHex: string, spendTxid: string, block: { height: number; hash: string; tip: number } | null = null, tip?: number): Promise<void> {
  await tx(async c => {
    const s = await lockSwap(c, swapId); if (!s || !s.btq_lock_txid || s.btq_lock_vout === null) return;
    const info = inspectHtlcSpend(rawHex, { txid: s.btq_lock_txid, vout: s.btq_lock_vout }, htlcForSwap(s));
    if (!info || info.kind === 'unknown') return;
    const confirmed = !!block && block.tip - block.height + 1 >= config().BTQ_MIN_CONFIRMATIONS;
    await reconcileEvidence(c, s, {
      btq_claim_txid: confirmed && info.kind === 'claim' ? spendTxid : null,
      btq_refund_txid: confirmed && info.kind === 'refund' ? spendTxid : null,
      btq_pending_spend_txid: confirmed ? null : spendTxid, btq_pending_spend_kind: confirmed ? null : info.kind,
      btq_spend_raw: rawHex, btq_spend_height: block?.height ?? null, btq_spend_block_hash: block?.hash ?? null,
      revealed_preimage: s.revealed_preimage ?? (info.kind === 'claim' ? bytesToHex(info.preimage!) : null),
    }, confirmed ? `btq_${info.kind}_confirmed` : `btq_${info.kind}_pending`, block?.tip ?? tip);
  });
}

// ─────────────────────────── deadlines ───────────────────────────

export async function runDeadlines(tip: number, nowMs = Date.now()): Promise<number> {
  let changed = 0;
  const due = await many<SwapRow>(
    db(),
    `SELECT * FROM swaps WHERE
       (status = 'awaiting_buyer_lock' AND buyer_lock_by < to_timestamp($1 / 1000.0))
    OR (status = 'buyer_lock_confirming' AND (evm_deadline IS NULL OR evm_deadline - ($3::text || ' seconds')::interval <= to_timestamp($1 / 1000.0)))
    OR (status = 'awaiting_seller_lock' AND seller_lock_by < to_timestamp($1 / 1000.0))
    OR (status = 'awaiting_seller_claim' AND ((btq_refund_locktime <= $2 AND btq_claim_txid IS NULL) OR (evm_claim_tx IS NULL AND evm_deadline <= to_timestamp($1 / 1000.0))))
    OR (status IN ('awaiting_buyer_claim', 'seller_lock_confirming') AND btq_refund_locktime <= $2)`,
    [nowMs, tip, sellerTimeBudgetSec() + 30],
  );
  for (const s of due) {
    await tx(async (c) => {
      if (s.status === 'awaiting_buyer_lock') {
        const r = await transition(c, s.id, ['awaiting_buyer_lock'], 'expired', 'buyer_lock_window_passed', { failure_reason: 'buyer did not lock USDT in time' });
        if (r) {
          changed++;
          await c.query('UPDATE users SET no_show_count = no_show_count + 1 WHERE id = $1 AND is_platform = false', [s.buyer_user_id]);
        }
      } else if (s.status === 'buyer_lock_confirming') {
        const r = await transition(c, s.id, ['buyer_lock_confirming'], s.btq_lock_txid ? 'awaiting_refunds' : 'awaiting_buyer_refund', 'buyer_confirmation_timeout', { failure_reason: 'the stablecoin lock did not confirm within its safe funding window' });
        if (r) changed++;
      } else if (s.status === 'awaiting_seller_lock') {
        const r = await transition(c, s.id, ['awaiting_seller_lock'], 'awaiting_buyer_refund', 'seller_lock_window_passed', { failure_reason: 'seller did not lock BTQ in time' });
        if (r) {
          changed++;
          await c.query('UPDATE users SET no_show_count = no_show_count + 1 WHERE id = $1 AND is_platform = false', [s.seller_user_id]);
        }
      } else {
        const r = await transition(c, s.id, ['awaiting_buyer_claim', 'seller_lock_confirming', 'awaiting_seller_claim'], 'awaiting_refunds', 'btq_timelock_reached', { failure_reason: 'buyer did not claim BTQ before the timelock' }, { tip });
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
