import { randomBytes } from 'node:crypto';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { bytesToHex, hexToBytes } from './bytes.js';
import { DILITHIUM2_PUBKEY_SIZE, DILITHIUM2_SIG_SIZE, PREIMAGE_SIZE, sha256Bytes } from './script.js';

/**
 * A Dilithium2 / ML-DSA-44 key derived from a 32-byte seed.
 *
 * BTQ Core links the pq-crystals reference implementation with randomized signing
 * disabled, so deterministic ML-DSA-44 signatures (extraEntropy: false) are exactly
 * what consensus verifies (same approach as btq-browser-wallet, proven against btqd).
 */
export interface DilithiumSigner {
  readonly publicKey: Uint8Array;
  sign(message: Uint8Array): Uint8Array;
}

export function signerFromSeed(seed: Uint8Array): DilithiumSigner {
  if (seed.length !== 32) throw new Error('Dilithium seed must be 32 bytes');
  const { publicKey, secretKey } = ml_dsa44.keygen(seed);
  if (publicKey.length !== DILITHIUM2_PUBKEY_SIZE) throw new Error('unexpected ML-DSA-44 public key size');
  return {
    publicKey,
    sign(message: Uint8Array): Uint8Array {
      const sig = ml_dsa44.sign(message, secretKey, { extraEntropy: false });
      if (sig.length !== DILITHIUM2_SIG_SIZE) throw new Error('unexpected ML-DSA-44 signature size');
      return sig;
    },
  };
}

export function signerFromSeedHex(seedHex: string): DilithiumSigner {
  return signerFromSeed(hexToBytes(seedHex));
}

export function newSeed(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}

export function verifySignature(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (publicKey.length !== DILITHIUM2_PUBKEY_SIZE || signature.length !== DILITHIUM2_SIG_SIZE) return false;
  try {
    return ml_dsa44.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

/** Domain-separated message for proof-of-possession of an HTLC key (Discord /swap link-btq). */
export function linkChallengeMessage(challenge: string): Uint8Array {
  return new TextEncoder().encode(`BTQ-Swap key link v1\n${challenge}`);
}

export interface Preimage {
  preimage: Uint8Array;
  secretHash: Uint8Array;
  preimageHex: string;
  secretHashHex: string;
}

export function newPreimage(): Preimage {
  const preimage = new Uint8Array(randomBytes(PREIMAGE_SIZE));
  const secretHash = sha256Bytes(preimage);
  return { preimage, secretHash, preimageHex: bytesToHex(preimage), secretHashHex: bytesToHex(secretHash) };
}

export function hashPreimage(preimage: Uint8Array): Uint8Array {
  if (preimage.length !== PREIMAGE_SIZE) throw new Error('preimage must be exactly 32 bytes');
  return sha256Bytes(preimage);
}
