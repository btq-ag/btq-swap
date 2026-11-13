import { describe, expect, it } from 'vitest';
import {
  buildClaimTx,
  buildRefundTx,
  bytesToHex,
  createHtlc,
  decodeSegwitAddress,
  encodeP2mrAddress,
  fromRecord,
  hexToBytes,
  htlcTreeJson,
  inspectHtlcSpend,
  linkChallengeMessage,
  merkleRootFromControlBlock,
  newPreimage,
  parseTx,
  signerFromSeed,
  toRecord,
  verifySignature,
  btqToSats,
  satsToBtq,
} from '../src/index.js';

const buyer = signerFromSeed(new Uint8Array(32).fill(1));
const seller = signerFromSeed(new Uint8Array(32).fill(2));
const secret = newPreimage();
const FUND_TXID = 'ab'.repeat(32);

function htlc(locktime = 500) {
  return createHtlc('regtest', {
    secretHash: secret.secretHash,
    claimPubkey: buyer.publicKey,
    refundPubkey: seller.publicKey,
    refundLocktime: locktime,
  });
}

describe('addresses', () => {
  it('encodes P2MR addresses with the network HRP and decodes them back', () => {
    const h = htlc();
    expect(h.address.startsWith('qcrt1z')).toBe(true);
    const decoded = decodeSegwitAddress(h.address, 'regtest');
    expect(decoded.version).toBe(2);
    expect(bytesToHex(decoded.scriptPubKey)).toBe(bytesToHex(h.scriptPubKey));
    expect(encodeP2mrAddress('mainnet', h.merkleRoot).startsWith('qbtc1z')).toBe(true);
    expect(encodeP2mrAddress('testnet', h.merkleRoot).startsWith('tbtq1z')).toBe(true);
  });

  it('decodes v0 addresses and rejects wrong networks or checksums', () => {
    const v0 = decodeSegwitAddress('qcrt1qqzy9e9njkp0pw82ym7j8rnsq47wdye783wuarc');
    expect(bytesToHex(v0.scriptPubKey)).toBe('001400885c9672b05e171d44dfa471ce00af9cd267c7');
    expect(() => decodeSegwitAddress('qcrt1qqzy9e9njkp0pw82ym7j8rnsq47wdye783wuarc', 'testnet')).toThrow(/regtest/);
    expect(() => decodeSegwitAddress('qcrt1qqzy9e9njkp0pw82ym7j8rnsq47wdye783wuarx')).toThrow();
    expect(() => decodeSegwitAddress('bc1qqzy9e9njkp0pw82ym7j8rnsq47wdye783wuarc')).toThrow(/prefix/);
  });

  it('control blocks recompute the committed merkle root for both leaves', () => {
    const h = htlc();
    expect(bytesToHex(merkleRootFromControlBlock(h.claimLeaf, h.claimControlBlock))).toBe(bytesToHex(h.merkleRoot));
    expect(bytesToHex(merkleRootFromControlBlock(h.refundLeaf, h.refundControlBlock))).toBe(bytesToHex(h.merkleRoot));
    expect(h.claimControlBlock[0]).toBe(0xc1);
    expect(h.claimControlBlock.length).toBe(33);
  });

  it('tree json matches the getnewp2mraddress shape', () => {
    const t = htlcTreeJson(htlc());
    expect(t).toHaveLength(2);
    expect(t[0]).toMatchObject({ depth: 1, leaf_version: 192 });
  });

  it('records round-trip and detect tampering', () => {
    const h = htlc();
    const r = toRecord(h);
    expect(fromRecord(r).address).toBe(h.address);
    expect(() => fromRecord({ ...r, refundLocktime: 501 })).toThrow(/does not match/);
  });
});

describe('claim / refund construction', () => {
  const outpoint = { txid: FUND_TXID, vout: 1, valueSats: 125_000_000n };
  const dest = 'qcrt1qqzy9e9njkp0pw82ym7j8rnsq47wdye783wuarc';

  it('builds a claim with [sig, preimage, leaf, control] and the BTQ vsize', () => {
    const h = htlc();
    const claim = buildClaimTx({ htlc: h, outpoint, destination: dest, preimage: secret.preimage, signer: buyer, feeRateSatVb: 2 });
    const tx = parseTx(claim.hex);
    const w = tx.inputs[0]!.witness;
    expect(w).toHaveLength(4);
    expect(w[0]!.length).toBe(2421);
    expect(bytesToHex(w[1]!)).toBe(secret.preimageHex);
    expect(tx.locktime).toBe(0);
    expect(tx.inputs[0]!.sequence).toBe(0xffffffff);
    // btqd reported vsize 323 for this exact shape on regtest.
    expect(claim.vsize).toBeGreaterThan(315);
    expect(claim.vsize).toBeLessThan(335);
    expect(claim.outputSats + claim.feeSats).toBe(outpoint.valueSats);
  });

  it('refuses the wrong key, the wrong preimage and early refund locktimes', () => {
    const h = htlc(700);
    expect(() => buildClaimTx({ htlc: h, outpoint, destination: dest, preimage: secret.preimage, signer: seller })).toThrow(/claim public key/);
    expect(() => buildClaimTx({ htlc: h, outpoint, destination: dest, preimage: newPreimage().preimage, signer: buyer })).toThrow(/secret hash/);
    expect(() => buildRefundTx({ htlc: h, outpoint, destination: dest, signer: buyer })).toThrow(/refund public key/);
    expect(() => buildRefundTx({ htlc: h, outpoint, destination: dest, signer: seller, locktime: 699 })).toThrow(/below/);
    const refund = buildRefundTx({ htlc: h, outpoint, destination: dest, signer: seller });
    const tx = parseTx(refund.hex);
    expect(tx.locktime).toBe(700);
    expect(tx.inputs[0]!.sequence).toBe(0xfffffffe);
    expect(tx.inputs[0]!.witness).toHaveLength(3);
  });

  it('inspectHtlcSpend extracts the preimage only from a genuine claim of this HTLC', () => {
    const h = htlc();
    const claim = buildClaimTx({ htlc: h, outpoint, destination: dest, preimage: secret.preimage, signer: buyer });
    const info = inspectHtlcSpend(claim.hex, outpoint, h);
    expect(info?.kind).toBe('claim');
    expect(info?.preimage && bytesToHex(info.preimage)).toBe(secret.preimageHex);

    const other = createHtlc('regtest', { secretHash: secret.secretHash, claimPubkey: buyer.publicKey, refundPubkey: seller.publicKey, refundLocktime: 501 });
    expect(inspectHtlcSpend(claim.hex, outpoint, other)?.kind).toBe('unknown');
    expect(inspectHtlcSpend(claim.hex, { txid: 'cd'.repeat(32), vout: 1 }, h)).toBeNull();

    const refund = buildRefundTx({ htlc: h, outpoint, destination: dest, signer: seller });
    expect(inspectHtlcSpend(refund.hex, outpoint, h)?.kind).toBe('refund');
  });
});

describe('keys and amounts', () => {
  it('signs and verifies link challenges deterministically', () => {
    const msg = linkChallengeMessage('abc123');
    const sig = buyer.sign(msg);
    expect(sig).toHaveLength(2420);
    expect(bytesToHex(buyer.sign(msg))).toBe(bytesToHex(sig));
    expect(verifySignature(buyer.publicKey, msg, sig)).toBe(true);
    expect(verifySignature(seller.publicKey, msg, sig)).toBe(false);
    expect(verifySignature(buyer.publicKey, linkChallengeMessage('abc124'), sig)).toBe(false);
  });

  it('converts BTQ amounts without float error', () => {
    expect(btqToSats('1.25')).toBe(125_000_000n);
    expect(btqToSats(0.1)).toBe(10_000_000n);
    expect(btqToSats('0.00000001')).toBe(1n);
    expect(satsToBtq(124_997_910n)).toBe('1.24997910');
    expect(() => btqToSats('1.123456789')).toThrow();
    expect(hexToBytes('0x00ff')).toEqual(Uint8Array.of(0, 255));
  });
});
