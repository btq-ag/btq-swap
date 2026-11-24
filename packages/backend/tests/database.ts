import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll } from 'vitest';
import { closePool, db } from '../src/lib/db';
import { resetConfigForTests } from '../src/config';
import type { UserRow } from '../src/domain/types';

export const databaseEnabled = !!process.env.TEST_DATABASE_URL;

/** Each integration suite owns a schema on an explicitly supplied test database. */
export function testDatabase(): void {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool;
  beforeAll(async () => {
    if (!databaseEnabled) return;
    const url = new URL(process.env.TEST_DATABASE_URL!);
    if (!url.pathname.includes('test')) throw new Error('TEST_DATABASE_URL must name a test database');
    admin = new Pool({ connectionString: url.toString() });
    await admin.query(`BEGIN; SELECT pg_advisory_xact_lock(187398244);
      CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public; COMMIT`);
    await admin.query(`CREATE SCHEMA ${schema}`);
    url.searchParams.set('options', `-c search_path=${schema},public`);
    Object.assign(process.env, {
      DATABASE_URL: url.toString(), ADMIN_TOKEN: 'a'.repeat(24), SESSION_SECRET: 's'.repeat(32),
      BTQ_RPC_URL: 'http://127.0.0.1:1', BTQ_RPC_USER: 'u', BTQ_RPC_PASS: 'p',
      PLATFORM_HTLC_SEED: '11'.repeat(32), PLATFORM_SECRET_KEY: '22'.repeat(32),
      EVM_RPC_URL: 'http://127.0.0.1:2', EVM_CHAIN_ID: '31337', EVM_PRIVATE_KEY: '0x' + '33'.repeat(32),
      BTQ_NETWORK: 'regtest', LOG_LEVEL: 'error',
    });
    resetConfigForTests();
    await closePool();
    const dir = resolve('migrations');
    for (const name of readdirSync(dir).filter(n => n.endsWith('.sql')).sort()) {
      await db().query(readFileSync(resolve(dir, name), 'utf8'));
    }
  });
  afterAll(async () => {
    if (!admin) return;
    await closePool();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
}

export async function testUser(): Promise<UserRow> {
  return (await db().query<UserRow>(`INSERT INTO users (discord_id, tos_version, tos_accepted_at)
    VALUES ($1, '2026-11-12', now()) RETURNING *`, [randomUUID()])).rows[0]!;
}
