import { useState, useCallback } from 'react';
import { api } from '../lib/api';
import type { Order, OrderSide, DepthEntry } from '../types';

interface BackendOrder {
  id: string;
  user_id: string;
  direction: string;
  amount_btq: string;
  price_usdt: string;
  amount_usdt: string;
  filled_btq: string;
  status: string;
  is_funded: boolean;
  locked_by_swap_id: string | null;
  created_at: string;
  expires_at?: string | null;
  [key: string]: unknown;
}

function mapOrder(raw: BackendOrder): Order & { isFunded: boolean; lockedBySwapId: string | null } {
  return {
    id: raw.id,
    userId: raw.user_id,
    userAddress: '',
    side: (raw.direction === 'buy' ? 'buy' : 'sell') as OrderSide,
    status: raw.status as Order['status'],
    price: raw.price_usdt,
    btqAmount: raw.amount_btq,
    filledAmount: raw.filled_btq || '0',
    createdAt: raw.created_at,
    expiresAt: raw.expires_at ?? null,
    isFunded: raw.is_funded ?? false,
    lockedBySwapId: raw.locked_by_swap_id ?? null,
  };
}

export function useOrders() {
  const [orders, setOrders] = useState<(Order & { isFunded: boolean; lockedBySwapId: string | null })[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<{ orders: BackendOrder[] }>('/orders');
      const all = (res.orders ?? []).map(mapOrder);
      const visible = all.filter((o) => {
        if (o.status === 'open' || o.status === 'partially_filled') return true;
        // Keep funded filled orders visible while settlement is in progress.
        // Some flows (e.g. taker-side fills) may not set lockedBySwapId on the order row.
        if (o.status === 'filled' && o.isFunded) return true;
        return false;
      });
      console.log('[useOrders] fetched', {
        total: all.length,
        visible: visible.length,
        statuses: all.map((o) => ({ id: o.id, status: o.status, isFunded: o.isFunded, lockedBySwapId: o.lockedBySwapId })),
      });
      setOrders(visible);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load open orders');
      setOrders([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const placeOrder = useCallback(
    async (side: OrderSide, price: string, btqAmount: string): Promise<Order | null> => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.post<{ order: BackendOrder; fills: number }>('/orders', {
          direction: side,
          amount_btq: btqAmount,
          price_usdt: price,
        });
        const mapped = mapOrder(res.order);
        setOrders((prev) => [mapped, ...prev]);
        return mapped;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to place order');
        return null;
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const cancelOrder = useCallback(async (id: string): Promise<boolean> => {
    try {
      await api.post(`/orders/${id}/cancel`, {});
      setOrders((prev) => prev.filter((o) => o.id !== id));
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel order');
      return false;
    }
  }, []);

  const fetchDepth = useCallback(async (): Promise<{ bids: DepthEntry[]; asks: DepthEntry[] }> => {
    try {
      const res = await api.get<{ orderbook: { bids: DepthEntry[]; asks: DepthEntry[] } }>('/orderbook');
      return {
        bids: res.orderbook?.bids ?? [],
        asks: res.orderbook?.asks ?? [],
      };
    } catch {
      return { bids: [], asks: [] };
    }
  }, []);

  return { orders, loading, error, fetchOrders, placeOrder, cancelOrder, fetchDepth };
}
