import { describe, expect, it } from 'vitest';
import { Wallet } from 'ethers';
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { beginBtq, beginEvm, beginSol, completeBtq, completeEvm, completeSol, userFromToken } from '../src/domain/desk';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { walletAddressForPubkey, walletProofPayload, type WalletProof } from '../src/domain/desk-proof';
import { startEvmLink } from '../src/domain/identity';
import { db } from '../src/lib/db';
import { databaseEnabled, testDatabase, testUser } from './database';

describe.skipIf(!databaseEnabled)('desk authentication and account linking (#12, #13)', () => {
  testDatabase();
  const solSignature = (key: Keypair, message: string) => Buffer.from(nacl.sign.detached(Buffer.from(message), key.secretKey)).toString('base64');

  it('completes an older EVM challenge and issues only one session under concurrent replay', async () => {
    const wallet = Wallet.createRandom();
    const first = await beginEvm(wallet.address, true);
    const second = await beginEvm(wallet.address, true);
    const signature = await wallet.signMessage(first.message);
    const result = await Promise.allSettled([1, 2].map(() => completeEvm(wallet.address, signature, first.challengeId)));
    expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const row = (await db().query('SELECT consumed_at FROM link_challenges WHERE id = $1', [second.challengeId])).rows[0];
    expect(row.consumed_at).toBeNull();
    const sessions = await db().query('SELECT * FROM desk_sessions WHERE user_id = (SELECT user_id FROM link_challenges WHERE id = $1)', [first.challengeId]);
    expect(sessions.rows).toHaveLength(1);
  });

  it('completes an older Solana challenge once and keeps other challenges available', async () => {
    const key = Keypair.generate();
    const address = key.publicKey.toBase58();
    const first = await beginSol(address, true, null);
    const next = await beginSol(address, true, null);
    const result = await Promise.allSettled([1, 2].map(() => completeSol(address, solSignature(key, first.message), null, first.challengeId)));
    expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    await expect(completeSol(address, solSignature(key, next.message), null, next.challengeId)).resolves.toHaveProperty('token');
  });

  it('links EVM after Solana to the same account and preserves the BTQ key', async () => {
    const key = Keypair.generate();
    const first = await beginSol(key.publicKey.toBase58(), true, null);
    const signedIn = await completeSol(key.publicKey.toBase58(), solSignature(key, first.message), null, first.challengeId);
    const user = await userFromToken(signedIn.token!);
    await db().query('UPDATE users SET dilithium_pubkey = $2 WHERE id = $1', [user.id, 'aabb']);
    const wallet = Wallet.createRandom();
    const link = await beginEvm(wallet.address, true, user);
    const done = await completeEvm(wallet.address, await wallet.signMessage(link.message), link.challengeId, user);
    const after = await userFromToken(done.token);
    expect(after.id).toBe(user.id);
    expect(after.sol_address).toBe(key.publicKey.toBase58());
    expect(after.dilithium_pubkey).toBe('aabb');
  });

  it('does not turn a link or Discord proof into an anonymous sign-in', async () => {
    const user = await testUser();
    const wallet = Wallet.createRandom();
    await beginEvm(wallet.address, true); // a separate anonymous account exists
    const link = await beginEvm(wallet.address, true, user);
    const signature = await wallet.signMessage(link.message);
    await expect(completeEvm(wallet.address, signature, link.challengeId)).rejects.toThrow(/challenge/);
    const discord = await startEvmLink(user, wallet.address);
    await expect(completeEvm(wallet.address, await wallet.signMessage(discord.message), discord.challengeId, user)).rejects.toThrow(/challenge/);
    await expect(completeEvm(wallet.address, signature, link.challengeId, user)).resolves.toHaveProperty('token');
  });

  it('rejects expired, foreign-wallet and invalid signatures without consuming a valid challenge', async () => {
    const wallet = Wallet.createRandom();
    const other = Wallet.createRandom();
    const link = await beginEvm(wallet.address, true);
    await expect(completeEvm(wallet.address, await other.signMessage(link.message), link.challengeId)).rejects.toThrow(/signature/);
    await db().query("UPDATE link_challenges SET expires_at = now() - interval '1 second' WHERE id = $1", [link.challengeId]);
    await expect(completeEvm(wallet.address, await wallet.signMessage(link.message), link.challengeId)).rejects.toThrow(/expired/);
    expect((await db().query('SELECT consumed_at FROM link_challenges WHERE id = $1', [link.challengeId])).rows[0].consumed_at).toBeNull();
  });

  it('does not let a pending old-wallet signature undo a later authenticated replacement', async () => {
    const old = Wallet.createRandom();
    const first = await beginEvm(old.address, true);
    const initial = await completeEvm(old.address, await old.signMessage(first.message), first.challengeId);
    const user = await userFromToken(initial.token);
    const stale = await beginEvm(old.address, true);
    const next = Wallet.createRandom();
    const link = await beginEvm(next.address, true, user);
    await completeEvm(next.address, await next.signMessage(link.message), link.challengeId, user);
    await expect(completeEvm(old.address, await old.signMessage(stale.message), stale.challengeId)).rejects.toThrow(/replaced/);
    await expect(beginEvm(old.address, true)).rejects.toThrow(/replaced/);
  });

  it('refuses merging an EVM wallet already linked to another account', async () => {
    const wallet = Wallet.createRandom();
    const first = await beginEvm(wallet.address, true);
    await completeEvm(wallet.address, await wallet.signMessage(first.message), first.challengeId);
    const user = await testUser();
    const link = await beginEvm(wallet.address, true, user);
    await expect(completeEvm(wallet.address, await wallet.signMessage(link.message), link.challengeId, user)).rejects.toThrow(/another account/);
    expect((await db().query('SELECT consumed_at FROM link_challenges WHERE id = $1', [link.challengeId])).rows[0].consumed_at).toBeNull();
  });

  it('handles concurrent first-time challenges without duplicating accounts', async () => {
    const wallet = Wallet.createRandom();
    const started = await Promise.all([1, 2].map(() => beginEvm(wallet.address, true)));
    expect(started[0]!.challengeId).not.toBe(started[1]!.challengeId);
    expect((await db().query('SELECT id FROM users WHERE discord_id = $1', [`web:${wallet.address.toLowerCase()}`])).rows).toHaveLength(1);
  });

  it('records acceptance of updated terms while linking to an existing account', async () => {
    const user = await testUser();
    await db().query("UPDATE users SET tos_version = 'old' WHERE id = $1", [user.id]);
    user.tos_version = 'old';
    const wallet = Wallet.createRandom();
    const link = await beginEvm(wallet.address, true, user);
    expect(link.profile.tos).toBe(true);
    expect((await completeEvm(wallet.address, await wallet.signMessage(link.message), link.challengeId, user)).profile.tos).toBe(true);
  });

  it('consumes only the selected BTQ proof and rolls back a failed proof', async () => {
    const user = await testUser();
    const first = await beginBtq(user);
    const next = await beginBtq(user);
    const key = ml_dsa44.keygen();
    const proof: WalletProof = { scheme: 'btq-wallet-message', version: 1, origin: 'http://localhost:5173',
      network: 'regtest', address: walletAddressForPubkey(key.publicKey, 'regtest'), message: first.challenge,
      publicKey: Buffer.from(key.publicKey).toString('hex'), signature: '' };
    proof.signature = Buffer.from(ml_dsa44.sign(walletProofPayload(proof), key.secretKey)).toString('hex');
    await expect(completeBtq(user, { ...proof, signature: '00' }, proof.origin, first.challengeId)).rejects.toThrow();
    const results = await Promise.allSettled([1, 2].map(() => completeBtq(user, proof, proof.origin, first.challengeId)));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await db().query('SELECT consumed_at FROM link_challenges WHERE id = $1', [next.challengeId])).rows[0].consumed_at).toBeNull();
  });

  it('rolls back EVM consumption and wallet update if session insertion fails', async () => {
    const wallet = Wallet.createRandom();
    const link = await beginEvm(wallet.address, true);
    const userId = (await db().query('SELECT user_id FROM link_challenges WHERE id = $1', [link.challengeId])).rows[0].user_id;
    // A real database error after the wallet update exercises the whole transaction boundary.
    await db().query("ALTER TABLE desk_sessions ADD CONSTRAINT refuse_test_session CHECK (user_id <> '" + userId + "'::uuid)");
    const signature = await wallet.signMessage(link.message);
    try { await expect(completeEvm(wallet.address, signature, link.challengeId)).rejects.toThrow(/refuse_test_session/); }
    finally { await db().query('ALTER TABLE desk_sessions DROP CONSTRAINT refuse_test_session'); }
    expect((await db().query('SELECT eth_address FROM users WHERE id = $1', [userId])).rows[0].eth_address).toBeNull();
    expect((await db().query('SELECT consumed_at FROM link_challenges WHERE id = $1', [link.challengeId])).rows[0].consumed_at).toBeNull();
    await expect(completeEvm(wallet.address, signature, link.challengeId)).resolves.toHaveProperty('token');
  });

  it('rejects a pending Solana proof after its wallet was replaced', async () => {
    const old = Keypair.generate();
    const address = old.publicKey.toBase58();
    const first = await beginSol(address, true, null);
    const login = await completeSol(address, solSignature(old, first.message), null, first.challengeId);
    const user = await userFromToken(login.token!);
    const stale = await beginSol(address, true, null);
    const next = Keypair.generate();
    const link = await beginSol(next.publicKey.toBase58(), true, user);
    await completeSol(next.publicKey.toBase58(), solSignature(next, link.message), user, link.challengeId);
    await expect(completeSol(address, solSignature(old, stale.message), null, stale.challengeId)).rejects.toThrow(/replaced/);
  });
});
