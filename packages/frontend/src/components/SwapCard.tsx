import { Link } from 'react-router-dom';
import type { MonitorState, SwapView } from '../api';
import { ago, countdown, short, trimAmount } from '../hooks';
import { Braid } from './Braid';

const TONE: Record<SwapView['tone'], string> = {
  active: 'text-evm border-evm/40 bg-evm/10',
  success: 'text-ok border-ok/40 bg-ok/10',
  warning: 'text-warn border-warn/40 bg-warn/10',
  danger: 'text-bad border-bad/40 bg-bad/10',
};

export function StatusChip({ swap }: { swap: SwapView }) {
  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONE[swap.tone]}`}>{swap.tone === 'active' && <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-evm" />}{swap.statusLabel}</span>;
}

function PartyLine({ who, verb, p }: { who: string; verb: string; p: SwapView['buyer'] }) {
  return (
    <span className="text-fog-3">
      <span className={p.platform ? 'font-medium text-key' : 'font-medium text-fog'}>{p.label}</span> {verb} <span className="text-fog-4">({who})</span>
    </span>
  );
}

export function Clocks({ swap, chains, now }: { swap: SwapView; chains: MonitorState['chains']; now: number }) {
  const items: Array<{ label: string; value: string; tone?: string }> = [];
  if (swap.status === 'awaiting_buyer_lock') items.push({ label: 'buyer must lock in', value: countdown(new Date(swap.deadlines.buyerLockBy).getTime(), now) });
  if (swap.status === 'awaiting_seller_lock' && swap.deadlines.sellerLockBy) items.push({ label: 'seller must lock in', value: countdown(new Date(swap.deadlines.sellerLockBy).getTime(), now) });
  if (swap.btq.refundLocktime && !swap.btq.claimTxid && !swap.btq.refundTxid && swap.btq.lockTxid) {
    const left = swap.btq.refundLocktime - chains.btq.tip;
    items.push({ label: 'BTQ refund opens', value: left > 0 ? `in ${left} blocks (~${left * chains.btq.targetBlockSec}s)` : `open since ${-left} blocks`, tone: left > 0 ? undefined : 'text-warn' });
  }
  if (swap.evm.deadline && !swap.evm.claimTx && !swap.evm.refundTx) {
    const t = new Date(swap.evm.deadline).getTime();
    items.push({ label: 'USDT lock expires', value: countdown(t, now), tone: t < now ? 'text-warn' : undefined });
  }
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
      {items.map((i) => (
        <span key={i.label} className="text-fog-3">
          {i.label} <span className={`font-medium ${i.tone ?? 'text-fog'}`}>{i.value}</span>
        </span>
      ))}
    </div>
  );
}

export function SwapCard({ swap, chains, now }: { swap: SwapView; chains: MonitorState['chains']; now: number }) {
  return (
    <Link to={`/swap/${swap.shortId}`} className="panel block p-4 transition-colors hover:border-ink-soft focus-visible:border-key">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex items-baseline gap-3">
          <span className="text-lg font-semibold tabular-nums text-fog">#{swap.shortId}</span>
          <span className="tabular-nums text-fog">
            <span className="text-btq">{trimAmount(swap.amountBtq, 6)} BTQ</span>
            <span className="mx-1.5 text-fog-4">⇄</span>
            <span className="text-evm">{trimAmount(swap.amountUsdt, 2)} USDT</span>
          </span>
          <span className="text-sm text-fog-3">at {trimAmount(swap.price, 4)}</span>
        </div>
        <div className="flex items-center gap-3">
          <StatusChip swap={swap} />
          <span className="text-xs text-fog-4">{ago(swap.createdAt, now)}</span>
        </div>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-5 text-sm">
        <PartyLine who="buyer" verb="pays USDT" p={swap.buyer} />
        <PartyLine who="seller" verb="pays BTQ" p={swap.seller} />
      </div>
      <div className="mt-2">
        <Braid swap={swap} />
      </div>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
        <Clocks swap={swap} chains={chains} now={now} />
        <span className="hash text-fog-4">
          {swap.preimage ? (
            <>
              secret <span className="text-key">{short(swap.preimage, 10, 6)}</span>
            </>
          ) : swap.secretHash ? (
            <>sha256 {short(swap.secretHash, 10, 6)}</>
          ) : (
            'secret not set'
          )}
        </span>
      </div>
      {swap.failureReason && swap.tone !== 'success' && <p className="mt-2 text-xs text-warn">{swap.failureReason}</p>}
    </Link>
  );
}
