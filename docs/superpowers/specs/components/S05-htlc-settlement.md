# S05 HTLC settlement (P2P)

Part of [BTQ Swap production design](../2026-11-04-btq-swap-production-design.md).

## Purpose

Atomic BTQ ⇄ USDT. Either both sides claim, or both refund after timeout. Platform never holds the taker's preimage.

## One ABI

Use `packages/contracts/contracts/HTLCERC20/HtlcERC20.sol`:

- `createHTLCProposal` / `withdrawTokens` / `refundTokens` / `getHTLCInstance`
- Events: `HTLCERC20Lockup`, `HTLCERC20Claimed` (secret is on the instance, not the event — `getHTLCInstance(id).key`)
- `agreementId = sha256(packed params)` — **this** is what the DB stores as `evm_htlc_id`

Delete `htlcContract.ts` fictional ABI (`createSwapERC20`, `SwapCreated`). Delete frontend `newContract` / `withdraw` / `getContract` in `constants.ts` / `useHTLCContract.ts`.

## Party assignment

| Direction | EVM lock | BTQ P2MR |
|---|---|---|
| User buys BTQ (pays USDT) | Buyer locks USDT; `partyB` = **seller ETH** (or platform ETH if MM is seller) | Seller (or platform) locks BTQ; claim leaf = **buyer Dilithium** |
| User sells BTQ (receives USDT) | Buyer of USDT (taker or MM) locks USDT; `partyB` = seller ETH | Seller locks BTQ; claim leaf = buyer Dilithium |

**Never** set `partyB` to the HTLC contract address (current TradeForm / FundOrderModal bug).

## Secret handling

- Buyer generates preimage **client-side** (Discord cannot safely hold it). Flow:
  1. Bot tells buyer: “Generate locally; send only the **SHA-256 hash** in the fund modal.”
  2. Server stores `secret_hash` only.
  3. After the USDT (or BTQ) claim reveals the preimage on that chain, the **other** side learns it from chain (`getHTLCInstance.key` or BTQ spend).
- **Do not** persist `swaps.secret` for user swaps. Drop it from `SELECT *` responses immediately.
- Platform MM may generate and store a secret **in the secret manager** only for orders where the platform is the party that must reveal.

## Confirmations

Configurable. Production defaults: BTQ ≥ 6, EVM ≥ 12 (or finalized). Staging can stay at 1. Today's `REQUIRED_CONFIRMATIONS = 1` is a blocker.

## Claim / refund

- `confirmUserBtqClaim` must verify the tx on btq-core (txid, spent output, preimage if applicable). No more “trust client txid”.
- `refundChecker`: call real `refundTokens` / BTQ refund CLI. Admin `fail`/`refund` routes become **triggers** that enqueue a worker, not DB-only status flips.
- Cancel of a **funded** order is not a silent `cancelled` — user gets refund instructions; worker watches timeout.

## CLI

`scriptBuilder.service` must use `BTQ_NETWORK` (no hardcoded `-regtest -rpcwallet=swap-wallet`). Commands are returned ephemerally and in DMs.

## Worker rewrite

Keep poll loops; point them at:

- `HTLCERC20Lockup` / instance reads
- BTQ P2MR vout + leaf verification (today sell funding skips leaves — fix)
- Outbox keys after each transition

`processMatchedSwap` must **not** call `initBuyBtqFlow` (platform lock) when the maker already funded a P2MR. Use the maker's lock.

## Tests

Contract tests already cover secret/flow/outsider. Add:

- Backend: lock → match → claim → complete (P2P) with fakes.
- `partyB` ≠ contract.
- Hash-only storage (no plaintext secret on user swaps).
- Refund after timeout.
- Forged claim txid rejected.
