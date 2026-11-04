import { getIO } from '../lib/websocket';
import { SwapRow } from '../types/swap.types';

type MatchActionRequiredPayload = {
  swapId: string;
  makerUserId: string;
  takerUserId: string;
  makerOrderId: string;
  takerOrderId: string;
  amountBtq: string;
  priceUsdt: string;
  side: 'buy' | 'sell';
};

type OrderRefreshHintPayload = {
  userId: string;
  reason: string;
  orderId?: string;
  swapId?: string;
};

export class NotificationService {
  emitSwapUpdate(swap: SwapRow): void {
    const io = getIO();
    const payload = {
      swapId: swap.id,
      status: swap.status,
      direction: swap.direction,
      updatedAt: swap.updated_at,
    };

    io.to(`swap:${swap.id}`).emit('swap:update', payload);
    io.to(`user:${swap.user_id}`).emit('swap:update', payload);
  }

  emitSwapCreated(swap: SwapRow): void {
    const io = getIO();
    io.to(`user:${swap.user_id}`).emit('swap:created', {
      swapId: swap.id,
      direction: swap.direction,
      amount_btq: swap.amount_btq,
      amount_usdt: swap.amount_usdt,
      status: swap.status,
    });
  }

  emitSwapCompleted(swap: SwapRow): void {
    const io = getIO();
    io.to(`swap:${swap.id}`).emit('swap:completed', {
      swapId: swap.id,
      direction: swap.direction,
    });
    io.to(`user:${swap.user_id}`).emit('swap:completed', {
      swapId: swap.id,
      direction: swap.direction,
    });
  }

  emitSwapFailed(swap: SwapRow, reason: string): void {
    const io = getIO();
    const payload = { swapId: swap.id, reason };
    io.to(`swap:${swap.id}`).emit('swap:failed', payload);
    io.to(`user:${swap.user_id}`).emit('swap:failed', payload);
  }

  emitOrderbookUpdate(orderbook: unknown): void {
    const io = getIO();
    io.to('orderbook').emit('orderbook:update', orderbook);
  }

  emitPriceUpdate(bid: string, ask: string): void {
    const io = getIO();
    io.emit('price:update', { bid, ask });
  }

  emitCliCommands(userId: string, swapId: string, commands: Record<string, string>): void {
    const io = getIO();
    io.to(`user:${userId}`).emit('swap:cli-commands', { swapId, commands });
  }

  emitTradeExecuted(trades: { price: string; amount: string; side: string }[]): void {
    const io = getIO();
    io.to('orderbook').emit('trades:new', { trades });
  }

  emitMatchActionRequired(payload: MatchActionRequiredPayload): void {
    const io = getIO();
    io.to(`user:${payload.makerUserId}`).emit('match:action-required', {
      ...payload,
      role: 'maker',
      userId: payload.makerUserId,
      orderId: payload.makerOrderId,
    });
    io.to(`user:${payload.takerUserId}`).emit('match:action-required', {
      ...payload,
      role: 'taker',
      userId: payload.takerUserId,
      orderId: payload.takerOrderId,
    });
  }

  emitOrderRefreshHint(payload: OrderRefreshHintPayload): void {
    const io = getIO();
    io.to(`user:${payload.userId}`).emit('orders:refresh', {
      reason: payload.reason,
      orderId: payload.orderId ?? null,
      swapId: payload.swapId ?? null,
      ts: new Date().toISOString(),
    });
  }
}

export const notificationService = new NotificationService();
