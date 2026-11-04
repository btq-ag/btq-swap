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

vi.mock('../src/services/btq.service', () => ({
  btqService: {
    getRawTransaction: vi.fn(),
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

describe('orderService.getSellFundingCommands', () => {
  beforeEach(() => {
    getOneMock.mockReset();
  });

  it('returns P2MR command sequence for sell funding', async () => {
    getOneMock
      .mockResolvedValueOnce(sellOrder()) // getSellFundingCommands order lookup
      .mockResolvedValueOnce(sellOrder()) // getSellFundingContext order lookup
      .mockResolvedValueOnce({
        id: 'buy-order-1',
        created_at: new Date(Date.now() - 60_000),
        expires_at: new Date(Date.now() + (20 * 60_000)),
        user_dilithium_pubkey: 'a1'.repeat(32),
      }) // best matching funded buy
      .mockResolvedValueOnce({
        dilithium_pubkey: 'b2'.repeat(32),
        btq_address: 'qcrt1qexample',
      }); // user btq profile

    const result = await orderService.getSellFundingCommands(
      'sell-order-1',
      'user-1',
      'ab'.repeat(32),
      30,
    );

    expect(result.timelockBlocks).toBe(30);
    expect(result.counterpartyDilithiumPubkey).toBe('a1'.repeat(32));
    expect(result.refundDilithiumPubkey).toBe('b2'.repeat(32));
    expect(result.createAddressCommand).toContain('getnewp2mraddress');
    expect(result.createAddressCommand).toContain('"order-sell-order-1"');
    expect(result.sendToAddressCommand).toBe(
      'btq-cli -regtest -rpcwallet=swap-wallet -named sendtoaddress address="<p2mr_address_from_step1>" amount=10.00000000 fee_rate=1',
    );
    expect(result.verifyTxCommand).toContain('getrawtransaction');
  });

  it('falls back to buyer profile pubkey when buy order pubkey is missing', async () => {
    getOneMock
      .mockResolvedValueOnce(sellOrder()) // getSellFundingCommands order lookup
      .mockResolvedValueOnce(sellOrder()) // getSellFundingContext order lookup
      .mockResolvedValueOnce({
        id: 'buy-order-1',
        created_at: new Date(Date.now() - 60_000),
        expires_at: new Date(Date.now() + (20 * 60_000)),
        user_dilithium_pubkey: 'c3'.repeat(32),
      }) // best matching funded buy (from fallback join)
      .mockResolvedValueOnce({
        dilithium_pubkey: 'b2'.repeat(32),
        btq_address: 'qcrt1qexample',
      }); // user btq profile

    const result = await orderService.getSellFundingCommands(
      'sell-order-1',
      'user-1',
      'ab'.repeat(32),
      30,
    );

    expect(result.counterpartyDilithiumPubkey).toBe('c3'.repeat(32));
  });

  it('rejects invalid secret hash', async () => {
    await expect(
      orderService.getSellFundingCommands('sell-order-1', 'user-1', 'not-hex', 30),
    ).rejects.toThrow('Invalid secret hash: expected 32-byte hex');
  });
});
