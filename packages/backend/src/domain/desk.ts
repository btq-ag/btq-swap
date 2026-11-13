import { getAddress } from 'ethers';
import { randomBytes } from 'node:crypto';
import nacl from 'tweetnacl';
import { PublicKey, Transaction } from '@solana/web3.js';
import { btqNetworkTag, swapBindingAsset } from '@btq-swap/htlc';
import { config } from '../config';
import { evmChain } from '../chains/evm';
import { buildHtlcTransaction } from '../chains/solana-htlc';
import { solanaMint, solanaProgramId, withSolana } from '../chains/solana';
import { sha256Hex } from '../lib/crypto';
import { db, one, type Queryable } from '../lib/db';
import { takeOrder } from './book';
import { verifyWalletProof, type WalletProof } from './desk-proof';
import { DomainError } from './errors';
import {
  acceptTos,
  finishEvmLink,
  getUserByDiscordId,
  getUserById,
  linkStatus,
  startBtqLink,
  startEvmLink,
} from './identity';
import { getSwap, hintBtqLock } from './settlement';
import type { SwapRow, UserRow } from './types';

const SESSION_HOURS = 12;

export interface DeskProfile {
  eth: string | null;
  sol: string | null;
  btq: string | null;
  evmLinked: boolean;
  solLinked: boolean;
  btqLinked: boolean;
  tos: boolean;
}

function webDiscordId(address: string): string {
  return `web:${address.toLowerCase()}`;
}

export function deskProfile(user: UserRow): DeskProfile {
  const s = linkStatus(user);
  return { eth: user.eth_address, sol: user.sol_address, btq: user.btq_address, evmLinked: s.evm, solLinked: s.sol, btqLinked: s.btq, tos: s.tos };
}

async function userByEth(address: string, q: Queryable = db()): Promise<UserRow | null> {
  return one<UserRow>(q, 'SELECT * FROM users WHERE lower(eth_address) = lower($1)', [address]);
}

/** A wallet that has not signed in yet gets a row keyed by `web:<address>`. An address already linked to Discord is that Discord user. */
export async function userForDesk(addressInput: string, accepted: boolean): Promise<UserRow> {
  let address: string;
  try {
    address = getAddress(addressInput.trim());
  } catch {
    throw new DomainError('VALIDATION', 'That is not a valid EVM address.');
  }
  const linked = await userByEth(address);
  if (linked) {
    if (!accepted && !linkStatus(linked).tos) throw new DomainError('TOS_REQUIRED', 'Accept the terms to trade from this desk.');
    if (accepted && !linkStatus(linked).tos) return acceptTos(linked.id);
    return linked;
  }
  const discordId = webDiscordId(address);
  let user = await getUserByDiscordId(discordId);
  if (!user) {
    if (!accepted) throw new DomainError('TOS_REQUIRED', 'Accept the terms to trade from this desk.');
    user = await one<UserRow>(
      db(),
      `INSERT INTO users (discord_id, discord_username, tos_accepted_at, tos_version, notifications_enabled)
       VALUES ($1, $2, now(), $3, false) RETURNING *`,
      [discordId, `Desk ${address.slice(0, 6)}`, config().TOS_VERSION],
    );
    return user!;
  }
  if (accepted && !linkStatus(user).tos) return acceptTos(user.id);
  return user;
}

export async function beginEvm(address: string, acceptTos: boolean): Promise<{ message: string; expiresAt: string; profile: DeskProfile }> {
  const user = await userForDesk(address, acceptTos);
  const link = await startEvmLink(user, address);
  return { message: link.message, expiresAt: link.expiresAt.toISOString(), profile: deskProfile(user) };
}

export async function completeEvm(address: string, signature: string): Promise<{ token: string; expiresAt: string; profile: DeskProfile }> {
  const checksum = getAddress(address.trim());
  const user = (await userByEth(checksum)) ?? (await getUserByDiscordId(webDiscordId(checksum)));
  if (!user) throw new DomainError('NOT_REGISTERED', 'Connect the EVM wallet again.');
  const updated = await finishEvmLink(user, signature);
  const token = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_HOURS * 3600_000);
  await db().query('INSERT INTO desk_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [sha256Hex(token), updated.id, expires]);
  return { token, expiresAt: expires.toISOString(), profile: deskProfile(updated) };
}

export async function userFromToken(token: string | undefined): Promise<UserRow> {
  if (!token || !/^[0-9a-f]{64}$/i.test(token)) throw new DomainError('NOT_REGISTERED', 'Connect your EVM wallet to trade.');
  const row = await one<{ user_id: string; expires_at: Date }>(
    db(),
    'SELECT user_id, expires_at FROM desk_sessions WHERE token_hash = $1',
    [sha256Hex(token.trim())],
  );
  if (!row || row.expires_at.getTime() < Date.now()) throw new DomainError('EXPIRED', 'The desk session expired. Connect your EVM wallet again.');
  const user = await getUserById(row.user_id);
  if (!user) throw new DomainError('NOT_REGISTERED', 'Connect your EVM wallet to trade.');
  return user;
}

export function bearer(header: string | undefined): string | undefined {
  const m = /^Bearer ([0-9a-f]{64})$/i.exec(header?.trim() ?? '');
  return m?.[1];
}

export async function beginBtq(user: UserRow): Promise<{ challenge: string; expiresAt: string }> {
  const link = await startBtqLink(user);
  return { challenge: link.challenge, expiresAt: link.expiresAt.toISOString() };
}

export async function completeBtq(user: UserRow, proof: WalletProof, requestOrigin: string): Promise<DeskProfile> {
  let originHost = '';
  try {
    originHost = new URL(requestOrigin).hostname;
  } catch {
    throw new DomainError('VALIDATION', 'The browser did not send a site origin.');
  }
  if (proof.origin !== requestOrigin) throw new DomainError('VALIDATION', 'The wallet signed a different site than this request.');
  const allowedHost = new URL(config().PUBLIC_BASE_URL).hostname;
  if (originHost !== allowedHost && originHost !== 'localhost' && originHost !== '127.0.0.1') {
    throw new DomainError('VALIDATION', 'This desk does not accept a wallet proof from that site.');
  }
  const verified = verifyWalletProof(proof, { message: (await currentBtqChallenge(user)).challenge, network: config().BTQ_NETWORK });
  await db().query('UPDATE link_challenges SET consumed_at = now() WHERE user_id = $1 AND kind = $2 AND consumed_at IS NULL', [user.id, 'btq']);
  const taken = await one<{ id: string }>(db(), 'SELECT id FROM users WHERE dilithium_pubkey = $1 AND id <> $2', [verified.pubkeyHex, user.id]);
  if (taken) throw new DomainError('CONFLICT', 'That BTQ key is already linked to another account.');
  const updated = await one<UserRow>(
    db(),
    `UPDATE users SET dilithium_pubkey = $2, btq_address = $3, btq_pubkey_verified_at = now(), updated_at = now() WHERE id = $1 RETURNING *`,
    [user.id, verified.pubkeyHex, verified.address],
  );
  return deskProfile(updated!);
}

async function currentBtqChallenge(user: UserRow): Promise<{ challenge: string }> {
  const ch = await one<{ challenge: string; expires_at: Date; consumed_at: Date | null }>(
    db(),
    `SELECT challenge, expires_at, consumed_at FROM link_challenges
     WHERE user_id = $1 AND kind = 'btq' ORDER BY created_at DESC LIMIT 1`,
    [user.id],
  );
  if (!ch || ch.consumed_at || ch.expires_at.getTime() < Date.now()) {
    throw new DomainError('EXPIRED', 'The BTQ challenge expired. Connect the BTQ wallet again.');
  }
  return ch;
}

export async function deskTake(user: UserRow, orderNo: number, amountBtq: string): Promise<SwapRow> {
  const result = await takeOrder(user.id, String(orderNo), amountBtq);
  const swap = result.swaps[0];
  if (!swap) throw new DomainError('NO_LIQUIDITY', 'That order was not available for this amount.');
  return swap;
}

export interface LockPlan {
  shortId: number;
  status: string;
  role: 'buyer' | 'seller';
  evmLock: null | {
    chainId: number;
    htlc: string;
    token: string;
    partyB: string;
    amountUnits: string;
    otherNetwork: string;
    otherAsset: string;
    otherAmount: string;
    deadline: number;
  };
  btqSend: null | { address: string; amountSats: string; amountBtq: string };
  usdtClaim: null | { agreementId: string; preimage: string };
  usdtRefund: null | { agreementId: string };
  solLock: boolean;
  solClaim: boolean;
  solRefund: boolean;
  contract: string;
  chainId: number;
}

export async function lockPlan(user: UserRow, ref: string): Promise<LockPlan> {
  const swap = await getSwap(ref);
  if (!swap) throw new DomainError('NOT_FOUND', 'No swap with that id.');
  const role = swap.buyer_user_id === user.id ? 'buyer' : swap.seller_user_id === user.id ? 'seller' : null;
  if (!role) throw new DomainError('NOT_FOUND', 'No swap with that id.');
  const { htlc, token } = evmChain().addresses();
  const evmLock =
    role === 'buyer' && swap.status === 'awaiting_buyer_lock'
      ? {
          chainId: config().EVM_CHAIN_ID,
          htlc,
          token,
          partyB: swap.seller_eth,
          amountUnits: swap.amount_usdt_units,
          otherNetwork: btqNetworkTag(swap.btq_network),
          otherAsset: swapBindingAsset(swap.id),
          otherAmount: swap.amount_sats,
          deadline: (await evmChain().latestTimestamp()) + config().SWAP_EVM_LOCK_DURATION_SEC,
        }
      : null;
  const btqSend =
    role === 'seller' && swap.status === 'awaiting_seller_lock' && swap.btq_htlc_address && !swap.btq_lock_txid
      ? { address: swap.btq_htlc_address, amountSats: swap.amount_sats, amountBtq: swap.amount_btq }
      : null;
  const usdtClaim =
    role === 'seller' && swap.status === 'awaiting_seller_claim' && swap.evm_agreement_id && swap.revealed_preimage && !swap.evm_claim_tx
      ? { agreementId: swap.evm_agreement_id, preimage: swap.revealed_preimage }
      : null;
  const usdtRefund =
    role === 'buyer' && ['awaiting_buyer_refund', 'awaiting_refunds'].includes(swap.status) && swap.evm_agreement_id && !swap.evm_refund_tx && !swap.evm_claim_tx
      ? { agreementId: swap.evm_agreement_id }
      : null;
  const sol = swap.settlement_rail === 'solana';
  return {
    shortId: Number(swap.short_id),
    status: swap.status,
    role,
    evmLock: sol ? null : evmLock,
    btqSend,
    usdtClaim: sol ? null : usdtClaim,
    usdtRefund: sol ? null : usdtRefund,
    solLock: sol && role === 'buyer' && swap.status === 'awaiting_buyer_lock',
    solClaim: sol && !!usdtClaim,
    solRefund: sol && !!usdtRefund,
    contract: htlc,
    chainId: config().EVM_CHAIN_ID,
  };
}

export async function noteBtqLock(user: UserRow, ref: string, txid: string): Promise<void> {
  await hintBtqLock(user.id, ref, txid);
}

async function userForSol(address: string, accepted: boolean): Promise<UserRow> {
  const linked = await one<UserRow>(db(), 'SELECT * FROM users WHERE sol_address = $1', [address]);
  if (linked) {
    if (!accepted && !linkStatus(linked).tos) throw new DomainError('TOS_REQUIRED', 'Accept the terms to trade from this desk.');
    if (accepted && !linkStatus(linked).tos) return acceptTos(linked.id);
    return linked;
  }
  const discordId = `web:sol:${address}`;
  let user = await getUserByDiscordId(discordId);
  if (!user) {
    if (!accepted) throw new DomainError('TOS_REQUIRED', 'Accept the terms to trade from this desk.');
    user = await one<UserRow>(
      db(),
      `INSERT INTO users (discord_id, discord_username, tos_accepted_at, tos_version, notifications_enabled)
       VALUES ($1, $2, now(), $3, false) RETURNING *`,
      [discordId, `Desk ${address.slice(0, 4)}`, config().TOS_VERSION],
    );
    return user!;
  }
  if (accepted && !linkStatus(user).tos) return acceptTos(user.id);
  return user;
}

export async function beginSol(address: string, accepted: boolean, sessionUser: UserRow | null): Promise<{ message: string; expiresAt: string; profile: DeskProfile }> {
  let canonical: string;
  try {
    canonical = new PublicKey(address).toBase58();
  } catch {
    throw new DomainError('VALIDATION', 'That is not a Solana address.');
  }
  const user = sessionUser ?? await userForSol(canonical, accepted);
  const nonce = randomBytes(16).toString('hex');
  const message = `BTQ Swap\nLink Solana ${canonical}\nNonce ${nonce}`;
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  await db().query(
    `INSERT INTO link_challenges (user_id, kind, challenge, message, expires_at) VALUES ($1, 'sol', $2, $3, $4)`,
    [user.id, nonce, message, expiresAt],
  );
  return { message, expiresAt: expiresAt.toISOString(), profile: deskProfile(user) };
}

export async function completeSol(address: string, signature: string, sessionUser: UserRow | null): Promise<{ token: string | null; expiresAt: string | null; profile: DeskProfile }> {
  const canonical = new PublicKey(address).toBase58();
  const user = sessionUser ?? (await one<UserRow>(db(), 'SELECT * FROM users WHERE discord_id = $1 OR sol_address = $2', [`web:sol:${canonical}`, canonical]));
  if (!user) throw new DomainError('NOT_REGISTERED', 'Connect the Solana wallet again.');
  const ch = await one<{ message: string; expires_at: Date; consumed_at: Date | null }>(
    db(),
    `SELECT message, expires_at, consumed_at FROM link_challenges WHERE user_id = $1 AND kind = 'sol' ORDER BY created_at DESC LIMIT 1`,
    [user.id],
  );
  if (!ch || ch.consumed_at || ch.expires_at.getTime() < Date.now()) throw new DomainError('EXPIRED', 'The Solana challenge expired. Connect the wallet again.');
  const sig = Buffer.from(signature, 'base64');
  if (sig.length !== 64 || !nacl.sign.detached.verify(Buffer.from(ch.message), sig, new PublicKey(canonical).toBytes())) {
    throw new DomainError('VALIDATION', 'The Solana signature does not match this desk.');
  }
  const taken = await one<{ id: string }>(db(), 'SELECT id FROM users WHERE sol_address = $1 AND id <> $2', [canonical, user.id]);
  if (taken) throw new DomainError('CONFLICT', 'That Solana wallet is already linked to another account.');
  await db().query(`UPDATE link_challenges SET consumed_at = now() WHERE user_id = $1 AND kind = 'sol' AND consumed_at IS NULL`, [user.id]);
  const updated = await one<UserRow>(db(), 'UPDATE users SET sol_address = $2, updated_at = now() WHERE id = $1 RETURNING *', [user.id, canonical]);
  if (sessionUser) return { token: null, expiresAt: null, profile: deskProfile(updated!) };
  const token = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_HOURS * 3600_000);
  await db().query('INSERT INTO desk_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [sha256Hex(token), updated!.id, expires]);
  return { token, expiresAt: expires.toISOString(), profile: deskProfile(updated!) };
}

export async function prepareSolTx(user: UserRow, ref: string, action: 'lock' | 'withdraw' | 'refund', secretHashHex?: string): Promise<{ tx: string }> {
  const swap = await getSwap(ref);
  if (!swap || swap.settlement_rail !== 'solana') throw new DomainError('NOT_FOUND', 'That swap is not on Solana.');
  if (!swap.buyer_sol || !swap.seller_sol) throw new DomainError('VALIDATION', 'This swap has no Solana wallets.');
  const buyerSol = swap.buyer_sol;
  const sellerSol = swap.seller_sol;
  const actor = action === 'withdraw' ? swap.seller_user_id : swap.buyer_user_id;
  if (user.id !== actor) throw new DomainError('FORBIDDEN', 'This step belongs to the other party.');
  let secretHash: Buffer;
  let deadline: bigint;
  let preimage: Buffer | undefined;
  if (action === 'lock') {
    if (!secretHashHex || !/^[0-9a-f]{64}$/i.test(secretHashHex)) throw new DomainError('VALIDATION', 'The secret hash must be 32 bytes of hex.');
    secretHash = Buffer.from(secretHashHex, 'hex');
    deadline = BigInt(Math.floor(Date.now() / 1000) + config().SWAP_EVM_LOCK_DURATION_SEC);
  } else {
    if (!swap.secret_hash || !swap.evm_deadline) throw new DomainError('CONFLICT', 'The Solana lock is not recorded yet.');
    secretHash = Buffer.from(swap.secret_hash, 'hex');
    deadline = BigInt(Math.floor(new Date(swap.evm_deadline).getTime() / 1000));
    if (action === 'withdraw') {
      if (!swap.revealed_preimage) throw new DomainError('CONFLICT', 'The secret is not public yet. Claim the BTQ first.');
      preimage = Buffer.from(swap.revealed_preimage, 'hex');
    }
  }
  const tx = await withSolana((connection) => buildHtlcTransaction({
    connection,
    programId: solanaProgramId(),
    mint: solanaMint(),
    feePayer: new PublicKey(action === 'withdraw' ? sellerSol : buyerSol),
    action,
    partyA: new PublicKey(buyerSol),
    partyB: new PublicKey(sellerSol),
    amount: BigInt(swap.amount_usdt_units),
    secretHash,
    deadline,
    preimage,
  }));
  return { tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64') };
}

export async function submitSolTx(signedTx: string): Promise<{ signature: string }> {
  const tx = Transaction.from(Buffer.from(signedTx, 'base64'));
  const signature = await withSolana(async (connection) => {
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await connection.confirmTransaction(sig, 'confirmed');
    return sig;
  });
  const { solanaTick } = await import('../workers/solana-watcher');
  await solanaTick();
  return { signature };
}
