import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrderDirection, OrderStatus, type OrderRow } from '../src/types/order.types';

const { getOneMock } = vi.hoisted(() => ({
  getOneMock: vi.fn(),
}));

vi.mock('../src/lib/db', () => ({
  query: vi.fn(),
  getOne: getOneMock,
  getMany: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('../src/services/matching.service', () => ({
  matchingService: { matchOrder: vi.fn() },
}));

vi.mock('../src/services/notification.service', () => ({
  notificationService: { emitOrderbookUpdate: vi.fn() },
}));

import { orderService } from '../src/services/order.service';

function sellOrder(): OrderRow {
  return {
    id: 'sell-order-1',
    user_id: 'user-1',
    direction: OrderDirection.SELL,
    amount_btq: '10.00000000',
    price_usdt: '2.000000',
    amount_usdt: '20.000000',
    filled_btq: '0',
    status: OrderStatus.OPEN,
    expires_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    secret_hash: null,
    btq_htlc_txid: null,
    btq_htlc_vout: null,
    is_funded: false,
    locked_by_swap_id: null,
    user_dilithium_pubkey: null,
    user_btq_address: null,
  };
}

describe('orderService.fundOrder sell timelock guard', () => {
  beforeEach(() => {
    getOneMock.mockReset();
  });

  it('rejects sell funding when no active funded buy order exists', async () => {
    getOneMock
      .mockResolvedValueOnce(sellOrder()) // load order
      .mockResolvedValueOnce(null); // load best buy candidate

    await expect(
      orderService.fundOrder('sell-order-1', 'user-1', {
        secret_hash: 'ab'.repeat(32),
        btq_htlc_txid: 'f'.repeat(64),
        btq_htlc_vout: 0,
      }),
    ).rejects.toThrow('No active funded buy order is available yet for this sell order');
  });

  it('rejects sell funding when matching buy timelock is too close to expiry', async () => {
    const now = Date.now();
    getOneMock
      .mockResolvedValueOnce(sellOrder()) // load order
      .mockResolvedValueOnce({
        id: 'buy-order-1',
        created_at: new Date(now - 60_000),
        expires_at: new Date(now + (2 * 60_000)),
      }); // best buy candidate expires too soon

    await expect(
      orderService.fundOrder('sell-order-1', 'user-1', {
        secret_hash: 'ab'.repeat(32),
        btq_htlc_txid: 'f'.repeat(64),
        btq_htlc_vout: 0,
      }),
    ).rejects.toThrow('Matching buy order timelock is too close to expiry; wait for a fresher buy order');
  });
});
