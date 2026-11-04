import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrderDirection, OrderStatus, type OrderRow } from '../src/types/order.types';

const { getOneMock, getRawTransactionMock } = vi.hoisted(() => ({
  getOneMock: vi.fn(),
  getRawTransactionMock: vi.fn(),
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

vi.mock('../src/services/btq.service', () => ({
  btqService: {
    getRawTransaction: getRawTransactionMock,
  },
}));

import { orderService } from '../src/services/order.service';

function fundedSellOrder(): OrderRow {
  return {
    id: 'order-1',
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
    btq_htlc_txid: '50ce88d5e12a638914cf1839e744d3e9ba96cc47f5066e9382714bf07bd22477',
    btq_htlc_vout: 0,
    is_funded: true,
    locked_by_swap_id: null,
    user_dilithium_pubkey: null,
    user_btq_address: null,
  };
}

describe('orderService.getOrderFundingStatus', () => {
  beforeEach(() => {
    getOneMock.mockReset();
    getRawTransactionMock.mockReset();
  });

  it('returns verified true when a qualifying P2MR output exists', async () => {
    getOneMock.mockResolvedValueOnce(fundedSellOrder());
    getRawTransactionMock.mockResolvedValueOnce({
      txid: fundedSellOrder().btq_htlc_txid,
      confirmations: 2,
      vout: [
        {
          n: 0,
          value: 4.9999976,
          scriptPubKey: { type: 'witness_v1_taproot', address: 'qcrt1p...' },
        },
        {
          n: 1,
          value: 10,
          scriptPubKey: { type: 'witness_v2_p2mr', address: 'qcrt1z...' },
        },
      ],
    });

    const status = await orderService.getOrderFundingStatus('order-1', 'user-1');
    expect(status.btq?.verified).toBe(true);
    expect(status.btq?.resolvedVout).toBe(1);
    expect(status.btq?.confirmations).toBe(2);
  });
});
