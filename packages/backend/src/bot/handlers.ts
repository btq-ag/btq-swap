import { config } from '../config';
import { btqChain } from '../chains/btq';
import { db, many, one } from '../lib/db';
import { getOrder, ordersForUser, placeOrder, publicBook, takeOrder, cancelOrder } from '../domain/book';
import { DomainError } from '../domain/errors';
import {
  acceptTos,
  assertCanTrade,
  finishBtqLink,
  finishEvmLink,
  getUserByDiscordId,
  isAdmin,
  linkStatus,
  setNotifications,
  startBtqLink,
  startEvmLink,
} from '../domain/identity';
import { cliUrl, instructionFor, timingSummary, usdtDisplay } from '../domain/instructions';
import { loadInventory } from '../domain/inventory';
import { fromUnits } from '../domain/money';
import { hintBtqLock, summaryLine, swapForUser, swapsForUser } from '../domain/settlement';
import { STATUS_LABEL, type UserRow } from '../domain/types';
import { bookEmbed, button, code, COLOR, modal, orderLine, priceLabel, row, swapEmbed, textInput, TOS_TEXT } from './render';
import type { BotInteraction, Ctx, Responder } from './types';

function requireUser(ctx: Ctx): UserRow {
  if (!ctx.actor.user) throw new DomainError('NOT_REGISTERED', 'Run `/swap start` first.');
  return ctx.actor.user;
}

function id(action: string, ctx: Ctx, arg?: string | number): string {
  return `swap:${action}:${ctx.actor.discordId}${arg !== undefined ? `:${arg}` : ''}`;
}

async function tip(): Promise<number | undefined> {
  return btqChain().tip().then((t) => t.height).catch(() => undefined);
}

// ───────────── onboarding ─────────────

export async function start(_i: BotInteraction, ctx: Ctx, r: Responder): Promise<void> {
  const u = ctx.actor.user;
  if (u && linkStatus(u).tos) {
    await r.reply({ embeds: [{ title: 'You are registered', description: 'Next: `/swap link-evm`, `/swap link-btq`, then `/swap book`.', color: COLOR.ok }] });
    return;
  }
  const exp = Math.floor(Date.now() / 1000) + 600;
  await r.reply({
    embeds: [{ title: 'Welcome to BTQ Swap', description: TOS_TEXT, color: COLOR.brand }],
    components: [row(button('Accept terms', `swap:tos:${ctx.actor.discordId}:${exp}`, 3))],
  });
}

export async function acceptTerms(_i: BotInteraction, ctx: Ctx, r: Responder, args: string[]): Promise<void> {
  const exp = Number(args[0] ?? '0');
  if (!exp || exp * 1000 < Date.now()) throw new DomainError('EXPIRED', 'That Accept button has expired. Run `/swap start` again.');
  const u = requireUser(ctx);
  await acceptTos(u.id);
  await r.reply({
    embeds: [{
      title: '✅ Terms accepted',
      description: `Next:\n1. \`/swap link-evm\` — prove your EVM wallet\n2. Download the swap tool: ${cliUrl()}\n3. \`/swap link-btq\` — prove your BTQ swap key`,
      color: COLOR.ok,
    }],
  });
}

export async function help(_i: BotInteraction, _ctx: Ctx, r: Responder): Promise<void> {
  await r.reply({
    embeds: [{
      title: 'BTQ Swap — how it works',
      color: COLOR.brand,
      description: [
        '**Atomic swap, nobody in the middle.** The buyer locks USDT in an EVM HTLC, the seller locks BTQ in a P2MR HTLC, the buyer claims the BTQ by revealing a secret, the seller uses that secret to claim the USDT. If anyone stops, both sides refund after their timelocks.',
        '',
        `**Tool:** \`curl -fsSLO ${cliUrl()}\` (Node ≥ 20). It keeps your swap key and secrets on your machine.`,
        '',
        '`/swap start` · `/swap link-evm` · `/swap link-btq` · `/swap profile`',
        '`/swap book` · `/swap buy` · `/swap sell` · `/swap take order:<n>` · `/swap orders`',
        '`/swap swaps` · `/swap status id:<n>` · `/swap fund id:<n>` · `/swap claim id:<n>` · `/swap refund id:<n>`',
        '`/swap notifications state:on|off`',
        '',
        `Timing: ${timingSummary()}`,
      ].join('\n'),
    }],
  });
}

export async function linkEvm(_i: BotInteraction, ctx: Ctx, r: Responder): Promise<void> {
  requireUser(ctx);
  await r.modal(modal(id('evm-addr', ctx), 'Link EVM wallet', [textInput('address', 'Your EVM address (0x…)', { min_length: 42, max_length: 42, placeholder: '0x…' })]));
}

export async function evmAddressSubmitted(i: BotInteraction, ctx: Ctx, r: Responder): Promise<void> {
  const u = requireUser(ctx);
  const { message, address } = await startEvmLink(u, i.fields!.getTextInputValue('address'));
  await r.reply({
    embeds: [{
      title: 'Sign this message with your wallet',
      color: COLOR.brand,
      description: `Sign the exact text below with \`${address}\` (MetaMask "personal_sign", or \`cast wallet sign\`), then press **Paste signature**. It expires in 15 minutes.\n` + '```\n' + message + '\n```',
    }],
    components: [row(button('Paste signature', id('evm-sig', ctx)))],
  });
}

export async function evmSigButton(_i: BotInteraction, ctx: Ctx, r: Responder): Promise<void> {
  await r.modal(modal(id('evm-sigsubmit', ctx), 'EVM wallet signature', [textInput('signature', 'Signature (0x…)', { min_length: 130, max_length: 200 })]));
}

export async function evmSigSubmitted(i: BotInteraction, ctx: Ctx, r: Responder): Promise<void> {
  const u = await finishEvmLink(requireUser(ctx), i.fields!.getTextInputValue('signature'));
  await r.reply({ embeds: [{ title: '✅ EVM wallet linked', description: `\`${u.eth_address}\``, color: COLOR.ok }] });
}

export async function linkBtq(_i: BotInteraction, ctx: Ctx, r: Responder): Promise<void> {
  const u = requireUser(ctx);
  const { challenge } = await startBtqLink(u);
  await r.reply({
    embeds: [{
      title: 'Link your BTQ swap key',
      color: COLOR.brand,
      description:
        'BTQ Core wallets cannot sign HTLC leaves, so swaps use a dedicated key kept by `btq-htlc` on your machine.\n' +
        code([`curl -fsSLO ${cliUrl()}`, 'node btq-htlc.mjs keygen', `node btq-htlc.mjs link ${challenge}`]) +
        '\nThen press **Submit key** and paste the `pubkey` and `signature`, plus the BTQ address where you want to receive coins.',
    }],
    components: [row(button('Submit key', id('btq-key', ctx)))],
  });
}

export async function btqKeyButton(_i: BotInteraction, ctx: Ctx, r: Responder): Promise<void> {
  await r.modal(
    modal(id('btq-keysubmit', ctx), 'BTQ swap key', [
      textInput('pubkey', 'pubkey (base64)', { style: 2, min_length: 1700, max_length: 4000 }),
      textInput('signature', 'signature (base64)', { style: 2, min_length: 3000, max_length: 4000 }),
      textInput('address', `BTQ receive address (${config().BTQ_NETWORK})`, { min_length: 20, max_length: 120 }),
    ]),
  );
}

export async function btqKeySubmitted(i: BotInteraction, ctx: Ctx, r: Responder): Promise<void> {
  const u = await finishBtqLink(requireUser(ctx), {
    pubkey: i.fields!.getTextInputValue('pubkey'),
    signature: i.fields!.getTextInputValue('signature'),
    btqAddress: i.fields!.getTextInputValue('address'),
  });
  await r.reply({ embeds: [{ title: '✅ BTQ swap key linked', description: `Receive address \`${u.btq_address}\`\nYou can trade now: \`/swap book\`.`, color: COLOR.ok }] });
}

export async function profile(_i: BotInteraction, ctx: Ctx, r: Responder): Promise<void> {
  const u = requireUser(ctx);
  const s = linkStatus(u);
  const counts = await one<{ total: string; done: string }>(db(), `SELECT COUNT(*)::text AS total, COUNT(*) FILTER (WHERE status = 'completed')::text AS done FROM swaps WHERE buyer_user_id = $1 OR seller_user_id = $1`, [u.id]);
  await r.reply({
    embeds: [{
      title: 'Your BTQ Swap profile',
      color: COLOR.brand,
      fields: [
        { name: 'Terms', value: s.tos ? '✅ accepted' : '❌ `/swap start`', inline: true },
        { name: 'EVM wallet', value: s.evm ? `✅ \`${u.eth_address}\`` : '❌ `/swap link-evm`', inline: false },
        { name: 'BTQ swap key', value: s.btq ? `✅ receive \`${u.btq_address}\`` : '❌ `/swap link-btq`', inline: false },
        { name: 'Swaps', value: `${counts?.done ?? 0} completed of ${counts?.total ?? 0} · no-shows ${u.no_show_count}`, inline: false },
        { name: 'DMs', value: u.notifications_enabled ? 'on' : 'off', inline: true },
      ],
    }],
  });
}

export async function notifications(i: BotInteraction, ctx: Ctx, r: Responder): Promise<void> {
  const on = i.options?.getString('state', true) === 'on';
  await setNotifications(requireUser(ctx).id, on);
  await r.reply(`Swap DMs are now **${on ? 'on' : 'off'}**.`);
}

// ───────────── trading ─────────────

export async function book(_i: BotInteraction, _ctx: Ctx, r: Responder): Promise<void> {
  await r.reply({ embeds: [bookEmbed(await publicBook(8))] });
}

export async function orderForm(_i: BotInteraction, ctx: Ctx, r: Responder, side: 'buy' | 'sell'): Promise<void> {
  assertCanTrade(requireUser(ctx));
  const b = await publicBook(1);
  const hint = side === 'buy' ? b.bestAsk : b.bestBid;
  await r.modal(
    modal(id('order', ctx, side), side === 'buy' ? 'Buy BTQ with USDT' : 'Sell BTQ for USDT', [
      textInput('amount', 'Amount of BTQ', { placeholder: '1.5', max_length: 20 }),
      textInput('price', `Price in USDT or "market" (best ${hint ? Number(hint).toString() : '—'})`, { value: 'market', max_length: 20 }),
    ]),
  );
}

export async function orderSubmitted(i: BotInteraction, ctx: Ctx, r: Responder, args: string[]): Promise<void> {
  const side = args[0] === 'sell' ? 'sell' : 'buy';
  const u = requireUser(ctx);
  const res = await placeOrder(u.id, { side, amountBtq: i.fields!.getTextInputValue('amount').trim(), price: i.fields!.getTextInputValue('price').trim() || 'market' });
  const lines = res.swaps.map((s) => `• Swap **#${s.short_id}** — ${s.amount_btq} BTQ ⇄ ${usdtDisplay(s)} USDT @ ${s.price_usdt}`);
  const first = res.swaps[0];
  const t = await tip();
  await r.reply({
    embeds: [
      {
        title: `Order #${res.order.short_id}: ${side} ${res.order.amount_btq} BTQ @ ${priceLabel(res.order.price_usdt)}`,
        color: res.swaps.length ? COLOR.ok : COLOR.brand,
        description: [
          res.swaps.length ? `Matched into ${res.swaps.length} swap(s):\n${lines.join('\n')}` : 'No match yet.',
          res.remainderCancelled ? 'Unfilled remainder cancelled (market order).' : res.order.status === 'filled' ? '' : `Remaining ${fromUnits(BigInt(Math.round((Number(res.order.amount_btq) - Number(res.order.filled_btq)) * 1e8)), 8)} BTQ rests on the book.`,
        ].filter(Boolean).join('\n'),
      },
      ...(first ? [swapEmbed(first, first.buyer_user_id === u.id ? 'buyer' : 'seller', t)] : []),
    ],
    components: first ? [row(button(`Refresh swap #${first.short_id}`, id('refresh', ctx, first.short_id), 2))] : [],
  });
}

export async function takeForm(i: BotInteraction, ctx: Ctx, r: Responder): Promise<void> {
  assertCanTrade(requireUser(ctx));
  const n = i.options?.getInteger('order', true);
  const o = await getOrder(String(n));
  if (!o || !['open', 'partially_filled'].includes(o.status)) throw new DomainError('NOT_FOUND', `Order #${n} is not on the book.`);
  const remaining = fromUnits(BigInt(Math.round((Number(o.amount_btq) - Number(o.filled_btq)) * 1e8)), 8);
  await r.modal(modal(id('take', ctx, o.short_id), `Take order #${o.short_id}`, [textInput('amount', `BTQ to ${o.side === 'sell' ? 'buy' : 'sell'} (max ${remaining})`, { value: remaining, max_length: 20 })]));
}

export async function takeSubmitted(i: BotInteraction, ctx: Ctx, r: Responder, args: string[]): Promise<void> {
  const o = await getOrder(args[0] ?? '');
  if (!o) throw new DomainError('NOT_FOUND', 'That order is gone.');
  const u = requireUser(ctx);
  if (o.user_id === u.id) throw new DomainError('VALIDATION', 'You cannot take your own order.');
  const res = await takeOrder(u.id, o.id, i.fields!.getTextInputValue('amount').trim());
  const t = await tip();
  const first = res.swaps[0];
  await r.reply({
    embeds: [
      { title: `Took order #${o.short_id}`, color: res.swaps.length ? COLOR.ok : COLOR.warn, description: res.swaps.length ? res.swaps.map((s) => `• Swap **#${s.short_id}** — ${s.amount_btq} BTQ ⇄ ${usdtDisplay(s)} USDT`).join('\n') : 'Nothing could be filled.' },
      ...(first ? [swapEmbed(first, first.buyer_user_id === u.id ? 'buyer' : 'seller', t)] : []),
    ],
  });
}

export async function orders(_i: BotInteraction, ctx: Ctx, r: Responder): Promise<void> {
  const u = requireUser(ctx);
  const list = await ordersForUser(u.id, { openOnly: true, limit: 10 });
  await r.reply({
    embeds: [{ title: 'Your open orders', color: COLOR.brand, description: list.length ? list.map(orderLine).join('\n') : 'None. `/swap buy` or `/swap sell` to place one.' }],
    components: list.slice(0, 5).map((o) => row(button(`Cancel #${o.short_id}`, id('cancel', ctx, o.short_id), 4))),
  });
}

export async function cancel(_i: BotInteraction, ctx: Ctx, r: Responder, args: string[]): Promise<void> {
  const o = await cancelOrder(requireUser(ctx).id, args[0] ?? '');
  await r.reply(`Order #${o.short_id} cancelled. Swaps that were already matched are not affected.`);
}

// ───────────── swaps ─────────────

export async function swaps(_i: BotInteraction, ctx: Ctx, r: Responder): Promise<void> {
  const u = requireUser(ctx);
  const list = await swapsForUser(u.id, { limit: 10 });
  const t = await tip();
  const lines = list.map((s) => {
    const role = s.buyer_user_id === u.id ? 'buyer' : 'seller';
    const ins = instructionFor(s, role, t);
    return `${ins.actionable ? '➡️' : '⏳'} ${summaryLine(s)}\n   ${role} · ${ins.headline}`;
  });
  await r.reply({ embeds: [{ title: 'Your swaps', color: COLOR.brand, description: lines.length ? lines.join('\n').slice(0, 4000) : 'No swaps yet.' }] });
}

export async function status(i: BotInteraction, ctx: Ctx, r: Responder, args: string[] = []): Promise<void> {
  const ref = args[0] ?? String(i.options?.getInteger('id', true));
  const { swap, role } = await swapForUser(requireUser(ctx).id, ref);
  const buttons = [button('Refresh', id('refresh', ctx, swap.short_id), 2)];
  if (role === 'seller' && swap.status === 'awaiting_seller_lock') buttons.push(button('I sent the BTQ', id('hint', ctx, swap.short_id), 1));
  await r.reply({ embeds: [swapEmbed(swap, role, await tip())], components: [row(...buttons)] });
}

export async function fundOrClaim(i: BotInteraction, ctx: Ctx, r: Responder, which: 'fund' | 'claim' | 'refund'): Promise<void> {
  const ref = String(i.options?.getInteger('id', true));
  const { swap, role } = await swapForUser(requireUser(ctx).id, ref);
  const ins = instructionFor(swap, role, await tip());
  const relevant =
    (which === 'fund' && ['awaiting_buyer_lock', 'awaiting_seller_lock'].includes(swap.status)) ||
    (which === 'claim' && ['awaiting_buyer_claim', 'awaiting_seller_claim'].includes(swap.status)) ||
    (which === 'refund' && ['awaiting_buyer_refund', 'awaiting_refunds'].includes(swap.status));
  if (!relevant || !ins.actionable) {
    await r.reply({ embeds: [{ title: `Swap #${swap.short_id}: nothing to ${which} right now`, description: `${STATUS_LABEL[swap.status]}\n${ins.headline}`, color: COLOR.muted }] });
    return;
  }
  const comps = role === 'seller' && swap.status === 'awaiting_seller_lock' ? [row(button('I sent the BTQ', id('hint', ctx, swap.short_id)))] : [];
  await r.reply({ embeds: [swapEmbed(swap, role, await tip())], components: comps });
}

export async function hintButton(_i: BotInteraction, ctx: Ctx, r: Responder, args: string[]): Promise<void> {
  await r.modal(modal(id('hintsubmit', ctx, args[0]), `Swap #${args[0]}: BTQ lock txid`, [textInput('txid', 'Transaction id from btq-cli', { min_length: 64, max_length: 64 })]));
}

export async function hintSubmitted(i: BotInteraction, ctx: Ctx, r: Responder, args: string[]): Promise<void> {
  const s = await hintBtqLock(requireUser(ctx).id, args[0] ?? '', i.fields!.getTextInputValue('txid'));
  await r.reply(`Thanks — checking that transaction for swap #${s.short_id}. You will get a DM when the lock is confirmed.`);
}

// ───────────── admin (read-only) ─────────────

async function requireAdmin(ctx: Ctx): Promise<void> {
  if (!(await isAdmin(ctx.actor.discordId, 'viewer'))) throw new DomainError('FORBIDDEN', 'You do not have access to this command.');
}

export async function adminStatus(_i: BotInteraction, ctx: Ctx, r: Responder): Promise<void> {
  await requireAdmin(ctx);
  const [b, inv, counts] = await Promise.all([
    publicBook(3),
    loadInventory(),
    many<{ status: string; n: string }>(db(), 'SELECT status, COUNT(*)::text AS n FROM swaps GROUP BY status ORDER BY status'),
  ]);
  const c = config();
  await r.reply({
    embeds: [{
      title: `BTQ Swap status${b.paused ? ' — BOOK PAUSED' : ''}`,
      color: b.paused ? COLOR.warn : COLOR.brand,
      fields: [
        { name: 'Best bid / ask', value: `${b.bestBid ?? '—'} / ${b.bestAsk ?? '—'}`, inline: true },
        { name: 'Inventory', value: inv ? `${fromUnits(inv.btqBalanceSats, 8)} BTQ · ${fromUnits(inv.usdtBalanceUnits, c.USDT_DECIMALS)} USDT\nin HTLCs: ${fromUnits(inv.btqInHtlcSats, 8)} BTQ · ${fromUnits(inv.usdtInHtlcUnits, c.USDT_DECIMALS)} USDT` : 'unknown', inline: false },
        { name: 'Swaps by state', value: counts.map((x) => `${x.status}: ${x.n}`).join('\n') || 'none', inline: false },
        { name: 'Snapshot age', value: inv ? `${Math.round((Date.now() - inv.at) / 1000)}s` : '—', inline: true },
      ],
      footer: { text: 'Read-only. Mutations live in the operator console.' },
    }],
  });
}

export async function adminLookup(i: BotInteraction, ctx: Ctx, r: Responder): Promise<void> {
  await requireAdmin(ctx);
  const target = i.options?.getUser('user', true);
  if (!target) throw new DomainError('VALIDATION', 'Pick a user.');
  const u = await getUserByDiscordId(target.id);
  if (!u) {
    await r.reply(`${target.username} has not used BTQ Swap.`);
    return;
  }
  const s = linkStatus(u);
  const list = await swapsForUser(u.id, { limit: 5 });
  await r.reply({
    embeds: [{
      title: `Lookup: ${u.discord_username}`,
      color: COLOR.brand,
      fields: [
        { name: 'Links', value: `ToS ${s.tos ? '✅' : '❌'} · EVM ${s.evm ? '✅' : '❌'} · BTQ ${s.btq ? '✅' : '❌'}`, inline: false },
        { name: 'Flags', value: `banned ${u.is_banned ? 'yes' : 'no'} · no-shows ${u.no_show_count}`, inline: false },
        { name: 'Recent swaps', value: list.map(summaryLine).join('\n') || 'none', inline: false },
      ],
    }],
  });
}
