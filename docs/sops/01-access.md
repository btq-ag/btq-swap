# SOP 01 — Access

## Preconditions

The personal skill file `~/.cursor/skills/btq-swap-vultr-ops/.env` exists and is mode 600. The repo is checked out at `~/BTQ/btq-swap`.

## Connect

```bash
cd ~/.cursor/skills/btq-swap-vultr-ops && set -a && . ./.env && set +a
export SSHPASS="$BTQ_SWAP_VPS_PASSWORD"
sshpass -e ssh -o StrictHostKeyChecking=accept-new "root@${BTQ_SWAP_VPS_HOST}" 'hostname; cat /opt/btq-swap/REVISION'
```

Never `set -x` after sourcing an env file. Never `cat` an env file. Never put a token on a command line; the admin client reads it from the environment.

## On the box

```bash
cd /opt/btq-swap
dc() { docker compose -f deploy/docker-compose.yml --env-file deploy/.env "$@"; }
```

Services: `postgres`, `btqd`, `anvil`, `bootstrap` (one-shot), `api` (API and workers), `miner`, `bot`, `web`. The sim service is profile `sim` and is not part of `dc ps`.

| Path | What |
|---|---|
| `/opt/btq-swap` | Source rsynced from the workstation. `REVISION` is the git SHA that was deployed |
| `/opt/btq-swap/deploy/.env` | Runtime secrets, mode 600 |
| `/var/lib/btq-swap/duty.json` | Market-maker mid, spread, and clip. Outside the rsync tree so a deploy cannot delete it |
| `/var/backups/btq-swap` | Daily Postgres dumps, 7-day rotation |

Public surfaces, from the host in the ops env:

- Trade desk: `http://$BTQ_SWAP_VPS_HOST:5173/`
- Monitor: `http://$BTQ_SWAP_VPS_HOST:5173/monitor`
- Swap: `http://$BTQ_SWAP_VPS_HOST:5173/swap/<n>`
- Operator console: `http://$BTQ_SWAP_VPS_HOST:5173/admin`
- Tool: `http://$BTQ_SWAP_VPS_HOST:5173/downloads/btq-htlc.mjs`
- EVM proxy: `http://$BTQ_SWAP_VPS_HOST:5173/api/rpc/evm`

From the box itself, call the site at `http://127.0.0.1:5173`. The API container is not published; nginx on `web` is the front door.

## Admin calls

On the box, after `set -a && . /opt/btq-swap/deploy/.env && set +a`:

```bash
python3 /opt/btq-swap/docs/sops/scripts/vps-admin.py health
python3 /opt/btq-swap/docs/sops/scripts/vps-admin.py GET /overview
python3 /opt/btq-swap/docs/sops/scripts/vps-admin.py POST /settings - <<'JSON'
{"key":"book_paused","value":true}
JSON
```

Login is rate-limited to 20 requests per 15 minutes. One script invocation is one login. Batch by doing the work in one session, not by retrying login in a loop.

## Verify

`hostname` returns, `REVISION` is a 40-character SHA, and `python3 ... health` prints JSON. If the script is missing, the deploy is older than these SOPs: copy `docs/sops/scripts/vps-admin.py` to that path with `scp` and continue. Do not deploy just to install the script.
