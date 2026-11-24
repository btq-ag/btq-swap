# SOP 06 — One swap

Use this when a swap number looks stuck. Refunds are on-chain spends by the party that locked. A database update never returns funds.

## Read

```bash
curl -fsS http://127.0.0.1:5173/api/public/swaps/<n>
python3 docs/sops/scripts/vps-admin.py GET /swaps/<n>
curl -fsS http://127.0.0.1:5173/api/public/monitor | python3 -c 'import json,sys; t=json.load(sys.stdin)["timing"]; print(t)'
```

The admin payload includes `events` and omits `platform_secret_enc`. Do not ask for that column. Public detail is safe to quote.

Devnet clocks, unless `timing` on the monitor says otherwise: buyer has 180 seconds to lock, the EVM lock lasts 420 seconds, the seller has 120 seconds to lock, the BTQ refund opens 24 blocks later, and blocks are 5 seconds. Confirmations are 1 on both chains.

## Decide

| Status | Meaning | Action |
|---|---|---|
| `completed`, `expired`, `refunded`, `failed` | Terminal | Report the status and `failureReason`. Stop |
| `buyer_lock_confirming`, `seller_lock_confirming` | Waiting on a block | Re-read once after 20 seconds. Still confirming after 2 minutes: SOP 11 |
| `awaiting_buyer_lock` | Buyer must lock USDT | Platform buyer: the platform agent locks. User buyer: SOP 12 |
| `awaiting_seller_lock` | Seller must send BTQ to the HTLC address | Platform seller: the platform agent sends. User seller: SOP 12 |
| `awaiting_buyer_claim` | Buyer claims BTQ, which reveals the secret | Platform buyer: the platform agent claims. User buyer: SOP 12. The refund height is the deadline |
| `awaiting_seller_claim` | Secret is on-chain; seller withdraws USDT | Platform seller: the platform agent withdraws. User seller: SOP 12 |
| `awaiting_buyer_refund` | Seller never locked. Buyer refunds USDT after `evm.deadline` | Before the deadline, waiting is correct. After it, platform buyer refunds itself; a user buyer gets the command in SOP 12 |
| `awaiting_refunds` | Timed out with funds locked | Same split. Seller refunds BTQ after `btq.refundLocktime`. Buyer refunds USDT after the EVM deadline |

"Platform" means `buyer.platform` or `seller.platform` on the public swap. The platform agent retries each action at most five times. Count `platform_action_failed` events for that kind. Under five, wait one tick (the devnet tick is 1.5 seconds) and re-read. At five, stop. The error string in the event is the report. Do not broadcast a claim or a refund yourself.

A deadline still in the future means the swap is waiting, not stuck.

`evm_lock_rejected` and `btq_lock_ignored` mean the lock did not match the swap. The user refunds their own lock after its timelock. Say that. Do not try to attach the lock to the row.
