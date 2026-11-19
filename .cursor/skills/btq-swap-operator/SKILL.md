---
name: btq-swap-operator
description: >-
  Operate the BTQ Swap devnet autonomously by following docs/sops: health, deploy,
  market-maker quote, Discord bot, stuck swaps, simulation, incidents, backups,
  secrets, chains, user support, and the btq-htlc download. Use when the user
  mentions BTQ Swap, the HTLC server, the swap dashboard, #btq-swap, the Madrid
  VPS, or asks an agent to run, watch, deploy, or repair the swap stack.
---

# BTQ Swap operator

The procedures are [docs/sops/README.md](../../../docs/sops/README.md). Read [00-autonomy.md](../../../docs/sops/00-autonomy.md), then the one SOP that matches the request. Those files are the steps. Do not invent a parallel procedure.

SSH credentials are in the personal skill `btq-swap-vultr-ops` (`~/.cursor/skills/btq-swap-vultr-ops/.env`). Never print a secret. Never commit `deploy/.env`.

End every operations turn with the duty report in the SOP index.
