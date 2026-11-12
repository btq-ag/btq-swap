#!/usr/bin/env bash
# Build images locally, ship them to the VPS, sync source + compose, and (re)start the stack.
#   VPS_HOST=208.85.23.103 VPS_PASSWORD=... deploy/deploy-vps.sh [--no-build] [--services "api bot web"]
# Requires: docker, sshpass, rsync. deploy/.env must exist (deploy/make-env.sh).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
host="${VPS_HOST:?VPS_HOST}"
export SSHPASS="${VPS_PASSWORD:?VPS_PASSWORD}"
remote=/opt/btq-swap
build=1
services=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-build) build=0 ;;
    --services) services="$2"; shift ;;
  esac
  shift
done
ssh_() { sshpass -e ssh -o StrictHostKeyChecking=accept-new "root@$host" "$@"; }
export DOCKER_CONFIG="${DOCKER_CONFIG:-/tmp/dockercfg}"
mkdir -p "$DOCKER_CONFIG" && [[ -f "$DOCKER_CONFIG/config.json" ]] || echo '{}' > "$DOCKER_CONFIG/config.json"

cd "$root"
[[ -f deploy/.env ]] || { echo "deploy/.env missing (run deploy/make-env.sh)"; exit 1; }
if [[ $build == 1 ]]; then
  [[ -x deploy/btqd/bin/btqd ]] || deploy/btqd/fetch-binaries.sh
  docker build -q -t btq-swap-btqd:latest deploy/btqd
  docker build -q -t btq-swap-backend:latest -f packages/backend/Dockerfile .
  docker build -q -t btq-swap-web:latest -f packages/frontend/Dockerfile .
fi
tmp="$(mktemp -d)"
docker save btq-swap-backend:latest btq-swap-web:latest btq-swap-btqd:latest | gzip -1 > "$tmp/images.tar.gz"
sshpass -e scp -o StrictHostKeyChecking=accept-new "$tmp/images.tar.gz" "root@$host:/root/btqswap-images.tar.gz"
rm -rf "$tmp"
sshpass -e rsync -az --delete \
  --exclude node_modules --exclude dist --exclude .git --exclude '.env' --exclude '.env.*' --exclude 'deploy/.env*' \
  --exclude deploy/btqd/bin --exclude sim-reports --exclude packages/contracts/artifacts --exclude packages/contracts/cache --exclude packages/contracts/typechain \
  -e "ssh -o StrictHostKeyChecking=accept-new" ./ "root@$host:$remote/"
sshpass -e scp deploy/.env "root@$host:$remote/deploy/.env"
git rev-parse HEAD | ssh_ "cat > $remote/REVISION"
ssh_ "set -e; chmod 600 $remote/deploy/.env; cd $remote; gunzip -c /root/btqswap-images.tar.gz | docker load -q;
  docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d $services;
  docker compose -f deploy/docker-compose.yml --env-file deploy/.env run --rm --no-deps api register;
  docker compose -f deploy/docker-compose.yml --env-file deploy/.env ps --format 'table {{.Service}}\t{{.Status}}'; cat REVISION"
