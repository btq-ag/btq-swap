import { useEffect, useState } from 'react';
import type { DepthEntry } from '../../types';
import { useOrders } from '../../hooks/useOrders';

export function DepthChart() {
  const { fetchDepth } = useOrders();
  const [bids, setBids] = useState<DepthEntry[]>([]);
  const [asks, setAsks] = useState<DepthEntry[]>([]);

  useEffect(() => {
    fetchDepth().then((data) => {
      setBids(data.bids);
      setAsks(data.asks);
    });
  }, [fetchDepth]);

  const maxTotal = Math.max(
    ...bids.map((b) => b.total),
    ...asks.map((a) => a.total),
    1
  );

  return (
    <div className="rounded-xl border border-slate-700/50 bg-slate-800/50 p-5">
      <h3 className="mb-4 text-base font-semibold text-white">Order Depth</h3>

      {bids.length === 0 && asks.length === 0 ? (
        <div className="flex h-40 items-center justify-center">
          <p className="text-sm text-slate-500">No depth data available</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          {/* Bids (buy) */}
          <div>
            <p className="mb-2 text-xs font-medium uppercase text-emerald-400">Bids</p>
            <div className="space-y-1">
              {bids.slice(0, 8).map((entry, i) => (
                <div key={i} className="relative overflow-hidden rounded text-xs">
                  <div
                    className="absolute inset-y-0 left-0 bg-emerald-500/10"
                    style={{ width: `${(entry.total / maxTotal) * 100}%` }}
                  />
                  <div className="relative flex items-center justify-between px-2 py-1.5">
                    <span className="font-mono text-emerald-400">{entry.price.toFixed(2)}</span>
                    <span className="font-mono text-slate-300">{entry.amount.toFixed(4)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Asks (sell) */}
          <div>
            <p className="mb-2 text-xs font-medium uppercase text-red-400">Asks</p>
            <div className="space-y-1">
              {asks.slice(0, 8).map((entry, i) => (
                <div key={i} className="relative overflow-hidden rounded text-xs">
                  <div
                    className="absolute inset-y-0 right-0 bg-red-500/10"
                    style={{ width: `${(entry.total / maxTotal) * 100}%` }}
                  />
                  <div className="relative flex items-center justify-between px-2 py-1.5">
                    <span className="font-mono text-red-400">{entry.price.toFixed(2)}</span>
                    <span className="font-mono text-slate-300">{entry.amount.toFixed(4)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
