import { useEffect, useRef, useCallback, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { WS_URL } from '../lib/constants';
import { useAuthStore } from '../store/authStore';
import { useSwapStore } from '../store/swapStore';
import type { Swap, SwapRate } from '../types';
import { trackEvent } from '../lib/telemetry';

type OrderbookUpdatePayload = {
  bids?: unknown[];
  asks?: unknown[];
  spread?: string | null;
};

type MatchActionRequiredPayload = {
  swapId: string;
  makerOrderId: string;
  takerOrderId: string;
  makerUserId: string;
  takerUserId: string;
  userId: string;
  role: 'maker' | 'taker';
  orderId: string;
  amountBtq: string;
  priceUsdt: string;
  side: 'buy' | 'sell';
};

type OrdersRefreshPayload = {
  reason: string;
  orderId: string | null;
  swapId: string | null;
  ts: string;
};

export function useWebSocket() {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const { token } = useAuthStore();
  const { updateSwap, setRate } = useSwapStore();

  const connect = useCallback(() => {
    if (socketRef.current?.connected) return;

    const socket = io(WS_URL, {
      auth: { token },
      transports: ['websocket', 'polling'],
    });

    socket.on('swap:update', (data: Partial<Swap> & { swapId?: string }) => {
      const normalized = {
        ...data,
        id: data.id ?? data.swapId,
      };
      updateSwap(normalized as Swap);
      window.dispatchEvent(new CustomEvent('swap:update', { detail: normalized }));
    });

    socket.on('orderbook:update', (data: OrderbookUpdatePayload) => {
      window.dispatchEvent(new CustomEvent('orderbook:update', { detail: data }));
    });

    socket.on('trades:new', (data: { trades?: Array<{ id?: string; price: string; amount: string; side?: string; direction?: string; created_at?: string }> }) => {
      window.dispatchEvent(new CustomEvent('trades:new', { detail: data }));
    });

    socket.on('match:action-required', (data: MatchActionRequiredPayload) => {
      window.dispatchEvent(new CustomEvent('match:action-required', { detail: data }));
    });

    socket.on('orders:refresh', (data: OrdersRefreshPayload) => {
      window.dispatchEvent(new CustomEvent('orders:refresh', { detail: data }));
    });

    socket.on('rate:update', (rate: SwapRate) => {
      setRate(rate);
    });

    socket.on('price:update', (rate: SwapRate) => {
      setRate(rate);
    });

    socket.on('connect_error', (err) => {
      console.error('WebSocket connection error:', err.message);
      setConnected(false);
      window.dispatchEvent(new CustomEvent('ws:connection', { detail: { connected: false } }));
      void trackEvent('ws_connect_failed', { message: err.message });
    });

    socket.on('connect', () => {
      setConnected(true);
      socket.emit('subscribe:orderbook');
      window.dispatchEvent(new CustomEvent('ws:connection', { detail: { connected: true } }));
      void trackEvent('ws_connected');
    });

    socket.on('disconnect', () => {
      setConnected(false);
      window.dispatchEvent(new CustomEvent('ws:connection', { detail: { connected: false } }));
    });

    socketRef.current = socket;
  }, [token, updateSwap, setRate]);

  const disconnect = useCallback(() => {
    socketRef.current?.disconnect();
    socketRef.current = null;
    setConnected(false);
    window.dispatchEvent(new CustomEvent('ws:connection', { detail: { connected: false } }));
  }, []);

  useEffect(() => {
    if (token) {
      connect();
    } else {
      disconnect();
    }
    return () => disconnect();
  }, [token, connect, disconnect]);

  const joinSwapRoom = useCallback((swapId: string) => {
    socketRef.current?.emit('subscribe:swap', swapId);
  }, []);

  const leaveSwapRoom = useCallback((swapId: string) => {
    socketRef.current?.emit('unsubscribe:swap', swapId);
  }, []);

  return { joinSwapRoom, leaveSwapRoom, connected };
}
