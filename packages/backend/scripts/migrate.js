// Versioned migrator: each migrations/*.sql file runs exactly once, whole-file, inside a transaction.
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

async function migrate(connectionString, { log = console.log } = {}) {
  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  try {
    // Serialize concurrent migrators (api + bootstrap containers start together).
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    // Databases created by the old migrator already contain 001/002 objects: record them as applied.
    const legacy = await client.query(`SELECT to_regclass('public.config') IS NOT NULL AS has_config`);
    const dir = path.join(__dirname, '..', 'migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const applied = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    if (legacy.rows[0].has_config && applied.size === 0) {
      for (const f of files.filter((f) => f.startsWith('001_') || f.startsWith('002_'))) {
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', [f]);
        applied.add(f);
        log(`[migrate] recorded pre-existing ${f}`);
      }
    }
    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        count += 1;
        log(`[migrate] applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`[migrate] ${file} failed: ${err.message}`);
      }
    }
    if (count === 0) log('[migrate] up to date');
    return count;
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => undefined);
    client.release();
    await pool.end();
  }
}

module.exports = { migrate };

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  migrate(url).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
