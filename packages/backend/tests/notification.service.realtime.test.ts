import { beforeEach, describe, expect, it, vi } from 'vitest';

const emitMock = vi.fn();
const toMock = vi.fn(() => ({ emit: emitMock }));

vi.mock('../src/lib/websocket', () => ({
  getIO: () => ({
    to: toMock,
    emit: emitMock,
  }),
}));

import { notificationService } from '../src/services/notification.service';

describe('notificationService realtime notifications', () => {
  beforeEach(() => {
    emitMock.mockReset();
    toMock.mockClear();
  });

  it('emits match action required for both maker and taker rooms', () => {
    (notificationService as any).emitMatchActionRequired({
      swapId: 'swap-1',
      makerUserId: 'maker-1',
      takerUserId: 'taker-1',
      makerOrderId: 'maker-order-1',
      takerOrderId: 'taker-order-1',
      amountBtq: '2.00000000',
      priceUsdt: '1.250000',
      side: 'sell',
    });

    expect(toMock).toHaveBeenCalledWith('user:maker-1');
    expect(toMock).toHaveBeenCalledWith('user:taker-1');
    expect(emitMock).toHaveBeenCalledWith(
      'match:action-required',
      expect.objectContaining({
        swapId: 'swap-1',
        role: 'maker',
        orderId: 'maker-order-1',
      }),
    );
    expect(emitMock).toHaveBeenCalledWith(
      'match:action-required',
      expect.objectContaining({
        swapId: 'swap-1',
        role: 'taker',
        orderId: 'taker-order-1',
      }),
    );
  });

  it('emits order refresh hint to user room', () => {
    (notificationService as any).emitOrderRefreshHint({
      userId: 'user-1',
      reason: 'reconciliation_update',
      orderId: 'order-1',
      swapId: 'swap-1',
    });

    expect(toMock).toHaveBeenCalledWith('user:user-1');
    expect(emitMock).toHaveBeenCalledWith(
      'orders:refresh',
      expect.objectContaining({
        reason: 'reconciliation_update',
        orderId: 'order-1',
        swapId: 'swap-1',
      }),
    );
  });
});
