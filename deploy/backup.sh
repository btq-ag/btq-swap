#!/usr/bin/env bash
# Daily Postgres dump with 7-day rotation. Cron: 15 3 * * * /opt/btq-swap/deploy/backup.sh
set -euo pipefail
cd "$(dirname "$0")/.."
dir=/var/backups/btq-swap
mkdir -p "$dir"
ts=$(date -u +%Y%m%dT%H%M%SZ)
docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec -T postgres pg_dump -U btqswap btqswap | gzip -9 > "$dir/btqswap-$ts.sql.gz"
find "$dir" -name 'btqswap-*.sql.gz' -mtime +7 -delete
ls -1t "$dir" | head -3
