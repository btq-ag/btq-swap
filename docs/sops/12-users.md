# SOP 12 — A person stuck in a swap

You cannot type `/swap` as that person. You can read the swap and hand them the next command. You never run `btq-htlc` with their key, and you never ask them to paste a seed, a preimage, or an EVM private key into chat.

## Steps

1. SOP 06 for swap `<n>`. If the platform is the side that must act, say so and stop. The platform agent does that side.
2. If the deadline is still in the future and the status is a confirming state, tell them to wait. Quote the deadline from the payload.
3. If it is their move, send the one command block below that matches the status. The tool URL is `http://<host>:5173/downloads/btq-htlc.mjs`. The API base is `http://<host>:5173/api`. The EVM RPC they must use is the public proxy, `http://<host>:5173/api/rpc/evm`.

Replace `<n>`, the HTLC address, and the amount from the swap payload. `EVM_PRIVATE_KEY` means their own shell environment, not the platform key.

**Buyer, `awaiting_buyer_lock`**

```sh
curl -fsSLO http://<host>:5173/downloads/btq-htlc.mjs
node btq-htlc.mjs secret new --swap <n> --api http://<host>:5173/api
node btq-htlc.mjs evm lock --swap <n> --api http://<host>:5173/api --evm-rpc http://<host>:5173/api/rpc/evm --key env:EVM_PRIVATE_KEY
```

**Seller, `awaiting_seller_lock`** — any BTQ wallet, exact amount, the swap's HTLC address:

```sh
btq-cli -regtest sendtoaddress <btq_htlc_address> <amount_btq>
```

**Buyer, `awaiting_buyer_claim`** — before the refund height:

```sh
node btq-htlc.mjs claim --swap <n> --api http://<host>:5173/api --to <buyer BTQ address> --broadcast
```

**Seller, `awaiting_seller_claim`** — the preimage is already on-chain; they still use their own EVM key:

```sh
node btq-htlc.mjs evm claim --swap <n> --api http://<host>:5173/api --evm-rpc http://<host>:5173/api/rpc/evm --key env:EVM_PRIVATE_KEY
```

**Buyer refund** (`awaiting_buyer_refund`, or `awaiting_refunds` with a USDT lock still open), only after `evm.deadline`:

```sh
node btq-htlc.mjs evm refund --swap <n> --api http://<host>:5173/api --evm-rpc http://<host>:5173/api/rpc/evm --key env:EVM_PRIVATE_KEY
```

**Seller refund** (`awaiting_refunds` with a BTQ lock and no claim), only at or after `btq.refundLocktime`:

```sh
node btq-htlc.mjs refund --swap <n> --api http://<host>:5173/api --to <seller BTQ address> --broadcast
```

## Linking a wallet

First-time setup, still their machine:

```sh
curl -fsSLO http://<host>:5173/downloads/btq-htlc.mjs
node btq-htlc.mjs keygen
node btq-htlc.mjs link <challenge from /swap link-btq>
```

`keygen` writes `~/.btq-htlc/key.json` mode 600 and refuses to overwrite. If the browser blocked the download, use SOP 13. The challenge comes from their own `/swap link-btq` reply. Do not invent one.

## After they say they did it

Re-read the public swap once. Report the new status. One re-read. If it did not move, SOP 06, then stop.
