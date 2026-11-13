# SOP 05 — Discord

Guild **BTQ (Bitcoin Quantum)** `1536334941791588392`. Channel **#btq-swap** `1569688660008505354`. Commands are guild-scoped. The feed and the command channel are the same channel: one embed per swap, edited in place. Simulated users never get DMs.

The running bot is **BTQ Bot**, application `1536335225414492220`. A dedicated **BTQ Swap** application `1569696535803990086` exists and its token is not on disk. Switching applications is a stop: it needs a new token in `deploy/.env` and a human to confirm. Read-only `/swap-admin` is seeded from `DISCORD_ADMIN_IDS` (devoskii `885814580008329217`).

## Check

```bash
dc logs --tail 50 bot
```

Pass: a recent `gateway ready` line. The process is up in `dc ps`.

The bot cannot invoke slash commands. Do not try. The simulation suite (SOP 07) is how commands are exercised. A human types `/swap` in the channel.

## Register

`deploy/deploy-vps.sh` already runs `api register`. Run it by hand after a token or command change:

```bash
dc run --rm --no-deps api register
```

Expect `/swap` and `/swap-admin`. Then restart is unnecessary if the gateway is already ready; registration is REST. If the gateway is down, restart `bot` once and read the log.

## Channel rules

`#btq-swap` is command-only. The guard deletes ordinary messages and replies from anyone who lacks Manage Messages, and it deletes this app's public slash echoes. Bot embeds stay. Pinned and system messages stay.

Do not post status chatter, quotes, or SOP output into the channel. Put that in the duty report.

The bot needs, in that channel: View Channel, Send Messages, Embed Links, Manage Messages, Create Public Threads.

## Token empty

If `dc logs bot` says the token is missing, confirm `DISCORD_BOT_TOKEN` and `DISCORD_CLIENT_ID` are non-empty in `deploy/.env` (test length, do not print them). The ops skill names the file they are copied from. Paste them into the workstation `deploy/.env` and the remote `deploy/.env`, then `dc up -d bot api`. Stop if you cannot find the token without searching the whole disk.

## Nickname

The price-in-the-name ticker is not built. Do not rename the bot to a price by hand on a timer. SOP 04 is how the quote is reported.
