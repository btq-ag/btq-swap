# S08 Production ops

Part of [BTQ Swap production design](../2026-11-04-btq-swap-production-design.md).

## Missing today

No CI, TLS, backups, systemd/k8s overlay, structured metrics, or runbooks. Compose is local-dev only. Frontend image bakes Hardhat addresses.

## Required

- **CI:** lint, unit, contract tests, docker build on PR (`btq-ag/btq-swap`).
- **TLS:** Caddy or nginx + Let's Encrypt in front of frontend:80; HSTS.
- **Prod compose / unit files:** no published Postgres/Redis; backend internal; only 443.
- **Backups:** daily Postgres dump + volume snapshot; restore drill in runbook.
- **Config:** `VITE_*` / chain IDs / HTLC / USDT injected at **deploy**, not leftover 31337 defaults.
- **Health:** `/health` liveness; `/health/deep` token-gated (DB, Redis, BTQ, EVM).
- **Metrics:** interaction counters, swap state gauges, watcher lag, notify failures (CFH C20).
- **Runbooks:** discord-install, pause-book, refund, reorg, key rotation, incident (clone CFH `docs/runbooks`).
- **Migrations:** version table; stop swallowing `23505` blindly once `IF NOT EXISTS` is complete.

## Staging

Sepolia mock USDT + BTQ testnet. Same Discord guild, `#btq-swap-staging` channel.
