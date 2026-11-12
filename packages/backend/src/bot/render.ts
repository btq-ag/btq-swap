import { config } from '../config';
import { cliUrl, instructionFor, usdtDisplay } from '../domain/instructions';
import { protocolSteps, short } from '../domain/present';
import type { PublicBook } from '../domain/book';
import { STATUS_LABEL, type OrderRow, type Role, type SwapRow } from '../domain/types';
import { MARKET_BUY_PRICE, MARKET_SELL_PRICE } from '../domain/book';
import type { ButtonPayload, EmbedPayload, ModalPayload, RowPayload, TextInputPayload } from './types';

export const COLOR = { brand: 0x3b82f6, ok: 0x10b981, warn: 0xf59e0b, bad: 0xef4444, muted: 0x64748b } as const;
const ICON = { done: '🟢', active: '🔵', pending: '⚪', skipped: '⚫', failed: '🔴' } as const;

export function button(label: string, customId: string, style: ButtonPayload['style'] = 1): ButtonPayload {
  return { type: 2, style, label, custom_id: customId };
}

export function row(...b: ButtonPayload[]): RowPayload {
  return { type: 1, components: b };
}

export function textInput(customId: string, label: string, opts: Partial<TextInputPayload> = {}): { type: 1; components: [TextInputPayload] } {
  return { type: 1, components: [{ type: 4, custom_id: customId, label, style: 1, required: true, ...opts }] };
}

export function modal(customId: string, title: string, inputs: Array<{ type: 1; components: [TextInputPayload] }>): ModalPayload {
  return { custom_id: customId, title: title.slice(0, 45), components: inputs };
}

export function code(lines: string[]): string {
  return lines.length ? '```sh\n' + lines.join('\n') + '\n```' : '';
}

export function priceLabel(p: string): string {
  return p === MARKET_BUY_PRICE || p === MARKET_SELL_PRICE ? 'market' : p;
}

export function bookEmbed(b: PublicBook): EmbedPayload {
  const fmt = (os: PublicBook['topAsks']) =>
    os.length ? os.map((o) => `\`#${String(o.orderNo).padEnd(5)}\` \`${o.price.padStart(10)}\`  ${o.remainingBtq} BTQ${o.mm ? '  · MM' : ''}`).join('\n') : '_empty_';
  const spread = b.bestAsk && b.bestBid ? (Number(b.bestAsk) - Number(b.bestBid)).toFixed(6) : '—';
  return {
    title: `BTQ/USDT order book${b.paused ? ' — PAUSED' : ''}`,
    color: b.paused ? COLOR.warn : COLOR.brand,
    fields: [
      { name: 'Asks — sellers of BTQ', value: fmt([...b.topAsks].reverse()).slice(0, 1024), inline: false },
      { name: 'Bids — buyers of BTQ', value: fmt(b.topBids).slice(0, 1024), inline: false },
      { name: 'Spread', value: spread, inline: true },
      { name: 'How to trade', value: '`/swap buy` · `/swap sell` · `/swap take order:<n>`', inline: true },
    ],
    footer: { text: 'Orders are intents; funds move only inside HTLCs after a match.' },
  };
}

export function orderLine(o: OrderRow): string {
  return `#${o.short_id} ${o.side.toUpperCase()} ${o.amount_btq} BTQ @ ${priceLabel(o.price_usdt)} · filled ${o.filled_btq} · ${o.status}`;
}

export function swapEmbed(s: SwapRow, role: Role, tipHeight?: number): EmbedPayload {
  const ins = instructionFor(s, role, tipHeight);
  const steps = protocolSteps(s).map((x) => `${ICON[x.state]} ${x.label}`).join('\n');
  const fields: EmbedPayload['fields'] = [
    { name: 'You are', value: role === 'buyer' ? 'Buyer — you pay USDT, receive BTQ' : 'Seller — you pay BTQ, receive USDT', inline: false },
    { name: 'Status', value: STATUS_LABEL[s.status], inline: true },
    { name: 'Price', value: `${s.price_usdt} USDT/BTQ`, inline: true },
    { name: ins.actionable ? '➡️ Your move' : 'Next', value: `${ins.headline}\n${ins.detail}`.slice(0, 1024), inline: false },
  ];
  if (ins.commands.length) fields.push({ name: 'Commands', value: code(ins.commands).slice(0, 1024), inline: false });
  fields.push({
    name: 'On-chain',
    value: [
      `USDT lock \`${short(s.evm_lock_tx, 10)}\` · agreement \`${short(s.evm_agreement_id, 10)}\``,
      `BTQ HTLC \`${short(s.btq_htlc_address, 12)}\` · lock \`${short(s.btq_lock_txid, 10)}\` · refund height ${s.btq_refund_locktime ?? '—'}`,
      s.revealed_preimage ? `secret revealed \`${short(s.revealed_preimage, 10)}\`` : `secret hash \`${short(s.secret_hash, 10)}\``,
    ].join('\n').slice(0, 1024),
    inline: false,
  });
  return {
    title: `Swap #${s.short_id} · ${s.amount_btq} BTQ ⇄ ${usdtDisplay(s)} USDT`,
    description: steps,
    color: s.status === 'completed' ? COLOR.ok : ['failed'].includes(s.status) ? COLOR.bad : ['expired', 'refunded', 'awaiting_refunds', 'awaiting_buyer_refund'].includes(s.status) ? COLOR.warn : COLOR.brand,
    fields,
    footer: { text: `${config().BTQ_NETWORK} · chain ${s.evm_chain_id} · tool: ${cliUrl()}` },
  };
}

export const TOS_TEXT = [
  '**BTQ Swap — terms (test network)**',
  '• Swaps are peer-to-peer hash time-locked contracts. BTQ Swap never holds your funds or your secret.',
  '• You run the `btq-htlc` tool and your own wallets. Lost keys or secrets cannot be recovered by anyone.',
  '• Each step has a deadline. Missing your claim window can lose funds; refunds are always available after the timelock.',
  '• This deployment runs on BTQ **regtest** and a local EVM test chain. Coins have no value.',
  '• Abuse (no-shows, spam) leads to a ban. Commands and replies are private to you.',
].join('\n');
