import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { StatusBadge } from '../../components/common/StatusBadge';
import type { Swap, PaginatedResponse, SwapStatus } from '../../types';

const STATUS_FILTERS: { label: string; value: string }[] = [
  { label: 'All', value: '' },
  { label: 'Pending', value: 'pending' },
  { label: 'Active', value: 'active' },
  { label: 'Completed', value: 'completed' },
  { label: 'Expired', value: 'expired' },
  { label: 'Failed', value: 'failed' },
];

export function SwapsPage() {
  const navigate = useNavigate();
  const [swaps, setSwaps] = useState<Swap[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const limit = 25;

  useEffect(() => {
    setLoading(true);
    const query = filter ? `&status=${filter}` : '';
    api
      .get<PaginatedResponse<Swap>>(`/admin/swaps?page=${page}&limit=${limit}${query}`)
      .then((res) => {
        setSwaps(res.data);
        setTotal(res.total);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [page, filter]);

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">All Swaps</h1>
        <span className="text-sm text-slate-400">{total} total</span>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        {STATUS_FILTERS.map(({ label, value }) => (
          <button
            key={value}
            onClick={() => { setFilter(value); setPage(1); }}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              filter === value
                ? 'bg-blue-600 text-white'
                : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-200'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Table */}
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-slate-800/50" />
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-700/50">
          <table className="w-full min-w-[800px]">
            <thead>
              <tr className="bg-slate-800/80">
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-400">ID</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-400">User</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-400">Direction</th>
                <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-slate-400">BTQ</th>
                <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-slate-400">USDT</th>
                <th className="px-4 py-3 text-center text-xs font-medium uppercase tracking-wider text-slate-400">Status</th>
                <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-slate-400">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/50">
              {swaps.map((swap) => (
                <tr
                  key={swap.id}
                  onClick={() => navigate(`/swaps/${swap.id}`)}
                  className="cursor-pointer bg-slate-800/30 transition-colors hover:bg-slate-800/60"
                >
                  <td className="px-4 py-3 font-mono text-xs text-slate-400">
                    {swap.id.slice(0, 8)}…
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-300">
                    {swap.userAddress.slice(0, 6)}…{swap.userAddress.slice(-4)}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-xs font-semibold ${
                      swap.direction === 'buy_btq' ? 'text-emerald-400' : 'text-blue-400'
                    }`}>
                      {swap.direction === 'buy_btq' ? 'BUY' : 'SELL'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-sm text-white">
                    {Number(swap.btqAmount).toFixed(8)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-sm text-white">
                    {Number(swap.usdtAmount).toFixed(2)}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <StatusBadge status={swap.status} />
                  </td>
                  <td className="px-4 py-3 text-right text-xs text-slate-400">
                    {new Date(swap.createdAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-slate-400">
            Page {page} of {totalPages}
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-700 disabled:cursor-not-allowed disabled:text-slate-600"
            >
              Previous
            </button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-700 disabled:cursor-not-allowed disabled:text-slate-600"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
