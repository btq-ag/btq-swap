# S04 Operator order book and market making

Part of [BTQ Swap production design](../2026-11-04-btq-swap-production-design.md).

## Purpose

One CLOB. Regular users post P2P orders. **You** post, pause, and reprice **market-maker orders** from the admin web console. Discord `book` is a public view of the same book.

## Reuse

Keep `matching.service` (advisory lock, `FOR UPDATE SKIP LOCKED`, partial fills, `trades`, candles). Keep `order.service` place/fund/cancel **after** these fixes:

- Remove `funded: true` without on-chain verify (TradeForm market-sell bug).
- Match insert must include **both** parties, dilithium, timelocks — not taker-only `pending` swaps.
- Maker and taker can both read the resulting swap (`assertSwapAccess`).

## Operator MM desk (admin web)

| Action | Role | Notes |
|---|---|---|
| Post bid/ask (size, price, side) | `admin` | Creates an order owned by `platform_user_id` |
| Pause / resume book | `admin` | Discord `book` shows paused; takes rejected |
| Reprice / reduce / kill MM order | `admin` | Confirm dialog + CSRF |
| Inventory view | `viewer` | Platform BTQ + USDT balances, open HTLC exposure |
| Risk caps | `owner` | Max notional outstanding, max per-order, min spread |

MM orders still **must fund** (platform locks BTQ P2MR or USDT HTLC) before they are `is_funded` and matchable. The platform is a maker, not a dark pool.

## Discord vs web

- Discord `book` / `take`: users.
- Discord `/swap-admin book status`: glance (spread, caps, pause).
- Web: every mutation. Same reason as CFH: CSRF + confirm UX.

## Fees

Apply `platform_fee_pct` at match (already on `config` / `trades.maker_fee`). v1: fee in the EVM amount or a documented spread on MM quotes — pick one in implementation and test it. Do not silently ignore the column.

## Invariants

- Self-trade: platform MM may match users; a user must not match themselves.
- Public book never includes wallets or secret hashes.
- Unfunded MM quotes do not rest on the book.

## Tests

Matcher unit tests (partial fill, self-trade, pause, MM vs user). Admin cannot post via Discord. Unfunded MM order hidden from `book`.
