#!/usr/bin/env bash
# Generate deploy/.env with fresh secrets for a devnet deployment. Usage: deploy/make-env.sh <public-base-url> [out]
set -euo pipefail
base="${1:?public base url, e.g. http://208.85.23.103:5173}"
out="${2:-$(dirname "$0")/.env}"
r() { node -e "process.stdout.write(require('crypto').randomBytes($1).toString('hex'))"; }
key() { node -e "const c=require('crypto');let k;do{k=c.randomBytes(32)}while(k[0]===0);process.stdout.write('0x'+k.toString('hex'))"; }
umask 077
cat > "$out" <<ENV
# Generated $(date -u +%FT%TZ) — devnet (BTQ regtest + anvil). Never commit.
NODE_ENV=production
LOG_LEVEL=info
DEVNET=1
PUBLIC_BASE_URL=${base}
CORS_ORIGINS=${base}
PUBLIC_EVM_RPC_URL=${base}/api/rpc/evm
TRUST_PROXY=1
POSTGRES_PASSWORD=$(r 18)
ADMIN_TOKEN=$(r 24)
SESSION_SECRET=$(r 32)
HEALTH_DEEP_TOKEN=$(r 16)
BTQ_NETWORK=regtest
BTQ_RPC_USER=btqswap
BTQ_RPC_PASS=$(r 18)
BTQ_PLATFORM_WALLET=platform
BTQ_TARGET_BLOCK_SEC=5
BTQ_MIN_CONFIRMATIONS=1
BTQ_FEE_RATE_SAT_VB=2
PLATFORM_HTLC_SEED=$(r 32)
PLATFORM_SECRET_KEY=$(r 32)
EVM_CHAIN_ID=31337
EVM_PRIVATE_KEY=$(key)
DEVNET_FAUCET_EVM_KEY=$(key)
EVM_MIN_CONFIRMATIONS=1
SWAP_BUYER_LOCK_WINDOW_SEC=180
SWAP_EVM_LOCK_DURATION_SEC=420
SWAP_EVM_LOCK_MAX_DURATION_SEC=3600
SWAP_SELLER_LOCK_WINDOW_SEC=120
SWAP_BTQ_LOCK_BLOCKS=24
SWAP_SAFETY_MARGIN_SEC=120
WORKER_TICK_MS=1500
DISCORD_BOT_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=
DISCORD_SWAP_CHANNEL_ID=
DISCORD_FEED_CHANNEL_ID=
DISCORD_ADMIN_IDS=
DISCORD_ENABLE_FEED=1
DISCORD_ENABLE_DMS=1
WEB_PORT=5173
ENV
echo "wrote $out"
