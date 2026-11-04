import { describe, it, expect, vi, beforeEach } from 'vitest';

const { withTransactionMock, priceServiceMock, btqServiceMock } = vi.hoisted(() => ({
  withTransactionMock: vi.fn(),
  priceServiceMock: {
    isSwapsPaused: vi.fn(),
    getMinSwapBtq: vi.fn(),
    getMaxSwapBtq: vi.fn(),
    getPriceForDirection: vi.fn(),
  },
  btqServiceMock: {
    getBlockCount: vi.fn(),
  },
}));

vi.mock('../src/lib/db', () => ({
  withTransaction: withTransactionMock,
  query: vi.fn(),
  getOne: vi.fn(),
  getMany: vi.fn(),
}));

vi.mock('../src/services/price.service', () => ({
  priceService: priceServiceMock,
}));

vi.mock('../src/services/btq.service', () => ({
  btqService: btqServiceMock,
}));

import { swapService } from '../src/services/swap.service';
import { SwapDirection } from '../src/types/swap.types';

describe('swapService.createSwap', () => {
  beforeEach(() => {
    withTransactionMock.mockReset();
    priceServiceMock.isSwapsPaused.mockReset();
    priceServiceMock.getMinSwapBtq.mockReset();
    priceServiceMock.getMaxSwapBtq.mockReset();
    priceServiceMock.getPriceForDirection.mockReset();
    btqServiceMock.getBlockCount.mockReset();
  });

  it('fails fast when buy_btq is missing user_dilithium_pubkey', async () => {
    priceServiceMock.isSwapsPaused.mockResolvedValue(false);
    priceServiceMock.getMinSwapBtq.mockResolvedValue('0.1');
    priceServiceMock.getMaxSwapBtq.mockResolvedValue('100');

    await expect(
      swapService.createSwap('user-1', {
        direction: SwapDirection.BUY_BTQ,
        amount_btq: '1.0',
      }),
    ).rejects.toThrow('user_dilithium_pubkey required for buy_btq');

    expect(withTransactionMock).not.toHaveBeenCalled();
    expect(priceServiceMock.getPriceForDirection).not.toHaveBeenCalled();
    expect(btqServiceMock.getBlockCount).not.toHaveBeenCalled();
  });
});
