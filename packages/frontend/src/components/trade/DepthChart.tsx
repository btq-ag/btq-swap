import { useMemo } from 'react';
import type { BookRow } from './OrderBook';

/** Depth from the live book. A single level still draws a filled step so the pane is not blank. */
export function DepthChart({ bids, asks }: { bids: BookRow[]; asks: BookRow[] }) {
  const geometry = useMemo(() => {
    const bidRows = [...bids].filter((r) => Number.isFinite(Number(r.price))).sort((a, b) => Number(b.price) - Number(a.price));
    const askRows = [...asks].filter((r) => Number.isFinite(Number(r.price))).sort((a, b) => Number(a.price) - Number(b.price));
    const prices = [...bidRows, ...askRows].map((r) => Number(r.price));
    if (!prices.length) return null;
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const pad = Math.max((max - min) * 0.2, min * 0.004, 0.01);
    const lo = min - pad;
    const hi = max + pad;
    const span = hi - lo || 1;
    const xOf = (price: number) => ((price - lo) / span) * 100;
    const steps = (rows: BookRow[], toward: 'left' | 'right') => {
      let cum = 0;
      const pts: Array<{ x: number; cum: number }> = [];
      if (!rows.length) return pts;
      pts.push({ x: xOf(Number(rows[0]!.price)), cum: 0 });
      for (const row of rows) {
        cum += Number(row.remainingBtq) || 0;
        pts.push({ x: xOf(Number(row.price)), cum });
      }
      pts.push({ x: toward === 'left' ? 0 : 100, cum });
      return pts;
    };
    const bidPts = steps(bidRows, 'left');
    const askPts = steps(askRows, 'right');
    const maxCum = Math.max(1, ...bidPts.map((p) => p.cum), ...askPts.map((p) => p.cum));
    const yOf = (cum: number) => 92 - (cum / maxCum) * 78;
    const area = (pts: Array<{ x: number; cum: number }>) => {
      if (pts.length < 2) return '';
      const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${yOf(p.cum).toFixed(2)}`).join(' ');
      const last = pts[pts.length - 1]!;
      const first = pts[0]!;
      return `${line} L ${last.x.toFixed(2)} 100 L ${first.x.toFixed(2)} 100 Z`;
    };
    return { bid: area(bidPts), ask: area(askPts) };
  }, [asks, bids]);

  return (
    <section className="flex min-h-[320px] flex-1 flex-col bg-ink" aria-label="Depth">
      <header className="flex items-center justify-between px-4 py-2">
        <h2 className="text-[13px] font-semibold text-fog">Depth</h2>
        <span className="text-[11px] text-fog-3">BTQ resting on the book</span>
      </header>
      {!geometry ? (
        <p className="px-4 py-8 text-[12px] text-fog-3">Depth appears when the book has a bid or an ask.</p>
      ) : (
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="min-h-[240px] w-full flex-1" role="img" aria-label="Bid and ask depth">
          <path d={geometry.bid} fill="rgba(0,200,130,0.16)" stroke="#00C882" strokeWidth="0.8" vectorEffect="non-scaling-stroke" />
          <path d={geometry.ask} fill="rgba(244,70,86,0.16)" stroke="#F44656" strokeWidth="0.8" vectorEffect="non-scaling-stroke" />
        </svg>
      )}
    </section>
  );
}
