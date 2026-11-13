import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { describe, expect, it } from 'vitest';
import { verifyWalletProof, walletAddressForPubkey, walletProofPayload, type WalletProof } from '../src/domain/desk-proof';

describe('BTQ wallet proof', () => {
  it('accepts a signature from the key that owns the address', () => {
    const { publicKey, secretKey } = ml_dsa44.keygen();
    const address = walletAddressForPubkey(publicKey, 'regtest');
    const proof: WalletProof = {
      scheme: 'btq-wallet-message',
      version: 1,
      origin: 'http://localhost:5173',
      network: 'regtest',
      address,
      message: 'btq-swap:desk:challenge',
      publicKey: Buffer.from(publicKey).toString('hex'),
      signature: '',
    };
    proof.signature = Buffer.from(ml_dsa44.sign(walletProofPayload(proof), secretKey)).toString('hex');
    expect(verifyWalletProof(proof, { message: proof.message, network: 'regtest' }).address).toBe(address);
  });

  it('rejects a signature over a different challenge', () => {
    const { publicKey, secretKey } = ml_dsa44.keygen();
    const address = walletAddressForPubkey(publicKey, 'regtest');
    const proof: WalletProof = {
      scheme: 'btq-wallet-message',
      version: 1,
      origin: 'http://localhost:5173',
      network: 'regtest',
      address,
      message: 'one',
      publicKey: Buffer.from(publicKey).toString('hex'),
      signature: Buffer.from(ml_dsa44.sign(new TextEncoder().encode('other'), secretKey)).toString('hex'),
    };
    expect(() => verifyWalletProof(proof, { message: 'one', network: 'regtest' })).toThrow(/does not verify/);
  });
});
