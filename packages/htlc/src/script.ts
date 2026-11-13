import { sha256 } from '@noble/hashes/sha2.js';
import { compactSize, concatBytes, equalBytes } from './bytes.js';

export const OP_0 = 0x00;
export const OP_PUSHDATA1 = 0x4c;
export const OP_PUSHDATA2 = 0x4d;
export const OP_1NEGATE = 0x4f;
export const OP_1 = 0x51;
export const OP_2 = 0x52;
export const OP_16 = 0x60;
export const OP_DROP = 0x75;
export const OP_SIZE = 0x82;
export const OP_EQUALVERIFY = 0x88;
export const OP_SHA256 = 0xa8;
export const OP_CHECKLOCKTIMEVERIFY = 0xb1;
export const OP_CHECKSIGDILITHIUM = 0xbb;

export const LEAF_VERSION_TAPSCRIPT = 0xc0;
export const DILITHIUM2_PUBKEY_SIZE = 1312;
export const DILITHIUM2_SIG_SIZE = 2420;
export const SIGHASH_ALL = 0x01;
export const PREIMAGE_SIZE = 32;
/** Consensus: CLTV values below this are block heights, at/above are UNIX times. */
export const LOCKTIME_THRESHOLD = 500_000_000;

/** Minimal data push (BIP62 / tapscript MINIMALDATA compatible for byte strings longer than 1). */
export function pushData(data: Uint8Array): Uint8Array {
  const len = data.length;
  if (len === 0) return Uint8Array.of(OP_0);
  if (len === 1 && data[0]! >= 1 && data[0]! <= 16) return Uint8Array.of(OP_1 + data[0]! - 1);
  if (len === 1 && data[0] === 0x81) return Uint8Array.of(OP_1NEGATE);
  if (len < OP_PUSHDATA1) return concatBytes(Uint8Array.of(len), data);
  if (len <= 0xff) return concatBytes(Uint8Array.of(OP_PUSHDATA1, len), data);
  if (len <= 0xffff) return concatBytes(Uint8Array.of(OP_PUSHDATA2, len & 0xff, (len >>> 8) & 0xff), data);
  throw new Error(`push too large: ${len}`);
}

/** CScriptNum serialization (little-endian sign-magnitude, minimal). */
export function encodeScriptNum(value: number): Uint8Array {
  if (!Number.isSafeInteger(value)) throw new Error('script number must be a safe integer');
  if (value === 0) return new Uint8Array(0);
  const negative = value < 0;
  let abs = Math.abs(value);
  const out: number[] = [];
  while (abs > 0) {
    out.push(abs & 0xff);
    abs = Math.floor(abs / 256);
  }
  if (out[out.length - 1]! & 0x80) out.push(negative ? 0x80 : 0x00);
  else if (negative) out[out.length - 1]! |= 0x80;
  return Uint8Array.from(out);
}

/** Push a number the way CScript() << int64 does (OP_0/OP_1..OP_16/OP_1NEGATE or minimal scriptnum push). */
export function pushNumber(value: number): Uint8Array {
  if (value === 0) return Uint8Array.of(OP_0);
  if (value === -1) return Uint8Array.of(OP_1NEGATE);
  if (value >= 1 && value <= 16) return Uint8Array.of(OP_1 + value - 1);
  const n = encodeScriptNum(value);
  return concatBytes(Uint8Array.of(n.length), n);
}

export function sha256Bytes(data: Uint8Array): Uint8Array {
  return sha256(data);
}

export interface HtlcLeafParams {
  /** SHA-256 of the 32-byte preimage. */
  secretHash: Uint8Array;
  /** Dilithium2 (ML-DSA-44) public key allowed to claim with the preimage. */
  claimPubkey: Uint8Array;
  /** Dilithium2 (ML-DSA-44) public key allowed to refund after the timelock. */
  refundPubkey: Uint8Array;
  /** Absolute block height (CLTV) after which the refund leaf becomes spendable. */
  refundLocktime: number;
}

function assertPubkey(pk: Uint8Array, label: string): void {
  if (pk.length !== DILITHIUM2_PUBKEY_SIZE) {
    throw new Error(`${label} must be a ${DILITHIUM2_PUBKEY_SIZE}-byte Dilithium2 public key (got ${pk.length})`);
  }
}

/**
 * Claim leaf:
 *   OP_SIZE <32> OP_EQUALVERIFY OP_SHA256 <H> OP_EQUALVERIFY <claimPk> OP_CHECKSIGDILITHIUM
 *
 * The OP_SIZE guard pins the preimage to exactly 32 bytes so it is always usable
 * as the `bytes32 _key` of the EVM HtlcERC20 contract (prevents the classic
 * cross-chain preimage-length attack).
 */
export function buildClaimLeaf(secretHash: Uint8Array, claimPubkey: Uint8Array): Uint8Array {
  if (secretHash.length !== 32) throw new Error('secretHash must be 32 bytes');
  assertPubkey(claimPubkey, 'claimPubkey');
  return concatBytes(
    Uint8Array.of(OP_SIZE),
    pushNumber(PREIMAGE_SIZE),
    Uint8Array.of(OP_EQUALVERIFY, OP_SHA256),
    pushData(secretHash),
    Uint8Array.of(OP_EQUALVERIFY),
    pushData(claimPubkey),
    Uint8Array.of(OP_CHECKSIGDILITHIUM),
  );
}

/** Refund leaf: <locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP <refundPk> OP_CHECKSIGDILITHIUM */
export function buildRefundLeaf(refundLocktime: number, refundPubkey: Uint8Array): Uint8Array {
  if (!Number.isInteger(refundLocktime) || refundLocktime <= 0 || refundLocktime >= LOCKTIME_THRESHOLD) {
    throw new Error('refundLocktime must be a positive block height below 500000000');
  }
  assertPubkey(refundPubkey, 'refundPubkey');
  return concatBytes(
    pushNumber(refundLocktime),
    Uint8Array.of(OP_CHECKLOCKTIMEVERIFY, OP_DROP),
    pushData(refundPubkey),
    Uint8Array.of(OP_CHECKSIGDILITHIUM),
  );
}

/** Parse a claim leaf built by buildClaimLeaf. Returns null if the script does not match the template exactly. */
export function parseClaimLeaf(script: Uint8Array): { secretHash: Uint8Array; claimPubkey: Uint8Array } | null {
  // OP_SIZE 0x01 0x20 OP_EQUALVERIFY OP_SHA256 0x20 <32> OP_EQUALVERIFY 0x4d <len16> <1312> OP_CHECKSIGDILITHIUM
  const expectedLen = 1 + 2 + 2 + 1 + 32 + 1 + 3 + DILITHIUM2_PUBKEY_SIZE + 1;
  if (script.length !== expectedLen) return null;
  let i = 0;
  if (script[i++] !== OP_SIZE) return null;
  if (script[i++] !== 0x01 || script[i++] !== PREIMAGE_SIZE) return null;
  if (script[i++] !== OP_EQUALVERIFY || script[i++] !== OP_SHA256) return null;
  if (script[i++] !== 32) return null;
  const secretHash = script.slice(i, i + 32);
  i += 32;
  if (script[i++] !== OP_EQUALVERIFY) return null;
  if (script[i++] !== OP_PUSHDATA2) return null;
  const len = script[i]! | (script[i + 1]! << 8);
  i += 2;
  if (len !== DILITHIUM2_PUBKEY_SIZE) return null;
  const claimPubkey = script.slice(i, i + len);
  i += len;
  if (script[i++] !== OP_CHECKSIGDILITHIUM || i !== script.length) return null;
  const rebuilt = buildClaimLeaf(secretHash, claimPubkey);
  return equalBytes(rebuilt, script) ? { secretHash, claimPubkey } : null;
}

/** BIP341 tagged hash. */
export function taggedHash(tag: string, data: Uint8Array): Uint8Array {
  const tagHash = sha256(new TextEncoder().encode(tag));
  return sha256(concatBytes(tagHash, tagHash, data));
}

/** ComputeTapleafHash(leaf_version, script) — identical for Taproot and P2MR. */
export function tapleafHash(script: Uint8Array, leafVersion = LEAF_VERSION_TAPSCRIPT): Uint8Array {
  return taggedHash('TapLeaf', concatBytes(Uint8Array.of(leafVersion), compactSize(script.length), script));
}
