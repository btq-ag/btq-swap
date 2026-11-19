import { describe, expect, it } from 'vitest';
import { claimRefusal } from '../src/guards.js';

const base = { lockConfirmations: 6, minConfirmations: 6, tipHeight: 100, refundLocktime: 172, marginBlocks: 6 };

describe('claimRefusal', () => {
  it('allows a confirmed lock well before the refund height', () => {
    expect(claimRefusal(base)).toBeNull();
  });

  it('refuses an unconfirmed or under-confirmed lock', () => {
    expect(claimRefusal({ ...base, lockConfirmations: 0 })).toMatch(/0 of 6 confirmations/);
    expect(claimRefusal({ ...base, lockConfirmations: 5 })).toMatch(/5 of 6/);
  });

  it('refuses when the tip is unknown', () => {
    expect(claimRefusal({ ...base, tipHeight: 0 })).toMatch(/tip height is unknown/);
  });

  it('allows the last safe height and refuses one block later', () => {
    // tip + margin must not exceed the refund locktime
    expect(claimRefusal({ ...base, tipHeight: 166 })).toBeNull();
    expect(claimRefusal({ ...base, tipHeight: 167 })).toMatch(/refund opens at BTQ height 172/);
  });

  it('refuses once the refund leaf is open', () => {
    expect(claimRefusal({ ...base, tipHeight: 172 })).not.toBeNull();
    expect(claimRefusal({ ...base, tipHeight: 500 })).not.toBeNull();
  });
});
