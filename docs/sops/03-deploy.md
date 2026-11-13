# SOP 03 — Deploy

Deploy only when the current request says deploy, ship, or redeploy. A red health check is a restart (SOP 08), not a deploy.

## Preconditions

- SOP 02 has been run, so you know what you are replacing.
- Workstation repo is `~/BTQ/btq-swap`.
- `deploy/.env` already exists. Do not run `deploy/make-env.sh` against this box.
- `git status --porcelain` is empty. A dirty tree ships, because the script rsyncs the worktree. Stop unless the request says to ship the working tree.

## Steps

On the workstation:

```bash
cd ~/.cursor/skills/btq-swap-vultr-ops && set -a && . ./.env && set +a
cd ~/BTQ/btq-swap
export DOCKER_CONFIG="${DOCKER_CONFIG:-/tmp/dockercfg}"
mkdir -p "$DOCKER_CONFIG"
[[ -f "$DOCKER_CONFIG/config.json" ]] || echo '{}' > "$DOCKER_CONFIG/config.json"
VPS_HOST="$BTQ_SWAP_VPS_HOST" VPS_PASSWORD="$BTQ_SWAP_VPS_PASSWORD" deploy/deploy-vps.sh
```

The script builds `btq-swap-btqd`, `btq-swap-backend`, and `btq-swap-web` locally, ships them with `docker save`, rsyncs the tree to `/opt/btq-swap`, writes `REVISION`, starts the stack, and runs `api register`. Rsync skips env files. The script then copies the workstation `deploy/.env` over the copy on the box. If a token was rotated on the box only, copy that file back to the workstation before you deploy, or the box will revert to the old secrets.

Use `--no-build` only when the request says the images are already built. Use `--services "api bot web"` only for a bounce of those services when the images on the box are already the ones you want.

## Verify

1. The script prints a compose table and the SHA.
2. Run SOP 02. Watchers need up to a minute after `api` becomes healthy.
3. Run the read-and-reconcile in SOP 04. Bootstrap seeds 2.45 / 2.55 when a side has no open order. The duty file is the price that should be on the book.

## When health fails after the deploy

Restart `api` once (SOP 08). If deep health is still degraded, stop. Migrations are forward-only. Do not check out an older SHA and deploy again unless the request says to roll back.

## Roll back

Only when the request names the SHA to restore.

```bash
cd ~/BTQ/btq-swap
git checkout <sha>
VPS_HOST="$BTQ_SWAP_VPS_HOST" VPS_PASSWORD="$BTQ_SWAP_VPS_PASSWORD" deploy/deploy-vps.sh
```

Tell the duty report that the database was not rolled back. Never `docker compose down -v`.
