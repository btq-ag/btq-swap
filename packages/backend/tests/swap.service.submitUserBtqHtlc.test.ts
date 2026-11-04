import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SwapDirection, SwapStatus, type SwapRow } from '../src/types/swap.types';

const { getOneMock, btqServiceMock, scriptBuilderServiceMock } = vi.hoisted(() => ({
  getOneMock: vi.fn(),
  btqServiceMock: {
    getRawTransaction: vi.fn(),
  },
  scriptBuilderServiceMock: {
    buildLeaves: vi.fn(),
  },
}));

vi.mock('../src/lib/db', () => ({
  query: vi.fn(),
  getOne: getOneMock,
  getMany: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('../src/services/btq.service', () => ({
  btqService: btqServiceMock,
}));

vi.mock('../src/services/scriptBuilder.service', () => ({
  scriptBuilderService: scriptBuilderServiceMock,
}));

import { swapService } from '../src/services/swap.service';

function makeSwap(): SwapRow {
  return {
    id: 'swap-1',
    order_id: null,
    user_id: 'user-1',
    direction: SwapDirection.SELL_BTQ,
    amount_btq: '2.0',
    amount_usdt: '12.0',
    price_usdt: '6.0',
    secret_hash: Buffer.from('11'.repeat(32), 'hex'),
    secret: Buffer.from('22'.repeat(32), 'hex'),
    timelock_btq: 1000,
    timelock_evm: new Date(),
    user_dilithium_pubkey: 'aa'.repeat(64),
    user_btq_address: 'btq-address',
    btq_htlc_txid: null,
    btq_htlc_vout: null,
    btq_htlc_created_by: null,
    btq_htlc_confs: 0,
    btq_claim_txid: null,
    btq_refund_txid: null,
    btq_merkle_root: null,
    claim_leaf_hex: null,
    refund_leaf_hex: null,
    control_block_hex: null,
    evm_htlc_swap_id: Buffer.from('33'.repeat(32), 'hex'),
    evm_htlc_tx_hash: null,
    evm_claim_tx_hash: null,
    evm_refund_tx_hash: null,
    status: SwapStatus.AWAITING_USER_BTQ_HTLC,
    error_message: null,
    admin_notes: null,
    created_at: new Date(),
    updated_at: new Date(),
    completed_at: null,
  };
}

describe('swapService.submitUserBtqHtlc', () => {
  beforeEach(() => {
    getOneMock.mockReset();
    btqServiceMock.getRawTransaction.mockReset();
    scriptBuilderServiceMock.buildLeaves.mockReset();
  });

  it('rejects leaf scripts that do not match expected swap parameters', async () => {
    getOneMock.mockResolvedValue(makeSwap());
    btqServiceMock.getRawTransaction.mockResolvedValue({
      txid: 'tx-1',
      hash: 'tx-1',
      version: 2,
      size: 100,
      vsize: 100,
      weight: 400,
      locktime: 0,
      vin: [],
      vout: [
        {
          value: 2.0,
          n: 0,
          scriptPubKey: {
            asm: '',
            hex: '',
            type: 'p2mr',
            address: 'expected-p2mr-address',
          },
        },
      ],
      hex: '00',
      confirmations: 1,
    });
    scriptBuilderServiceMock.buildLeaves.mockReturnValue({
      claimLeaf: { depth: 1, leaf_version: 192, script: 'expected-claim' },
      refundLeaf: { depth: 1, leaf_version: 192, script: 'expected-refund' },
    });

    await expect(
      swapService.submitUserBtqHtlc({
        swap_id: 'swap-1',
        btq_htlc_txid: 'tx-1',
        btq_htlc_vout: 0,
        btq_merkle_root: 'expected-p2mr-address',
        claim_leaf_hex: 'wrong-claim',
        refund_leaf_hex: 'expected-refund',
        control_block_hex: 'cb',
      }),
    ).rejects.toThrow('BTQ claim leaf does not match the expected swap parameters');
  });
});
