# BTQ Swap — Quantum-Safe Atomic Swap Platform

Trustless BTQ ⇄ USDT atomic swaps using Hash Time-Locked Contracts (HTLCs) with Dilithium post-quantum signatures on the BTQ side and EVM smart contracts on Ethereum.

## Architecture

```
btq-swap/
├── packages/
│   ├── contracts/    # Solidity HTLC contracts (Hardhat)
│   ├── backend/      # Express + TypeScript API server
│   └── frontend/     # React + Vite + Tailwind UI
├── docker-compose.yml
└── package.json      # npm workspaces root
```

**How it works:**

1. The platform runs a btq-core node and acts as the always-available market maker
2. Users connect via MetaMask (EVM side) and run btq-cli locally (BTQ side)
3. Swaps use true HTLC atomicity — the user claims BTQ themselves with the preimage
4. The web app generates btq-cli commands; users copy-paste them in their terminal

### Swap Flows

**Buy BTQ with USDT:**
- Platform locks BTQ in P2MR HTLC (claim leaf = user's Dilithium pubkey)
- User locks USDT in EVM HTLC via MetaMask
- Platform claims USDT (reveals preimage on-chain)
- User claims BTQ using revealed preimage + btq-cli

**Sell BTQ for USDT:**
- User locks BTQ in P2MR HTLC via btq-cli (claim leaf = platform's Dilithium pubkey)
- Platform verifies and locks USDT in EVM HTLC
- User claims USDT via MetaMask (reveals preimage)
- Platform claims BTQ using revealed preimage

## Prerequisites

- **Docker + Docker Compose** (recommended — runs everything with one command)
- Or Node.js >= 20 for local development
- A synced btq-core node with RPC enabled (for live swaps)
- An Ethereum RPC endpoint (Infura/Alchemy)

## Quick Start (Docker — recommended)

```bash
cd btq-swap
cp .env.example .env   # optional: set EVM_PRIVATE_KEY, HTLC_CONTRACT_ADDRESS, JWT_SECRET
docker compose up --build -d
# or: npm run docker:up
```

Open **http://localhost:5173** — nginx serves the UI and proxies `/api` + `/socket.io` to the backend.

| Service    | URL (from your machine)      |
|------------|------------------------------|
| Web UI     | http://localhost:5173        |
| API health | http://localhost:5173/api/health |

Logs: `docker compose logs -f` or `npm run docker:logs`  
Stop: `docker compose down` or `npm run docker:down`

**BTQ node on the host:** the backend uses `host.docker.internal` by default so a local btq-core RPC on port 8332 is reachable from the container.

## Local development (without Docker app containers)

```bash
cd btq-swap
npm install
docker compose up -d postgres redis   # infra only
cp .env.example .env
# Set DATABASE_URL to postgresql://btqswap:btqswap@127.0.0.1:5436/btqswap
# Set REDIS_URL to redis://127.0.0.1:6381
npm run migrate
npm run build:contracts
npm run dev:backend   # Express API on :3001
npm run dev:frontend  # Vite dev server on :5173
```

## Smart Contracts

The EVM HTLC contracts support both ERC-20 tokens (USDT) and native ETH. Deploy to Sepolia for testing:

```bash
cd packages/contracts
npx hardhat compile
npx hardhat run scripts/HTLCERC20/deploy.ts --network sepolia
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, TypeScript, Vite, Tailwind CSS, wagmi v2, RainbowKit |
| Backend | Node.js, Express, TypeScript, Socket.IO |
| Database | PostgreSQL 16, Redis 7 |
| Smart Contracts | Solidity 0.8.20, Hardhat, OpenZeppelin |
| BTQ Integration | btq-core JSON-RPC (P2MR, Dilithium signing) |
| EVM Integration | ethers.js v6 |
| Auth | Sign-In with Ethereum (SIWE) + JWT |

## License

MIT
