import { describe, it, expect, vi } from 'vitest';
import { OrderDirection, OrderStatus, type OrderRow } from '../src/types/order.types';

const { getRawTransactionMock } = vi.hoisted(() => ({
  getRawTransactionMock: vi.fn(),
}));

vi.mock('../src/lib/db', () => ({
  query: vi.fn(),
  getOne: vi.fn(),
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

describe('orderService BTQ funding output selection', () => {
  it('auto-selects matching P2MR output when provided vout does not qualify', async () => {
    getRawTransactionMock.mockResolvedValue({
      txid: '50ce88d5e12a638914cf1839e744d3e9ba96cc47f5066e9382714bf07bd22477',
      vout: [
        {
          n: 0,
          value: 4.9999976,
          scriptPubKey: {
            type: 'witness_v1_taproot',
            address: 'qcrt1p...',
          },
        },
        {
          n: 1,
          value: 10,
          scriptPubKey: {
            type: 'witness_v2_p2mr',
            address: 'qcrt1z...',
          },
        },
      ],
    });

    const result = await (orderService as any).verifySellOrderFundingOnBtq(sellOrder(), {
      secret_hash: 'ab'.repeat(32),
      btq_htlc_txid: '50ce88d5e12a638914cf1839e744d3e9ba96cc47f5066e9382714bf07bd22477',
      btq_htlc_vout: 0,
    });

    expect(result.vout).toBe(1);
    expect(result.fundingTxid).toBe('50ce88d5e12a638914cf1839e744d3e9ba96cc47f5066e9382714bf07bd22477');
  });
});
