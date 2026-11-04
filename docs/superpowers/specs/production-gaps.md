# BTQ Swap — production gap audit (2026-11-04)

Source: repo audit of `/home/o/BTQ/btq-swap` plus Cash for Hash comparison (`/home/o/BTQ/cash-for-hash`).

## Reuse (do not rebuild)

| Piece | Path |
|---|---|
| CLOB matcher | `packages/backend/src/services/matching.service.ts` |
| Order funding / P2MR verify | `packages/backend/src/services/order.service.ts` |
| P2MR script builder | `packages/backend/src/services/scriptBuilder.service.ts` |
| MM-era state machine (rewrite, keep states) | `packages/backend/src/services/swap.service.ts` |
| Worker skeletons | `packages/backend/src/workers/*` |
| `HtlcERC20` + contract tests | `packages/contracts/` |
| Docker migrate-on-start | `packages/backend/docker-entrypoint.sh` |

## Blockers

1. No Discord identity, bot, or `discord_id` column.
2. Three HTLC ABIs; workers cannot talk to `HtlcERC20`.
3. Buy lock sets `partyB` to the HTLC contract; nobody can withdraw. Buyer secret is discarded.
4. EVM `agreementId` ≠ DB `evm_htlc_swap_id`.
5. Matcher and MM settlement are different products; matched swaps stick in `pending`. Maker cannot `GET /swaps/:id`.
6. `platformClaimBtq` is dead; `getSecretFromClaim` listens for a non-existent `SwapClaimed` event.
7. Dummy JWT / EVM keys in compose; mainnet USDT address on Sepolia RPC; Hardhat addresses baked into the UI image.
8. No CI, no TLS, no ToS.
9. Market sells can be marked `funded: true` with no on-chain lock.

## High

- `placeOrder(funded=true)` skips on-chain verify.
- Sell funding does not verify P2MR leaves / claim pubkey.
- 1 confirmation on BTQ and EVM.
- Admin refund/fail and cancel-funded-order are DB-only (no chain refund).
- `swaps.secret` stored and returned by `SELECT *`.
- Rate limiter fail-open (600/min).
- Unauthenticated `/health/deep`.
- CLI commands hardcoded `-regtest`.
- SIWE does not bind domain/URI/chain.
- JWT in `localStorage`.
- No backups, metrics, or audit log.
- Fees (`platform_fee_pct`) never applied.

## Medium

- WebSocket JWT not checked for revoke/ban.
- No admin bootstrap.
- Public book leaks secret hash / Dilithium / BTQ address.
- Naive migrator (split on `;`).
- No frontend or worker tests; matcher untested.

## Decision this design locks

Ship **one** product: **P2P HTLC + operator-as-maker**. Discord is the buyer terminal. Admin web is the MM desk. Workers watch both chains and DM via outbox. Platform keys never sit in the taker path.
