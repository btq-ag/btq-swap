import { toRecord, btqNetworkTag, swapBindingAsset } from '@btq-swap/htlc';
import { config, sellerTimeBudgetSec } from '../config';
import { db, many, one } from '../lib/db';
import { btqStatus } from '../workers/btq-watcher';
import { evmStatus } from '../workers/evm-watcher';
import { publicBook } from './book';
import { loadInventory } from './inventory';
import { usdtDisplay } from './instructions';
import { fromUnits } from './money';
import { partyLabel, protocolSteps, statusTone } from './present';
import { getSwap, htlcForSwap, swapEvents } from './settlement';
import { getSettings } from './settings';
import { solanaStatus } from '../workers/solana-watcher';
import { ACTIVE_STATUSES, STATUS_LABEL, type SwapRow, type UserRow } from './types';

type Party = Pick<UserRow, 'id' | 'is_platform' | 'is_simulated' | 'discord_username' | 'discord_id'>;

async function partiesFor(swaps: SwapRow[]): Promise<Map<string, Party>> {
  const ids = [...new Set(swaps.flatMap((s) => [s.buyer_user_id, s.seller_user_id]))];
  if (!ids.length) return new Map();
  const rows = await many<Party>(db(), 'SELECT id, is_platform, is_simulated, discord_username, discord_id FROM users WHERE id = ANY($1)', [ids]);
  return new Map(rows.map((r) => [r.id, r]));
}

export function swapView(s: SwapRow, parties: Map<string, Party>) {
  const buyer = parties.get(s.buyer_user_id);
  const seller = parties.get(s.seller_user_id);
  const doneMs = s.completed_at ? new Date(s.completed_at).getTime() : null;
  return {
    id: s.id,
    shortId: Number(s.short_id),
    status: s.status,
    statusLabel: STATUS_LABEL[s.status],
    tone: statusTone(s.status),
    amountBtq: s.amount_btq,
    amountUsdt: usdtDisplay(s),
    price: s.price_usdt,
    buyer: { label: partyLabel(buyer), platform: !!buyer?.is_platform, simulated: !!buyer?.is_simulated },
    seller: { label: partyLabel(seller), platform: !!seller?.is_platform, simulated: !!seller?.is_simulated },
    steps: protocolSteps(s),
    secretHash: s.secret_hash,
    preimage: s.revealed_preimage,
    evm: {
      chainId: s.evm_chain_id,
      contract: s.evm_htlc_contract,
      agreementId: s.evm_agreement_id,
      lockTx: s.evm_lock_tx,
      lockConfs: s.evm_lock_confs,
      deadline: s.evm_deadline,
      claimTx: s.evm_claim_tx,
      refundTx: s.evm_refund_tx,
    },
    btq: {
      network: s.btq_network,
      htlcAddress: s.btq_htlc_address,
      refundLocktime: s.btq_refund_locktime,
      lockTxid: s.btq_lock_txid,
      lockVout: s.btq_lock_vout,
      lockConfs: s.btq_lock_confs,
      claimTxid: s.btq_claim_txid,
      refundTxid: s.btq_refund_txid,
    },
    rail: s.settlement_rail === 'solana' ? 'solana' as const : 'evm' as const,
    deadlines: { buyerLockBy: s.buyer_lock_by, sellerLockBy: s.seller_lock_by },
    failureReason: s.failure_reason,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    completedAt: s.completed_at,
    durationSec: doneMs ? Math.round((doneMs - new Date(s.created_at).getTime()) / 1000) : null,
  };
}

export async function monitorState() {
  const c = config();
  const swaps = await many<SwapRow>(
    db(),
    `(SELECT * FROM swaps WHERE status = ANY($1) ORDER BY created_at DESC LIMIT 100)
     UNION ALL
     (SELECT * FROM swaps WHERE NOT (status = ANY($1)) ORDER BY updated_at DESC LIMIT 60)`,
    [ACTIVE_STATUSES as unknown as string[]],
  );
  const parties = await partiesFor(swaps);
  const stats = await one<Record<string, string>>(
    db(),
    `SELECT
       COUNT(*) FILTER (WHERE status = ANY($1))::text AS active,
       COUNT(*) FILTER (WHERE status = 'completed')::text AS completed,
       COUNT(*) FILTER (WHERE status = 'refunded')::text AS refunded,
       COUNT(*) FILTER (WHERE status = 'expired')::text AS expired,
       COUNT(*) FILTER (WHERE status = 'failed')::text AS failed,
       COALESCE(SUM(amount_btq) FILTER (WHERE status = 'completed'), 0)::text AS volume_btq,
       COALESCE(SUM(amount_usdt) FILTER (WHERE status = 'completed'), 0)::text AS volume_usdt,
       COALESCE(AVG(EXTRACT(EPOCH FROM (completed_at - created_at))) FILTER (WHERE status = 'completed'), 0)::text AS avg_sec
     FROM swaps`,
    [ACTIVE_STATUSES as unknown as string[]],
  );
  const events = await many<{ short_id: string; event_type: string; from_status: string | null; to_status: string | null; actor: string; metadata: Record<string, unknown>; created_at: Date }>(
    db(),
    `SELECT s.short_id, e.event_type, e.from_status, e.to_status, e.actor, e.metadata, e.created_at
       FROM swap_events e JOIN swaps s ON s.id = e.swap_id
      WHERE e.event_type <> 'platform_action'
      ORDER BY e.id DESC LIMIT 80`,
  );
  const notifications = await many<{ kind: string; status: string; title: string; created_at: Date; username: string | null; is_simulated: boolean }>(
    db(),
    `SELECT n.kind, n.status, n.payload->>'title' AS title, n.created_at, u.discord_username AS username, u.is_simulated
       FROM notifications n JOIN users u ON u.id = n.user_id ORDER BY n.id DESC LIMIT 40`,
  );
  const inv = await loadInventory();
  return {
    generatedAt: new Date().toISOString(),
    chains: {
      btq: { network: c.BTQ_NETWORK, tip: btqStatus.tip, tipHash: btqStatus.tipHash, mempool: btqStatus.mempool, lastTickAt: btqStatus.lastTickAt, targetBlockSec: c.BTQ_TARGET_BLOCK_SEC, minConfirmations: c.BTQ_MIN_CONFIRMATIONS },
      evm: { chainId: c.EVM_CHAIN_ID, head: evmStatus.head, lastTickAt: evmStatus.lastTickAt, minConfirmations: c.EVM_MIN_CONFIRMATIONS },
      solana: { slot: solanaStatus.slot, lastTickAt: solanaStatus.lastTickAt, reachable: solanaStatus.reachable },
    },
    settlementRail: (await getSettings()).settlement_rail,
    timing: {
      buyerLockWindowSec: c.SWAP_BUYER_LOCK_WINDOW_SEC,
      evmLockDurationSec: c.SWAP_EVM_LOCK_DURATION_SEC,
      sellerLockWindowSec: c.SWAP_SELLER_LOCK_WINDOW_SEC,
      btqLockBlocks: c.SWAP_BTQ_LOCK_BLOCKS,
      safetyMarginSec: c.SWAP_SAFETY_MARGIN_SEC,
      sellerBudgetSec: sellerTimeBudgetSec(),
    },
    stats: {
      active: Number(stats?.active ?? 0),
      completed: Number(stats?.completed ?? 0),
      refunded: Number(stats?.refunded ?? 0),
      expired: Number(stats?.expired ?? 0),
      failed: Number(stats?.failed ?? 0),
      volumeBtq: stats?.volume_btq ?? '0',
      volumeUsdt: stats?.volume_usdt ?? '0',
      avgCompletionSec: Math.round(Number(stats?.avg_sec ?? 0)),
    },
    book: await publicBook(12),
    inventory: inv
      ? {
          at: inv.at,
          btq: fromUnits(inv.btqBalanceSats, 8),
          btqInHtlc: fromUnits(inv.btqInHtlcSats, 8),
          btqCommitted: fromUnits(inv.btqCommittedSats, 8),
          usdt: fromUnits(inv.usdtBalanceUnits, c.USDT_DECIMALS),
          usdtInHtlc: fromUnits(inv.usdtInHtlcUnits, c.USDT_DECIMALS),
          usdtCommitted: fromUnits(inv.usdtCommittedUnits, c.USDT_DECIMALS),
          eth: fromUnits(inv.ethBalanceWei, 18),
        }
      : null,
    swaps: swaps.map((s) => swapView(s, parties)),
    events: events.map((e) => ({ swap: Number(e.short_id), type: e.event_type, from: e.from_status, to: e.to_status, actor: e.actor, meta: e.metadata, at: e.created_at })),
    notifications: notifications.map((n) => ({ kind: n.kind, status: n.status, title: n.title, at: n.created_at, user: n.is_simulated ? `${n.username} (sim)` : n.username ? `${n.username.slice(0, 3)}…` : 'user' })),
  };
}

const SWAP_FILTERS = ['active', 'completed', 'refunds', 'all'] as const;
export type SwapFilter = (typeof SWAP_FILTERS)[number];

function filterSql(filter: SwapFilter): { sql: string; params: unknown[] } {
  if (filter === 'completed') return { sql: `status = 'completed'`, params: [] };
  if (filter === 'refunds') return { sql: `status IN ('refunded', 'expired', 'failed')`, params: [] };
  if (filter === 'all') return { sql: 'TRUE', params: [] };
  return { sql: `(status = ANY($1) OR status IN ('awaiting_buyer_refund', 'awaiting_refunds'))`, params: [ACTIVE_STATUSES as unknown as string[]] };
}

/** Page through swaps. `q` matches a swap number or any lock, claim, refund, or agreement id. */
export async function searchSwaps(rawQ: string, filter: SwapFilter, page: number, limit: number) {
  const q = rawQ.trim().slice(0, 128);
  const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const size = Math.min(50, Math.max(1, limit));
  const current = Math.max(1, page);
  const { sql: statusSql, params: statusParams } = filterSql(filter);
  const qIndex = statusParams.length + 1;
  const likeIndex = qIndex + 1;
  const where = `${statusSql} AND (
    $${qIndex} = ''
    OR short_id::text = $${qIndex}
    OR evm_lock_tx ILIKE $${likeIndex} ESCAPE '\\'
    OR evm_claim_tx ILIKE $${likeIndex} ESCAPE '\\'
    OR evm_refund_tx ILIKE $${likeIndex} ESCAPE '\\'
    OR evm_agreement_id ILIKE $${likeIndex} ESCAPE '\\'
    OR btq_lock_txid ILIKE $${likeIndex} ESCAPE '\\'
    OR btq_claim_txid ILIKE $${likeIndex} ESCAPE '\\'
    OR btq_refund_txid ILIKE $${likeIndex} ESCAPE '\\'
    OR btq_htlc_address ILIKE $${likeIndex} ESCAPE '\\'
    OR buyer_sol ILIKE $${likeIndex} ESCAPE '\\'
    OR seller_sol ILIKE $${likeIndex} ESCAPE '\\'
    OR buyer_eth ILIKE $${likeIndex} ESCAPE '\\'
    OR seller_eth ILIKE $${likeIndex} ESCAPE '\\'
  )`;
  const args = [...statusParams, q, like];
  const total = Number((await one<{ n: string }>(db(), `SELECT COUNT(*)::text AS n FROM swaps WHERE ${where}`, args))?.n ?? 0);
  const pages = Math.max(1, Math.ceil(total / size));
  const safePage = Math.min(current, pages);
  const rows = await many<SwapRow>(
    db(),
    `SELECT * FROM swaps WHERE ${where} ORDER BY created_at DESC LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
    [...args, size, (safePage - 1) * size],
  );
  const parties = await partiesFor(rows);
  return { swaps: rows.map((s) => swapView(s, parties)), total, page: safePage, pageSize: size, pages };
}

/** Public descriptor consumed by the btq-htlc CLI (all data is on-chain or derivable from it). */
export async function cliDescriptor(ref: string) {
  const s = await getSwap(ref);
  if (!s) return null;
  const htlc = s.secret_hash && s.btq_refund_locktime ? toRecord(htlcForSwap(s)) : null;
  return {
    swap: { id: s.id, shortId: Number(s.short_id), status: s.status, network: s.btq_network, amountSats: s.amount_sats, amountBtq: s.amount_btq },
    btq: {
      htlc,
      lock: s.btq_lock_txid ? { txid: s.btq_lock_txid, vout: s.btq_lock_vout, valueSats: s.btq_lock_sats, confirmations: s.btq_lock_confs } : null,
      tipHeight: btqStatus.tip,
    },
    evm: {
      chainId: s.evm_chain_id,
      htlcContract: s.evm_htlc_contract,
      token: s.evm_token,
      tokenDecimals: config().USDT_DECIMALS,
      buyer: s.buyer_eth,
      seller: s.seller_eth,
      amountUnits: s.amount_usdt_units,
      lockDurationSec: config().SWAP_EVM_LOCK_DURATION_SEC,
      otherNetwork: btqNetworkTag(s.btq_network),
      otherAsset: swapBindingAsset(s.id),
      otherAmount: s.amount_sats,
      agreementId: s.evm_agreement_id,
      deadline: s.evm_deadline ? Math.floor(new Date(s.evm_deadline).getTime() / 1000) : null,
      secretHash: s.secret_hash,
    },
    preimage: s.revealed_preimage,
  };
}

export async function publicSwapDetail(ref: string) {
  const s = await getSwap(ref);
  if (!s) return null;
  const parties = await partiesFor([s]);
  const events = await swapEvents(s.id);
  return { swap: swapView(s, parties), events: events.filter((e) => e.event_type !== 'platform_action') };
}
