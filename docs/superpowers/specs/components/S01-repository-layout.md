# S01 Repository layout and CFH port split

Part of [BTQ Swap production design](../2026-11-04-btq-swap-production-design.md).

## Purpose

Move from a Vite/Express demo toward Cash for Hash's four-deployable layout without throwing away working matcher/funding code.

## Target layout

```
btq-swap/
  apps/
    bot/          # discord.js gateway — slash/modal/button only
    worker/       # chain watchers + notify (no Discord gateway)
    api/          # admin HTTP + (optional) public REST used by leftover web UI
    web/          # operator console (can start as the existing admin pages)
  packages/
    core/         # domain: identity, book, settlement, notify ports
    db/           # Postgres repos, listForUser
    shared/       # zod DTOs
    contracts/    # existing Hardhat package (keep)
  docker-compose.yml
```

## Migration rule

Until the split is complete, new Discord/identity/outbox code may live under `packages/backend` **behind ports** (`IdentityService`, `BookService`, `SettlementService`, `NotificationPort`) so `apps/bot` can import ports only. Do not put `discord.js` inside `swap.service.ts`.

## Import rule (copy CFH ESLint)

`shared` → nothing internal. `db` → `shared`. `core` → `db` + `shared`. Apps → `core` / `db` / `shared`. Core public surface must not import `express`, `discord.js`, or `ethers` types.

## Tests

Workspace lint forbids `discord.js` inside `packages/core` and `packages/backend/src/services`.
