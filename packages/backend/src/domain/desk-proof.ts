import {
  BtqNetwork,
  OP_CHECKSIGDILITHIUM,
  concatBytes,
  encodeP2mrAddress,
  hexToBytes,
  pushData,
  tapleafHash,
  verifySignature,
} from '@btq-swap/htlc';
import { DomainError } from './errors';

const DOMAIN = 'BTQ Wallet Signed Message\nversion=1\n';

export interface WalletProof {
  scheme: string;
  version: number;
  origin: string;
  network: string;
  address: string;
  message: string;
  publicKey: string;
  signature: string;
}

/** Single-key P2MR address, the same leaf the BTQ browser wallet uses. */
export function walletAddressForPubkey(pubkey: Uint8Array, network: BtqNetwork): string {
  const leaf = concatBytes(pushData(pubkey), Uint8Array.of(OP_CHECKSIGDILITHIUM));
  return encodeP2mrAddress(network, tapleafHash(leaf));
}

export function walletProofPayload(proof: Pick<WalletProof, 'origin' | 'network' | 'address' | 'message'>): Uint8Array {
  return new TextEncoder().encode(DOMAIN + JSON.stringify([1, proof.origin, proof.network, proof.address, proof.message]));
}

/** Verify a `window.btq.signMessage` proof. The caller checks origin and network policy. */
export function verifyWalletProof(proof: WalletProof, expected: { message: string; network: BtqNetwork }): { pubkeyHex: string; address: string } {
  if (proof.scheme !== 'btq-wallet-message' || proof.version !== 1) {
    throw new DomainError('VALIDATION', 'That is not a BTQ wallet signature.');
  }
  if (proof.network !== expected.network) {
    throw new DomainError('VALIDATION', `The BTQ wallet is on ${proof.network}. This desk is on ${expected.network}.`);
  }
  if (proof.message !== expected.message) {
    throw new DomainError('VALIDATION', 'The wallet signed a different challenge. Connect the BTQ wallet again.');
  }
  if (!/^https?:\/\//.test(proof.origin)) throw new DomainError('VALIDATION', 'The wallet proof has no site origin.');
  let pubkey: Uint8Array;
  let signature: Uint8Array;
  try {
    pubkey = hexToBytes(proof.publicKey);
    signature = hexToBytes(proof.signature);
  } catch {
    throw new DomainError('VALIDATION', 'The wallet proof is not valid hex.');
  }
  const address = walletAddressForPubkey(pubkey, expected.network);
  if (address !== proof.address) throw new DomainError('VALIDATION', 'The public key does not match the BTQ address.');
  if (!verifySignature(pubkey, walletProofPayload(proof), signature)) {
    throw new DomainError('VALIDATION', 'The BTQ wallet signature does not verify.');
  }
  return { pubkeyHex: proof.publicKey.replace(/^0x/, '').toLowerCase(), address };
}
