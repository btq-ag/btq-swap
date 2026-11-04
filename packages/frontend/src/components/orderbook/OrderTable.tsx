import type { Order } from '../../types';

interface OrderTableProps {
  orders: Order[];
  showCancel?: boolean;
  onCancel?: (id: string) => void;
}

export function OrderTable({ orders = [], showCancel = false, onCancel }: OrderTableProps) {
  if (!orders || orders.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-slate-700/50 bg-slate-800/50 py-12">
        <svg className="mb-3 h-10 w-10 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
        </svg>
        <p className="text-sm text-slate-500">No orders found</p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-700/50">
      <table className="w-full">
        <thead>
          <tr className="bg-slate-800/80">
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-400">Side</th>
            <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-slate-400">Price</th>
            <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-slate-400">Amount</th>
            <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-slate-400">Filled</th>
            <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-slate-400">Status</th>
            {showCancel && (
              <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-slate-400">Action</th>
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-700/50">
          {orders.map((order) => (
            <tr key={order.id} className="bg-slate-800/30 transition-colors hover:bg-slate-800/60">
              <td className="px-4 py-3">
                <span
                  className={`text-sm font-medium ${
                    order.side === 'buy' ? 'text-emerald-400' : 'text-red-400'
                  }`}
                >
                  {order.side.toUpperCase()}
                </span>
              </td>
              <td className="px-4 py-3 text-right font-mono text-sm text-white">
                {Number(order.price).toFixed(2)}
              </td>
              <td className="px-4 py-3 text-right font-mono text-sm text-white">
                {Number(order.btqAmount).toFixed(8)}
              </td>
              <td className="px-4 py-3 text-right font-mono text-sm text-slate-400">
                {Number(order.filledAmount).toFixed(8)}
              </td>
              <td className="px-4 py-3 text-right">
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                    order.status === 'open'
                      ? 'bg-blue-500/20 text-blue-400'
                      : order.status === 'filled'
                        ? 'bg-emerald-500/20 text-emerald-400'
                        : order.status === 'partial'
                          ? 'bg-amber-500/20 text-amber-400'
                          : 'bg-slate-500/20 text-slate-400'
                  }`}
                >
                  {order.status}
                </span>
              </td>
              {showCancel && (
                <td className="px-4 py-3 text-right">
                  {order.status === 'open' && onCancel && (
                    <button
                      onClick={() => onCancel(order.id)}
                      className="text-xs text-red-400 transition-colors hover:text-red-300"
                    >
                      Cancel
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
