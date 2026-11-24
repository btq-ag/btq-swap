import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { config } from '../config';

let _pool: Pool | null = null;

export function pool(): Pool {
  if (!_pool) {
    _pool = new Pool({ connectionString: config().DATABASE_URL, max: 15, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
    _pool.on('error', (err) => console.error('[db] pool error', err.message));
  }
  return _pool;
}

export async function closePool(): Promise<void> {
  if (_pool) {
    const p = _pool;
    _pool = null;
    await p.end();
  }
}

/** Anything that can run a query: the pool or a transaction client. */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

export function db(): Queryable {
  return pool() as unknown as Queryable;
}

export async function one<R extends QueryResultRow>(q: Queryable, text: string, params: unknown[] = []): Promise<R | null> {
  const r = await q.query<R>(text, params);
  return r.rows[0] ?? null;
}

export async function many<R extends QueryResultRow>(q: Queryable, text: string, params: unknown[] = []): Promise<R[]> {
  return (await q.query<R>(text, params)).rows;
}

export async function tx<T>(fn: (client: PoolClient & Queryable) => Promise<T>): Promise<T> {
  const client = (await pool().connect()) as PoolClient & Queryable;
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
