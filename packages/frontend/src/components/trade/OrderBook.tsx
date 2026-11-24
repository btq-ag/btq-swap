import { btqText, priceText } from '../../lib/format';

export interface BookRow {
  orderNo: number;
  price: string;
  remainingBtq: string;
  mm: boolean;
  orders?: number;
}

interface Props {
  asks: BookRow[];
  bids: BookRow[];
  paused: boolean;
  selected: number | null;
  onSelect: (side: 'buy' | 'sell', row: BookRow) => void;
}

function Ladder({
  rows,
  side,
  max,
  selected,
  onPick,
}: {
  rows: BookRow[];
  side: 'buy' | 'sell';
  max: number;
  selected: number | null;
  onPick: (row: BookRow) => void;
}) {
  const tone = side === 'buy' ? 'text-positive' : 'text-negative';
  const wash = side === 'buy' ? 'bg-positive/15' : 'bg-negative/15';
  return (
    <div>
      {rows.map((row) => {
        const size = Number(row.remainingBtq);
        const width = max > 0 && Number.isFinite(size) ? Math.min(100, (size / max) * 100) : 0;
        const active = row.orderNo === selected;
        return (
          <button
            key={row.orderNo}
            type="button"
            onClick={() => onPick(row)}
            className={`relative flex h-7 w-full items-center px-3 text-left text-[12px] num hover:bg-white/5 ${active ? 'bg-white/5' : ''}`}
          >
            <span className={`absolute inset-y-0 right-0 ${wash}`} style={{ width: `${width}%` }} />
            <span className={`relative z-10 w-[38%] text-right ${tone}`}>{priceText(row.price)}</span>
            <span className="relative z-10 w-[31%] text-right text-fog">{btqText(row.remainingBtq)}</span>
            <span className="relative z-10 w-[31%] pr-1 text-right text-fog-3">{row.orders ? String(row.orders) : row.mm ? 'MM' : ''}</span>
          </button>
        );
      })}
    </div>
  );
}

export function OrderBook({ asks, bids, paused, selected, onSelect }: Props) {
  const max = Math.max(0, ...[...asks, ...bids].map((r) => Number(r.remainingBtq) || 0));
  const bestAsk = asks[0];
  const bestBid = bids[0];
  return (
    <section className="flex h-full min-h-[480px] flex-col border-white/10 bg-ink lg:border-r" aria-label="Order book">
      <header className="flex items-center justify-between px-3 py-2">
        <h2 className="text-[13px] font-semibold text-fog">Order book</h2>
        {paused && <span className="rounded-control bg-warn/15 px-2 py-0.5 text-[11px] font-medium text-warn">Paused</span>}
      </header>
      <div className="flex px-3 pb-1 text-[10px] text-fog-4">
        <span className="w-[38%] text-right">Price USDT</span>
        <span className="w-[31%] text-right">Amount BTQ</span>
        <span className="w-[31%] pr-1 text-right">Orders</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {asks.length === 0 && bids.length === 0 && <p className="px-3 py-6 text-[12px] text-fog-3">The book is empty.</p>}
        <Ladder rows={[...asks].reverse()} side="sell" max={max} selected={selected} onPick={(row) => onSelect('buy', row)} />
        <div className="flex items-baseline justify-between border-y border-white/10 px-3 py-2">
          <span className="text-[13px] font-semibold num text-fog">{bestBid && bestAsk ? `${priceText(bestBid.price)} – ${priceText(bestAsk.price)}` : priceText(bestAsk?.price ?? bestBid?.price)}</span>
          <span className="text-[11px] text-fog-3">{bestBid && bestAsk ? 'bid – ask' : 'one side'}</span>
        </div>
        <Ladder rows={bids} side="buy" max={max} selected={selected} onPick={(row) => onSelect('sell', row)} />
      </div>
    </section>
  );
}
