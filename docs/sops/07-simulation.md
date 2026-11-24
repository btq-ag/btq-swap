# SOP 07 — Simulation

Run this only when the request says simulate, test the suite, or run a scenario. The suite performs real HTLC swaps through the bot pipeline and spends platform inventory. With `--mirror-discord` it opens a thread in `#btq-swap`.

## Preconditions

- SOP 02 passes.
- `df -P / /var` shows Use% under 85 on both. Otherwise stop.
- `dc ps` shows no `sim` container. One suite at a time. This box has one vCPU and about 4 GB of RAM.
- Pick a new salt: `sop-$(date -u +%Y%m%dT%H%M%SZ)`. Never reuse a salt. Personas are derived from it.

## Run

A canary is one scenario and finishes in a few minutes:

```bash
cd /opt/btq-swap
dc() { docker compose -f deploy/docker-compose.yml --env-file deploy/.env "$@"; }
dc --profile sim run --rm -T sim --scenario buy-from-mm --salt "$SALT" --burst 6 --mirror-discord
```

The full suite is what "run the simulations" means. It takes about 11 minutes because the refund scenarios wait out the real 420-second EVM deadline.

```bash
dc --profile sim run --rm -T sim --scenario all --salt "$SALT" --burst 6 --mirror-discord
```

Scenarios: `buy-from-mm`, `sell-to-mm`, `p2p`, `partial-fill`, `buyer-no-show`, `seller-no-show`, `buyer-never-claims`, `security`, `burst`. A comma-separated `--scenario` list runs a subset.

## Report

The container is removed on exit. The report stays on the `btqswap_simreports` volume.

```bash
docker run --rm -v btqswap_simreports:/r alpine cat "/r/sim-${SALT}.md"
```

Exit 0 and `ALL PASSED` is a pass. Any other exit is a fail: include the failing scenario and the first failing check in the duty report. Do not re-run `all` hoping it flakes past. Re-run a single failed scenario only when the failure was a timeout talking to a chain you have since restored.

## After

Run SOP 04. The suite takes the quote. Reconcile it back to the clip.
