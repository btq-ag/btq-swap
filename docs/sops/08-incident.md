# SOP 08 — Incident

Pause first, then name the failing check. One restart of the service this SOP names. If that does not clear it, stop.

## 1. Pause

```bash
python3 docs/sops/scripts/vps-admin.py POST /settings <<'JSON'
{"key":"book_paused","value":true}
JSON
```

Matched swaps keep settling. Their HTLCs are already on-chain. New orders and takes are refused. Resume with `"value": false` only after SOP 02 passes and the request, or this SOP, says the incident is over. A pause you set during an incident stays until you can say why it is safe to resume.

## 2. Name the failure

| What you see | Do |
|---|---|
| Deep health `database=error`, or `postgres` is not Up | `dc restart postgres`. Wait until `pg_isready` passes. Do not delete `pgdata` |
| `btq_node=error`, or BTQ height is stuck | SOP 11, service `btqd`, then `miner` |
| `evm_node=error`, or the EVM head is stuck | SOP 11, service `anvil` |
| `btq_watcher=stale` or `evm_watcher=stale`, nodes ok | `dc restart api` once. Workers live in `api` |
| `api` unhealthy, or the monitor returns 502 | `dc restart api`. If the monitor still 502s, `dc restart web` once. Nginx resolves `api` through Docker DNS; a recreate can still leave `web` holding a dead upstream until it is restarted |
| `bot` is Exit, or no `gateway ready` | SOP 05. `dc restart bot` once |
| `miner` is Exit | SOP 11 |
| `platform_action_failed` five times on one swap | SOP 06. Stop. Do not craft a transaction |
| Disk Use% at or above 90 | Stop deploys and sims. Report `df -h` and `docker system df`. Do not prune volumes |

Logs:

```bash
dc logs --tail 80 api
dc logs --tail 40 bot miner btqd anvil
```

Quote the error line. Leave the token, the RPC password, and any hex private key out of the duty report.

## 3. After it recovers

SOP 02, then resume the book, then SOP 04. If bootstrap logged `deploying MockUSDT` because Anvil lost its state, keep the book paused and say so: old EVM agreement ids no longer exist. BTQ locks from before the wipe still need their own refund path. That is a stop.
