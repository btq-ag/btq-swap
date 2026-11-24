import { btqToSats, bytesToHex, parseTx, txid as computeTxid } from '@btq-swap/htlc';
import { btqChain } from '../chains/btq';
import { db, many } from '../lib/db';
import { createLogger } from '../lib/logger';
import { onBtqLockConfirmations, onBtqLockOutput, onBtqSpend, runDeadlines } from '../domain/settlement';
import type { SwapRow } from '../domain/types';
import { getCursor, setCursor } from './cursors';

const log = createLogger('btq-watcher');
const REORG_DEPTH = 12;

export const btqStatus = { tip: 0, tipHash: '', cursor: 0, lag: 0, lastTickAt: 0, mempool: 0 };

interface Watch {
  bySpk: Map<string, SwapRow>;
  byOutpoint: Map<string, SwapRow>;
}

async function loadWatch(): Promise<Watch> {
  const rows = await many<SwapRow>(
    db(),
    `SELECT * FROM swaps WHERE
       (status IN ('awaiting_seller_lock','seller_lock_confirming','awaiting_buyer_refund','expired') AND btq_htlc_spk IS NOT NULL AND btq_lock_txid IS NULL AND updated_at > now() - interval '2 days')
    OR (btq_lock_txid IS NOT NULL AND btq_claim_txid IS NULL AND btq_refund_txid IS NULL)`,
  );
  const w: Watch = { bySpk: new Map(), byOutpoint: new Map() };
  for (const s of rows) {
    if (s.btq_htlc_spk && !s.btq_lock_txid) w.bySpk.set(s.btq_htlc_spk, s);
    if (s.btq_lock_txid && s.btq_lock_vout !== null) w.byOutpoint.set(`${s.btq_lock_txid}:${s.btq_lock_vout}`, s);
  }
  return w;
}

interface TxView {
  txid: string;
  hex: string;
  inputs: Array<{ txid: string; vout: number }>;
  outputs: Array<{ spk: string; sats: bigint; n: number }>;
}

async function processTx(t: TxView, height: number | null, tip: number, w: Watch): Promise<void> {
  for (const o of t.outputs) {
    const s = w.bySpk.get(o.spk);
    if (s) await onBtqLockOutput(s.id, { txid: t.txid, vout: o.n, sats: o.sats, height }, tip);
  }
  for (const i of t.inputs) {
    const s = w.byOutpoint.get(`${i.txid}:${i.vout}`);
    if (s) await onBtqSpend(s.id, t.hex, t.txid);
  }
}

const seenMempool = new Set<string>();

export async function btqTick(): Promise<number> {
  const chain = btqChain();
  const tip = await chain.tip();
  let cur = await getCursor('btq');
  if (!cur) {
    cur = { height: Math.max(0, tip.height - 1), hash: null };
  }
  // reorg check: if the block at our cursor changed, rescan the last REORG_DEPTH blocks (handlers are idempotent)
  if (cur.hash && cur.height <= tip.height) {
    const hashNow = await chain.blockHash(cur.height).catch(() => null);
    if (hashNow !== cur.hash) {
      const h = Math.max(0, cur.height - REORG_DEPTH);
      log.warn('BTQ reorg detected, rescanning', { from: h, storedHeight: cur.height });
      cur = { height: h, hash: null };
    }
  } else if (cur.height > tip.height) {
    cur = { height: Math.max(0, tip.height - REORG_DEPTH), hash: null };
  }

  let watch = await loadWatch();
  for (let h = cur.height + 1; h <= tip.height; h++) {
    const hash = await chain.blockHash(h);
    const block = await chain.block(hash);
    for (const t of block.tx) {
      const view: TxView = {
        txid: t.txid,
        hex: t.hex,
        inputs: t.vin.filter((v) => v.txid).map((v) => ({ txid: v.txid!, vout: v.vout! })),
        outputs: t.vout.map((o) => ({ spk: o.scriptPubKey.hex, sats: btqToSats(o.value.toFixed(8)), n: o.n })),
      };
      const hit = view.outputs.some((o) => watch.bySpk.has(o.spk)) || view.inputs.some((i) => watch.byOutpoint.has(`${i.txid}:${i.vout}`));
      if (hit) {
        await processTx(view, h, tip.height, watch);
        watch = await loadWatch();
      }
    }
    await setCursor('btq', h, hash);
  }

  // mempool: learn locks and preimages at 0-conf
  const mempool = await chain.mempoolTxids();
  btqStatus.mempool = mempool.length;
  const live = new Set(mempool);
  for (const id of seenMempool) if (!live.has(id)) seenMempool.delete(id);
  for (const id of mempool) {
    if (seenMempool.has(id)) continue;
    seenMempool.add(id);
    const hex = await chain.rawTx(id).catch(() => null);
    if (!hex) continue;
    const parsed = parseTx(hex);
    const view: TxView = {
      txid: computeTxid(parsed),
      hex,
      inputs: parsed.inputs.map((i) => ({ txid: i.txid, vout: i.vout })),
      outputs: parsed.outputs.map((o, n) => ({ spk: bytesToHex(o.scriptPubKey), sats: o.valueSats, n })),
    };
    await processTx(view, null, tip.height, watch);
  }

  // confirmations for locks first seen in the mempool
  const confirming = await many<SwapRow>(db(), `SELECT * FROM swaps WHERE status = 'seller_lock_confirming'`);
  for (const s of confirming) {
    let height = s.btq_lock_height;
    if (!height) {
      const c = await chain.txConfirmations(s.btq_lock_txid!).catch(() => null);
      height = c?.height ?? null;
    }
    await onBtqLockConfirmations(s.id, height, tip.height);
  }

  await runDeadlines(tip.height);
  btqStatus.tip = tip.height;
  btqStatus.tipHash = tip.hash;
  btqStatus.cursor = tip.height;
  btqStatus.lag = 0;
  btqStatus.lastTickAt = Date.now();
  return tip.height;
}

/** Lock txid hints submitted by sellers: verify by fetching the tx and matching outputs. */
export async function processLockHints(): Promise<void> {
  const hints = await many<{ swap_id: string; txid: string }>(
    db(),
    `SELECT e.swap_id, e.metadata->>'txid' AS txid FROM swap_events e JOIN swaps s ON s.id = e.swap_id
      WHERE e.event_type = 'btq_lock_hint' AND s.status = 'awaiting_seller_lock' AND e.created_at > now() - interval '1 hour'`,
  );
  if (!hints.length) return;
  const chain = btqChain();
  const tip = (await chain.tip()).height;
  const watch = await loadWatch();
  for (const h of hints) {
    const hex = await chain.rawTx(h.txid).catch(() => null);
    if (!hex) continue;
    const parsed = parseTx(hex);
    const conf = await chain.txConfirmations(h.txid).catch(() => null);
    await processTx(
      { txid: h.txid, hex, inputs: [], outputs: parsed.outputs.map((o, n) => ({ spk: bytesToHex(o.scriptPubKey), sats: o.valueSats, n })) },
      conf?.height ?? null,
      tip,
      watch,
    );
  }
}
