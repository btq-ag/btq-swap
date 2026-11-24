# BTQ Swap runbooks

Agent procedures, with stop conditions and the exact commands, are in [../sops/README.md](../sops/README.md). This page is the short human version.

Compose alias used below (on the VPS, in `/opt/btq-swap`):

```bash
alias dc='docker compose -f deploy/docker-compose.yml --env-file deploy/.env'
```

## Deploy / rollback

1. Workstation: `deploy/make-env.sh <public-url>` once per environment (fresh secrets → `deploy/.env`).
2. `VPS_HOST=… VPS_PASSWORD=… deploy/deploy-vps.sh` builds `btq-swap-{backend,web,btqd}`, ships images, rsyncs source, `dc up -d`, re-registers Discord commands. Revision deployed: `/opt/btq-swap/REVISION`.
3. Verify: monitor pills green, `dc ps` all up, `dc logs --tail 20 bot` shows `gateway ready`.
4. Rollback: `git checkout <previous>` locally and rerun the script (images are rebuilt from that revision). Migrations are forward-only; 003 keeps legacy tables as `legacy_*`.

## Pause the book

Operator console → **Pause book** (or `POST /api/admin/settings {"key":"book_paused","value":true}` with an admin session). New orders and takes are refused; swaps already matched keep settling (their HTLCs are on-chain and must finish or refund). Individual MM orders: Pause / Resume / Reprice / Cancel in the MM desk.

## Refunds

Refunds are never a DB flip — they are on-chain spends by the party that locked:

| Situation | Who refunds | When | How |
|---|---|---|---|
| Buyer locked USDT, seller never locked BTQ (`awaiting_buyer_refund`) | buyer | after the EVM deadline | `btq-htlc evm refund --swap <n>` (the bot DMs it); platform-as-buyer refunds automatically |
| Seller locked BTQ, buyer never claimed (`awaiting_refunds`) | seller | after the CLTV height | `btq-htlc refund --swap <n> --to <addr> --broadcast`; platform-as-seller refunds automatically |
| Same, USDT side | buyer | after the EVM deadline | `btq-htlc evm refund` |

The monitor shows both clocks per swap. A swap reaches `refunded` only when every locked leg is refunded on-chain.

## Discord install / bot identity

- Guild-scoped commands only: `dc run --rm --no-deps api register`.
- Switch to the dedicated **BTQ Swap** app: set `DISCORD_BOT_TOKEN` + `DISCORD_CLIENT_ID` in `deploy/.env`, run register, `dc up -d bot`, then remove the old app's guild commands (`PUT /applications/<old>/guilds/<guild>/commands []`).
- The bot needs View Channel, Send Messages, Embed Links, Manage Messages (channel guard) and Create Public Threads (simulation transcripts) in `#btq-swap`.

## Key rotation

| Key | Effect of rotating | Procedure |
|---|---|---|
| `ADMIN_TOKEN`, `SESSION_SECRET` | logs out operators | edit `deploy/.env`, `dc up -d api` |
| `DISCORD_BOT_TOKEN` | none | reset in the developer portal, edit `.env`, `dc up -d bot api` |
| `PLATFORM_HTLC_SEED` | MM can no longer claim/refund **existing** HTLCs | only rotate with zero active platform swaps (pause the book, wait for all MM swaps to settle) |
| `PLATFORM_SECRET_KEY` | encrypted MM preimages unreadable | same as above |
| `EVM_PRIVATE_KEY` | MM inventory lives at the old address | move funds first, then rotate with zero active platform swaps |

## Incident

1. **Pause the book** (stops new exposure).
2. Check watchers: monitor pills / `dc logs api | grep -E "watcher|tick failed"`; deep health with `x-health-token`.
3. Chain node down → workers retry every tick; swaps resume when the node returns. Deadlines keep running on-chain, so prioritize restoring `btqd`/EVM RPC.
4. Stuck platform action → `swap_events` with `platform_action_failed` show the error; the agent retries up to 5 times per action.
5. Wrong or late locks are recorded as `evm_lock_rejected` / `btq_lock_ignored`; users get a DM telling them to refund after their own timelock.

## Backups

`deploy/backup.sh` (cron: `15 3 * * * /opt/btq-swap/deploy/backup.sh`) dumps Postgres daily to `/var/backups/btq-swap` with 7-day rotation. Restore: `gunzip -c dump.sql.gz | dc exec -T postgres psql -U btqswap btqswap`. Chain data (btqd, anvil) are devnet volumes; on mainnet the chains are the source of truth for every lock and the DB can be rebuilt by rescanning from the cursors.
