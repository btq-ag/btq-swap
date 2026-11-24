import { MessageType, PermissionFlagsBits } from 'discord.js';

/** Minimal message shape (works without the Message Content intent). */
export interface GuardMessage {
  guildId: string | null;
  channelId: string;
  type: number;
  system: boolean;
  pinned: boolean;
  author: { bot: boolean; id: string };
  member: { permissions: { has(flag: bigint): boolean } } | null;
  applicationId: string | null;
  delete(): Promise<unknown>;
}

/**
 * #btq-swap is command-only: delete public chatter, replies and leaked public slash echoes
 * from non-staff. Bot messages (our live feed) stay.
 */
export function shouldRemove(m: GuardMessage, ctx: { guildId: string; channelId: string; applicationId: string }): boolean {
  if (m.guildId !== ctx.guildId || m.channelId !== ctx.channelId) return false;
  if (m.system || m.pinned) return false;
  if (m.applicationId === ctx.applicationId && (m.type === MessageType.ChatInputCommand || m.type === MessageType.ContextMenuCommand)) return true;
  if (m.author.bot) return false;
  if (m.member?.permissions.has(PermissionFlagsBits.ManageMessages)) return false;
  return m.type === MessageType.Default || m.type === MessageType.Reply;
}
