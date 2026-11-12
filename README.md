# BTQ Swap — BTQ ⇄ USDT atomic swaps over Discord

Peer-to-peer hash time-locked swaps between **BTQ** (Dilithium / ML-DSA-44 keys in P2MR scripts) and an
**ERC-20 stablecoin** on an EVM chain. Users trade entirely from Discord (`/swap`), keep their own keys
and secrets, and every swap either completes on both chains or refunds on both chains. The operator
runs an automated market maker against the same order book. A live monitor shows every swap's state.

## How a swap settles

1. **Match.** Orders are intents; a match creates a swap that names both parties.
2. **Buyer locks USDT** in `HtlcERC20` for the seller, under `sha256(secret)` — the secret stays on the buyer's machine.
3. **Seller locks BTQ** in a two-leaf P2MR HTLC: claim = `OP_SIZE 32 OP_EQUALVERIFY OP_SHA256 <H> OP_EQUALVERIFY <buyerPk> OP_CHECKSIGDILITHIUM`, refund = `<height> OP_CLTV OP_DROP <sellerPk> OP_CHECKSIGDILITHIUM`.
4. **Buyer claims BTQ**, revealing the secret in the BTQ witness.
5. **Seller claims USDT** with that secret. Missing steps time out into refunds (BTQ after the CLTV height, USDT after the EVM deadline; the USDT lock always outlives the BTQ lock by a safety margin).

BTQ Core wallets cannot sign HTLC leaves, so users sign claims/refunds with the bundled
**`btq-htlc`** tool (`packages/htlc`); funding still uses any BTQ wallet (`btq-cli sendtoaddress`).

## Repository

```
packages/htlc       P2MR HTLC toolkit (scripts, addresses, BTQ sighash, ML-DSA-44, claim/refund, preimage extraction) + btq-htlc CLI
packages/backend    domain (identity, book, settlement), chain watchers, platform MM agent, API, Discord bot, simulator, devnet tools
packages/frontend   settlement monitor (/) and operator console (/admin)
packages/contracts  HtlcERC20 / HtlcNative + tests
deploy/             Docker images, compose stack, env generator, VPS deploy + backup scripts
docs/               design specs, gap analysis, completion plan, runbooks
```

## Run the whole devnet locally

```bash
deploy/btqd/fetch-binaries.sh                       # BTQ Core v0.5.0-testnet binaries (sha256 verified)
deploy/make-env.sh http://localhost:5173            # fresh secrets → deploy/.env (add DISCORD_* to enable the bot)
docker build -t btq-swap-btqd deploy/btqd
docker build -t btq-swap-backend -f packages/backend/Dockerfile .
docker build -t btq-swap-web -f packages/frontend/Dockerfile .
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
open http://localhost:5173
```

Stack: BTQ **regtest** node with a 5 s block clock, **anvil** (chain 31337) with MockUSDT + HtlcERC20, Postgres, API + workers,
Discord bot, nginx (monitor + `/downloads/btq-htlc.mjs` + whitelisted `/api/rpc/evm`).

## Simulation suite

Real HTLCs on both chains, every user action going through the same Discord handlers as real users:

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env --profile sim run --rm sim --scenario all --mirror-discord
```

Scenarios: `buy-from-mm`, `sell-to-mm`, `p2p`, `partial-fill`, `buyer-no-show`, `seller-no-show`, `buyer-never-claims`,
`security`, `burst`. Reports are written as Markdown + JSON; `--mirror-discord` posts a run summary and a transcript thread
in the swap channel while the bot's live swap cards update.

## Discord

`/swap start · help · link-evm · link-btq · profile · book · buy · sell · take · orders · swaps · status · fund · claim · refund · notifications`
and read-only `/swap-admin status · lookup`. Replies are ephemeral; wallets go in modals; buttons are bound to the user who
received them; 20 interactions/min/user; the swap channel is command-only. Register commands per guild:
`docker compose … run --rm --no-deps api register`.

## Tests

```bash
npm test -w packages/htlc          # unit (live regtest/anvil suites: BTQ_LIVE=1 / EVM_LIVE=1)
npm test -w packages/backend       # settlement validation, instructions, money, guard, Discord payload limits
npm test -w packages/contracts     # HtlcERC20
```

Deployment, refunds, key rotation and incident handling: [`docs/runbooks`](docs/runbooks/README.md).
Design and history: [`docs/superpowers`](docs/superpowers).
