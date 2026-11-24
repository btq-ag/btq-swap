import { db, many, one } from '../lib/db';

export async function getCursor(chain: 'btq' | 'evm'): Promise<{ height: number; hash: string | null } | null> {
  const r = await one<{ height: string; block_hash: string | null }>(db(), 'SELECT height, block_hash FROM chain_cursors WHERE chain = $1', [chain]);
  return r ? { height: Number(r.height), hash: r.block_hash } : null;
}

export async function setCursor(chain: 'btq' | 'evm', height: number, hash: string | null): Promise<void> {
  await db().query(
    `WITH checkpoint AS (
       INSERT INTO chain_checkpoints (chain,height,block_hash) SELECT $1,$2,$3 WHERE $3::text IS NOT NULL
       ON CONFLICT (chain,height) DO UPDATE SET block_hash = EXCLUDED.block_hash
     ) INSERT INTO chain_cursors (chain, height, block_hash, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (chain) DO UPDATE SET height = EXCLUDED.height, block_hash = EXCLUDED.block_hash, updated_at = now()`,
    [chain, height, hash],
  );
}

/** Find a verified ancestor, including deep forks and head retreat. Never infer canonicality from height. */
export async function canonicalCursor(chain: 'btq' | 'evm', head: number, hashAt: (height: number) => Promise<string>, initial: number): Promise<{ height: number; hash: string | null }> {
  const cursor = await getCursor(chain);
  if (!cursor) return { height: initial, hash: null };
  if (cursor.hash && cursor.height <= head && await hashAt(cursor.height) === cursor.hash) return cursor;
  const history = await many<{ height: string; block_hash: string }>(db(),
    'SELECT height, block_hash FROM chain_checkpoints WHERE chain = $1 AND height <= $2 ORDER BY height DESC', [chain, Math.min(head, cursor.height)]);
  let ancestor = { height: -1, hash: null as string | null };
  for (const row of history) {
    if (await hashAt(Number(row.height)) === row.block_hash) { ancestor = { height: Number(row.height), hash: row.block_hash }; break; }
  }
  await db().query('DELETE FROM chain_checkpoints WHERE chain = $1 AND height > $2', [chain, ancestor.height]);
  await setCursor(chain, ancestor.height, ancestor.hash);
  return ancestor;
}
