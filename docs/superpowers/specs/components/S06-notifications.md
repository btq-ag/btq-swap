# S06 Notifications outbox

Part of [BTQ Swap production design](../2026-11-04-btq-swap-production-design.md). Clone Cash for Hash C13.

## Purpose

Every settlement transition that a user must act on arrives as a Discord DM, even if the gateway is down.

## Write path

In the **same DB transaction** as the state change, insert `notifications` (`kind`, `payload`, `dedupe_key` unique, `status queued|sent|failed|skipped`). If `notifications_enabled` is false, insert `skipped`.

## Kinds / keys

| Kind | Dedupe key |
|---|---|
| `order_posted` | `order_posted:{orderId}` |
| `order_taken` | `order_taken:{orderId}:{userId}` |
| `funding_needed` | `funding_needed:{orderId}:{userId}` |
| `swap_funded` | `swap_funded:{swapId}:{userId}` |
| `action_required` | `action_required:{swapId}:{userId}:{status}` |
| `swap_completed` | `swap_completed:{swapId}` |
| `swap_expired` | `swap_expired:{swapId}:{userId}` |
| `swap_refunded` | `swap_refunded:{swapId}:{userId}` |

## Send path

Worker job `notify` (retries 30s / 2m / 10m). `notify-sweep` re-enqueues orphaned `queued` rows. Discord 50007 (cannot DM) → `failed`, no retry; show on admin user page.

Bot process does **not** open DMs.

## Tests

Enqueue/dedupe/skip (port `outbox.test.ts`). Cannot-DM marks failed. Payload renderer includes `btq-cli` / claim steps, never the preimage.
