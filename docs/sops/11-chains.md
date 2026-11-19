# SOP 11 — Chains

Both chains are local to the box. `btqd` is BTQ v0.5.0 regtest, RPC only on `127.0.0.1:18443`. `anvil` is chain 31337, block time 2 seconds, RPC only on `127.0.0.1:8545`. The public EVM URL is the whitelisted proxy on `/api/rpc/evm`. It does not forward `anvil_*`, `evm_*`, or `eth_sendTransaction`. Do not publish either RPC port.

The miner is a backend process, not btqd. It mines one regtest block every `BTQ_TARGET_BLOCK_SEC` (5) and alternates the coinbase between the `platform` wallet and the `faucet` wallet. Coinbase maturity is 100 blocks. If the miner is down, BTQ height stalls, CLTV refunds do not approach, and confirmations do not arrive.

## Height check

```bash
curl -fsS http://127.0.0.1:5173/api/public/monitor | python3 -c 'import json,sys; m=json.load(sys.stdin); print(m["chains"])'
sleep 15
curl -fsS http://127.0.0.1:5173/api/public/monitor | python3 -c 'import json,sys; m=json.load(sys.stdin); print(m["chains"])'
```

Pass: `chains.btq.tip` increased, and `chains.evm.head` increased. `lastTickAt` on both is within 60 seconds.

## Restart order

Restart the node that failed, then the process that depends on it.

```bash
dc restart btqd
dc restart miner
```

or

```bash
dc restart anvil
dc restart api
```

`anvil` keeps state in the `anvildata` volume (`/data/anvil-state.json`). Restarting it does not wipe state. Removing the volume does. That is a stop.

## Balances

SOP 04's overview is the balance check.

- Platform BTQ under `1000`: the miner may be down, or the coins are immature. Restore the miner and wait. Bootstrap tops the wallet up to `DEVNET_PLATFORM_MIN_BTQ` (default 1000) by mining 150 blocks a round.
- Platform ETH under `100`: re-run bootstrap. It calls `anvil_setBalance` for the platform and the faucet when either is under 100 ETH.
- Faucet USDT under `1000000`: bootstrap transfers from the platform minter. The sim uses the faucet so it does not race the platform nonce.

```bash
dc run --rm --no-deps bootstrap
```

Bootstrap is idempotent. It migrates, mines if the platform wallet is short, deploys MockUSDT and HtlcERC20 only when the saved addresses have no code, funds the faucet, and seeds a 2.45 / 2.55 order only on a side that has no open order. After it, run SOP 04 so the duty-file quote replaces a seeded price.

If the log says `deploying MockUSDT`, Anvil state was empty. Keep the book paused and follow the last paragraph of SOP 08.

Contract addresses:

```bash
dc exec -T postgres psql -U btqswap -d btqswap -c "SELECT value->>'htlc' AS htlc, value->>'token' AS token FROM devnet_state WHERE key = 'evm_contracts';"
```
