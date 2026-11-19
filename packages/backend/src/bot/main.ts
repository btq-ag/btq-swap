import { ActivityType, Client, Events, GatewayIntentBits, type Message } from 'discord.js';
import { config } from '../config';
import { createLogger } from '../lib/logger';
import { getSettings } from '../domain/settings';
import { resolveEvmAddresses } from '../domain/runtime';
import { shouldRemove, type GuardMessage } from './guard';
import { handleInteraction } from './pipeline';
import type { BotInteraction } from './types';

const log = createLogger('bot');

async function main(): Promise<void> {
  const c = config();
  if (!c.DISCORD_BOT_TOKEN || !c.DISCORD_GUILD_ID) throw new Error('DISCORD_BOT_TOKEN and DISCORD_GUILD_ID are required');
  await resolveEvmAddresses({ waitMs: c.DEVNET ? 10 * 60_000 : 0 });

  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

  const guard = (m: Message) => {
    if (!c.DISCORD_SWAP_CHANNEL_ID) return;
    const gm = m as unknown as GuardMessage;
    if (!shouldRemove(gm, { guildId: c.DISCORD_GUILD_ID!, channelId: c.DISCORD_SWAP_CHANNEL_ID, applicationId: client.application?.id ?? '' })) return;
    gm.delete().then(
      () => log.info('removed public message in swap channel', { author: m.author.id }),
      (err) => log.warn('could not remove message', { err: String(err) }),
    );
  };

  const presence = async () => {
    const s = await getSettings().catch(() => null);
    client.user?.setPresence({
      activities: [{ name: s?.book_paused ? 'Book paused' : 'Book live · /swap help', type: ActivityType.Watching }],
      status: s?.book_paused ? 'idle' : 'online',
    });
  };

  client.once(Events.ClientReady, async (ready) => {
    log.info('gateway ready', { user: ready.user.tag, id: ready.user.id });
    await presence();
    setInterval(() => void presence(), 60_000).unref();
  });
  client.on(Events.MessageCreate, guard);
  client.on(Events.InteractionCreate, (i) => {
    if (i.guildId !== c.DISCORD_GUILD_ID) return;
    if (!i.isChatInputCommand() && !i.isButton() && !i.isModalSubmit()) return;
    const name = i.isChatInputCommand() ? i.commandName : i.customId.split(':')[0];
    if (name !== 'swap' && name !== 'swap-admin') return;
    void handleInteraction(i as unknown as BotInteraction);
  });
  client.on(Events.ShardDisconnect, () => log.warn('gateway disconnected'));
  client.on(Events.ShardResume, () => log.info('gateway resumed'));

  const stop = () => {
    log.info('shutting down');
    void client.destroy();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  await client.login(c.DISCORD_BOT_TOKEN);
}

main().catch((err) => {
  console.error('[bot] fatal', err);
  process.exit(1);
});
