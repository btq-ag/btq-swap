# SOP 02 — Health

Run this at the start of every session and after every deploy or restart. Read-only.

## Steps

On the box:

```bash
cd /opt/btq-swap
dc() { docker compose -f deploy/docker-compose.yml --env-file deploy/.env "$@"; }
dc ps --format 'table {{.Service}}\t{{.Status}}'
set -a && . ./deploy/.env && set +a
python3 docs/sops/scripts/vps-admin.py health
curl -fsS http://127.0.0.1:5173/api/public/monitor | python3 -c 'import json,sys; m=json.load(sys.stdin); print("btq", m["chains"]["btq"]["tip"], "evm", m["chains"]["evm"]["head"], "active", m["stats"]["active"])'
dc logs --tail 30 bot
dc logs --tail 20 miner
```

`/api/health` (no token) only proves the API process answers. Deep health is the one that counts.

## Pass

All of these are true:

- `postgres`, `btqd`, `api`, `miner`, `bot`, and `web` are Up. `api` is healthy. `bootstrap` has exited 0.
- Deep health is HTTP 200 and every check is `ok`: `database`, `btq_node`, `evm_node`, `btq_watcher`, `evm_watcher`. A watcher is `stale` when its last tick is 60 seconds old or more.
- `dc logs bot` contains `gateway ready` in the recent lines.
- The miner log shows a rising block height, or a fresh `block` line. Target block time on this devnet is 5 seconds.
- The monitor loads. BTQ height and the EVM block are both increasing across two samples about 15 seconds apart.

Then read the quote with SOP 04's read step. A missing quote is a quote problem, not a health failure.

## Fail

Go to [08-incident.md](08-incident.md) with the failing check named. Do not deploy because health failed.
