import type { BotInteraction, ModalPayload, ReplyPayload, Responder } from './types';

export const EPHEMERAL = 1 << 6;

function asPayload(p: ReplyPayload | string): ReplyPayload {
  return typeof p === 'string' ? { content: p } : { ...p };
}

/**
 * Every reply from this bot is ephemeral (S03). Handlers must use this responder,
 * never the raw interaction.
 */
export function ephemeralResponder(i: BotInteraction): Responder {
  const withFlags = (p: ReplyPayload | string): ReplyPayload => ({ ...asPayload(p), flags: EPHEMERAL, allowedMentions: { parse: [] } });
  return {
    async reply(p) {
      const body = withFlags(p);
      if (i.deferred || i.replied) await i.editReply(body);
      else await i.reply(body);
    },
    async defer() {
      if (!i.deferred && !i.replied) await i.deferReply({ flags: EPHEMERAL });
    },
    async modal(m: ModalPayload) {
      await i.showModal(m);
    },
  };
}
