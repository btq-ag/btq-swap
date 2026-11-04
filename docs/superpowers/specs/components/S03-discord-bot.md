# S03 Discord bot

Part of [BTQ Swap production design](../2026-11-04-btq-swap-production-design.md). Clone Cash for Hash C14 (`apps/bot`).

## Purpose

The entire buyer-facing product, safe by construction.

## Process

- discord.js v14. Intents: `Guilds` + `GuildMessages` (no Message Content). `GuildMessages` only to delete public slash echoes.
- Guild-scoped command PUT (`/swap`, `/swap-admin`) via `npm run register`.
- Pipeline: `correlationId` → `resolveActor` (`interaction.user.id` only) → rate limit 20/min/user → `ensureRegistered` (except `start`, `help`) → `banCheck` → handler → **always ephemeral** → `errorBoundary` (unknown errors show correlation ID only).
- Channel guard (copy `command-channel-guard.ts`): designated `#btq-swap` is command-only; delete public echoes, replies, and non-moderator chat. Do not read message text.
- Bot **never** sends DMs. Worker outbox does.
- Presence: “Book live” / “Book paused”.

## Commands

See master spec table. Implementation notes:

- `book`: public price/size/side only. Buttons prev/next. **No** secret hashes, Dilithium, or addresses in the embed.
- `sell` / `buy` / `take` / `link-*`: **modals** for amounts and addresses.
- `fund` / `claim` / `refund`: ephemeral `btq-cli` blocks (strip `-regtest`; use `BTQ_NETWORK`) + EVM calldata / explorer link.
- Buttons `customId` include actor id **or** handlers authorize `(id, actor.userId)` so user B cannot take/cancel A's order.
- Defer if handler may exceed 2.5s (QR, RPC).

## Admin Discord

Read-only: `book status`, `lookup`. No `pause`, `post`, `ban`, `refund` in Discord.

## Tests (copy CFH QA first)

Port `c14-c21-security.spec-qa.test.ts` and `c14-c21-command-surface.spec-qa.test.ts`:

- Every reply ephemeral.
- Buyer command tree has no `User` option and no wallet slash options.
- Cross-user take/cancel via forged `customId` fails.
- Admin Discord cannot mutate.
- Rate limit 20/min.
- Channel guard deletes public slash echoes.
