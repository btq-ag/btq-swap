import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll } from 'vitest';
import { closePool, db } from '../src/lib/db';
import { resetConfigForTests } from '../src/config';
import type { UserRow } from '../src/domain/types';
import type { SwapRow } from '../src/domain/types';
import { bytesToHex, signerFromSeed } from '@btq-swap/htlc';

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

export async function testSwap(overrides: Partial<SwapRow> = {}): Promise<SwapRow> {
  const buyer = await testUser(); const seller = await testUser();
  const orders = await db().query<{ id: string }>(`INSERT INTO orders (user_id, side, price_usdt, amount_btq)
    VALUES ($1,'buy',1,1),($2,'sell',1,1) RETURNING id`, [buyer.id, seller.id]);
  let s = (await db().query<SwapRow>(`INSERT INTO swaps (
    maker_order_id,taker_order_id,maker_user_id,taker_user_id,buyer_user_id,seller_user_id,status,
    amount_btq,amount_sats,price_usdt,amount_usdt,amount_usdt_units,buyer_eth,seller_eth,buyer_btq_pubkey,seller_btq_pubkey,
    evm_chain_id,evm_htlc_contract,evm_token,btq_network,buyer_lock_by)
    VALUES ($1,$2,$3,$4,$3,$4,'awaiting_buyer_lock',1,100000000,1,1,1000000,$5,$6,$7,$8,31337,$9,$10,'regtest',now()+interval '30 minutes') RETURNING *`,
  [orders.rows[0]!.id, orders.rows[1]!.id, buyer.id, seller.id, '0x'+'1'.repeat(40), '0x'+'2'.repeat(40),
    bytesToHex(signerFromSeed(new Uint8Array(32).fill(1)).publicKey), bytesToHex(signerFromSeed(new Uint8Array(32).fill(2)).publicKey),
    '0x'+'3'.repeat(40), '0x'+'4'.repeat(40)])).rows[0]!;
  const entries = Object.entries(overrides);
  if (entries.length) {
    if (entries.some(([k]) => !/^[a-z_]+$/.test(k))) throw new Error('invalid fixture column');
    s = (await db().query<SwapRow>(`UPDATE swaps SET ${entries.map(([k], i) => `${k}=$${i+2}`).join(',')} WHERE id=$1 RETURNING *`,
      [s.id, ...entries.map(([, v]) => v)])).rows[0]!;
  }
  return s;
}
