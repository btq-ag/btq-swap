import { one, type Queryable } from '../lib/db';
import type { SwapRow } from './types';

/** Serialize equal hashes before checking the partial unique index, without aborting the transaction on expected duplicates. */
export async function hashOwnerConflict(c: Queryable, hash: string, s: SwapRow, agreementId: string): Promise<boolean> {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [hash.toLowerCase()]);
  if (await one(c, 'SELECT id FROM swaps WHERE lower(secret_hash) = $1 AND id <> $2', [hash.toLowerCase(), s.id])) return true;
  const lockId = `${s.settlement_rail}:${s.evm_chain_id}:${s.evm_htlc_contract}:${agreementId.toLowerCase()}`;
  const row = await one(c, `INSERT INTO secret_hash_uses (secret_hash, swap_id, lock_id) VALUES ($1,$2,$3)
    ON CONFLICT (secret_hash) DO UPDATE SET lock_id = EXCLUDED.lock_id
    WHERE secret_hash_uses.swap_id = EXCLUDED.swap_id
      AND (secret_hash_uses.lock_id IS NULL OR secret_hash_uses.lock_id = EXCLUDED.lock_id) RETURNING swap_id`,
  [hash.toLowerCase(), s.id, lockId]);
  return !row;
}

export async function rememberLock(c: Queryable, s: SwapRow, chain: 'evm' | 'btq' | 'solana', lockId: string,
  metadata: Record<string, unknown>, reason: string | null): Promise<boolean> {
  const network = chain === 'btq' ? s.btq_network : `${s.evm_chain_id}:${s.evm_htlc_contract}`;
  const result = await c.query(`INSERT INTO swap_locks (chain, network, lock_id, swap_id, reason, metadata)
    VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (chain, network, lock_id)
    DO UPDATE SET metadata = swap_locks.metadata || EXCLUDED.metadata || jsonb_build_object('accepted',
      swap_locks.reason IS NULL OR EXCLUDED.reason IS NULL OR COALESCE((swap_locks.metadata->>'accepted')::boolean, false)), reason = EXCLUDED.reason
    WHERE swap_locks.swap_id = EXCLUDED.swap_id RETURNING swap_id`,
  [chain, network, lockId.toLowerCase(), s.id, reason, JSON.stringify(metadata, (_, v) => typeof v === 'bigint' ? v.toString() : v)]);
  return result.rows.length === 1;
}
