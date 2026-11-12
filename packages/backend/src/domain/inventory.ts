import { config } from '../config';
import { btqChain } from '../chains/btq';
import { evmChain } from '../chains/evm';
import { db, one, type Queryable } from '../lib/db';
import { createLogger } from '../lib/logger';
import { usdtUnitsFor } from './money';

const log = createLogger('inventory');

export interface InventorySnapshot {
  at: number;
  btqBalanceSats: bigint;
  btqCommittedSats: bigint; // platform-seller swaps whose BTQ is not locked yet
  btqInHtlcSats: bigint; // platform BTQ currently sitting in HTLCs
  usdtBalanceUnits: bigint;
  usdtCommittedUnits: bigint; // platform-buyer swaps whose USDT is not locked yet
  usdtInHtlcUnits: bigint;
  ethBalanceWei: bigint;
  openAskSats: bigint;
  openBidUnits: bigint;
}

let snapshot: InventorySnapshot | null = null;

const BIG_KEYS = ['btqBalanceSats', 'btqCommittedSats', 'btqInHtlcSats', 'usdtBalanceUnits', 'usdtCommittedUnits', 'usdtInHtlcUnits', 'ethBalanceWei', 'openAskSats', 'openBidUnits'] as const;

function serialize(s: InventorySnapshot): string {
  return JSON.stringify(s, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
}

function deserialize(raw: Record<string, unknown>): InventorySnapshot {
  const out: Record<string, unknown> = { at: Number(raw.at) };
  for (const k of BIG_KEYS) out[k] = BigInt(String(raw[k] ?? '0'));
  return out as unknown as InventorySnapshot;
}

export async function refreshInventory(): Promise<InventorySnapshot> {
  const [btqBal, usdtBal, ethBal] = await Promise.all([
    btqChain().platformBalanceSats(1),
    evmChain().tokenBalance(evmChain().platformAddress),
    evmChain().ethBalance(evmChain().platformAddress),
  ]);
  const row = await one<{
    btq_committed: string; btq_in_htlc: string; usdt_committed: string; usdt_in_htlc: string;
  }>(
    db(),
    `SELECT
       COALESCE(SUM(s.amount_sats) FILTER (WHERE s.seller_user_id = p.id AND s.btq_lock_txid IS NULL AND s.status IN ('awaiting_buyer_lock','buyer_lock_confirming','awaiting_seller_lock')), 0)::text AS btq_committed,
       COALESCE(SUM(s.btq_lock_sats) FILTER (WHERE s.seller_user_id = p.id AND s.btq_lock_txid IS NOT NULL AND s.btq_claim_txid IS NULL AND s.btq_refund_txid IS NULL), 0)::text AS btq_in_htlc,
       COALESCE(SUM(s.amount_usdt_units) FILTER (WHERE s.buyer_user_id = p.id AND s.evm_agreement_id IS NULL AND s.status = 'awaiting_buyer_lock'), 0)::text AS usdt_committed,
       COALESCE(SUM(s.amount_usdt_units) FILTER (WHERE s.buyer_user_id = p.id AND s.evm_agreement_id IS NOT NULL AND s.evm_claim_tx IS NULL AND s.evm_refund_tx IS NULL), 0)::text AS usdt_in_htlc
     FROM users p LEFT JOIN swaps s ON (s.seller_user_id = p.id OR s.buyer_user_id = p.id)
     WHERE p.is_platform`,
  );
  const orders = await one<{ ask_sats: string; bid_units: string }>(
    db(),
    `SELECT
       COALESCE(SUM(((o.amount_btq - o.filled_btq) * 100000000)::bigint) FILTER (WHERE o.side = 'sell'), 0)::text AS ask_sats,
       COALESCE(SUM(((o.amount_btq - o.filled_btq) * o.price_usdt * power(10, $1::int))::numeric(40,0)) FILTER (WHERE o.side = 'buy'), 0)::text AS bid_units
     FROM orders o JOIN users p ON p.id = o.user_id AND p.is_platform
     WHERE o.status IN ('open','partially_filled')`,
    [config().USDT_DECIMALS],
  );
  snapshot = {
    at: Date.now(),
    btqBalanceSats: btqBal,
    btqCommittedSats: BigInt(row?.btq_committed ?? '0'),
    btqInHtlcSats: BigInt(row?.btq_in_htlc ?? '0'),
    usdtBalanceUnits: usdtBal,
    usdtCommittedUnits: BigInt(row?.usdt_committed ?? '0'),
    usdtInHtlcUnits: BigInt(row?.usdt_in_htlc ?? '0'),
    ethBalanceWei: ethBal,
    openAskSats: BigInt(orders?.ask_sats ?? '0'),
    openBidUnits: BigInt(orders?.bid_units ?? '0'),
  };
  await db().query(
    `INSERT INTO platform_inventory (id, snapshot, updated_at) VALUES (1, $1, now())
     ON CONFLICT (id) DO UPDATE SET snapshot = EXCLUDED.snapshot, updated_at = now()`,
    [serialize(snapshot)],
  );
  return snapshot;
}

/** Latest snapshot from any process (the platform agent refreshes it every tick). */
export async function loadInventory(q: Queryable = db()): Promise<InventorySnapshot | null> {
  const row = await one<{ snapshot: Record<string, unknown> }>(q, 'SELECT snapshot FROM platform_inventory WHERE id = 1');
  return row ? deserialize(row.snapshot) : snapshot;
}

export function inventorySnapshot(): InventorySnapshot | null {
  return snapshot;
}

/** Can the platform deliver this fill right now (ignoring its own resting-order reservations)? */
export async function platformCanFill(platformSide: 'buy' | 'sell', fillSats: bigint, price: string, q: Queryable = db()): Promise<boolean> {
  const s = await loadInventory(q);
  if (!s || Date.now() - s.at > 120_000) {
    log.warn('inventory snapshot stale; refusing platform fill');
    return false;
  }
  if (platformSide === 'sell') return s.btqBalanceSats - s.btqCommittedSats >= fillSats;
  return s.usdtBalanceUnits - s.usdtCommittedUnits >= usdtUnitsFor(fillSats, price, config().USDT_DECIMALS);
}

/** Headroom for posting a new MM order on top of existing resting MM orders. */
export async function mmHeadroom(): Promise<{ askSats: bigint; bidUnits: bigint } | null> {
  const s = await loadInventory();
  if (!s) return null;
  return {
    askSats: s.btqBalanceSats - s.btqCommittedSats - s.openAskSats,
    bidUnits: s.usdtBalanceUnits - s.usdtCommittedUnits - s.openBidUnits,
  };
}
