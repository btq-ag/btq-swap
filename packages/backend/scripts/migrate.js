const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const pool = new Pool({ connectionString });
  const migrationsDir = path.join(__dirname, '..', 'migrations');
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const statements = sql
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);

    for (const statement of statements) {
      try {
        await pool.query(statement);
      } catch (err) {
        // Skip idempotent re-runs (table/index/column already exists)
        const code = err && typeof err === 'object' && 'code' in err ? err.code : null;
        if (code === '42P07' || code === '42710' || code === '42701' || code === '23505') {
          continue;
        }
        throw err;
      }
    }
    console.log(`[migrate] applied ${file}`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
