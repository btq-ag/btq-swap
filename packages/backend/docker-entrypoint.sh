#!/bin/sh
set -e

echo "[entrypoint] waiting for postgres..."
until node -e "
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query('SELECT 1')
  .then(() => pool.end().then(() => process.exit(0)))
  .catch(() => process.exit(1));
" >/dev/null 2>&1; do
  sleep 2
done

echo "[entrypoint] running migrations..."
node scripts/migrate.js

echo "[entrypoint] starting API..."
exec node dist/index.js
