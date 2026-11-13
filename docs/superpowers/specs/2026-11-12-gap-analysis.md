# BTQ Swap — gap analysis (2026-11-12)

Scope: everything between the repository at `444f28c`/`244cd15` and "a user can complete real BTQ ⇄ USDT HTLC swaps from Discord, with live visibility". Every finding below was checked against code, a live regtest node, or a live service on 2026-11-12. Nothing here is inferred from docs alone.

## Evidence collected

| Check | Result |
|---|---|
| `packages/contracts` tests (`npx hardhat test`) | **0/15 ran** — every test failed with `Transaction gas limit is 59023256 and exceeds transaction gas cap of 16777216` (hardhat 2.28 / EDR enforces EIP-7825). Fixed config → **15/15 pass**. |
| BTQ Core wallet RPCs, v0.5.0-testnet and `mainnet-freeze-20261026` | `signp2mrtransaction(hexstring, p2mr_id)` only. The `witness_args/leaf_script/control_block` params that the swap code and UI emit were **removed after v0.3.2**. `SignTaprootScript` only signs Dilithium single-key, multisig and threshold templates, so **no BTQ Core wallet can sign an HTLC claim or refund leaf**. |
| Live regtest spike (`packages/htlc/scripts/spike.ts`, btqd v0.5.0) | TypeScript-built HTLC address == `getnewp2mraddress` address; ML-DSA-44 claim with 32-byte preimage accepted by `testmempoolaccept` and mined; tampered signature rejected (`Signature must be zero for failed CHECK(MULTI)SIG`); refund rejected `non-final` before CLTV, accepted at CLTV; claim after refund rejected `missing-inputs`; preimage extracted from the claim witness. |
| BTQ weight rules | `WITNESS_SCALE_FACTOR = 16` (consensus.h). Node reported vsize 323 for a claim the BIP141 formula sizes at 1045 — fee estimates must use BTQ weight. |
| Discord | `#btq-swap` (1569688660008505354) exists, private (`@everyone` deny view; allow role `BTQ Swap` + user `barnyard4233`). Application **BTQ Swap** (1569696535803990086) joined 2026-11-10 but **its token is not in any `.env` on this machine or the VPS**. Usable tokens found: `BTQ Bot` (Administrator in the guild, no commands registered), `Cash 4 Hash` (production CFH — must not be reused). |
| VPS 208.85.23.103 (BTQ-HTLC) | Ubuntu 26.04, 1 vCPU, 3.4 GB RAM, 13 GB free. Only a stale, non-git copy of btq-swap in `/opt/btq-swap` and two containers exited 3 months ago. No btqd, no EVM node, nothing listening except ssh/node_exporter. ufw allows 22, 3001, 5173, 9100. |

## Blockers (swap cannot complete at all)

1. **Users cannot sign BTQ HTLC spends.** Every CLI string in `scriptBuilder.service.ts`, `order.service.ts` and the UI calls `signp2mrtransaction … '["<secret>"]' <leaf> <control>`, an RPC shape that no longer exists — and even v0.3.2 put only the preimage on the stack with no Dilithium signature, which the claim leaf rejects. A local signer (ML-DSA-44 + P2MR sighash) is required on both the user and platform side.
2. **EVM ABI mismatch.** `lib/htlcContract.ts`/`evm.service.ts` call `createSwapERC20/claim/refund/getSwap` and listen for `SwapCreated/SwapClaimed/SwapRefunded`. The deployed `HtlcERC20` exposes `createHTLCProposal/withdrawTokens/refundTokens/getHTLCInstance` and emits `HTLCERC20Lockup/Claimed/Redeemed`. Every worker EVM call reverts or matches nothing.
3. **USDT locked to nobody.** UI funding sets `partyB` to the HTLC contract address; `withdrawTokens` requires `msg.sender == partyB`, so funds can only be refunded.
4. **Secret handling breaks atomicity.** The platform generates every preimage and stores it in plaintext (`swaps.secret`, returned by `SELECT *`). In the sell flow the user locks BTQ to a hash the platform knows, so the platform could claim BTQ without paying. The party that locks first must be the only holder of the preimage.
5. **No counterparty binding at order time.** Orders are "funded" before a counterparty exists, which is why `partyB` was unknowable. HTLC locks must be created after the match, naming the counterparty.
6. **`agreementId` never tracked.** DB stores a random `evm_htlc_swap_id`; the contract id is `sha256(abi.encodePacked(...))`. Nothing links an on-chain lock to a swap.
7. **Matched swaps never progress.** `processMatchedSwap` runs the platform-custody flow on P2P matches; maker cannot read the swap; `platformClaimBtq` is dead code; `getSecretFromClaim` listens for a non-existent event.
8. **Claim detection is fake.** `btqMonitor` marks a swap `completed` with `btq_claim_txid = 'detected-on-chain'` when an outpoint is missing from the *platform* wallet's `listunspent`; `confirmUserBtqClaim` trusts any client txid.
9. **No Discord product.** No bot, no `discord_id`, no ToS, no outbox, no channel guard.
10. **Contract tests do not run** (gas cap, fixed in this branch).

## High

- HTLC claim leaf lacks `OP_SIZE 32 OP_EQUALVERIFY`: a 33+ byte preimage would claim BTQ while being unusable as the EVM `bytes32 _key` (cross-chain preimage-length attack).
- Market sells can be placed `funded: true` with no chain check; sell funding never verifies leaves/claim key.
- One confirmation everywhere (`REQUIRED_CONFIRMATIONS = 1`), no reorg handling.
- Admin refund/fail are DB-only status flips; cancel of a funded order is silent.
- CLI strings hardcode `-regtest -rpcwallet=swap-wallet`.
- SIWE does not bind domain/URI/chain; JWT in `localStorage`; rate limiter fail-open; `/health/deep` open when no token set.
- Fee estimates use BIP141 weight (3.2× too high on BTQ).
- `platform_fee_pct` never applied; no documented fee model.
- Migrator splits SQL on `;` and swallows `23505`.
- No CI, TLS, backups, metrics, audit log, runbooks.

## Medium

- WebSocket JWT not checked for revoke/ban; no admin bootstrap; public book leaks secret hash, Dilithium keys and BTQ addresses.
- No worker/frontend/matcher tests; tests that exist only cover the legacy custody flow.
- Compose ships dummy keys (`0x…01`), mainnet USDT address on Sepolia RPC, and Hardhat addresses baked into the UI.

## What is reusable

- `HtlcERC20` contract and its 15 tests (after the config fix).
- Matching algorithm shape (advisory lock + `FOR UPDATE SKIP LOCKED`, price-time priority, partial fills, `trades`, candles).
- EVM lockup-event parsing in `order.service.verifyBuyOrderFundingOnEvm`.
- Docker migrate-on-start, React/Tailwind shell, Socket.IO plumbing.
- Cash for Hash bot patterns: ephemeral responder, actor resolution, token-bucket limiter, error boundary, channel guard, guild-only registration.
- `btq-browser-wallet` P2MR sighash/serialization/ML-DSA approach (proven against btqd).

## Decision

Build one P2P HTLC protocol (buyer holds the preimage and locks USDT first; seller locks BTQ second with a shorter CLTV; buyer claims BTQ revealing the preimage; seller claims USDT with it), a standalone signer (`@btq-swap/htlc` + `btq-htlc` CLI) for every BTQ HTLC spend, the platform as an ordinary automated maker, Discord as the user terminal, and a live monitor. See `docs/superpowers/plans/2026-11-12-htlc-swap-completion.md`.
