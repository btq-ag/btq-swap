import { beforeEach, describe, expect, it, vi } from 'vitest';

const { btqCallMock } = vi.hoisted(() => ({
  btqCallMock: vi.fn(),
}));

vi.mock('../src/lib/btqRpc', () => ({
  btqRpc: {
    call: btqCallMock,
  },
}));

import { btqService } from '../src/services/btq.service';

describe('btqService.getAddressBalance', () => {
  beforeEach(() => {
    btqCallMock.mockReset();
  });

  it('returns total_amount from scantxoutset for address descriptor', async () => {
    btqCallMock.mockResolvedValue({
      success: true,
      total_amount: 12.3456789,
      unspents: [],
    });

    const balance = await (btqService as any).getAddressBalance('btq1testaddress');

    expect(btqCallMock).toHaveBeenCalledWith('scantxoutset', ['start', ['addr(btq1testaddress)']]);
    expect(balance).toBe(12.3456789);
  });

  it('returns null when RPC lookup fails', async () => {
    btqCallMock.mockRejectedValue(new Error('RPC unavailable'));

    const balance = await (btqService as any).getAddressBalance('btq1testaddress');

    expect(balance).toBeNull();
  });
});
