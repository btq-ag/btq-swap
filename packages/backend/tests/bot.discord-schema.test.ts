/**
 * Every modal, button and embed the bot can send must pass discord.js's own validators
 * (the simulator's synthetic interactions do not enforce Discord's limits).
 */
import { ActionRowBuilder, ButtonBuilder, EmbedBuilder, ModalBuilder, TextInputBuilder } from 'discord.js';
import { describe, expect, it, vi, beforeAll } from 'vitest';

beforeAll(() => {
  Object.assign(process.env, {
    DATABASE_URL: 'postgres://x:y@127.0.0.1:1/z', ADMIN_TOKEN: 'a'.repeat(24), SESSION_SECRET: 's'.repeat(32),
    BTQ_RPC_URL: 'http://127.0.0.1:1', BTQ_RPC_USER: 'u', BTQ_RPC_PASS: 'p', PLATFORM_HTLC_SEED: '11'.repeat(32), PLATFORM_SECRET_KEY: '22'.repeat(32),
    EVM_RPC_URL: 'http://127.0.0.1:2', EVM_CHAIN_ID: '31337', EVM_PRIVATE_KEY: '0x' + '33'.repeat(32), BTQ_NETWORK: 'regtest',
    SWAP_EVM_LOCK_DURATION_SEC: '420', SWAP_SELLER_LOCK_WINDOW_SEC: '120', SWAP_BTQ_LOCK_BLOCKS: '24', BTQ_TARGET_BLOCK_SEC: '5', SWAP_SAFETY_MARGIN_SEC: '120', SWAP_EVM_LOCK_MAX_DURATION_SEC: '3600',
  });
});

vi.mock('../src/chains/btq', () => ({ btqChain: () => ({ tip: async () => ({ height: 100, hash: 'h', time: 0 }) }), btqCliNetworkFlag: () => '-regtest ' }));
vi.mock('../src/domain/book', async (orig) => ({
  ...(await orig<typeof import('../src/domain/book')>()),
  publicBook: async () => ({ bids: [], asks: [], topBids: [], topAsks: [], bestBid: '2.450000', bestAsk: '2.550000', paused: false }),
  getOrder: async () => ({ id: 'o', short_id: '12', side: 'sell', price_usdt: '2.550000', amount_btq: '100.00000000', filled_btq: '0', status: 'open' }),
}));
vi.mock('../src/domain/settings', async (orig) => ({
  ...(await orig<typeof import('../src/domain/settings')>()),
  getSettings: async () => ({
    book_paused: false, min_order_btq: '0.1', max_order_btq: '1000', mm_max_notional_usdt: '100000',
    mm_max_order_btq: '500', mm_min_spread_pct: '0.5', settlement_rail: 'evm',
  }),
}));
vi.mock('../src/domain/identity', async (orig) => ({
  ...(await orig<typeof import('../src/domain/identity')>()),
  assertCanTrade: () => undefined,
  startBtqLink: async () => ({ challengeId: '11c54482-4cad-405d-b89c-0d553f79d002', challenge: 'btq-swap:123456789012345678:abcdef0123456789abcd', expiresAt: new Date() }),
  startEvmLink: async () => ({ challengeId: '11c54482-4cad-405d-b89c-0d553f79d002', message: 'x'.repeat(400), address: '0x' + '1'.repeat(40), expiresAt: new Date() }),
  finishEvmLink: vi.fn(async () => ({ eth_address: '0x' + '1'.repeat(40) })),
  finishBtqLink: vi.fn(async () => ({ btq_address: 'qcrt1example' })),
}));

import * as h from '../src/bot/handlers';
import { finishEvmLink, finishBtqLink } from '../src/domain/identity';
import type { ModalPayload, ReplyPayload, Responder } from '../src/bot/types';

function capture() {
  const out: { modals: ModalPayload[]; replies: ReplyPayload[] } = { modals: [], replies: [] };
  const r: Responder = {
    reply: async (p) => { out.replies.push(typeof p === 'string' ? { content: p } : p); },
    defer: async () => undefined,
    modal: async (m) => { out.modals.push(m); },
  };
  return { out, r };
}

const ctx = { correlationId: 'c', command: 'x', actor: { discordId: '123456789012345678', username: 'tester', simulated: false, user: { id: 'u1', discord_id: '123456789012345678', is_banned: false, tos_accepted_at: new Date(), tos_version: '2026-11-12' } as never } };
const i = { user: { id: ctx.actor.discordId, username: 'tester' }, options: { getInteger: () => 12, getString: () => 'on', getSubcommand: () => null, getSubcommandGroup: () => null, getUser: () => null }, fields: { getTextInputValue: () => '' } } as never;

/** Rebuild through setters: discord.js only enforces Discord's limits in setters, not in constructors. */
export function strictModal(m: ModalPayload): unknown {
  const b = new ModalBuilder().setCustomId(m.custom_id).setTitle(m.title);
  for (const row of m.components) {
    const t = row.components[0];
    const ti = new TextInputBuilder().setCustomId(t.custom_id).setLabel(t.label).setStyle(t.style).setRequired(t.required ?? true);
    if (t.min_length !== undefined) ti.setMinLength(t.min_length);
    if (t.max_length !== undefined) ti.setMaxLength(t.max_length);
    if (t.value !== undefined) ti.setValue(t.value);
    if (t.placeholder !== undefined) ti.setPlaceholder(t.placeholder);
    b.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(ti));
  }
  return b.toJSON();
}

function strictReply(rep: ReplyPayload): void {
  for (const e of rep.embeds ?? []) {
    const eb = new EmbedBuilder();
    if (e.title) eb.setTitle(e.title);
    if (e.description) eb.setDescription(e.description);
    if (e.fields?.length) eb.addFields(...e.fields.map((f) => ({ name: f.name, value: f.value, inline: f.inline })));
    if (e.footer) eb.setFooter(e.footer);
    eb.toJSON();
  }
  for (const row of rep.components ?? []) {
    new ActionRowBuilder<ButtonBuilder>().addComponents(...row.components.map((c) => new ButtonBuilder().setCustomId(c.custom_id!).setLabel(c.label).setStyle(c.style))).toJSON();
  }
}

function validate(out: { modals: ModalPayload[]; replies: ReplyPayload[] }) {
  for (const m of out.modals) expect(() => strictModal(m)).not.toThrow();
  for (const rep of out.replies) {
    expect(() => strictReply(rep)).not.toThrow();
    const total = (rep.embeds ?? []).reduce((n, e) => n + (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.fields ?? []).reduce((k, f) => k + f.name.length + f.value.length, 0), 0);
    expect(total).toBeLessThanOrEqual(6000);
  }
}

describe('Discord payload limits', () => {
  it.each(['evm', 'btq'])('carries the %s challenge through button, modal and completion', async kind => {
    const { out, r } = capture();
    await (kind === 'evm' ? h.evmAddressSubmitted : h.linkBtq)(i, ctx, r);
    const buttonId = out.replies[0]!.components![0]!.components[0]!.custom_id!;
    const challenge = buttonId.split(':').slice(3);
    expect(challenge).toEqual(['11c54482-4cad-405d-b89c-0d553f79d002']);
    await (kind === 'evm' ? h.evmSigButton : h.btqKeyButton)(i, ctx, r, challenge);
    const modalArgs = out.modals[0]!.custom_id.split(':').slice(3);
    await (kind === 'evm' ? h.evmSigSubmitted : h.btqKeySubmitted)(i, ctx, r, modalArgs);
    if (kind === 'evm') expect(finishEvmLink).toHaveBeenCalledWith(ctx.actor.user, '', challenge[0]);
    else expect(finishBtqLink).toHaveBeenCalledWith(ctx.actor.user, expect.objectContaining({ challengeId: challenge[0] }));
    validate(out);
  });
  it.each([
    ['link-evm', h.linkEvm], ['evm-sig button', h.evmSigButton], ['btq-key button', h.btqKeyButton],
    ['buy form', (a: never, b: never, c: Responder) => h.orderForm(a, b, c, 'buy')], ['sell form', (a: never, b: never, c: Responder) => h.orderForm(a, b, c, 'sell')],
    ['take form', h.takeForm], ['hint button', (a: never, b: never, c: Responder) => h.hintButton(a, b, c, ['12'])],
  ])('modal %s passes discord.js validation', async (_n, fn) => {
    const { out, r } = capture();
    await (fn as (a: never, b: never, c: Responder, d: string[]) => Promise<void>)(i, ctx as never, r, []);
    expect(out.modals.length).toBe(1);
    validate(out);
  });

  it.each([['start', h.start], ['help', h.help], ['link-btq', h.linkBtq]])('reply %s passes discord.js validation', async (_n, fn) => {
    const { out, r } = capture();
    await (fn as (a: never, b: never, c: Responder) => Promise<void>)(i, { ...ctx, actor: { ...ctx.actor, user: { ...ctx.actor.user, tos_accepted_at: null } } } as never, r);
    validate(out);
  });

  it('the strict validator really rejects an over-long label (guards this suite)', () => {
    const bad: ModalPayload = { custom_id: 'x', title: 't', components: [{ type: 1, components: [{ type: 4, custom_id: 'p', label: 'L'.repeat(48), style: 1 }] }] };
    expect(() => strictModal(bad)).toThrow();
  });

  it('every custom_id stays within 100 characters', () => {
    expect(`swap:hintsubmit:${'9'.repeat(19)}:${'9'.repeat(12)}`.length).toBeLessThanOrEqual(100);
    expect(`swap:tos:${'9'.repeat(19)}:${'9'.repeat(10)}`.length).toBeLessThanOrEqual(100);
  });
});
