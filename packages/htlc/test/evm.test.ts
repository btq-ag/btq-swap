import { describe, expect, it } from 'vitest';
import { parseSwapBindingAsset, swapBindingAsset } from '../src/evm.js';

describe('parseSwapBindingAsset', () => {
  const id = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';

  it('round-trips a canonical swap id', () => {
    expect(parseSwapBindingAsset(swapBindingAsset(id))).toBe(id);
    expect(parseSwapBindingAsset(`BTQ swap ${id.toUpperCase()}`)).toBe(id);
  });

  it('rejects 36-character strings that are not UUIDs', () => {
    expect(parseSwapBindingAsset(`BTQ swap ${'-'.repeat(36)}`)).toBeNull();
    expect(parseSwapBindingAsset(`BTQ swap ${'a'.repeat(36)}`)).toBeNull();
    expect(parseSwapBindingAsset(`BTQ swap ${id.replace(/-/g, 'a').slice(0, 32)}----`)).toBeNull();
  });

  it('rejects other prefixes and trailing data', () => {
    expect(parseSwapBindingAsset(id)).toBeNull();
    expect(parseSwapBindingAsset(`BTQ swap ${id} x`)).toBeNull();
  });
});
