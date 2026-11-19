# SOP 00 — Autonomy

This stack is a devnet: BTQ regtest and Anvil chain id 31337. Coins are worthless. Treat the database, the Discord channel, and the platform wallets as if a person is watching them.

## Do this without asking

- Read health, logs, the monitor, the book, swap detail, and the audit log.
- Reconcile the market-maker quote (SOP 04) once per session.
- Restart one crashed service when SOP 08 names that service.
- Pause the book when SOP 08 says to pause it.
- Run `deploy/backup.sh` when a backup is due or before a restore.
- Re-register Discord commands as part of a deploy the user just asked for.
- Tell a person the next `btq-htlc` command from SOP 12. The platform side of a swap settles itself.

## Stop and report

Stop on the first line that matches. Report the duty block from the index and the evidence. Do not take the next step.

- `BTQ_NETWORK` is anything other than `regtest`, or `EVM_CHAIN_ID` is anything other than `31337`, or `DEVNET` is not `1`.
- The request is to wipe volumes, delete `/var/backups/btq-swap`, or run `docker compose down -v`.
- The request regenerates `deploy/.env` (`deploy/make-env.sh`) on a box that already has one.
- The request rotates `PLATFORM_HTLC_SEED`, `PLATFORM_SECRET_KEY`, or `EVM_PRIVATE_KEY`.
- The request bans a user whose `is_simulated` is false.
- The request moves platform BTQ or USDT outside an order, a fill, or the platform agent.
- A deploy is implied by a failure. Deploy only when the current request says deploy, ship, or redeploy.
- The working tree is dirty and the request did not say to ship the working tree.
- The host is anything other than `BTQ_SWAP_VPS_HOST` from the ops skill.
- Deep health stays `degraded` after the single restart SOP 08 allows.
- A platform action has failed five times (`platform_action_failed` in `swap_events`). Read the error. Do not broadcast a manual claim or refund.

## How a session runs

1. Read this file.
2. Open the box with [01-access.md](01-access.md).
3. Run [02-health.md](02-health.md) before any mutation.
4. Do the one SOP the request names.
5. Return the duty report.

A watch request ("keep an eye on it", "run the desk") reconciles the quote, waits five minutes, reconciles again, and stops after 30 minutes. It does not loop overnight.
