import { useEffect, useState, useCallback } from 'react';
import { api } from '../../lib/api';

interface Trade {
  id: string;
  price: string;
  amount: string;
  direction: string;
  created_at: string;
}

export function RecentTrades() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [wsConnected, setWsConnected] = useState(false);

  const fetchTrades = useCallback(async () => {
    try {
      const res = await api.get<{ trades: Trade[] }>('/orders/trades');
      setTrades(res.trades ?? []);
    } catch {
      // keep previous
    }
  }, []);

  useEffect(() => {
    fetchTrades();
  }, [fetchTrades]);

  useEffect(() => {
    const onWsConnection = (event: Event) => {
      const custom = event as CustomEvent<{ connected?: boolean }>;
      setWsConnected(Boolean(custom.detail?.connected));
    };
    const onTradesNew = (event: Event) => {
      const custom = event as CustomEvent<{ trades?: Array<{ id?: string; price: string; amount: string; side?: string; direction?: string; created_at?: string }> }>;
      const incoming = custom.detail?.trades ?? [];
      if (!incoming.length) return;
      const mapped: Trade[] = incoming.map((trade, index) => ({
        id: trade.id ?? `${trade.price}-${trade.amount}-${trade.created_at ?? Date.now()}-${index}`,
        price: trade.price,
        amount: trade.amount,
        direction: trade.side ?? trade.direction ?? 'buy',
        created_at: trade.created_at ?? new Date().toISOString(),
      }));
      setTrades((prev) => [...mapped, ...prev].slice(0, 100));
    };
    window.addEventListener('ws:connection', onWsConnection as EventListener);
    window.addEventListener('trades:new', onTradesNew as EventListener);
    return () => {
      window.removeEventListener('ws:connection', onWsConnection as EventListener);
      window.removeEventListener('trades:new', onTradesNew as EventListener);
    };
  }, []);

  useEffect(() => {
    if (wsConnected) return;
    const iv = setInterval(fetchTrades, 20000);
    return () => clearInterval(iv);
  }, [fetchTrades, wsConnected]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b border-slate-700/50 px-4 py-3">
        <h3 className="text-sm font-semibold text-white">Recent Trades</h3>
      </div>

      <div className="grid grid-cols-3 border-b border-slate-700/30 px-4 py-2">
        <span className="text-[10px] font-medium uppercase text-slate-500">Price (USDT)</span>
        <span className="text-right text-[10px] font-medium uppercase text-slate-500">Amount (BTQ)</span>
        <span className="text-right text-[10px] font-medium uppercase text-slate-500">Time</span>
      </div>

      <div className="flex-1 overflow-y-auto" style={{ maxHeight: 500 }}>
        {trades.length === 0 ? (
          <div className="flex h-32 items-center justify-center">
            <p className="text-xs text-slate-500">No trades yet</p>
          </div>
        ) : (
          trades.map((trade) => (
            <div key={trade.id} className="grid grid-cols-3 px-4 py-[5px] hover:bg-slate-800/60">
              <span className={`font-mono text-xs ${trade.direction === 'buy' ? 'text-emerald-400' : 'text-red-400'}`}>
                {parseFloat(trade.price).toFixed(4)}
              </span>
              <span className="text-right font-mono text-xs text-slate-300">
                {parseFloat(trade.amount).toFixed(4)}
              </span>
              <span className="text-right font-mono text-xs text-slate-500">
                {new Date(trade.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
