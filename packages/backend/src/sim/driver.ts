import { handleInteraction, type PipelineResult } from '../bot/pipeline';
import type { BotInteraction, ModalPayload, ReplyPayload } from '../bot/types';
import type { Persona } from './personas';

export interface InteractionResult extends PipelineResult {
  replies: ReplyPayload[];
  modal: ModalPayload | null;
}

type Opt = string | number | { id: string; username: string };

/** A synthetic interaction implementing exactly the discord.js surface the bot uses. */
class SimInteraction implements BotInteraction {
  readonly simulated = true;
  replied = false;
  deferred = false;
  readonly replies: ReplyPayload[] = [];
  modalShown: ModalPayload | null = null;
  commandName?: string;
  customId?: string;
  options?: BotInteraction['options'];
  fields?: BotInteraction['fields'];

  constructor(
    readonly user: { id: string; username: string },
    private readonly kind: 'command' | 'button' | 'modal',
    init: { commandName?: string; sub?: string; opts?: Record<string, Opt>; customId?: string; fields?: Record<string, string> },
  ) {
    this.commandName = init.commandName;
    this.customId = init.customId;
    const opts = init.opts ?? {};
    if (kind === 'command') {
      this.options = {
        getSubcommand: () => init.sub ?? null,
        getSubcommandGroup: () => null,
        getString: (n) => (typeof opts[n] === 'string' ? (opts[n] as string) : null),
        getInteger: (n) => (typeof opts[n] === 'number' ? (opts[n] as number) : null),
        getUser: (n) => (typeof opts[n] === 'object' ? (opts[n] as { id: string; username: string }) : null),
      };
    }
    if (kind === 'modal') {
      const f = init.fields ?? {};
      this.fields = {
        getTextInputValue: (k) => {
          if (!(k in f)) throw new Error(`modal field ${k} missing`);
          return f[k]!;
        },
      };
    }
  }

  isChatInputCommand() { return this.kind === 'command'; }
  isButton() { return this.kind === 'button'; }
  isModalSubmit() { return this.kind === 'modal'; }
  async showModal(m: ModalPayload) { this.modalShown = m; this.replied = true; }
  async reply(o: ReplyPayload) { this.replies.push(o); this.replied = true; }
  async deferReply() { this.deferred = true; }
  async editReply(o: ReplyPayload) { this.replies.push(o); }
  async followUp(o: ReplyPayload) { this.replies.push(o); }
}

export interface TranscriptLine {
  at: string;
  persona: string;
  action: string;
  outcome: string;
  summary: string;
}

export function summarize(r: InteractionResult): string {
  if (r.modal) return `modal "${r.modal.title}" (${r.modal.components.map((c) => c.components[0].custom_id).join(', ')})`;
  const parts: string[] = [];
  for (const rep of r.replies) {
    if (rep.content) parts.push(rep.content);
    for (const e of rep.embeds ?? []) parts.push([e.title, (e.description ?? '').split('\n')[0]].filter(Boolean).join(' — '));
  }
  return parts.join(' | ').slice(0, 300);
}

export class Driver {
  readonly transcript: TranscriptLine[] = [];
  onLine?: (l: TranscriptLine) => void;

  private async run(p: Persona, action: string, i: SimInteraction): Promise<InteractionResult> {
    const res = await handleInteraction(i);
    const out: InteractionResult = { ...res, replies: i.replies, modal: i.modalShown };
    const line = { at: new Date().toISOString(), persona: p.name, action, outcome: res.outcome + (res.errorCode ? `:${res.errorCode}` : ''), summary: summarize(out) };
    this.transcript.push(line);
    this.onLine?.(line);
    return out;
  }

  slash(p: Persona, command: string, sub: string, opts: Record<string, Opt> = {}): Promise<InteractionResult> {
    const desc = `/${command} ${sub}${Object.keys(opts).length ? ' ' + Object.entries(opts).map(([k, v]) => `${k}:${typeof v === 'object' ? '@' + v.username : v}`).join(' ') : ''}`;
    return this.run(p, desc, new SimInteraction({ id: p.discordId, username: p.name }, 'command', { commandName: command, sub, opts }));
  }

  click(p: Persona, customId: string, label = customId): Promise<InteractionResult> {
    return this.run(p, `[${label}]`, new SimInteraction({ id: p.discordId, username: p.name }, 'button', { customId }));
  }

  submit(p: Persona, customId: string, fields: Record<string, string>, label = 'modal'): Promise<InteractionResult> {
    const shown = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.length > 24 ? `${v.slice(0, 10)}…(${v.length})` : v]));
    return this.run(p, `{${label}} ${JSON.stringify(shown)}`, new SimInteraction({ id: p.discordId, username: p.name }, 'modal', { customId, fields }));
  }
}

export function findButton(r: InteractionResult, match: (label: string, id: string) => boolean): string {
  for (const rep of r.replies) {
    for (const rowp of rep.components ?? []) {
      for (const b of rowp.components) if (b.custom_id && match(b.label, b.custom_id)) return b.custom_id;
    }
  }
  throw new Error(`button not found in reply: ${summarize(r)}`);
}

export function embedText(r: InteractionResult): string {
  return r.replies.flatMap((rep) => [rep.content ?? '', ...(rep.embeds ?? []).flatMap((e) => [e.title ?? '', e.description ?? '', ...(e.fields ?? []).map((f) => `${f.name}\n${f.value}`)])]).join('\n');
}

export function swapIdsFrom(r: InteractionResult): number[] {
  const ids = new Set<number>();
  for (const m of embedText(r).matchAll(/Swap \*{0,2}#(\d+)/g)) ids.add(Number(m[1]));
  return [...ids];
}

export function expectOk(r: InteractionResult, what: string): InteractionResult {
  if (r.outcome !== 'ok') throw new Error(`${what} failed: ${r.errorCode} — ${summarize(r)}`);
  return r;
}
