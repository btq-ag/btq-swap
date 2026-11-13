# SOP 04 — Market maker

The in-process quoter is not built yet. Until it is, the agent keeps one platform bid and one platform ask on the book. Bid is the mid rounded down by half the spread. Ask is the mid rounded up by half the spread. A spread of 2 means the market is 2% wide: at mid 2.50 the quote is **2.475000 / 2.525000**. Volume is the BTQ still resting at that price.

The price lives in `/var/lib/btq-swap/duty.json`, which a deploy cannot delete:

```json
{ "mid": "2.50", "spreadPct": "2", "clipBtq": "100", "usdtDecimals": 6 }
```

Change `mid`, `spreadPct`, or `clipBtq` only when the request names the new number. Spread must stay at or above `mm_min_spread_pct` (0.5). Clip must stay inside `min_order_btq` and `mm_max_order_btq`. If the file is missing, create it with the JSON above and mode 600. That default is the devnet mid.

## Read

On the box, env loaded, `DEVNET=1`, `BTQ_NETWORK=regtest`, `EVM_CHAIN_ID=31337`:

```bash
install -d -m 700 /var/lib/btq-swap
if [[ ! -s /var/lib/btq-swap/duty.json ]]; then
  umask 077
  printf '%s\n' '{"mid":"2.50","spreadPct":"2","clipBtq":"100","usdtDecimals":6}' > /var/lib/btq-swap/duty.json
fi
python3 docs/sops/scripts/vps-admin.py GET /overview > /tmp/overview.json
python3 docs/sops/scripts/vps-admin.py GET /mm/orders > /tmp/orders.json
node docs/sops/scripts/mm-quote.mjs /var/lib/btq-swap/duty.json /tmp/overview.json /tmp/orders.json > /tmp/plan.json
```

`/tmp/plan.json` is the quote. `quote.buyBtq` is the ask (what a person pays to buy BTQ) and the size resting there. `quote.sellBtq` is the bid. Exit 2 means do not trade: report `error` and stop.

A paused book produces an empty `actions` list. Leave the orders up. The duty report says `paused yes`.

## Reconcile

Run this once per session, and after a deploy or a simulation. A watch request repeats it every five minutes for at most 30 minutes.

Apply `actions` in order. Cancels come before posts.

```bash
# cancel
python3 docs/sops/scripts/vps-admin.py POST /mm/orders/<ref>/cancel <<'JSON'
{}
JSON

# post
python3 docs/sops/scripts/vps-admin.py POST /mm/orders <<'JSON'
{"side":"sell","price":"2.525000","amountBtq":"100.00000000"}
JSON
```

Use the price and amount from the plan, not the sample above. Then read the orders again. Report the remaining size at the bid and the ask. An order within 80% of the target, at the exact target price, is left alone so a live partial fill is not yanked.

## Stop

- The plan exits 2.
- A post returns `INSUFFICIENT_INVENTORY`, `BOOK_PAUSED`, or `VALIDATION`. Do not retry.
- Inventory is null. That is a stale snapshot. Run SOP 02. Do not cancel the resting orders.
- One side's target is under `min_order_btq`. That side stays empty. Post the other side. Say which wallet is short (BTQ for the ask, USDT for the bid).

Someone else's order may sit inside the spread. Leave it. This SOP's price is the platform quote. `/swap book` is the whole book, and a market order hits the better price first.

## What you tell Discord

There is no `/swap price` command yet. When someone needs the quote, report bid, ask, and the two resting sizes from the re-read. Do not type into `#btq-swap`; the channel guard removes chatter. The operator console is `http://<host>:5173/admin`.
