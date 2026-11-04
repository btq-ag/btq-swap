# BTQ HTLC Smart Contracts

EVM-side Hashed Timelock Contract (HTLC) implementations for **BTQ ⇄ USDT** (and other ERC-20) atomic swaps.

These contracts enable trustless, decentralized, cryptographically secure cross-chain swaps between BTQ and any EVM chain. The protocol uses SHA-256 preimage verification and time-locked escrow to guarantee atomicity — either both sides complete, or both sides can reclaim their funds.

## Contracts

| Contract | Description |
|---|---|
| `HtlcERC20` | HTLC for ERC-20 tokens (USDT, USDC, etc.). Takes an `HTLCParams` struct. |
| `HtlcNative` | HTLC for native assets (ETH, etc.). Uses positional arguments + `msg.value`. |
| `IHtlcERC20` | Interface for `HtlcERC20`, matching the struct-based API. |
| `MockToken` | Configurable-decimal ERC-20 for testing. |
| `MockUSDT` | 6-decimal mock USDT for testing. |

## Prerequisites

- Node.js >= 16
- npm or yarn

## Install

```bash
npm install
```

## Compile

```bash
npx hardhat compile
```

## Test

```bash
npx hardhat test
```

## Deploy

Deploy to a local Hardhat node:

```bash
npx hardhat node
# in another terminal:
npx hardhat run scripts/HTLCERC20/deploy.ts --network localhost
npx hardhat run scripts/HTLCNative/deploy.ts --network localhost
```

Deploy to a testnet (configure `.env` first — see `.env.example`):

```bash
npx hardhat run scripts/HTLCERC20/deploy.ts --network sepolia
npx hardhat run scripts/HTLCNative/deploy.ts --network arbitrumSepolia
```

## How It Works

1. **Party A** locks ERC-20 tokens (e.g. USDT) into `HtlcERC20` with a SHA-256 hash of a secret and a deadline.
2. **Party B** sees the lock on-chain, then locks BTQ on the BTQ chain using the same secret hash.
3. **Party A** claims BTQ by revealing the secret preimage on the BTQ chain.
4. **Party B** reads the revealed secret from BTQ, then claims the USDT from `HtlcERC20`.
5. If either party fails to act before the deadline, the other can **refund** their locked assets.

## Networks

Configured in `hardhat.config.ts`:

- `hardhat` (local, default)
- `sepolia` (Ethereum testnet)
- `arbitrumSepolia` (Arbitrum testnet)
- `arbitrumMainnet`
- `mainnet` (Ethereum)

## License

MIT
