import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { StatusBadge } from '../components/common/StatusBadge';
import { useSwap } from '../hooks/useSwap';
import type { Swap } from '../types';

export function HistoryPage() {
  const navigate = useNavigate();
  const { fetchHistory } = useSwap();
  const [swaps, setSwaps] = useState<Swap[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const limit = 20;

  useEffect(() => {
    setLoading(true);
    fetchHistory(page, limit)
      .then((res) => {
        const items = res?.swaps ?? [];
        setSwaps(items);
        setTotal(items.length < limit ? (page - 1) * limit + items.length : (page + 1) * limit);
        setLoadError(null);
      })
      .catch((err) => {
        setSwaps([]);
        setTotal(0);
        setLoadError(err instanceof Error ? err.message : 'Failed to load activity');
      })
      .finally(() => setLoading(false));
  }, [page, fetchHistory, reloadTick]);

  const hasNextPage = swaps.length >= limit;
  const totalPages = Math.max(page, hasNextPage ? page + 1 : page);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Activity</h1>
        <p className="text-sm text-slate-400">Your completed and in-flight swap records</p>
      </div>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl bg-slate-800/50" />
          ))}
        </div>
      ) : loadError ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-slate-700/50 bg-slate-800/50 py-16">
          <p className="text-slate-300">Unable to load activity right now.</p>
          <p className="mt-1 text-xs text-slate-500">{loadError}</p>
          <button
            onClick={() => setReloadTick((v) => v + 1)}
            className="mt-3 text-sm text-blue-400 transition-colors hover:text-blue-300"
          >
            Retry
          </button>
        </div>
      ) : swaps.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-slate-700/50 bg-slate-800/50 py-16">
          <svg className="mb-4 h-12 w-12 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
          </svg>
          <p className="text-slate-400">No activity yet</p>
          <button
            onClick={() => navigate('/')}
            className="mt-3 text-sm text-blue-400 transition-colors hover:text-blue-300"
          >
            Start your first swap →
          </button>
        </div>
      ) : (
        <>
          <div className="overflow-hidden rounded-xl border border-slate-700/50">
            <table className="w-full">
              <thead>
                <tr className="bg-slate-800/80">
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-400">Type</th>
                  <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-slate-400">BTQ</th>
                  <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-slate-400">USDT</th>
                  <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-slate-400">Rate</th>
                  <th className="px-4 py-3 text-center text-xs font-medium uppercase tracking-wider text-slate-400">Status</th>
                  <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-slate-400">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                {swaps.map((swap) => (
                  <tr
                    key={swap.id}
                    onClick={() => navigate(`/swaps/${swap.id}`)}
                    className="cursor-pointer bg-slate-800/30 transition-colors hover:bg-slate-800/60"
                  >
                    <td className="px-4 py-3">
                      <span className={`text-sm font-medium ${
                        swap.direction === 'buy_btq' ? 'text-emerald-400' : 'text-blue-400'
                      }`}>
                        {swap.direction === 'buy_btq' ? 'Buy BTQ' : 'Sell BTQ'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-sm text-white">
                      {Number(swap.btqAmount).toFixed(8)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-sm text-white">
                      {Number(swap.usdtAmount).toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-sm text-slate-400">
                      {Number(swap.rate).toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <StatusBadge status={swap.status} />
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-slate-400">
                      {new Date(swap.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-between">
              <p className="text-sm text-slate-400">
                Showing {(page - 1) * limit + 1}–{Math.min(page * limit, total)} of {total}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm text-slate-300 transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:text-slate-600"
                >
                  Previous
                </button>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm text-slate-300 transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:text-slate-600"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
