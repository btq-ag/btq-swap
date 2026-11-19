/** Register /swap and /swap-admin for ONE guild (never global). */
import { config } from '../config';
import { DiscordRest } from '../discord/rest';
import { commandPayloads } from './commands';

export async function registerGuildCommands(): Promise<Array<{ id: string; name: string }>> {
  const c = config();
  if (!c.DISCORD_BOT_TOKEN || !c.DISCORD_CLIENT_ID || !c.DISCORD_GUILD_ID) {
    throw new Error('DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID and DISCORD_GUILD_ID are required');
  }
  const rest = new DiscordRest(c.DISCORD_BOT_TOKEN);
  return rest.request('PUT', `/applications/${c.DISCORD_CLIENT_ID}/guilds/${c.DISCORD_GUILD_ID}/commands`, commandPayloads());
}

if (require.main === module) {
  registerGuildCommands()
    .then((r) => console.log('registered', r.map((x) => `/${x.name} (${x.id})`).join(', ')))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
