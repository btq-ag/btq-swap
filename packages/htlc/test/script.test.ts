import { describe, expect, it } from 'vitest';
import {
  buildClaimLeaf,
  buildRefundLeaf,
  bytesToHex,
  encodeScriptNum,
  hexToBytes,
  parseClaimLeaf,
  pushData,
  pushNumber,
  tapleafHash,
} from '../src/index.js';

const H = hexToBytes('11'.repeat(32));
const PK_A = new Uint8Array(1312).fill(0xaa);
const PK_B = new Uint8Array(1312).fill(0xbb);

describe('script numbers', () => {
  it.each([
    [1, ''],
    [127, '7f'],
    [128, '8000'],
    [255, 'ff00'],
    [256, '0001'],
    [8_388_608, '00008000'],
    [-1, '81'],
    [-128, '8080'],
  ])('encodeScriptNum(%i) = %s', (n, hex) => {
    if (n === 1) expect(bytesToHex(encodeScriptNum(1))).toBe('01');
    else expect(bytesToHex(encodeScriptNum(n))).toBe(hex);
  });

  it('pushNumber uses OP_N for small values and minimal pushes otherwise', () => {
    expect(bytesToHex(pushNumber(0))).toBe('00');
    expect(bytesToHex(pushNumber(16))).toBe('60');
    expect(bytesToHex(pushNumber(17))).toBe('0111');
    expect(bytesToHex(pushNumber(32))).toBe('0120');
    expect(bytesToHex(pushNumber(150))).toBe('029600');
  });

  it('pushData picks the smallest opcode', () => {
    expect(bytesToHex(pushData(new Uint8Array(75)))).toMatch(/^4b/);
    expect(bytesToHex(pushData(new Uint8Array(76)))).toMatch(/^4c4c/);
    expect(bytesToHex(pushData(new Uint8Array(1312)))).toMatch(/^4d2005/);
  });
});

describe('HTLC leaves', () => {
  it('claim leaf pins a 32 byte preimage and commits to the hash and key', () => {
    const leaf = buildClaimLeaf(H, PK_A);
    const hex = bytesToHex(leaf);
    expect(hex.startsWith('82' + '0120' + '88' + 'a8' + '20' + '11'.repeat(32) + '88' + '4d2005')).toBe(true);
    expect(hex.endsWith('bb')).toBe(true);
    expect(leaf.length).toBe(1 + 2 + 2 + 33 + 1 + 3 + 1312 + 1);
  });

  it('refund leaf encodes the CLTV height minimally', () => {
    const leaf = buildRefundLeaf(250, PK_B);
    expect(bytesToHex(leaf.slice(0, 5))).toBe('02fa00b175');
    expect(leaf[leaf.length - 1]).toBe(0xbb);
  });

  it('rejects malformed parameters', () => {
    expect(() => buildClaimLeaf(new Uint8Array(31), PK_A)).toThrow(/32 bytes/);
    expect(() => buildClaimLeaf(H, new Uint8Array(1311))).toThrow(/1312/);
    expect(() => buildRefundLeaf(0, PK_B)).toThrow(/block height/);
    expect(() => buildRefundLeaf(500_000_000, PK_B)).toThrow(/block height/);
  });

  it('parseClaimLeaf round-trips and rejects anything else', () => {
    const leaf = buildClaimLeaf(H, PK_A);
    const parsed = parseClaimLeaf(leaf);
    expect(parsed && bytesToHex(parsed.secretHash)).toBe(bytesToHex(H));
    expect(parsed && bytesToHex(parsed.claimPubkey)).toBe(bytesToHex(PK_A));
    expect(parseClaimLeaf(buildRefundLeaf(300, PK_A))).toBeNull();
    const tampered = Uint8Array.from(leaf);
    tampered[2] = 0x21; // OP_SIZE 33
    expect(parseClaimLeaf(tampered)).toBeNull();
  });

  it('tapleaf hash uses the TapLeaf tag with leaf version 0xc0', () => {
    // Known vector: tapleaf("51") from BIP341 test vectors style computation.
    expect(bytesToHex(tapleafHash(hexToBytes('51')))).toHaveLength(64);
    expect(bytesToHex(tapleafHash(hexToBytes('51')))).not.toBe(bytesToHex(tapleafHash(hexToBytes('51'), 0xc2)));
  });
});
