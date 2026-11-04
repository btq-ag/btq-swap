import { useState } from 'react';
import type { OrderSide } from '../../types';
import { useOrders } from '../../hooks/useOrders';

export function OrderForm() {
  const { placeOrder, loading, error } = useOrders();
  const [side, setSide] = useState<OrderSide>('buy');
  const [price, setPrice] = useState('');
  const [amount, setAmount] = useState('');

  const total = price && amount ? (Number(price) * Number(amount)).toFixed(2) : '';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!price || !amount) return;
    await placeOrder(side, price, amount);
    setPrice('');
    setAmount('');
  };

  return (
    <form onSubmit={handleSubmit} className="rounded-xl border border-slate-700/50 bg-slate-800/50 p-5">
      <h3 className="mb-4 text-base font-semibold text-white">Place Limit Order</h3>

      <div className="mb-4 flex rounded-lg bg-slate-900 p-1">
        <button
          type="button"
          onClick={() => setSide('buy')}
          className={`flex-1 rounded-md py-2 text-sm font-medium transition-all ${
            side === 'buy'
              ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-600/20'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          Buy BTQ
        </button>
        <button
          type="button"
          onClick={() => setSide('sell')}
          className={`flex-1 rounded-md py-2 text-sm font-medium transition-all ${
            side === 'sell'
              ? 'bg-red-600 text-white shadow-lg shadow-red-600/20'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          Sell BTQ
        </button>
      </div>

      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-sm text-slate-400">Price (USDT)</label>
          <input
            type="number"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="0.00"
            step="0.01"
            className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2.5 text-sm text-white placeholder-slate-500 outline-none transition-colors focus:border-blue-500 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm text-slate-400">Amount (BTQ)</label>
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00000000"
            step="0.00000001"
            className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2.5 text-sm text-white placeholder-slate-500 outline-none transition-colors focus:border-blue-500 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
        </div>
        {total && (
          <div className="flex items-center justify-between rounded-lg bg-slate-900/50 px-3 py-2 text-sm">
            <span className="text-slate-400">Total</span>
            <span className="font-mono text-white">{total} USDT</span>
          </div>
        )}
      </div>

      {error && <p className="mt-3 text-xs text-red-400">{error}</p>}

      <button
        type="submit"
        disabled={loading || !price || !amount}
        className={`mt-4 w-full rounded-lg py-3 text-sm font-semibold text-white transition-all disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500 ${
          side === 'buy'
            ? 'bg-emerald-600 shadow-lg shadow-emerald-600/20 hover:bg-emerald-500'
            : 'bg-red-600 shadow-lg shadow-red-600/20 hover:bg-red-500'
        }`}
      >
        {loading ? 'Placing Order…' : side === 'buy' ? 'Place Buy Order' : 'Place Sell Order'}
      </button>
    </form>
  );
}
