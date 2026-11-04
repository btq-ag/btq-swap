# S09 Testing and delivery phases

Part of [BTQ Swap production design](../2026-11-04-btq-swap-production-design.md).

## Tests that must exist before mainnet

| Suite | Covers |
|---|---|
| Bot security QA | Ephemeral, actor, no wallet slash options, stolen buttons, ban, ToS |
| Command surface snapshot | `/swap` + `/swap-admin` registration payload |
| Matcher | Partials, pause, self-trade, MM vs user, both parties on swap row |
| Settlement | P2P lock/claim/refund with chain fakes; `partyB`; hash-only secret |
| Funding | EVM event parse; BTQ P2MR **leaves**; reject `funded=true` without chain |
| Outbox | Dedupe, skip, cannot-DM |
| Identity | SIWE domain bind; Dilithium challenge |
| Contracts | Existing secret/flow/outsider (keep) |

## Phases (Linear children map 1:1)

**P0 Discord product (no real funds)**  
S01 ports, S02 identity, S03 bot (`start`, `help`, `book`, `mine`), S06 outbox stub, channel guard.

**P1 P2P settlement**  
S05 ABI unify + party/secret/confirmations; Discord `buy|sell|take|fund|claim|refund`; worker rewrite.

**P2 Operator MM desk**  
S04 admin web post/pause/reprice/caps; `/swap-admin book status`.

**P3 Production harden**  
S07 secrets, S08 CI/TLS/backups/metrics/runbooks; mainnet addresses.

## Out of scope v1

KYC vendor, custodial balances, mutating Discord admin, non-USDT pairs, rewriting the matcher from scratch, mobile app.
