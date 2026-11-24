# BTQ Swap — HTLC swap completion plan (end to end)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Discord user can buy or sell BTQ for USDT through `/swap` commands, every swap settles through real HTLCs on a BTQ chain and an EVM chain (or refunds safely), the operator's market maker runs automatically, and a live dashboard plus a Discord feed show every swap's state. A one-command simulation suite proves it with real transactions.

**Architecture:** `@btq-swap/htlc` (pure TS) builds/signs/inspects BTQ P2MR HTLCs with ML-DSA-44 and is shared by the platform, the simulator and the user CLI. `@btq-swap/backend` holds the domain (identity, book, settlement state machine, outbox), chain adapters (btqd JSON-RPC, ethers v6 against `HtlcERC20`), workers (chain watchers, deadlines, platform agent, notifier, Discord feed), the HTTP API, the Discord bot and the simulator as separate entry points of one image. The frontend becomes the public swap monitor plus the operator console.

**Tech Stack:** Node 24, TypeScript, Postgres 16, Redis 7 (optional), discord.js 14, ethers 6, @noble/post-quantum (ML-DSA-44), Hardhat (contracts), anvil (local EVM), btqd v0.5.0-testnet in regtest, React 18 + Vite + Tailwind, Docker Compose.

Gap evidence: `docs/superpowers/specs/2026-11-12-gap-analysis.md`. Master design (still authoritative where not superseded here): `docs/superpowers/specs/2026-11-04-btq-swap-production-design.md`.

---

## 0. Decisions locked by this plan (supersede the 2026-11-04 spec where they differ)

1. **Swap protocol (both directions identical).**
   - *Buyer* = party receiving BTQ and paying USDT. *Seller* = party paying BTQ and receiving USDT.
   - Buyer generates a 32-byte preimage `s` locally; only `H = sha256(s)` ever leaves the buyer. If the platform is the buyer it generates `s` itself and stores it AES-256-GCM encrypted (`PLATFORM_SECRET_KEY`).
   - Step 1 — buyer locks USDT: `HtlcERC20.createHTLCProposal({partyB: sellerEth, secretlock: H, deadline: T_evm, erc20Contract: USDT, tokenAmount, otherNetwork: "btq:<network>", otherAsset: "BTQ swap <swapId>", otherAmount: sats})`. `otherAsset` binds the lock to the swap.
   - Step 2 — seller verifies the confirmed lock (amount, token, partyA/partyB, H, deadline, swap binding) and locks BTQ to the P2MR HTLC built from `(H, buyerPk, sellerPk, L)` where `L = tip + SWAP_BTQ_LOCK_BLOCKS`. Seller must not lock unless `T_evm − now ≥ SWAP_BTQ_LOCK_BLOCKS × BTQ_TARGET_BLOCK_SEC + SWAP_SAFETY_MARGIN_SEC`.
   - Step 3 — buyer verifies the confirmed BTQ lock and claims it with `[sig, s, claimLeaf, control]`, revealing `s` on the BTQ chain.
   - Step 4 — seller reads `s` from the BTQ claim witness and calls `withdrawTokens(agreementId, s)`.
   - Refunds: seller refunds BTQ after height `L`; buyer refunds USDT after `T_evm`. Nobody can lose funds unless they miss their own claim window.
2. **HTLC leaves** (`@btq-swap/htlc/src/script.ts`): claim `OP_SIZE 32 OP_EQUALVERIFY OP_SHA256 <H> OP_EQUALVERIFY <buyerPk> OP_CHECKSIGDILITHIUM`; refund `<L> OP_CHECKLOCKTIMEVERIFY OP_DROP <sellerPk> OP_CHECKSIGDILITHIUM`; two leaves at depth 1 (same tree `getnewp2mraddress` builds). `OP_SIZE` pins the preimage to the EVM `bytes32` key.
3. **Signing:** ML-DSA-44 deterministic (`extraEntropy: false`), P2MR tapscript sighash (BIP341 + BIP342 ext, `SIGHASH_ALL` byte appended), BTQ weight `WITNESS_SCALE_FACTOR = 16`. Users sign with the `btq-htlc` CLI because BTQ Core cannot sign HTLC leaves (gap B1). Funding (`sendtoaddress <htlc>`) still uses any BTQ wallet.
4. **Order book = intents.** Orders are never pre-funded. A match creates a swap that names both parties; locks follow the protocol. Price-time priority, partial fills, self-trade prevention, IOC (`market`) or GTC (limit). Book pause and per-order pause.
5. **Platform = automated maker.** MM quotes are backed by free inventory (BTQ wallet balance / USDT balance minus reservations). The platform agent performs the platform's protocol steps automatically. Fee model v1: **zero protocol fee; the operator earns the MM bid/ask spread** (`trades.maker_fee/taker_fee` recorded as 0, tested).
6. **Identity:** Discord snowflake is the key. ToS acceptance required before trading. EVM address linked by EIP-4361 message bound to domain, URI, chain id and a single-use nonce. BTQ HTLC public key linked by an ML-DSA-44 signature over a single-use challenge (proof of possession), plus a BTQ receive address.
7. **Discord:** guild-scoped `/swap` and read-only `/swap-admin`; every reply ephemeral; wallets only in modals; actor = `interaction.user.id`; component ids carry the actor; 20 interactions/min/user; channel guard removes public non-staff messages in `#btq-swap`; the bot process never DMs — the notifier worker does (outbox). A **live feed** posts and edits one public embed per swap in the swap channel (no secrets before reveal, masked user names).
8. **Networks for this deliverable:** BTQ regtest (btqd v0.5.0-testnet binary) and a local anvil chain (chain id 31337) with `MockUSDT` (6 dp) — both approved by the owner. Mainnet values are config only.
9. **Bot identity:** use `DISCORD_BOT_TOKEN` from `.env`. The dedicated *BTQ Swap* application token was not found on disk, so the *BTQ Bot* application (already Administrator in the guild) runs the bot until the owner pastes the BTQ Swap token (one env change, no code change).
10. **Legacy custody flow is removed**, not patched: `swap.service.ts`, `order.service.ts`, `matching.service.ts`, `scriptBuilder.service.ts`, `htlcContract.ts`, the five legacy workers, legacy routes and the trading UI. Their reusable logic moves into the new modules listed below.

## 1. Timing profiles

| Env var | devnet (this deliverable) | production default |
|---|---|---|
| `BTQ_TARGET_BLOCK_SEC` | 5 (block clock) | 600 |
| `SWAP_BUYER_LOCK_WINDOW_SEC` | 180 | 1800 |
| `SWAP_EVM_LOCK_DURATION_SEC` (T_evm − lock time) | 420 | 86400 |
| `SWAP_EVM_LOCK_MAX_DURATION_SEC` | 3600 | 172800 |
| `SWAP_SELLER_LOCK_WINDOW_SEC` | 120 | 3600 |
| `SWAP_BTQ_LOCK_BLOCKS` | 24 | 72 |
| `SWAP_SAFETY_MARGIN_SEC` | 120 | 21600 |
| `BTQ_MIN_CONFIRMATIONS` / `EVM_MIN_CONFIRMATIONS` | 1 / 1 | 6 / 12 |

Constraint enforced in code and tested: `SWAP_EVM_LOCK_DURATION_SEC ≥ SWAP_SELLER_LOCK_WINDOW_SEC + SWAP_BTQ_LOCK_BLOCKS × BTQ_TARGET_BLOCK_SEC + SWAP_SAFETY_MARGIN_SEC` (devnet: 420 ≥ 120 + 120 + 120 ✓).

## 2. Swap state machine

```
awaiting_buyer_lock ──(lock seen)──► buyer_lock_confirming ──(N confs, verified)──► awaiting_seller_lock
      │ window passes                                                                    │ window/time budget passes
      ▼                                                                                  ▼
   expired (terminal, nothing locked)                                         awaiting_buyer_refund ──(EVM refunded)──► refunded
awaiting_seller_lock ──(BTQ lock seen)──► seller_lock_confirming ──(N confs, verified)──► awaiting_buyer_claim
awaiting_buyer_claim ──(claim seen, preimage extracted)──► awaiting_seller_claim ──(USDT withdrawn)──► completed
awaiting_buyer_claim ──(height ≥ L, unclaimed)──► awaiting_refunds ──(BTQ refunded AND USDT refunded)──► refunded
awaiting_seller_claim ──(T_evm passed, buyer refunded USDT)──► failed (seller missed claim — reported loudly)
```

Leg facts are stored independently (`evm_lock_tx`, `evm_claim_tx`, `evm_refund_tx`, `btq_lock_txid`, `btq_claim_txid`, `btq_refund_txid`) so any out-of-order observation (e.g. claim seen in mempool before the lock confirms) still reconciles. Every transition writes `swap_events` and enqueues outbox notifications in the same DB transaction.

## 3. Data model (`packages/backend/migrations/003_p2p_htlc.sql`)

- Rename legacy `orders, swaps, trades, swap_events` → `legacy_*` (keeps any old data; no FK breakage).
- `users`: `eth_address` nullable; add `discord_id unique`, `discord_username`, `tos_accepted_at`, `tos_version`, `notifications_enabled`, `is_simulated`, `is_platform`, `eth_verified_at`, `btq_pubkey_verified_at`, `banned_at`, `no_show_count`. Reuse `dilithium_pubkey` (verified HTLC key hex) and `btq_address` (receive address).
- New: `admin_users`, `audit_log`, `link_challenges`, `orders`, `swaps`, `swap_events`, `trades`, `notifications` (outbox, `dedupe_key unique`), `feed_messages`, `chain_cursors`, `schema_migrations`.
- `scripts/migrate.js` rewritten: `schema_migrations` table, each file applied once inside a transaction, whole-file execution (no `;` splitting).

## 4. File structure

```
packages/htlc/                 @btq-swap/htlc (ESM)
  src/bytes.ts script.ts address.ts tx.ts keys.ts htlc.ts rpc.ts index.ts
  src/cli.ts                   btq-htlc CLI (keygen, pubkey, link, secret, claim, refund, inspect, evm lock/claim/refund)
  test/*.test.ts               unit + live (BTQ_LIVE=1) tests
  scripts/spike.ts             regtest feasibility proof (kept as a smoke test)
  scripts/bundle.mjs           esbuild single-file CLI → dist/btq-htlc.mjs (served by the frontend)
packages/backend/              @btq-swap/backend (CJS)
  migrations/003_p2p_htlc.sql
  scripts/migrate.js
  src/config/index.ts          env schema (all knobs in §1, Discord, chains, secrets)
  src/lib/db.ts crypto.ts logger.ts
  src/chains/btq.ts            node RPC adapter (blocks, raw tx, send, wallet ops)
  src/chains/evm.ts            HtlcERC20 + ERC20 adapter, agreementId, log polling
  src/chains/artifacts/*.json  compiled MockUSDT + HtlcERC20 (abi + bytecode)
  src/domain/errors.ts settings.ts audit.ts
  src/domain/identity.ts book.ts settlement.ts instructions.ts outbox.ts inventory.ts monitor.ts
  src/workers/evm-watcher.ts btq-watcher.ts deadlines.ts platform-agent.ts notifier.ts feed.ts runner.ts
  src/routes/public.ts admin.ts
  src/bot/  (client, commands, pipeline, handlers, render, guard, register)
  src/sim/  (personas, driver, scenarios, report, main)
  src/devnet/bootstrap.ts miner.ts
  src/main-api.ts              API + workers entry
  tests/                       vitest (unit with fakes; integration with real Postgres)
packages/frontend/             monitor (public) + operator console (admin token)
packages/contracts/            unchanged contracts; hardhat config fixed
deploy/                        compose files, btqd image, env templates, VPS scripts
docs/runbooks/                 deploy, pause-book, refunds, key-rotation, incident, discord-install
.github/workflows/ci.yml
```

## 5. Tasks

Each task: write failing test → implement → run → commit. Commands assume repo root.

### Phase A — Protocol foundations

#### Task A1: `@btq-swap/htlc` library (done as spike, harden + test)
**Files:** `packages/htlc/src/*.ts`, `packages/htlc/test/{script,address,tx,htlc,keys}.test.ts`
- [x] Script builders (`buildClaimLeaf` with OP_SIZE, `buildRefundLeaf`, minimal pushes, `parseClaimLeaf`), tapleaf/tapbranch hashing, P2MR address encode/decode (all four HRPs), BTQ-weight vsize, P2MR sighash, ML-DSA-44 signer, claim/refund builders, spend inspection/preimage extraction, BTQ RPC client, sats helpers.
- [ ] Unit tests: leaf bytes for fixed inputs; scriptnum edge cases (127, 128, 255, 256, 2^23, 500_000_000 rejected); `decodeSegwitAddress` round-trips and rejects wrong HRP/version/checksum; control block recomputes merkle root; claim/refund refuse wrong signer, wrong preimage, early locktime; `inspectHtlcSpend` classifies claim/refund/unknown and rejects a claim whose leaf hash ≠ HTLC; vsize of a claim ≈ node vsize (323±3).
- [ ] Live test (`BTQ_LIVE=1`): run the spike flow as a vitest suite against regtest.
- Run: `npm test -w packages/htlc` → all pass; `BTQ_LIVE=1 npm test -w packages/htlc` against devnet → pass.

#### Task A2: `btq-htlc` CLI
**Files:** `packages/htlc/src/cli.ts`, `packages/htlc/scripts/bundle.mjs`, `packages/htlc/test/cli.test.ts`
- [ ] `keygen [--home]` writes `~/.btq-htlc/key.json` (0600, seed hex) and prints pubkey (base64); refuses to overwrite.
- [ ] `link <challenge>` prints `pubkey_b64` and `signature_b64` for the Discord modal.
- [ ] `secret new --swap <id>` writes `secrets/<id>.json` (0600) and prints `H`; `secret show --swap <id>`.
- [ ] `claim --swap <id> --to <addr> [--api URL] [--broadcast --rpc URL --rpcuser --rpcpass] [--fee-rate]`: fetches `GET /api/public/swaps/<id>/htlc`, **rebuilds the HTLC locally and refuses unless** address matches, claim key == own key, `sha256(local secret) == H`; signs; prints raw hex + `btq-cli sendrawtransaction`.
- [ ] `refund --swap <id> --to <addr>` (seller) same verification with refund key + locktime.
- [ ] `evm lock|claim|refund --swap <id> --key <env:VAR|hex> --rpc URL` for users without MetaMask/cast.
- [ ] Bundle: `node packages/htlc/scripts/bundle.mjs` → `packages/htlc/dist/btq-htlc.mjs` runs on Node ≥ 20 with no install.
- Test: spawn CLI with a temp HOME against a fake API (or devnet) and assert outputs/refusals.

#### Task A3: EVM adapter against the real `HtlcERC20`
**Files:** `packages/backend/src/chains/evm.ts`, `src/chains/artifacts/{HtlcERC20,MockUSDT}.json`, `scripts/export-artifacts.mjs`, `tests/evm.agreement.test.ts`, `tests/live/evm.live.test.ts`
- [ ] ABI from compiled artifact (no hand-written fiction). `computeAgreementId(params)` = `sha256(solidityPacked([...]))` — unit test against a value produced by the contract on anvil.
- [ ] `lock()`, `withdraw()`, `refund()`, `getInstance()`, `pollLogs(fromBlock,toBlock)` → typed `Lockup/Claimed/Redeemed` events with tx hash + block; `erc20 balanceOf/allowance/approve/mint`.
- [ ] Live test on anvil: deploy, lock with partyB = seller, verify `computeAgreementId == event.agreementId`, withdraw by seller with preimage, `getInstance().key == preimage`, refund path with `evm_increaseTime`.

#### Task A4: Local devnet (btqd regtest + anvil + block clock + bootstrap)
**Files:** `deploy/btqd/Dockerfile`, `deploy/btqd/btq.conf`, `deploy/docker-compose.devnet.yml`, `packages/backend/src/devnet/{bootstrap,miner}.ts`
- [ ] btqd image from the official v0.5.0-testnet linux binary (`release-artifacts/v0.5.0-testnet`, sha256 recorded), regtest, `txindex=1`, persistent volume.
- [ ] anvil with `--state /data/anvil.json --state-interval 5 --block-time 2`, chain id 31337.
- [ ] `bootstrap`: idempotent — create wallets `platform` + one per persona, mine 110+ blocks, deploy MockUSDT + HtlcERC20 once (addresses persisted in `devnet_state` table), mint USDT to platform and personas, fund persona ETH, seed MM quotes from config.
- [ ] `miner`: mines one block every `BTQ_TARGET_BLOCK_SEC`.
- Verify: `docker compose -f deploy/docker-compose.devnet.yml up -d` then `curl` RPCs; bootstrap twice → no duplicate deploys.

### Phase B — Domain + persistence

#### Task B1: Migration 003 + migrator
**Files:** `packages/backend/migrations/003_p2p_htlc.sql`, `packages/backend/scripts/migrate.js`, `tests/integration/migrate.int.test.ts`
- [ ] Schema in §3 with CHECK constraints, indexes (`swaps(status)`, `orders(side,status,price_usdt,created_at)`, `notifications(status,next_attempt_at)`), seeded `settings` rows.
- [ ] Migrator idempotent: running twice applies nothing the second time.

#### Task B2: Settings + audit
**Files:** `src/domain/settings.ts`, `src/domain/audit.ts`, tests
- [ ] Typed settings (`book_paused`, `min_order_btq`, `max_order_btq`, `mm_max_notional_usdt`, `mm_max_order_btq`, `mm_min_spread_pct`) with zod validation; every admin mutation writes `audit_log`.

#### Task B3: Identity
**Files:** `src/domain/identity.ts`, `tests/identity.test.ts`
- [ ] `ensureUser(discordId, username, {simulated})`, `acceptTos(userId, version)` idempotent + audit, `setBanned`, `setNotifications`.
- [ ] `startEvmLink(user)` → EIP-4361 message (domain `SWAP_PUBLIC_DOMAIN`, URI, chain id, nonce, issued/expiration) stored in `link_challenges`; `finishEvmLink(user, signature)` verifies with `ethers.verifyMessage`, checks nonce unused/unexpired, binds address (unique across users).
- [ ] `startBtqLink(user)` → challenge; `finishBtqLink(user, pubkeyB64, sigB64, btqAddress)` verifies ML-DSA-44 over `linkChallengeMessage(challenge)`, decodes address for the configured network, stores key + address.
- Tests: replayed nonce rejected, expired rejected, wrong domain message rejected, pubkey of wrong size rejected, signature from another key rejected, address on wrong network rejected.

#### Task B4: Book + matching
**Files:** `src/domain/book.ts`, `src/domain/inventory.ts`, `tests/book.test.ts` (integration, real Postgres)
- [ ] `placeOrder(user, {side, amountBtq, price | 'market'})`: requires ToS + both links, not banned, book not paused, bounds; MM orders require inventory headroom. Matching in one transaction: `pg_advisory_xact_lock`, opposite side `FOR UPDATE SKIP LOCKED`, best price then oldest, skip same user, partial fills, `trades` rows, one `swap` per fill with both parties' snapshots, `buyer_lock_by = now + window`; IOC remainder cancelled; GTC remainder rests.
- [ ] Platform-as-buyer fills get a fresh platform preimage (encrypted).
- [ ] `cancelOrder(user, orderId)` only owner, only unfilled remainder; `publicBook()` aggregates price levels only (no ids, keys, hashes or addresses).
- Tests: partial fill across 2 makers, price-time priority, self-trade skipped, paused book rejects, IOC remainder cancelled, MM without inventory rejected, maker/taker both linked to swap, concurrent takers never double-fill (parallel `placeOrder`).

#### Task B5: Settlement state machine
**Files:** `src/domain/settlement.ts`, `tests/settlement.test.ts`
- [ ] `recordEvmLock(event)`: map via `otherAsset`, verify partyA = buyer, partyB = seller, token, amount ≥ expected, `H` 32 bytes, deadline within `[now + minRemaining, now + max]`, recomputed agreement id; wrong locks are recorded as rejected events (never advance).
- [ ] `confirmEvmLock` (confs), `sellerLockParams(swap)` (computes `L`, address; refuses if time budget insufficient), `recordBtqLock(txid, vout, value, height)` (address/amount check), `confirmBtqLock`, `recordBtqSpend(rawTx)` via `inspectHtlcSpend` (claim → store preimage, verify `sha256 == H`; refund → refund txid), `recordEvmClaim/Refund`, deadline transitions in §2.
- [ ] All transitions guarded (`FOR UPDATE`, allowed-from set), idempotent on replays, emit events + outbox in the same transaction.
- Tests: every arrow in §2, idempotent replays, wrong-amount lock rejected, forged BTQ claim (wrong preimage) ignored, out-of-order (claim before confirm) reconciles.

#### Task B6: Instructions renderer
**Files:** `src/domain/instructions.ts`, tests
- [ ] For (swap, viewer) → role, step, deadline, human text, exact commands: buyer `secret new`, `evm lock` (or calldata), `claim`, `evm refund`; seller `btq-cli -<network flag> sendtoaddress <htlc> <amount>`, `evm claim` with revealed preimage, `refund`. Network flag from `BTQ_NETWORK` (never hardcoded `-regtest`). Never contains a preimage before it is public on-chain.

#### Task B7: Outbox
**Files:** `src/domain/outbox.ts`, tests
- [ ] `enqueue(tx, {userId, kind, dedupeKey, payload})`; disabled DMs → `skipped`; simulated users → `simulated` (shown on monitor). Kinds: `swap_matched`, `action_required:<status>`, `swap_completed`, `swap_expired`, `swap_refunded`, `swap_failed`.

#### Task B8: Platform agent + inventory
**Files:** `src/workers/platform-agent.ts`, `src/domain/inventory.ts`, tests with fakes
- [ ] Platform buyer: lock USDT right after match; claim BTQ when confirmed (platform Dilithium key from `PLATFORM_HTLC_SEED`, destination = platform wallet address); refund USDT after `T_evm`.
- [ ] Platform seller: lock BTQ (`sendtoaddress` from `platform` wallet) once EVM lock confirmed and budget OK; withdraw USDT when preimage known; refund BTQ after `L`.
- [ ] Each action guarded by an `action_key` in `swap_events` so restarts never double-send; tx hashes recorded before waiting for receipts.

### Phase C — Workers + API

#### Task C1: Chain watchers
**Files:** `src/workers/evm-watcher.ts`, `src/workers/btq-watcher.ts`, `chain_cursors`
- [ ] EVM: poll logs from cursor in ranges ≤ 2000 blocks, confirmations from head, persist cursor; also re-read `getHTLCInstance` for open swaps (reconciliation).
- [ ] BTQ: scan each new block (verbosity 2) for (a) outputs paying watched HTLC scriptPubKeys, (b) inputs spending watched outpoints; scan mempool for (b) so preimages are learned at 0-conf; persist height + hash, rewind on hash mismatch (reorg).

#### Task C2: Deadlines worker — §2 timeouts, no-show counters.

#### Task C3: Notifier (outbox → Discord DM)
- [ ] REST `POST /users/@me/channels` then `POST /channels/:id/messages`; retries 30s/2m/10m; 50007 → `failed` no retry; respects 429 `retry_after`.

#### Task C4: Discord live feed
- [ ] One embed per swap in `DISCORD_FEED_CHANNEL_ID`: status chip, progress bar of the 6 protocol steps, amounts, price, masked parties, tx ids per leg, timelocks (height vs `L`, time vs `T_evm`), preimage only after reveal. Create on first sight, edit on change (hash-compare to skip no-ops), rate-limit aware queue.

#### Task C5: HTTP API
**Files:** `src/routes/public.ts`, `src/routes/admin.ts`, `src/main-api.ts`
- [ ] Public: `GET /api/health`, `GET /api/health/deep` (requires `HEALTH_DEEP_TOKEN`, fail closed), `GET /api/public/monitor` (chains, book, swaps with legs + events, outbox stats), `GET /api/public/swaps/:id` and `/:id/htlc` (CLI descriptor), `GET /api/public/book`.
- [ ] Admin (cookie session from `POST /api/admin/login {token}`, `X-BTQ-Request: 1` on mutations): MM orders CRUD (post, pause, resume, reprice, cancel), book pause, risk caps, users (ban/unban), swaps list/detail/note, inventory, audit log.
- [ ] CORS allowlist, helmet, `trust proxy` only when `TRUST_PROXY=1`.

### Phase D — Discord bot

#### Task D1: Bot core
**Files:** `src/bot/{client,pipeline,respond,actor,rate-limit,errors,guard,register,commands,render}.ts`
- [ ] Ported CFH patterns: correlation id, actor from `interaction.user.id` only, token bucket 20/min, ToS gate (except `start`, `help`), ban gate, always-ephemeral responder, error boundary with correlation id, guild-only registration (`npm run register -w packages/backend`), Guilds + GuildMessages intents only, channel guard + startup sweep, presence "Book live/paused".

#### Task D2: `/swap` commands
| Sub | Behaviour |
|---|---|
| `start` | ToS embed + Accept button `swap:tos:<actorId>:<exp>` |
| `help` | Command list, tool download URL, how swaps work |
| `link-evm` | Shows SIWE message + button → modal (signature) → verify |
| `link-btq` | Shows challenge + CLI hint + button → modal (pubkey b64, signature b64, BTQ address) → verify |
| `profile` | Linked wallets, stats |
| `book` | Aggregated levels + MM status + paused flag |
| `buy` / `sell` | Modal (amount BTQ, price or `market`) → order + fills summary |
| `orders` | Own open orders with Cancel buttons `swap:cancel:<actorId>:<orderId>` |
| `swaps` | Own active swaps with step + deadline |
| `swap id:<n>` | Detail + next action (`instructions.ts`) + action buttons |
| `fund id:<n>` | Buyer: modal for `H` → exact lock commands; Seller: HTLC address + amount + `btq-cli` command; optional modal to submit txid |
| `claim id:<n>` | Buyer: `btq-htlc claim` command; Seller: `btq-htlc evm claim` / calldata with the revealed preimage |
| `refund id:<n>` | Refund instructions when eligible |
| `notifications state:on|off` | Toggle DMs |
`/swap-admin status` (book, inventory, active swaps by state) and `/swap-admin lookup user:<@>` — read-only, gated by `admin_users`.

#### Task D3: Bot tests
- [ ] Command surface snapshot; every reply ephemeral; no user/wallet options on buyer commands; forged component ids (other actor) → FORBIDDEN; rate limit; banned; unregistered; admin lookups never mutate.

### Phase E — Monitor + operator console (frontend)

#### Task E1: Monitor (`/`)
- [ ] Header stats (active, completed, refunded, volume), chain health (BTQ height/tip age, EVM block, watcher lag), live swaps board (cards with 6-step progress, role chips, countdowns to `L` and `T_evm`, leg tx ids), selected swap drawer (event timeline, HTLC address, preimage after reveal), book depth, notification log. Polls `/api/public/monitor` every 2 s.
- [ ] Remove legacy trading pages/components/hooks and wagmi/RainbowKit from the bundle.

#### Task E2: Operator console (`/admin`)
- [ ] Token login, MM desk (post/pause/resume/reprice/cancel, book pause), inventory and exposure vs caps, users (ban), swaps (detail, notes), audit log.

### Phase F — Simulation suite (`npm run sim`)

#### Task F1: Personas + driver
**Files:** `src/sim/{personas,driver,interaction,chainops,report,main}.ts`
- [ ] Personas (alice, bob, carol, dave, erin, …) — synthetic snowflakes ≥ 9e17 flagged `is_simulated`, own regtest wallet, own anvil key, own HTLC key and local secret store.
- [ ] Driver issues real `/swap` interactions through the **same bot pipeline** (synthetic interaction objects implementing the discord.js surface the handlers use), records every ephemeral reply, and performs the persona's chain steps exactly as the instructions say (library calls equivalent to the CLI).
- [ ] Optional Discord transcript thread per run (`--mirror-discord`): "alice ▸ /swap buy 2 @ market → reply …".

#### Task F2: Scenarios (each asserts final state + balance deltas on both chains)
1. `buy-from-mm` 2. `sell-to-mm` 3. `p2p` 4. `partial-fill` (one order spanning MM + user asks) 5. `buyer-no-show` (expired, nothing moved) 6. `seller-no-show` (buyer refunds USDT) 7. `buyer-never-claims` (seller refunds BTQ, buyer refunds USDT) 8. `security` (stolen button, unlinked trade, banned, wrong-amount lock rejected, forged claim ignored) 9. `burst` (N concurrent mixed swaps).
- [ ] Report `sim-reports/<ts>.{json,md}` with every swap, txids, timings, pass/fail.

### Phase G — Deploy + ops

#### Task G1: Images + compose
- [ ] One backend image (`node:24-slim`) with entrypoints `api`, `bot`, `sim`, `bootstrap`, `miner`, `migrate`; frontend image (nginx) also serving `/downloads/btq-htlc.mjs`.
- [ ] `deploy/docker-compose.yml` (VPS): btqd, anvil, postgres, redis, migrate, bootstrap, api, miner, bot, web. Only web (5173) published publicly; RPCs bound to 127.0.0.1 (anvil/btqd optionally exposed for testers via `DEVNET_PUBLIC_RPC=1`).
- [ ] systemd unit `btq-swap.service` running compose; `scripts/deploy-vps.sh`.

#### Task G2: CI, backups, runbooks
- [ ] `.github/workflows/ci.yml`: install, typecheck all packages, htlc + backend unit tests, contracts tests, docker build.
- [ ] `deploy/backup.sh` (daily `pg_dump` + 7-day rotation, cron), restore steps in runbook.
- [ ] `docs/runbooks/{deploy,pause-book,refunds,key-rotation,incident,discord-install}.md`.

#### Task G3: Ops skill
- [ ] `~/.cursor/skills/btq-swap-vultr-ops/SKILL.md` + `.env` (host, credentials, layout, health checks, sim commands). Never committed.

### Phase H — Acceptance (status 2026-11-12)

- [x] Unit suites green: htlc 25 (+7 live regtest/anvil tests run with `BTQ_LIVE=1`/`EVM_LIVE=1`), backend 35, contracts 15.
- [x] Simulation `vps1` on the VPS: 9/9 scenarios, 41/41 checks, 15 swaps (12 completed, 2 refunded, 1 expired), 287 bot interactions — `docs/evidence/sim-vps1.md`.
- [x] Real-user path with only the published `btq-htlc` CLI + public API/RPC: swaps #17 (buy) and #18 (sell) completed — `docs/evidence/cli-e2e-vps.log`.
- [x] Independent chain check of swap #4 (btqd witness + EVM receipt) — `docs/evidence/swap4-independent-chain-check.txt`.
- [x] Monitor live at `http://208.85.23.103:5173` — screenshots in `docs/evidence/`.
- [x] `#btq-swap` carries the live per-swap cards, the run summary and the transcript thread.
- [ ] Human-driven swap from the Discord client (a person typing `/swap` in `#btq-swap`). Bots cannot invoke slash commands, so this needs a human tester; the commands are registered and every payload passes discord.js's validators.

| Gap (analysis §Blockers) | Closed by | Evidence |
|---|---|---|
| 1 users cannot sign BTQ HTLC spends | `071b60e` (`@btq-swap/htlc` + CLI) | live claim/refund tests; swap #17 claim via CLI |
| 2 EVM ABI mismatch | `b98c082` (real `HtlcERC20` ABI, artifact-verified) | `evm.live.test.ts`; every EVM tx in sim-vps1 |
| 3 USDT locked to nobody (`partyB`) | `b98c082` (`validateLockup` requires partyB = seller) | unit test "wrong recipient"; seller withdrawals in sim |
| 4 platform knew user secrets | `b98c082` (buyer-held preimage; platform secret only when it is buyer, AES-GCM) | instructions test; sell-to-mm (#6) |
| 5 no counterparty binding | `b98c082` (intents + post-match locks + `otherAsset` swap binding) | p2p (#7), partial-fill (#8/#9) |
| 6 `agreementId` never tracked | `b98c082` (`computeAgreementId`, stored + checked) | unit test "forged agreement id" |
| 7 matched swaps never progress | `b98c082` (state machine + platform agent) | 12 completed swaps in sim-vps1 |
| 8 fake claim detection | `b98c082` (block + mempool scan, preimage verified against the leaf) | swap #4 witness check |
| 9 no Discord product | `4810725`, `51406f3` | registered commands, payload tests, channel feed |
| 10 contract tests did not run | `071b60e` (hardhat config) | 15 passing |
| — HTLC preimage-length attack | `071b60e` (`OP_SIZE 32 OP_EQUALVERIFY`) | `script.test.ts` |
| — nginx 502 after API redeploy (found in this run) | `f198edc` | recreate-api regression check |

## 6. Out of scope (unchanged from master spec)

KYC, custodial balances, mutating Discord admin, non-USDT pairs, mobile. Mainnet launch additionally needs: dedicated BTQ Swap bot token, production keys in a secret manager, a domain + TLS (Caddy) in front of the web container, real Ethereum RPC + USDT address, an audited `HtlcERC20` deployment, and production timing profile (§1).
