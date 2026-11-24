# SOP 10 — Secrets

Secrets live in two places:

- Workstation and box: `/opt/btq-swap/deploy/.env` and `~/BTQ/btq-swap/deploy/.env` (mode 600).
- SSH to the box: `~/.cursor/skills/btq-swap-vultr-ops/.env`.

Never print them, commit them, or copy them into the duty report, a Discord message, or a log quote. `deploy/make-env.sh` mints a new set. Running it against this box orphans the platform wallets. That is a stop (SOP 00).

Confirm a variable by length only: `[ -n "$ADMIN_TOKEN" ] && echo ADMIN_TOKEN=set`.

## Rotation

| Variable | What changes | When it is allowed |
|---|---|---|
| `ADMIN_TOKEN`, `SESSION_SECRET` | Operators are logged out | The request says to rotate the operator token. Edit both env files, `dc up -d api` |
| `HEALTH_DEEP_TOKEN` | Deep health clients need the new value | Same, with the request |
| `DISCORD_BOT_TOKEN` | The gateway reconnects as the same or a new app | Reset in the developer portal first. Then SOP 05. Switching app id is a stop until a human confirms |
| `BTQ_RPC_PASS` | btqd and the clients must change together | Stop. It means editing the btqd command and the env in one step, and a mistake locks the chain |
| `PLATFORM_HTLC_SEED` | The platform can no longer claim or refund HTLCs it already signed | Stop. Allowed only with zero active platform swaps, and only when the request says to rotate it |
| `PLATFORM_SECRET_KEY` | Encrypted platform preimages become unreadable | Same stop |
| `EVM_PRIVATE_KEY` | USDT and ETH sit at the old address | Stop. Funds move first, then a rotate with zero active platform swaps |
| `POSTGRES_PASSWORD` | The database URL inside compose breaks unless the role is altered to match | Stop |

After any rotation that you were allowed to do: SOP 02, and confirm the old token no longer logs in (one failed login is enough; the limit is 20 per 15 minutes).

Active platform swaps, before anyone even considers a seed or key rotate:

```bash
python3 docs/sops/scripts/vps-admin.py GET /overview
```

Look at `swapCounts` for anything other than `completed`, `expired`, `refunded`, and `failed`. Any other count means the book stays up and the key stays.
