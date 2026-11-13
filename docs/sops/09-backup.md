# SOP 09 — Backup and restore

The cron entry on the box is `15 3 * * * /opt/btq-swap/deploy/backup.sh`. It dumps Postgres to `/var/backups/btq-swap/btqswap-<UTC>.sql.gz` and deletes dumps older than 7 days. Chain data is the Docker volumes `btqdata` and `anvildata`. On this devnet those volumes are the chains. A database restore does not rewind them.

## Take a dump

Any time, and always before a restore:

```bash
/opt/btq-swap/deploy/backup.sh
ls -lh /var/backups/btq-swap | head
```

Pass: a new `btqswap-*.sql.gz` with a non-zero size.

## Restore

Only when the request says restore and names the file. Pause the book first (SOP 08). Take a fresh dump so the current database is kept beside the one you load. Never drop the `pgdata` volume.

```bash
dc stop api bot miner
dc exec -T postgres psql -U btqswap -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'btqswap' AND pid <> pg_backend_pid();"
dc exec -T postgres psql -U btqswap -d postgres -c "DROP DATABASE btqswap;"
dc exec -T postgres psql -U btqswap -d postgres -c "CREATE DATABASE btqswap;"
gunzip -c /var/backups/btq-swap/btqswap-<stamp>.sql.gz | dc exec -T postgres psql -U btqswap -d btqswap
dc start api miner bot
```

## Verify

SOP 02. Then open one swap that the dump should contain, via `/api/public/swaps/<n>`. Run SOP 04. If the chains moved on while the database was old, say that swaps in the restored rows may not match the chain. That is a stop, not a second restore.
