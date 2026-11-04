# S07 Security, secrets, threat model

Part of [BTQ Swap production design](../2026-11-04-btq-swap-production-design.md).

## Invariants (copy CFH C21)

1. Actor = `interaction.user.id` only.
2. Ephemeral Discord replies; wallets in modals.
3. Channel redact; no Message Content intent.
4. Admin gate = `admin_users`, not Discord roles.
5. User-scoped repos (`listForUser`).
6. No plaintext swap secrets in DB for user flows.
7. Rate limit 20/min/user on bot; fail-**closed** on API when Redis is down (today fail-open is wrong).
8. `/health/deep` requires token.
9. CORS allowlist of real origins; no `*` .
10. `trust proxy` only behind a locked ingress.

## Secrets

| Secret | Storage |
|---|---|
| Discord bot token / client secret | secret manager |
| `JWT_SECRET` | secret manager; no compose default |
| `EVM_PRIVATE_KEY` (MM hot wallet) | secret manager; staging cap |
| Platform Dilithium | secret manager / offline for refunds if possible |
| Postgres password | generated per env; Redis AUTH |
| RPC keys | secret manager; no public-node default in prod |

Remove compose defaults `0x…0001`, `dev-jwt-secret-change-me-in-production`.

## Threats

| Threat | Mitigation |
|---|---|
| Stolen button / take someone else's order | `customId` + actor check |
| Paste wallet in channel | modal + channel guard |
| SIWE replay | nonce + domain bind |
| Fake Dilithium | signed challenge |
| Worker ABI mismatch (today) | single ABI + integration tests |
| Admin refund without chain | worker-enqueued refund |
| XSS stealing JWT | no localStorage token for Discord users; cookie if web stays |
| Inventory drain | MM risk caps |

## Audit

`audit_log` for ToS, ban, MM post/pause/reprice, admin refund, role change (CFH C19).
