import type { UserRow } from '../domain/types';

/** The subset of the discord.js interaction surface the bot uses (also implemented by the simulator). */
export interface BotInteraction {
  id?: string;
  user: { id: string; username: string };
  guildId?: string | null;
  channelId?: string | null;
  replied: boolean;
  deferred: boolean;
  commandName?: string;
  customId?: string;
  options?: {
    getSubcommand(required?: boolean): string | null;
    getSubcommandGroup(required?: boolean): string | null;
    getString(name: string, required?: boolean): string | null;
    getInteger(name: string, required?: boolean): number | null;
    getUser(name: string, required?: boolean): { id: string; username: string } | null;
  };
  fields?: { getTextInputValue(customId: string): string };
  isChatInputCommand(): boolean;
  isButton(): boolean;
  isModalSubmit(): boolean;
  showModal(modal: ModalPayload): Promise<unknown>;
  reply(options: ReplyPayload): Promise<unknown>;
  deferReply(options?: { ephemeral?: boolean; flags?: number }): Promise<unknown>;
  editReply(options: ReplyPayload): Promise<unknown>;
  followUp(options: ReplyPayload): Promise<unknown>;
  /** Set by the simulator; real Discord interactions never carry it. */
  readonly simulated?: boolean;
}

export interface EmbedPayload {
  title?: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
  timestamp?: string;
}

export interface ButtonPayload {
  type: 2;
  style: 1 | 2 | 3 | 4 | 5;
  label: string;
  custom_id?: string;
  url?: string;
  disabled?: boolean;
}

export interface RowPayload {
  type: 1;
  components: ButtonPayload[];
}

export interface ReplyPayload {
  content?: string;
  embeds?: EmbedPayload[];
  components?: RowPayload[];
  flags?: number;
  ephemeral?: boolean;
  allowedMentions?: { parse: string[] };
}

export interface TextInputPayload {
  type: 4;
  custom_id: string;
  label: string;
  style: 1 | 2;
  required?: boolean;
  min_length?: number;
  max_length?: number;
  value?: string;
  placeholder?: string;
}

export interface ModalPayload {
  custom_id: string;
  title: string;
  components: Array<{ type: 1; components: [TextInputPayload] }>;
}

export interface Actor {
  discordId: string;
  username: string;
  simulated: boolean;
  user: UserRow | null;
}

export interface Ctx {
  correlationId: string;
  command: string;
  actor: Actor;
}

export interface Responder {
  reply(payload: ReplyPayload | string): Promise<void>;
  defer(): Promise<void>;
  modal(m: ModalPayload): Promise<void>;
}
