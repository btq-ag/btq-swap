import { db, one } from '../lib/db';

export async function getCursor(chain: 'btq' | 'evm'): Promise<{ height: number; hash: string | null } | null> {
  const r = await one<{ height: string; block_hash: string | null }>(db(), 'SELECT height, block_hash FROM chain_cursors WHERE chain = $1', [chain]);
  return r ? { height: Number(r.height), hash: r.block_hash } : null;
}

export async function setCursor(chain: 'btq' | 'evm', height: number, hash: string | null): Promise<void> {
  await db().query(
    `INSERT INTO chain_cursors (chain, height, block_hash, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (chain) DO UPDATE SET height = EXCLUDED.height, block_hash = EXCLUDED.block_hash, updated_at = now()`,
    [chain, height, hash],
  );
}
