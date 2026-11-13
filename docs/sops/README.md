# BTQ Swap — agent SOPs

These are the procedures for operating the live devnet on the Madrid VPS. An agent follows them instead of inventing steps.

Start at [00-autonomy.md](00-autonomy.md). Then open the one SOP that matches the request. Credentials and SSH live in the personal skill `btq-swap-vultr-ops` (`~/.cursor/skills/btq-swap-vultr-ops/.env`). Never print a secret.

| Request | SOP |
|---|---|
| What am I allowed to do | [00-autonomy.md](00-autonomy.md) |
| Log in and reach the box | [01-access.md](01-access.md) |
| Is it up | [02-health.md](02-health.md) |
| Deploy or roll forward | [03-deploy.md](03-deploy.md) |
| Price, quote, market maker, `/swap` liquidity | [04-market-maker.md](04-market-maker.md) |
| Discord bot, commands, channel, feed | [05-discord.md](05-discord.md) |
| One swap looks stuck | [06-swaps.md](06-swaps.md) |
| Run the simulation suite | [07-simulation.md](07-simulation.md) |
| Something is broken | [08-incident.md](08-incident.md) |
| Backup or restore the database | [09-backup.md](09-backup.md) |
| Keys, tokens, rotation | [10-secrets.md](10-secrets.md) |
| btqd, anvil, miner, balances | [11-chains.md](11-chains.md) |
| A person is stuck in a swap | [12-users.md](12-users.md) |
| The swap tool download is flagged | [13-cli.md](13-cli.md) |

## Duty report

End every operations turn with this. Fill unknown fields with `unknown`. Quote numbers come from the book after any reconcile, not from memory.

```
Revision: <contents of /opt/btq-swap/REVISION>
Health: <healthy|degraded> database= btq_node= evm_node= btq_watcher= evm_watcher=
Chains: BTQ height <n> (moving) · EVM block <n> (moving)
Quote: bid <price> × <btq> · ask <price> × <btq> · paused <yes|no>
Swaps: <non-terminal counts, or none>
Bot: <gateway ready | down>
Did: <one line per action, or none>
Stopped: <stop line that fired, or none>
```
