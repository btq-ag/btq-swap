import { beforeAll, describe, expect, it } from 'vitest';
import { computeAgreementId, swapBindingAsset } from '@btq-swap/htlc';

beforeAll(() => {
  Object.assign(process.env, {
    DATABASE_URL: 'postgres://x:y@127.0.0.1:1/z', ADMIN_TOKEN: 'a'.repeat(24), SESSION_SECRET: 's'.repeat(32),
    BTQ_RPC_URL: 'http://127.0.0.1:1', BTQ_RPC_USER: 'u', BTQ_RPC_PASS: 'p', PLATFORM_HTLC_SEED: '11'.repeat(32), PLATFORM_SECRET_KEY: '22'.repeat(32),
    EVM_RPC_URL: 'http://127.0.0.1:2', EVM_CHAIN_ID: '31337', EVM_PRIVATE_KEY: '0x' + '33'.repeat(32), BTQ_NETWORK: 'regtest',
    SWAP_EVM_LOCK_DURATION_SEC: '420', SWAP_SELLER_LOCK_WINDOW_SEC: '120', SWAP_BTQ_LOCK_BLOCKS: '24', BTQ_TARGET_BLOCK_SEC: '5', SWAP_SAFETY_MARGIN_SEC: '120', SWAP_EVM_LOCK_MAX_DURATION_SEC: '3600',
  });
});

const SWAP_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const BUYER = '0x1111111111111111111111111111111111111111';
const SELLER = '0x2222222222222222222222222222222222222222';
const TOKEN = '0x3333333333333333333333333333333333333333';

function swap(over: Record<string, unknown> = {}) {
  return {
    id: SWAP_ID, short_id: '7', status: 'awaiting_buyer_lock', buyer_eth: BUYER, seller_eth: SELLER, evm_token: TOKEN,
    amount_usdt_units: '5100000', amount_sats: '200000000', btq_network: 'regtest', secret_hash: null,
    amount_btq: '2.00000000', price_usdt: '2.550000', evm_htlc_contract: '0x4444444444444444444444444444444444444444',
    buyer_lock_by: new Date(), seller_lock_by: new Date(), evm_deadline: new Date(), btq_refund_locktime: 500, btq_htlc_address: 'qcrt1zexample',
    revealed_preimage: null, evm_lock_confs: 0, btq_lock_confs: 0, buyer_btq_address: 'qcrt1qbuyer', seller_btq_address: 'qcrt1qseller',
    btq_lock_txid: null, btq_claim_txid: null, btq_refund_txid: null, evm_agreement_id: null, evm_claim_tx: null, evm_refund_tx: null,
    ...over,
  } as never;
}

function lockup(over: Record<string, unknown> = {}, nowSec = 1_800_000_000) {
  const p = {
    partyA: BUYER, partyB: SELLER, secretlock: '0x' + 'ab'.repeat(32), deadline: nowSec + 420, erc20Contract: TOKEN,
    tokenAmount: 5_100_000n, otherNetwork: 'btq:regtest', otherAsset: swapBindingAsset(SWAP_ID), otherAmount: 200_000_000n, ...over,
  } as Record<string, unknown> & { partyA: string };
  return { ...p, agreementId: computeAgreementId(p as never), txHash: '0x' + '0'.repeat(64), blockNumber: 10 } as never;
}

describe('USDT lock validation (seller protection)', async () => {
  const { validateLockup } = await import('../src/domain/settlement');
  const now = 1_800_000_000;
  it('accepts an exact, well-formed lock', () => {
    expect(validateLockup(swap(), lockup({}, now), now)).toBeNull();
  });
  it.each([
    ['wrong buyer', { partyA: SELLER }, /partyA/],
    ['wrong recipient', { partyB: BUYER }, /partyB/],
    ['wrong token', { erc20Contract: '0x5555555555555555555555555555555555555555' }, /token/],
    ['underpaid', { tokenAmount: 5_099_999n }, /amount/],
    ['wrong network tag', { otherNetwork: 'btq:mainnet' }, /otherNetwork/],
    ['wrong BTQ amount binding', { otherAmount: 1n }, /otherAmount/],
    ['deadline too short for the seller', { deadline: now + 200 }, /deadline leaves/],
    ['deadline absurdly far', { deadline: now + 10_000 }, /too far/],
  ])('rejects %s', (_name, over, re) => {
    expect(validateLockup(swap(), lockup(over, now), now)).toMatch(re as RegExp);
  });
  it('rejects a lock whose secret differs from the platform-held hash', () => {
    expect(validateLockup(swap({ secret_hash: 'cd'.repeat(32) }), lockup({}, now), now)).toMatch(/platform secret/);
  });
  it('rejects a forged agreement id', () => {
    const l = { ...(lockup({}, now) as object), agreementId: '0x' + '9'.repeat(64) };
    expect(validateLockup(swap(), l as never, now)).toMatch(/agreement id/);
  });
});

describe('instructions never leak the secret early', async () => {
  const { instructionFor } = await import('../src/domain/instructions');
  const PRE = 'f'.repeat(64);
  it.each(['awaiting_buyer_lock', 'awaiting_seller_lock', 'awaiting_buyer_claim'])('%s shows no preimage', (status) => {
    for (const role of ['buyer', 'seller'] as const) {
      const ins = instructionFor(swap({ status, secret_hash: 'ab'.repeat(32) }), role);
      expect(JSON.stringify(ins)).not.toContain(PRE);
    }
  });
  it('seller gets the revealed preimage and the claim command only after the BTQ claim', () => {
    const ins = instructionFor(swap({ status: 'awaiting_seller_claim', revealed_preimage: PRE, evm_agreement_id: '0x1' }), 'seller');
    expect(ins.actionable).toBe(true);
    expect(ins.detail).toContain(PRE);
    expect(ins.commands.join(' ')).toContain('evm claim');
  });
  it('uses the configured network flag, never a hardcoded wallet', () => {
    const ins = instructionFor(swap({ status: 'awaiting_seller_lock' }), 'seller');
    expect(ins.commands[0]).toMatch(/^btq-cli -regtest sendtoaddress qcrt1zexample 2\.00000000$/);
    expect(ins.commands.join(' ')).not.toContain('rpcwallet');
  });
});

describe('money', async () => {
  const { usdtUnitsFor, toUnits, fromUnits } = await import('../src/domain/money');
  it('computes USDT units exactly (floor)', () => {
    expect(usdtUnitsFor(200_000_000n, '2.55', 6)).toBe(5_100_000n);
    expect(usdtUnitsFor(1n, '2.55', 6)).toBe(0n);
    expect(usdtUnitsFor(150_000_000n, '2.600000', 6)).toBe(3_900_000n);
    // 0.33333333 BTQ × 3.333333 = 1.1111109888888890 exactly, at 18 decimals
    expect(usdtUnitsFor(33_333_333n, '3.333333', 18)).toBe(1_111_110_988_888_890_000n);
  });
  it('rejects excess precision instead of rounding silently', () => {
    expect(() => toUnits('1.123456789', 8)).toThrow();
    expect(toUnits('1.10000000000', 8)).toBe(110_000_000n);
    expect(fromUnits(5_100_000n, 6)).toBe('5.100000');
  });
});

describe('channel guard', async () => {
  const { shouldRemove } = await import('../src/bot/guard');
  const ctx = { guildId: 'g', channelId: 'c', applicationId: 'app' };
  const msg = (over: Record<string, unknown>) => ({ guildId: 'g', channelId: 'c', type: 0, system: false, pinned: false, author: { bot: false, id: 'u' }, member: { permissions: { has: () => false } }, applicationId: null, delete: async () => undefined, ...over }) as never;
  it('removes public chatter from non-staff', () => expect(shouldRemove(msg({}), ctx)).toBe(true));
  it('keeps staff messages', () => expect(shouldRemove(msg({ member: { permissions: { has: () => true } } }), ctx)).toBe(false));
  it('keeps the bot feed', () => expect(shouldRemove(msg({ author: { bot: true, id: 'app' } }), ctx)).toBe(false));
  it('removes leaked public slash echoes of our app', () => expect(shouldRemove(msg({ type: 20, applicationId: 'app', author: { bot: true, id: 'app' } }), ctx)).toBe(true));
  it('ignores other channels', () => expect(shouldRemove(msg({ channelId: 'other' }), ctx)).toBe(false));
});
