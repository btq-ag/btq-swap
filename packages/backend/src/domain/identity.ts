import { getAddress, verifyMessage } from 'ethers';
import {
  DILITHIUM2_PUBKEY_SIZE,
  DILITHIUM2_SIG_SIZE,
  bytesToHex,
  decodeBlob,
  decodeSegwitAddress,
  linkChallengeMessage,
  verifySignature,
} from '@btq-swap/htlc';
import { config } from '../config';
import { randomToken } from '../lib/crypto';
import { db, one, tx, type Queryable } from '../lib/db';
import { writeAudit } from './audit';
import { DomainError } from './errors';
import type { UserRow } from './types';

const LINK_TTL_SEC = 15 * 60;

export async function getUserByDiscordId(discordId: string, q: Queryable = db()): Promise<UserRow | null> {
  return one<UserRow>(q, 'SELECT * FROM users WHERE discord_id = $1', [discordId]);
}

export async function getUserById(id: string, q: Queryable = db()): Promise<UserRow | null> {
  return one<UserRow>(q, 'SELECT * FROM users WHERE id = $1', [id]);
}

export async function getPlatformUser(q: Queryable = db()): Promise<UserRow> {
  const u = await one<UserRow>(q, 'SELECT * FROM users WHERE is_platform = true');
  if (!u) throw new DomainError('NOT_FOUND', 'platform user is not initialised');
  return u;
}

/** Upsert by Discord snowflake; refreshes the username on every interaction. */
export async function ensureUser(discordId: string, username: string, opts: { simulated?: boolean } = {}, q: Queryable = db()): Promise<UserRow> {
  if (!/^\d{5,25}$/.test(discordId)) throw new DomainError('VALIDATION', 'invalid Discord id');
  const row = await one<UserRow>(
    q,
    `INSERT INTO users (discord_id, discord_username, is_simulated)
     VALUES ($1, $2, $3)
     ON CONFLICT (discord_id) DO UPDATE SET discord_username = EXCLUDED.discord_username, updated_at = now()
     RETURNING *`,
    [discordId, username.slice(0, 64), opts.simulated ?? false],
  );
  return row!;
}

export async function acceptTos(userId: string, version = config().TOS_VERSION): Promise<UserRow> {
  return tx(async (c) => {
    const u = await one<UserRow>(c, 'SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (!u) throw new DomainError('NOT_FOUND', 'user not found');
    if (u.tos_accepted_at && u.tos_version === version) return u;
    const updated = await one<UserRow>(
      c,
      'UPDATE users SET tos_accepted_at = now(), tos_version = $2, updated_at = now() WHERE id = $1 RETURNING *',
      [userId, version],
    );
    await writeAudit(c, `user:${userId}`, 'tos.accept', userId, { version });
    return updated!;
  });
}

export function linkStatus(u: UserRow): { tos: boolean; evm: boolean; btq: boolean; sol: boolean } {
  return {
    tos: !!u.tos_accepted_at && u.tos_version === config().TOS_VERSION,
    evm: !!u.eth_address && !!u.eth_verified_at,
    sol: !!u.sol_address,
    btq: !!u.dilithium_pubkey && !!u.btq_pubkey_verified_at && !!u.btq_address,
  };
}

/** Throws a user-facing DomainError unless the user may trade. */
export function assertCanTrade(u: UserRow, rail: 'evm' | 'solana' = 'evm'): void {
  if (u.is_banned) throw new DomainError('USER_BANNED', 'This account is not available.');
  if (u.is_platform) return;
  const s = linkStatus(u);
  if (!s.tos) throw new DomainError('TOS_REQUIRED', 'Accept the terms first with `/swap start`.');
  if (rail === 'solana') {
    if (!s.sol) throw new DomainError('LINK_REQUIRED', 'Link your Solana wallet before trading on the Solana rail.');
  } else if (!s.evm) {
    throw new DomainError('LINK_REQUIRED', 'Link your EVM wallet first with `/swap link-evm`.');
  }
  if (!s.btq) throw new DomainError('LINK_REQUIRED', 'Link your BTQ swap key first with `/swap link-btq`.');
}

function siweDomain(): string {
  return new URL(config().PUBLIC_BASE_URL).host;
}

/** EIP-4361 message bound to our domain, URI, chain id and a single-use nonce. */
export function buildSiweMessage(p: { address: string; username: string; nonce: string; issuedAt: Date; expiresAt: Date }): string {
  return [
    `${siweDomain()} wants you to sign in with your Ethereum account:`,
    p.address,
    '',
    `Link this wallet to BTQ Swap for Discord user ${p.username}.`,
    '',
    `URI: ${config().PUBLIC_BASE_URL}`,
    'Version: 1',
    `Chain ID: ${config().EVM_CHAIN_ID}`,
    `Nonce: ${p.nonce}`,
    `Issued At: ${p.issuedAt.toISOString()}`,
    `Expiration Time: ${p.expiresAt.toISOString()}`,
  ].join('\n');
}

export async function startEvmLink(user: UserRow, addressInput: string): Promise<{ message: string; address: string; expiresAt: Date }> {
  let address: string;
  try {
    address = getAddress(addressInput.trim());
  } catch {
    throw new DomainError('VALIDATION', 'That is not a valid EVM address.');
  }
  const nonce = randomToken(12);
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + LINK_TTL_SEC * 1000);
  const message = buildSiweMessage({ address, username: user.discord_username ?? user.discord_id ?? user.id, nonce, issuedAt, expiresAt });
  await db().query(
    `INSERT INTO link_challenges (user_id, kind, challenge, message, expires_at) VALUES ($1, 'evm', $2, $3, $4)`,
    [user.id, nonce, message, expiresAt],
  );
  return { message, address, expiresAt };
}

export async function finishEvmLink(user: UserRow, signature: string): Promise<UserRow> {
  return tx(async (c) => {
    const ch = await one<{ id: string; message: string; expires_at: Date; consumed_at: Date | null }>(
      c,
      `SELECT id, message, expires_at, consumed_at FROM link_challenges
       WHERE user_id = $1 AND kind = 'evm' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [user.id],
    );
    if (!ch || ch.consumed_at) throw new DomainError('EXPIRED', 'No pending wallet link. Run `/swap link-evm` again.');
    if (ch.expires_at.getTime() < Date.now()) throw new DomainError('EXPIRED', 'That link request expired. Run `/swap link-evm` again.');
    const lines = ch.message.split('\n');
    if (!lines[0]?.startsWith(`${siweDomain()} wants you to sign in`)) throw new DomainError('VALIDATION', 'Link message domain mismatch.');
    const claimed = getAddress(lines[1]!.trim());
    let recovered: string;
    try {
      recovered = getAddress(verifyMessage(ch.message, signature.trim()));
    } catch {
      throw new DomainError('VALIDATION', 'That signature could not be verified.');
    }
    if (recovered !== claimed) throw new DomainError('VALIDATION', 'The signature was not made by the address in the message.');
    const taken = await one<{ id: string }>(c, 'SELECT id FROM users WHERE lower(eth_address) = lower($1) AND id <> $2', [claimed, user.id]);
    if (taken) throw new DomainError('CONFLICT', 'That wallet is already linked to another account.');
    await c.query('UPDATE link_challenges SET consumed_at = now() WHERE id = $1', [ch.id]);
    const updated = await one<UserRow>(
      c,
      'UPDATE users SET eth_address = $2, eth_verified_at = now(), updated_at = now() WHERE id = $1 RETURNING *',
      [user.id, claimed.toLowerCase()],
    );
    await writeAudit(c, `user:${user.id}`, 'link.evm', user.id, { address: claimed });
    return updated!;
  });
}

export async function startBtqLink(user: UserRow): Promise<{ challenge: string; expiresAt: Date }> {
  const challenge = `btq-swap:${user.discord_id ?? user.id}:${randomToken(10)}`;
  const expiresAt = new Date(Date.now() + LINK_TTL_SEC * 1000);
  await db().query(
    `INSERT INTO link_challenges (user_id, kind, challenge, message, expires_at) VALUES ($1, 'btq', $2, $2, $3)`,
    [user.id, challenge, expiresAt],
  );
  return { challenge, expiresAt };
}

export async function finishBtqLink(user: UserRow, input: { pubkey: string; signature: string; btqAddress: string }): Promise<UserRow> {
  let pubkey: Uint8Array;
  let sig: Uint8Array;
  try {
    pubkey = decodeBlob(input.pubkey);
    sig = decodeBlob(input.signature);
  } catch {
    throw new DomainError('VALIDATION', 'Public key and signature must be base64 (as printed by `btq-htlc link`).');
  }
  if (pubkey.length !== DILITHIUM2_PUBKEY_SIZE) throw new DomainError('VALIDATION', `Swap key must be a ${DILITHIUM2_PUBKEY_SIZE}-byte Dilithium2 public key.`);
  if (sig.length !== DILITHIUM2_SIG_SIZE) throw new DomainError('VALIDATION', 'Signature has the wrong length.');
  try {
    decodeSegwitAddress(input.btqAddress.trim(), config().BTQ_NETWORK);
  } catch (e) {
    throw new DomainError('VALIDATION', `BTQ address: ${(e as Error).message}`);
  }
  return tx(async (c) => {
    const ch = await one<{ id: string; challenge: string; expires_at: Date; consumed_at: Date | null }>(
      c,
      `SELECT id, challenge, expires_at, consumed_at FROM link_challenges
       WHERE user_id = $1 AND kind = 'btq' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [user.id],
    );
    if (!ch || ch.consumed_at) throw new DomainError('EXPIRED', 'No pending key link. Run `/swap link-btq` again.');
    if (ch.expires_at.getTime() < Date.now()) throw new DomainError('EXPIRED', 'That key link expired. Run `/swap link-btq` again.');
    if (!verifySignature(pubkey, linkChallengeMessage(ch.challenge), sig)) {
      throw new DomainError('VALIDATION', 'The signature does not prove ownership of that swap key for this challenge.');
    }
    const pkHex = bytesToHex(pubkey);
    const taken = await one<{ id: string }>(c, 'SELECT id FROM users WHERE dilithium_pubkey = $1 AND id <> $2', [pkHex, user.id]);
    if (taken) throw new DomainError('CONFLICT', 'That swap key is already linked to another account.');
    await c.query('UPDATE link_challenges SET consumed_at = now() WHERE id = $1', [ch.id]);
    const updated = await one<UserRow>(
      c,
      `UPDATE users SET dilithium_pubkey = $2, btq_address = $3, btq_pubkey_verified_at = now(), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [user.id, pkHex, input.btqAddress.trim()],
    );
    await writeAudit(c, `user:${user.id}`, 'link.btq', user.id, { btqAddress: input.btqAddress.trim() });
    return updated!;
  });
}

export async function setNotifications(userId: string, enabled: boolean): Promise<void> {
  await db().query('UPDATE users SET notifications_enabled = $2, updated_at = now() WHERE id = $1', [userId, enabled]);
}

export async function setBanned(userId: string, banned: boolean, actor: string): Promise<UserRow> {
  return tx(async (c) => {
    const u = await one<UserRow>(
      c,
      `UPDATE users SET is_banned = $2, banned_at = CASE WHEN $2 THEN now() ELSE NULL END, updated_at = now()
       WHERE id = $1 AND is_platform = false RETURNING *`,
      [userId, banned],
    );
    if (!u) throw new DomainError('NOT_FOUND', 'user not found');
    if (banned) {
      await c.query(`UPDATE orders SET status = 'cancelled', updated_at = now() WHERE user_id = $1 AND status IN ('open', 'partially_filled', 'paused')`, [userId]);
    }
    await writeAudit(c, actor, banned ? 'user.ban' : 'user.unban', userId);
    return u;
  });
}

export async function isAdmin(discordId: string, minRole: 'viewer' | 'admin' | 'owner' = 'viewer', q: Queryable = db()): Promise<boolean> {
  const row = await one<{ role: string; disabled_at: Date | null }>(q, 'SELECT role, disabled_at FROM admin_users WHERE discord_id = $1', [discordId]);
  if (!row || row.disabled_at) return false;
  const rank = { viewer: 1, admin: 2, owner: 3 } as const;
  return rank[row.role as keyof typeof rank] >= rank[minRole];
}

export async function seedAdmins(discordIds: string[]): Promise<void> {
  for (const id of discordIds) {
    await db().query(`INSERT INTO admin_users (discord_id, role) VALUES ($1, 'owner') ON CONFLICT (discord_id) DO NOTHING`, [id]);
  }
}
