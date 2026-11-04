# S02 Identity, ToS, Discord linking

Part of [BTQ Swap production design](../2026-11-04-btq-swap-production-design.md). Pattern: Cash for Hash `packages/core/src/identity`.

## Purpose

A user is a Discord snowflake who has accepted ToS. ETH, BTQ address, and Dilithium pubkey are **linked attributes**, not the primary key.

## Schema additions (`users`)

| Column | Notes |
|---|---|
| `discord_id` | `text unique` (snowflake). Nullable only for legacy SIWE-only rows during migration. |
| `discord_username` | refreshed on every interaction |
| `tos_accepted_at` | required before book writes |
| `status` | `active \| banned` |
| `notifications_enabled` | default true |
| `eth_address` | existing; set via SIWE |
| `btq_address` / `dilithium_pubkey` | existing; set via signed challenge |

New `admin_users`: `discord_id unique`, `role` (`owner\|admin\|viewer`), `disabled_at`. Discord guild roles are **never** trusted.

## Flows

1. `/swap start` → ephemeral ToS + Accept button `swap:tos:accept:{discordId}:{exp}`. Stolen button → `FORBIDDEN`.
2. `/swap link-evm` → modal (no address as slash option). Bot shows SIWE message; user pastes signature **in the modal**. Verify domain, URI, chain, nonce (fix today's SIWE gap).
3. `/swap link-btq` → modal for address + Dilithium pubkey. Worker/bot issues a one-time challenge; user signs with `btq-cli` and pastes in a follow-up modal. Do not accept an unsigned pubkey (`PUT /user` today is spoofable).
4. `ensureBuyer(discordId, username)` upsert. `acceptTos` idempotent + audit row.
5. Ban: short-circuit with “This account is not available.” Open orders cancel; locked HTLCs still expire/refund on-chain.

## Invariants

- Actor is always `interaction.user.id`.
- No wallet fields on slash options.
- SIWE nonce in Redis with TTL; bind domain + URI.
- JWT (if web UI stays) is HttpOnly cookie or short-lived and checked for revoke/ban on WS.

## Tests

Idempotent start; stolen ToS button; ban blocks `buy`/`sell`/`take`; SIWE without domain rejected; unsigned Dilithium rejected.
