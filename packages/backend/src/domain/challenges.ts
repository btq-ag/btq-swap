import { randomUUID } from 'node:crypto';
import { UUID_RE } from '@btq-swap/htlc';
import { db, one, type Queryable } from '../lib/db';
import { DomainError } from './errors';

export type ChallengePurpose = 'identity' | 'desk_signin' | 'desk_link';
export type ChallengeKind = 'evm' | 'btq' | 'sol';
export interface Challenge {
  id: string;
  user_id: string;
  kind: ChallengeKind;
  challenge: string;
  message: string;
  purpose: ChallengePurpose;
  target_address: string | null;
}

export async function issueChallenge(p: Omit<Challenge, 'id'> & { expires_at: Date }): Promise<string> {
  const id = randomUUID();
  await db().query(`INSERT INTO link_challenges
    (id, user_id, kind, challenge, message, expires_at, purpose, target_address)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
  [id, p.user_id, p.kind, p.challenge, p.message, p.expires_at, p.purpose, p.target_address]);
  return id;
}

/** Must share a transaction with verification, the account update and any new session.
 * A verification failure rolls back consumption; concurrent successful submissions cannot both win.
 */
export async function consumeChallenge(q: Queryable, id: string, userId: string, kind: ChallengeKind, purpose: ChallengePurpose): Promise<Challenge> {
  if (!UUID_RE.test(id)) throw new DomainError('EXPIRED', 'Select a current wallet challenge. Connect again.');
  const ch = await one<Challenge>(q, `UPDATE link_challenges SET consumed_at = now()
    WHERE id = $1 AND user_id = $2 AND kind = $3 AND purpose = $4
      AND consumed_at IS NULL AND expires_at > clock_timestamp() RETURNING *`, [id, userId, kind, purpose]);
  if (!ch) throw new DomainError('EXPIRED', 'This wallet challenge is expired, already used, or belongs to a different sign-in. Connect again.');
  return ch;
}
