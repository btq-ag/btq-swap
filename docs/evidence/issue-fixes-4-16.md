# Consolidated issue fixes #4–#16

This change addresses every open issue in `btq-ag/btq-swap` as checked on 2026-11-24. It does not deploy contracts, change a running database, or merge the PR.

## Issue-to-validation map

| Issue | Resulting behavior | Regression coverage |
| --- | --- | --- |
| [#4](https://github.com/btq-ag/btq-swap/issues/4) | BTQ funding confirmations require canonical block evidence; orphaned observations and dependent statuses are rolled back. | `btq-watcher.integration.test.ts`, `chain-adapters.live.test.ts` |
| [#5](https://github.com/btq-ag/btq-swap/issues/5) | Pending spends remain watched after eviction/replacement; settlement requires confirmation; disclosed secrets remain public. Canonical witness data is re-read even when two spends share a txid. | `btq-watcher.integration.test.ts`, `settlement.unit.test.ts`, browser claim recovery |
| [#6](https://github.com/btq-ag/btq-swap/issues/6) | EVM checkpoints include block hashes; locks, claims, and refunds are reconciled after reorgs and respect confirmation policy. Unconfirmed locks time out. Bounded historical replay also watches the live tail. | `evm-watcher.integration.test.ts`, `chain-adapters.live.test.ts`, `settlement.unit.test.ts` |
| [#7](https://github.com/btq-ag/btq-swap/issues/7) | Platform claims recheck their own node's output, value, script, confirmations, and refund margin immediately before signing; deferrals do not consume attempts. | `platform-claim.unit.test.ts`, HTLC guard tests |
| [#8](https://github.com/btq-ag/btq-swap/issues/8) | Solana tracking uses a bounded registry and finalized receipts instead of scanning every program account. Relays require the authorized swap, actor, exact prepared message, and valid signatures; refresh is targeted. | `solana-submit.integration.test.ts`, `solana-watcher.integration.test.ts`, browser retry/recovery tests |
| [#9](https://github.com/btq-ag/btq-swap/issues/9) | New Solana locks require the canonical ATA. Legacy settlement uses the vault authenticated by its lock receipt, and recognizes valid legacy spends from another escrow-owned vault. | Rust runtime tests, Solana watcher tests, local-validator exercise |
| [#10](https://github.com/btq-ag/btq-swap/issues/10) | Rejected locks retain recovery metadata. Refund commands accept an explicit agreement or a node-verified outpoint. EVM lock prints its agreement before broadcasting. | `funding.integration.test.ts`, `cli-recovery.test.ts`, `cli-evm-recovery.test.ts` |
| [#11](https://github.com/btq-ag/btq-swap/issues/11) | New CLI secrets are keyed by normalized deployment URL and full swap UUID, created exclusively, and protected by durable used-hash markers. | `secrets.test.ts`, CLI EVM recovery tests |
| [#12](https://github.com/btq-ag/btq-swap/issues/12) | Explicit challenge IDs prevent replacement of an in-progress login. Challenge consumption, identity changes, and session issuance share one transaction. | `challenges.integration.test.ts`, `desk-auth.integration.test.ts`, desk/Discord client tests |
| [#13](https://github.com/btq-ag/btq-swap/issues/13) | An authenticated wallet link keeps the current account and refuses wallets already owned by another account. Invalid sessions cannot silently create another identity. | `desk-auth.integration.test.ts`, desk client tests |
| [#14](https://github.com/btq-ag/btq-swap/issues/14) | Invalid fixed fees and negative/non-finite fee rates fail before signing or disclosing a secret. | HTLC spend-builder tests |
| [#15](https://github.com/btq-ag/btq-swap/issues/15) | Unique hash/outpoint constraints and durable ownership prevent two swaps from crediting one lock, including rejected observations and concurrent requests. | `funding.integration.test.ts`, migration and concurrency cases |
| [#16](https://github.com/btq-ag/btq-swap/issues/16) | Version 2 handles prefunded PDAs, drains token donations, and returns vault/state rent to the buyer on settlement. Finalized receipts preserve settlement evidence after account closure. | Five Rust runtime tests with boundary subcases, Solana watcher tests, local-validator exercise |

Backend test paths are under `packages/backend/tests/`, HTLC test paths under `packages/htlc/test/`, browser tests under `packages/frontend/tests/`, and native Solana tests under `packages/solana-htlc/tests/`.

## Local verification

Final local runs passed with Node 24.20.0 and an isolated PostgreSQL test database. Tests that modify BTQ/EVM nodes were run serially against dedicated regtest/Anvil processes.

| Check | Result |
| --- | --- |
| Backend, including PostgreSQL suites and two real-node adapter tests | 149 passed |
| HTLC/CLI, including seven real BTQ/EVM consensus tests | 67 passed |
| Browser recovery, reload, navigation, session expiry, retry, and Solana-only wallet flows | 7 passed |
| Solidity HTLC tests | 15 passed |
| Native Solana runtime tests | 5 passed |
| Solana SBF build and local-validator lock/withdraw/refund exercise | Passed |
| Backend typecheck/build; HTLC build and CLI bundle; frontend typecheck/build | Passed |
| Backend and frontend Docker builds | Passed |
| Exported Solidity artifacts versus committed backend artifacts | No differences |
| `git diff --check` | Passed |

The local-validator exercise prefunds both the state PDA and its ATA, donates extra tokens, and checks exact token/rent conservation and account closure for withdrawal and refund. The native runtime cases also cover zero preimages, deadline boundaries, incorrect parties/vaults/secrets, occupied state accounts, and the five-account version 1 withdrawal interface.

Reproduction commands, with dedicated test nodes and `TEST_DATABASE_URL` supplied by the operator:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run build -w packages/htlc
node packages/htlc/scripts/bundle.mjs
npm run typecheck -w packages/backend
CHAIN_LIVE=1 npm run test:coverage -w packages/backend
BTQ_LIVE=1 EVM_LIVE=1 npm run test:coverage -w packages/htlc
npm run build -w packages/frontend
npx playwright install --with-deps chromium
npm run test:browser -w packages/frontend
npm test -w packages/contracts
node packages/contracts/scripts/export-artifacts.mjs
git diff --exit-code -- packages/backend/src/chains/artifacts
RUST_LOG=error cargo test --locked --manifest-path packages/solana-htlc/Cargo.toml
cargo-build-sbf --arch v0 --tools-version v1.57 --manifest-path packages/solana-htlc/Cargo.toml
npx tsx packages/backend/scripts/solana-htlc-e2e.ts
docker build -f packages/backend/Dockerfile -t btq-swap-backend:test .
docker build -f packages/frontend/Dockerfile -t btq-swap-web:test .
```

The adapter tests use `BTQ_LIVE_RPC` and `EVM_LIVE_RPC`; the BTQ fixture expects the dedicated credentials specified in that test. HTLC live tests use `BTQ_RPC_URL`, `BTQ_RPC_USER`, `BTQ_RPC_PASS`, and `EVM_RPC_URL`. `CHAIN_LIVE`, `BTQ_LIVE`, and `EVM_LIVE` are opt-in. Never point these tests at production nodes. The SBF build used cargo-build-sbf 4.6.0 with platform-tools v1.57 and architecture v0, followed by a Solana 2.1 local validator. `SOLANA_TOOLS_DIR` can supply the validator/CLI directory when it is not on `PATH`.

CI runs the PostgreSQL, browser, Solidity, native Solana, build, and Docker checks. The BTQ/EVM live-node tests and SBF local-validator exercise were run locally; they are not provisioned in CI.

## Measured coverage and review limits

V8 coverage includes the existing untested source files; no exclusions were added to inflate the totals.

| Package | Lines | Branches |
| --- | ---: | ---: |
| Backend | 34.09% | 77.16% |
| HTLC | 78.09% | 71.46% |

The BTQ/EVM/Solana watcher line coverage is 98.34%/100%/94.79%; the Solana transaction and receipt modules are 96.63%/100%. The fee/claim guards have 100% line and branch coverage. These figures are **not 100% repository coverage**. Browser and Rust runtime tests are separate behavior checks, not an instrumented repository-wide coverage total. Passing these tests is not a proof of absence of defects.

Fresh-context adversarial reviews covered authentication, CLI recovery, funding ownership, both chain watcher designs and implementations, Solana runtime settlement, receipt tracking, rollout compatibility, and the browser recovery/retry changes. Reported actionable findings were fixed and exercised by regression tests. No external cross-model review was run. The requested `ponytail` skill was not available in the workspace or installed skill catalog; it is not claimed as part of validation.

## Upgrade and recovery requirements

1. Back up the database and pause new trading during a coordinated API/worker, web, bot, CLI, and Solana-program rollout. Apply migrations 007–010 before running the new backend. Migrations are forward-only.
2. Migration 007 adds unique linked-wallet constraints. Migration 008 refuses duplicate secret hashes or funding outpoints. Reconcile existing conflicts explicitly before retrying migration; do not delete financial records to make it pass. Pending challenges from before the upgrade must be restarted with an explicit challenge ID.
3. Old EVM cursors without block hashes replay conservatively from genesis in bounded batches, while the live tail is checked each tick. The watcher requires historical logs/receipts and canonical block headers, but does not require historical contract-state calls from an archive node.
4. Solana RPC endpoints must provide finalized transaction history for tracked escrows. Missing required receipts defer acceptance or settlement. An already funded pre-upgrade Solana swap without an accepted agreement can be reopened by number/UUID in the desk and its lock transaction signature imported. This verifies the signed lock and full observed settlement history; it does not relay a transaction.
5. Solana version 2 uses the same state layout size with a new version byte. It closes the canonical vault and state and returns rent to the original buyer. Version 1 remains withdrawable/refundable, including its five-account withdrawal interface, but **legacy rent is not automatically reclaimed**: the old program did not persist the original vault, so silently applying v2 closure rules to v1 would change its semantics.
6. Solana retries reuse the stored signed message. A replacement is authorized only after a positively observed finalized failure. A timeout, preflight error, or null historical status does not prove that a previous lock never landed. Expired attempts with ambiguous history require receipt recovery or allowing the unfunded swap to expire before starting a new swap with a new secret. This deliberately avoids creating a second lifetime at a closed escrow address. The distinction follows Solana's [confirmation/expiration model](https://solana.com/developers/cookbook/transactions/confirmation) and [signature-status API](https://solana.com/docs/rpc/http/getsignaturestatuses).
7. New CLI lock operations require version 2 scoped secret files and never reuse short-number files. Existing/browser-generated secret files remain usable for BTQ claims through hash lookup. Keep used-hash markers and rejected-lock records when backing up or moving a CLI home/database.
