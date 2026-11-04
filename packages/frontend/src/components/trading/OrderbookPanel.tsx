import { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../lib/api';

interface OrderLevel {
  price: string;
  amount_btq: string;
  total_usdt: string;
  order_count: number;
}

interface OrderbookData {
  bids: OrderLevel[];
  asks: OrderLevel[];
  spread: string | null;
}

interface FundedOrder {
  id: string;
  direction: 'buy' | 'sell';
  status: 'open' | 'partially_filled';
  price_usdt: string;
  amount_btq: string;
  filled_btq: string;
  remaining_btq: string;
  btq_htlc_txid: string | null;
  btq_htlc_vout: number | null;
  secret_hash_hex: string | null;
  user_dilithium_pubkey: string | null;
  user_btq_address: string | null;
  created_at: string;
  expires_at: string | null;
}

function TimeUntil({ expiresAt }: { expiresAt: string | null }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);

  if (!expiresAt) {
    return <span className="font-mono text-[11px] text-slate-500">Unknown</span>;
  }

  const end = new Date(expiresAt).getTime();
  const remaining = Math.max(0, end - now);
  const expired = remaining <= 0;
  const mins = Math.floor(remaining / 60000);
  const secs = Math.floor((remaining % 60000) / 1000);

  return (
    <span className={`font-mono text-[11px] ${expired ? 'text-red-400' : 'text-amber-300'}`}>
      {expired ? 'Expired' : `${mins}m ${secs.toString().padStart(2, '0')}s`}
    </span>
  );
}

function OrderDetailsModal({
  order,
  onClose,
}: {
  order: FundedOrder;
  onClose: () => void;
}) {
  const oppositeSide = order.direction === 'buy' ? 'sell' : 'buy';

  const handlePrefill = () => {
    window.dispatchEvent(
      new CustomEvent('btq:prefill-order', {
        detail: {
          side: oppositeSide,
          tab: 'limit',
          price: order.price_usdt,
          amount: order.remaining_btq,
        },
      }),
    );
    onClose();
  };

  return createPortal(
    <div className="fixed inset-0 z-[9999] bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className="flex min-h-full items-center justify-center p-4">
        <div
          className="w-full max-w-2xl rounded-2xl border border-slate-700/60 bg-slate-900 shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-start justify-between border-b border-slate-700/50 px-5 py-4">
            <div>
              <h3 className="text-lg font-semibold text-white">Market Order Details</h3>
              <p className="mt-1 text-xs text-slate-400">Quick view before you take this quote</p>
            </div>
            <button onClick={onClose} className="rounded-md p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-300">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="px-5 py-4">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${order.direction === 'buy' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'}`}>
                {order.direction.toUpperCase()}
              </span>
              <span className="rounded-full bg-blue-500/15 px-2.5 py-1 text-xs font-semibold text-blue-300">{order.status}</span>
              <span className="rounded-full bg-slate-700/70 px-2.5 py-1 text-xs font-medium text-slate-300">
                {parseFloat(order.remaining_btq).toFixed(4)} BTQ remaining
              </span>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-slate-700/60 bg-slate-800/40 p-3">
                <p className="text-[11px] uppercase tracking-wide text-slate-500">Price</p>
                <p className="mt-1 font-mono text-base text-white">{parseFloat(order.price_usdt).toFixed(4)} USDT</p>
              </div>
              <div className="rounded-xl border border-slate-700/60 bg-slate-800/40 p-3">
                <p className="text-[11px] uppercase tracking-wide text-slate-500">Lock ends in</p>
                <p className="mt-1 text-base text-white"><TimeUntil expiresAt={order.expires_at} /></p>
              </div>
            </div>
          </div>

          <div className="border-t border-slate-700/50 px-5 py-4">
            <p className="mb-3 text-sm text-slate-300">
              Quick action: place a <span className="font-semibold text-white">{oppositeSide.toUpperCase()}</span> order at
              <span className="mx-1 font-mono text-white">{parseFloat(order.price_usdt).toFixed(4)} USDT</span>
              to take this quote.
            </p>
            <button
              onClick={handlePrefill}
              className="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-500"
            >
              Fill This Order
            </button>

            <details className="mt-4 rounded-lg border border-slate-700/50 bg-slate-800/30 p-3">
              <summary className="cursor-pointer text-xs font-medium text-slate-400">Advanced chain details</summary>
              <div className="mt-2 space-y-1.5 text-xs text-slate-400">
                <p>Order ID: <span className="break-all font-mono text-slate-300">{order.id}</span></p>
                <p>Lock TX: <span className="break-all font-mono text-slate-300">{order.btq_htlc_txid ?? 'n/a'}</span></p>
                <p>Hash: <span className="break-all font-mono text-slate-300">{order.secret_hash_hex ?? 'n/a'}</span></p>
              </div>
            </details>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function OrderbookPanel() {
  const [data, setData] = useState<OrderbookData>({ bids: [], asks: [], spread: null });
  const [fundedOrders, setFundedOrders] = useState<FundedOrder[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<FundedOrder | null>(null);
  const [wsConnected, setWsConnected] = useState(false);

  const fetchBook = useCallback(async () => {
    try {
      const res = await api.get<{ orderbook: OrderbookData }>('/orderbook');
      setData(res.orderbook ?? { bids: [], asks: [], spread: null });
      console.debug('[OrderbookPanel] fetched /orderbook', {
        bids: res.orderbook?.bids?.length ?? 0,
        asks: res.orderbook?.asks?.length ?? 0,
        spread: res.orderbook?.spread ?? null,
      });
    } catch {
      // keep previous data on error
      console.debug('[OrderbookPanel] failed to fetch /orderbook');
    }
  }, []);

  const fetchFundedOrders = useCallback(async () => {
    try {
      const res = await api.get<{ orders: FundedOrder[] }>('/orderbook/orders?limit=20');
      setFundedOrders(res.orders ?? []);
      console.debug('[OrderbookPanel] fetched funded orders', { count: res.orders?.length ?? 0 });
    } catch {
      // Backward-compatible fallback while backend restarts roll out.
      try {
        const fallback = await api.get<{ orders: FundedOrder[] }>('/orders/orderbook/orders?limit=20');
        setFundedOrders(fallback.orders ?? []);
      } catch {
        setFundedOrders([]);
      }
      console.debug('[OrderbookPanel] failed to fetch funded orders');
    }
  }, []);

  useEffect(() => {
    fetchBook();
    fetchFundedOrders();
  }, [fetchBook, fetchFundedOrders, wsConnected]);

  useEffect(() => {
    const onWsConnection = (event: Event) => {
      const custom = event as CustomEvent<{ connected?: boolean }>;
      setWsConnected(Boolean(custom.detail?.connected));
    };
    const onOrderbookUpdate = (event: Event) => {
      const custom = event as CustomEvent<OrderbookData>;
      if (!custom.detail) return;
      setData((prev) => ({
        bids: Array.isArray(custom.detail.bids) ? custom.detail.bids : prev.bids,
        asks: Array.isArray(custom.detail.asks) ? custom.detail.asks : prev.asks,
        spread: typeof custom.detail.spread === 'string' || custom.detail.spread === null
          ? custom.detail.spread
          : prev.spread,
      }));
      void fetchFundedOrders();
    };
    window.addEventListener('ws:connection', onWsConnection as EventListener);
    window.addEventListener('orderbook:update', onOrderbookUpdate as EventListener);
    return () => {
      window.removeEventListener('ws:connection', onWsConnection as EventListener);
      window.removeEventListener('orderbook:update', onOrderbookUpdate as EventListener);
    };
  }, [fetchFundedOrders]);

  useEffect(() => {
    if (wsConnected) return;
    const iv = setInterval(() => {
      fetchBook();
      fetchFundedOrders();
    }, 30000);
    return () => clearInterval(iv);
  }, [fetchBook, fetchFundedOrders]);

  const allAmounts = [
    ...data.bids.map((b) => parseFloat(b.total_usdt || '0')),
    ...data.asks.map((a) => parseFloat(a.total_usdt || '0')),
  ];
  const maxTotal = Math.max(...allAmounts, 1);

  const bestBid = data.bids[0] ? parseFloat(data.bids[0].price) : null;
  const bestAsk = data.asks[0] ? parseFloat(data.asks[0].price) : null;
  const midPrice = bestBid !== null && bestAsk !== null
    ? ((bestBid + bestAsk) / 2).toFixed(4)
    : '--';

  const displayAsks = [...data.asks].slice(0, 12).reverse();
  const displayBids = data.bids.slice(0, 12);

  const isEmpty = data.bids.length === 0 && data.asks.length === 0;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b border-slate-700/50 px-4 py-3">
        <h3 className="text-sm font-semibold text-white">Order Book</h3>
      </div>

      <div className="grid grid-cols-3 border-b border-slate-700/30 px-4 py-2">
        <span className="text-[10px] font-medium uppercase text-slate-500">Price (USDT)</span>
        <span className="text-right text-[10px] font-medium uppercase text-slate-500">Amount (BTQ)</span>
        <span className="text-right text-[10px] font-medium uppercase text-slate-500">Total</span>
      </div>

      {isEmpty ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-xs text-slate-500">No orders yet</p>
        </div>
      ) : (
        <>
          <div className="flex-1 overflow-y-auto" style={{ maxHeight: 240 }}>
            {displayAsks.map((level, i) => {
              const pct = (parseFloat(level.total_usdt) / maxTotal) * 100;
              return (
                <div key={`a-${i}`} className="group relative grid grid-cols-3 px-4 py-[5px] hover:bg-slate-800/60">
                  <div className="pointer-events-none absolute inset-y-0 right-0 bg-red-500/8" style={{ width: `${pct}%` }} />
                  <span className="relative font-mono text-xs text-red-400">{parseFloat(level.price).toFixed(4)}</span>
                  <span className="relative text-right font-mono text-xs text-slate-300">{parseFloat(level.amount_btq).toFixed(4)}</span>
                  <span className="relative text-right font-mono text-xs text-slate-500">{parseFloat(level.total_usdt).toFixed(2)}</span>
                </div>
              );
            })}
          </div>

          <div className="flex items-center justify-center border-y border-slate-700/30 bg-slate-900/50 py-2">
            <span className="text-base font-bold text-white">{midPrice}</span>
            {data.spread && (
              <span className="ml-2 text-xs text-slate-500">Spread: {parseFloat(data.spread).toFixed(4)}</span>
            )}
          </div>

          <div className="flex-1 overflow-y-auto" style={{ maxHeight: 240 }}>
            {displayBids.map((level, i) => {
              const pct = (parseFloat(level.total_usdt) / maxTotal) * 100;
              return (
                <div key={`b-${i}`} className="group relative grid grid-cols-3 px-4 py-[5px] hover:bg-slate-800/60">
                  <div className="pointer-events-none absolute inset-y-0 right-0 bg-emerald-500/8" style={{ width: `${pct}%` }} />
                  <span className="relative font-mono text-xs text-emerald-400">{parseFloat(level.price).toFixed(4)}</span>
                  <span className="relative text-right font-mono text-xs text-slate-300">{parseFloat(level.amount_btq).toFixed(4)}</span>
                  <span className="relative text-right font-mono text-xs text-slate-500">{parseFloat(level.total_usdt).toFixed(2)}</span>
                </div>
              );
            })}
          </div>
        </>
      )}

      <div className="border-t border-slate-700/40 px-4 py-2">
        <p className="text-[10px] font-medium uppercase text-slate-500">Active funded orders</p>
      </div>
      <div className="max-h-40 overflow-y-auto">
        {fundedOrders.length === 0 ? (
          <div className="px-4 py-3 text-xs text-slate-500">No funded orders</div>
        ) : (
          fundedOrders.map((order) => (
            <button
              key={order.id}
              onClick={() => setSelectedOrder(order)}
              className="grid w-full grid-cols-[auto_1fr_auto] items-center gap-2 border-b border-slate-800/40 px-4 py-2 text-left transition-colors hover:bg-slate-800/40"
            >
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${order.direction === 'buy' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'}`}>
                {order.direction.toUpperCase()}
              </span>
              <div className="min-w-0">
                <p className="truncate font-mono text-[11px] text-slate-300">
                  {parseFloat(order.remaining_btq).toFixed(4)} BTQ @ {parseFloat(order.price_usdt).toFixed(4)}
                </p>
              </div>
              <TimeUntil expiresAt={order.expires_at} />
            </button>
          ))
        )}
      </div>

      {selectedOrder && (
        <OrderDetailsModal
          order={selectedOrder}
          onClose={() => setSelectedOrder(null)}
        />
      )}
    </div>
  );
}
