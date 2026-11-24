import { BtqRpcError, btqToSats, bytesToHex, parseTx, txid as computeTxid } from '@btq-swap/htlc';
import { btqChain } from '../chains/btq';
import { db, many } from '../lib/db';
import { createLogger } from '../lib/logger';
import { clearBtqObservation, onBtqLockConfirmations, onBtqLockOutput, onBtqSpend, runDeadlines } from '../domain/settlement';
import type { SwapRow } from '../domain/types';
import { canonicalCursor, setCursor } from './cursors';

const log = createLogger('btq-watcher');

export const btqStatus = { tip: 0, tipHash: '', cursor: 0, lag: 0, lastTickAt: 0, mempool: 0 };

interface Watch {
  bySpk: Map<string, SwapRow>;
  byOutpoint: Map<string, SwapRow>;
}

async function loadWatch(): Promise<Watch> {
  const rows = await many<SwapRow>(
    db(),
    `SELECT * FROM swaps WHERE btq_htlc_spk IS NOT NULL`,
  );
  const w: Watch = { bySpk: new Map(), byOutpoint: new Map() };
  for (const s of rows) {
    if (s.btq_htlc_spk) w.bySpk.set(s.btq_htlc_spk, s);
    if (s.btq_lock_txid && s.btq_lock_vout !== null && !s.btq_claim_txid && !s.btq_refund_txid) w.byOutpoint.set(`${s.btq_lock_txid}:${s.btq_lock_vout}`, s);
  }
  return w;
}

interface TxView {
  txid: string;
  hex: string;
  inputs: Array<{ txid: string; vout: number }>;
  outputs: Array<{ spk: string; sats: bigint; n: number }>;
}

async function processTx(t: TxView, height: number | null, tip: number, w: Watch, blockHash: string | null = null): Promise<boolean> {
  let touched = false;
  for (const o of t.outputs) {
    const s = w.bySpk.get(o.spk);
    if (s) { touched = true; await onBtqLockOutput(s.id, { txid: t.txid, vout: o.n, sats: o.sats, height, blockHash }, tip); }
  }
  for (const i of t.inputs) {
    const s = w.byOutpoint.get(`${i.txid}:${i.vout}`);
    if (s) { touched = true; await onBtqSpend(s.id, t.hex, t.txid, height !== null && blockHash ? { height, hash: blockHash, tip } : null, tip); }
  }
  return touched;
}

async function confirmation(txid: string) {
  try { return await btqChain().txConfirmations(txid); }
  catch (err) { if (err instanceof BtqRpcError && err.code === -5) return null; throw err; }
}

export async function btqTick(): Promise<number> {
  const chain = btqChain();
  const tip = await chain.tip();
  const mempool = await chain.mempoolTxids();
  const live = new Set(mempool);
  // Reconcile before scanning the replacement branch, including already-promoted and terminal rows.
  const observed = await many<SwapRow>(db(), 'SELECT * FROM swaps WHERE btq_lock_txid IS NOT NULL');
  for (const s of observed) {
    const funding = await confirmation(s.btq_lock_txid!);
    if (funding?.height === undefined && !live.has(s.btq_lock_txid!)) {
      await clearBtqObservation(s.id, 'lock', tip.height); continue;
    }
    await onBtqLockConfirmations(s.id, funding?.height !== undefined && funding.blockhash ? { height: funding.height, hash: funding.blockhash } : null, tip.height);
    const spendId = s.btq_pending_spend_txid ?? s.btq_claim_txid ?? s.btq_refund_txid;
    if (spendId) {
      const spend = await confirmation(spendId);
      if (spend?.height === undefined && !live.has(spendId)) await clearBtqObservation(s.id, 'spend', tip.height);
      else {
        const raw = await chain.rawTx(spendId, spend?.blockhash);
        await onBtqSpend(s.id, raw, spendId, spend?.height !== undefined && spend.blockhash ? { height: spend.height, hash: spend.blockhash, tip: tip.height } : null, tip.height);
      }
    }
  }
  const cur = await canonicalCursor('btq', tip.height, h => chain.blockHash(h), Math.max(-1, tip.height - 1));
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
        if (await chain.blockHash(h) !== hash) throw new Error('BTQ branch changed during scan');
        await processTx(view, h, tip.height, watch, hash);
        watch = await loadWatch();
      }
    }
    if (await chain.blockHash(h) !== hash) throw new Error('BTQ branch changed during scan');
    await setCursor('btq', h, hash);
  }

  // Retry fetching on every tick. A failed fetch or child-before-parent order must never hide a secret.
  btqStatus.mempool = mempool.length;
  const views: TxView[] = [];
  for (const id of mempool) {
    let hex: string;
    try { hex = await chain.rawTx(id); }
    catch (err) { if (err instanceof BtqRpcError && err.code === -5) continue; throw err; }
    const parsed = parseTx(hex);
    views.push({ txid: computeTxid(parsed), hex,
      inputs: parsed.inputs.map(i => ({ txid: i.txid, vout: i.vout })),
      outputs: parsed.outputs.map((o, n) => ({ spk: bytesToHex(o.scriptPubKey), sats: o.valueSats, n })) });
  }
  for (const view of views) { if (await processTx({ ...view, inputs: [] }, null, tip.height, watch)) watch = await loadWatch(); }
  for (const view of views) { if (await processTx({ ...view, outputs: [] }, null, tip.height, watch)) watch = await loadWatch(); }

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
      WHERE e.event_type = 'btq_lock_hint' AND s.btq_htlc_spk IS NOT NULL AND e.created_at > now() - interval '1 hour'`,
  );
  if (!hints.length) return;
  const chain = btqChain();
  const tip = (await chain.tip()).height;
  const watch = await loadWatch();
  const mempool = new Set(await chain.mempoolTxids());
  for (const h of hints) {
    const hex = await chain.rawTx(h.txid).catch(() => null);
    if (!hex) continue;
    const parsed = parseTx(hex);
    const conf = await confirmation(h.txid);
    if (conf?.height === undefined && !mempool.has(h.txid)) continue;
    await processTx(
      { txid: h.txid, hex, inputs: [], outputs: parsed.outputs.map((o, n) => ({ spk: bytesToHex(o.scriptPubKey), sats: o.valueSats, n })) },
      conf?.height ?? null,
      tip,
      watch,
      conf?.blockhash ?? null,
    );
  }
}
