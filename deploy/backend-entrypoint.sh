#!/bin/sh
# One image, several roles: api | bot | register | sim | bootstrap | miner | migrate | btq-htlc
set -e
cmd="${1:-api}"
[ "$#" -gt 0 ] && shift
case "$cmd" in
  api)       node scripts/migrate.js && exec node dist/main-api.js ;;
  bot)       exec node dist/bot/main.js ;;
  register)  exec node dist/bot/register.js ;;
  sim)       exec node dist/sim/main.js "$@" ;;
  bootstrap) exec node dist/devnet/bootstrap.js ;;
  miner)     exec node dist/devnet/miner.js ;;
  migrate)   exec node scripts/migrate.js ;;
  btq-htlc)  exec node /app/packages/htlc/dist/btq-htlc.mjs "$@" ;;
  *)         exec "$cmd" "$@" ;;
esac
