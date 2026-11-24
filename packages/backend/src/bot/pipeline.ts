import { randomBytes } from 'node:crypto';
import { createLogger } from '../lib/logger';
import { DomainError, isDomainError } from '../domain/errors';
import { ensureUser, linkStatus } from '../domain/identity';
import { PUBLIC_COMMANDS } from './commands';
import * as h from './handlers';
import { ephemeralResponder } from './respond';
import { TokenBucket } from './rate-limit';
import type { BotInteraction, Ctx, Responder } from './types';

const log = createLogger('bot');
const limiter = new TokenBucket();

type Handler = (i: BotInteraction, ctx: Ctx, r: Responder, args: string[]) => Promise<void>;

const SLASH: Record<string, Handler> = {
  'swap start': h.start,
  'swap help': h.help,
  'swap link-evm': h.linkEvm,
  'swap link-btq': h.linkBtq,
  'swap profile': h.profile,
  'swap notifications': h.notifications,
  'swap book': h.book,
  'swap buy': (i, c, r) => h.orderForm(i, c, r, 'buy'),
  'swap sell': (i, c, r) => h.orderForm(i, c, r, 'sell'),
  'swap take': h.takeForm,
  'swap orders': h.orders,
  'swap swaps': h.swaps,
  'swap status': (i, c, r) => h.status(i, c, r),
  'swap fund': (i, c, r) => h.fundOrClaim(i, c, r, 'fund'),
  'swap claim': (i, c, r) => h.fundOrClaim(i, c, r, 'claim'),
  'swap refund': (i, c, r) => h.fundOrClaim(i, c, r, 'refund'),
  'swap-admin status': h.adminStatus,
  'swap-admin lookup': h.adminLookup,
};

const COMPONENTS: Record<string, Handler> = {
  tos: h.acceptTerms,
  'evm-addr': h.evmAddressSubmitted,
  'evm-sig': h.evmSigButton,
  'evm-sigsubmit': h.evmSigSubmitted,
  'btq-key': h.btqKeyButton,
  'btq-keysubmit': h.btqKeySubmitted,
  order: h.orderSubmitted,
  take: h.takeSubmitted,
  cancel: h.cancel,
  refresh: (i, c, r, a) => h.status(i, c, r, a),
  hint: h.hintButton,
  hintsubmit: h.hintSubmitted,
};

export function commandPath(i: BotInteraction): string {
  if (i.isButton() || i.isModalSubmit()) {
    const [ns, action] = (i.customId ?? '').split(':');
    return `component:${ns}:${action}`;
  }
  const sub = i.options?.getSubcommand(false) ?? null;
  return [i.commandName, sub].filter(Boolean).join(' ');
}

export const FRIENDLY: Partial<Record<string, string>> = {
  RATE_LIMITED: 'You are doing that too often. Try again in a minute.',
  USER_BANNED: 'This account is not available.',
  FORBIDDEN: 'You do not have access to that.',
  NOT_REGISTERED: 'Run `/swap start` first.',
  CHAIN_UNAVAILABLE: 'A chain node is temporarily unavailable.',
};

export interface PipelineResult {
  correlationId: string;
  command: string;
  outcome: 'ok' | 'error';
  errorCode?: string;
}

export async function handleInteraction(i: BotInteraction): Promise<PipelineResult> {
  const correlationId = randomBytes(4).toString('hex');
  const command = commandPath(i);
  const r = ephemeralResponder(i);
  try {
    if (!limiter.take(i.user.id)) throw new DomainError('RATE_LIMITED', FRIENDLY.RATE_LIMITED!);
    const user = await ensureUser(i.user.id, i.user.username, { simulated: !!i.simulated });
    const ctx: Ctx = { correlationId, command, actor: { discordId: i.user.id, username: i.user.username, simulated: !!i.simulated, user } };
    if (user.is_banned) throw new DomainError('USER_BANNED', FRIENDLY.USER_BANNED!);
    if (!PUBLIC_COMMANDS.has(command) && !command.startsWith('swap-admin') && !linkStatus(user).tos) {
      throw new DomainError('TOS_REQUIRED', 'Accept the terms first with `/swap start`.');
    }

    if (command.startsWith('component:')) {
      const [ns, action, owner, ...args] = (i.customId ?? '').split(':');
      if (ns !== 'swap' || !action || !COMPONENTS[action]) throw new DomainError('NOT_FOUND', 'That button is no longer valid.');
      // Actor binding: a component created for user A can never act for user B.
      if (owner !== i.user.id) throw new DomainError('FORBIDDEN', 'That button belongs to someone else.');
      await COMPONENTS[action](i, ctx, r, args);
    } else {
      const handler = SLASH[command];
      if (!handler) throw new DomainError('NOT_FOUND', 'Unknown command.');
      await handler(i, ctx, r, []);
    }
    log.info('interaction', { correlationId, command, user: i.user.id, simulated: !!i.simulated });
    return { correlationId, command, outcome: 'ok' };
  } catch (err) {
    const domain = isDomainError(err);
    const content = domain ? (FRIENDLY[err.code] ?? err.message) : `Something went wrong. Reference: \`${correlationId}\``;
    if (!domain) log.error('interaction failed', { correlationId, command, err: (err as Error).stack ?? String(err) });
    try {
      await r.reply({ content: `⚠️ ${content}` });
    } catch {
      /* interaction already acknowledged with a modal or expired */
    }
    return { correlationId, command, outcome: 'error', errorCode: domain ? err.code : 'INTERNAL' };
  }
}
