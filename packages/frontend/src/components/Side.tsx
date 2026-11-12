import type { MonitorState } from '../api';
import { ago, trimAmount } from '../hooks';

const EVENT_TEXT: Record<string, string> = {
  matched: 'matched',
  evm_locked: 'USDT locked on EVM',
  evm_lock_confirmed: 'USDT lock confirmed · BTQ HTLC address issued',
  btq_locked: 'BTQ locked in P2MR HTLC',
  btq_lock_confirmed: 'BTQ lock confirmed',
  btq_claimed: 'BTQ claimed · secret revealed',
  evm_claimed: 'USDT claimed with the secret',
  evm_refunded: 'USDT refunded',
  btq_refunded: 'BTQ refunded',
  buyer_lock_window_passed: 'buyer missed the lock window',
  seller_lock_window_passed: 'seller missed the lock window',
  btq_timelock_reached: 'BTQ timelock reached',
  evm_lock_rejected: 'USDT lock rejected',
  btq_lock_rejected: 'BTQ lock rejected',
  platform_evm_lock: 'MM locked USDT',
  platform_btq_lock: 'MM locked BTQ',
  platform_btq_claim: 'MM claimed BTQ',
  platform_evm_claim: 'MM claimed USDT',
  platform_btq_refund: 'MM refunded BTQ',
  platform_evm_refund: 'MM refunded USDT',
  btq_lock_hint: 'seller reported lock txid',
};

export function EventStream({ events, now }: { events: MonitorState['events']; now: number }) {
  return (
    <section className="panel p-4" aria-labelledby="ev-h">
      <h2 id="ev-h" className="text-sm font-semibold text-fog">Settlement log</h2>
      <ol className="mt-3 max-h-[420px] space-y-2 overflow-y-auto pr-1 text-sm">
        {events.length === 0 && <li className="text-fog-3">Nothing has happened yet. Run a swap from Discord with <code className="hash">/swap buy</code>.</li>}
        {events.map((e, i) => {
          const tone = e.type.includes('reject') || e.type.includes('passed') ? 'text-warn' : e.type.includes('refund') ? 'text-warn' : e.type.includes('claimed') ? 'text-key' : 'text-fog-2';
          return (
            <li key={`${e.swap}-${e.at}-${i}`} className="flex gap-3">
              <span className="w-12 shrink-0 tabular-nums text-fog-4">#{e.swap}</span>
              <span className={`flex-1 ${tone}`}>
                {EVENT_TEXT[e.type] ?? e.type.replace(/_/g, ' ')}
                {typeof e.meta?.reason === 'string' && <span className="block text-xs text-fog-4">{String(e.meta.reason)}</span>}
              </span>
              <span className="shrink-0 text-xs text-fog-4">{ago(e.at, now)}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function BookPanel({ book }: { book: MonitorState['book'] }) {
  const maxQty = Math.max(1, ...[...book.topAsks, ...book.topBids].map((o) => Number(o.remainingBtq)));
  const Row = ({ o, side }: { o: MonitorState['book']['topAsks'][number]; side: 'ask' | 'bid' }) => (
    <li className="relative flex justify-between px-2 py-1 text-sm tabular-nums">
      <span className={`absolute inset-y-0 right-0 rounded ${side === 'ask' ? 'bg-btq/10' : 'bg-evm/10'}`} style={{ width: `${(Number(o.remainingBtq) / maxQty) * 100}%` }} aria-hidden />
      <span className="relative text-fog-4">#{o.orderNo}</span>
      <span className={`relative ${side === 'ask' ? 'text-btq' : 'text-evm'}`}>{trimAmount(o.price, 4)}</span>
      <span className="relative text-fog-2">{trimAmount(o.remainingBtq, 4)}{o.mm && <span className="ml-1 text-key">MM</span>}</span>
    </li>
  );
  return (
    <section className="panel p-4" aria-labelledby="book-h">
      <div className="flex items-baseline justify-between">
        <h2 id="book-h" className="text-sm font-semibold text-fog">Order book</h2>
        {book.paused ? <span className="text-xs font-medium text-warn">paused by operator</span> : <span className="text-xs text-fog-4">orders are intents — funds move only inside HTLCs</span>}
      </div>
      <ul className="mt-3 space-y-0.5">
        {[...book.topAsks].reverse().slice(-6).map((o) => <Row key={o.orderNo} o={o} side="ask" />)}
      </ul>
      <div className="my-2 flex justify-between border-y border-ink-line px-2 py-1.5 text-xs text-fog-3">
        <span>spread</span>
        <span className="tabular-nums">{book.bestAsk && book.bestBid ? trimAmount(String(Number(book.bestAsk) - Number(book.bestBid)), 4) : '—'} USDT</span>
      </div>
      <ul className="space-y-0.5">
        {book.topBids.slice(0, 6).map((o) => <Row key={o.orderNo} o={o} side="bid" />)}
      </ul>
    </section>
  );
}

export function InventoryPanel({ inv }: { inv: MonitorState['inventory'] }) {
  if (!inv) return null;
  return (
    <section className="panel p-4" aria-labelledby="inv-h">
      <h2 id="inv-h" className="text-sm font-semibold text-fog">Market-maker inventory</h2>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <dt className="text-fog-3">BTQ wallet</dt>
        <dd className="text-right tabular-nums text-btq">{trimAmount(inv.btq, 4)}</dd>
        <dt className="text-fog-3">BTQ in HTLCs</dt>
        <dd className="text-right tabular-nums text-fog-2">{trimAmount(inv.btqInHtlc, 4)}</dd>
        <dt className="text-fog-3">USDT wallet</dt>
        <dd className="text-right tabular-nums text-evm">{trimAmount(inv.usdt, 2)}</dd>
        <dt className="text-fog-3">USDT in HTLCs</dt>
        <dd className="text-right tabular-nums text-fog-2">{trimAmount(inv.usdtInHtlc, 2)}</dd>
      </dl>
    </section>
  );
}

export function NotificationPanel({ items, now }: { items: MonitorState['notifications']; now: number }) {
  return (
    <section className="panel p-4" aria-labelledby="dm-h">
      <h2 id="dm-h" className="text-sm font-semibold text-fog">Discord DMs</h2>
      <ul className="mt-3 max-h-60 space-y-1.5 overflow-y-auto text-sm">
        {items.length === 0 && <li className="text-fog-3">No messages yet.</li>}
        {items.map((n, i) => (
          <li key={i} className="flex gap-2">
            <span className={`w-16 shrink-0 text-xs ${n.status === 'sent' ? 'text-ok' : n.status === 'failed' ? 'text-bad' : 'text-fog-4'}`}>{n.status}</span>
            <span className="flex-1 truncate text-fog-2" title={n.title}>
              <span className="text-fog-3">{n.user}</span> {n.title.replace(/^Swap #\d+ — /, '')}
            </span>
            <span className="shrink-0 text-xs text-fog-4">{ago(n.at, now)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
