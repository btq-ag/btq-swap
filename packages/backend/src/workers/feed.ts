import { config, feedChannelId } from '../config';
import { DiscordRest } from '../discord/rest';
import { sha256Hex } from '../lib/crypto';
import { db, many, one } from '../lib/db';
import { createLogger } from '../lib/logger';
import { usdtDisplay } from '../domain/instructions';
import { partyLabel, protocolSteps, short, statusTone } from '../domain/present';
import { STATUS_LABEL, type SwapRow, type UserRow } from '../domain/types';
import { btqStatus } from './btq-watcher';

const log = createLogger('feed');
const COLORS = { active: 0x3b82f6, success: 0x10b981, warning: 0xf59e0b, danger: 0xef4444 } as const;
const ICON = { done: '🟢', active: '🔵', pending: '⚪', skipped: '⚫', failed: '🔴' } as const;

export function renderSwapEmbed(s: SwapRow, buyer: UserRow | null, seller: UserRow | null, tip: number): Record<string, unknown> {
  const steps = protocolSteps(s);
  const progress = steps.map((x) => `${ICON[x.state]} ${x.label}`).join('\n');
  const usdt = usdtDisplay(s);
  const deadline = s.evm_deadline ? `<t:${Math.floor(s.evm_deadline.getTime() / 1000)}:R>` : '—';
  const fields = [
    { name: 'Buyer (pays USDT)', value: partyLabel(buyer), inline: true },
    { name: 'Seller (pays BTQ)', value: partyLabel(seller), inline: true },
    { name: 'Status', value: STATUS_LABEL[s.status], inline: true },
    {
      name: 'USDT leg · EVM HTLC',
      value: [
        `lock \`${short(s.evm_lock_tx, 10)}\``,
        `agreement \`${short(s.evm_agreement_id, 10)}\``,
        `deadline ${deadline}`,
        s.evm_claim_tx ? `claimed \`${short(s.evm_claim_tx, 10)}\`` : s.evm_refund_tx ? `refunded \`${short(s.evm_refund_tx, 10)}\`` : '',
      ].filter(Boolean).join('\n').slice(0, 1024),
      inline: false,
    },
    {
      name: 'BTQ leg · P2MR HTLC',
      value: [
        `address \`${short(s.btq_htlc_address, 12)}\``,
        `lock \`${s.btq_lock_txid ? `${short(s.btq_lock_txid, 10)}:${s.btq_lock_vout}` : '—'}\``,
        `refund height ${s.btq_refund_locktime ?? '—'} (tip ${tip})`,
        s.btq_claim_txid ? `claimed \`${short(s.btq_claim_txid, 10)}\`` : s.btq_refund_txid ? `refunded \`${short(s.btq_refund_txid, 10)}\`` : '',
      ].filter(Boolean).join('\n').slice(0, 1024),
      inline: false,
    },
    {
      name: 'Secret',
      value: s.revealed_preimage ? `revealed \`${short(s.revealed_preimage, 12)}\`` : s.secret_hash ? `hash \`${short(s.secret_hash, 12)}\`` : 'not set yet',
      inline: false,
    },
  ];
  return {
    title: `Swap #${s.short_id} · ${s.amount_btq} BTQ ⇄ ${usdt} USDT @ ${s.price_usdt}`,
    description: progress,
    color: COLORS[statusTone(s.status)],
    fields,
    footer: { text: `BTQ ${s.btq_network} · EVM chain ${s.evm_chain_id} · HTLC atomic swap` },
    timestamp: new Date(s.updated_at).toISOString(),
  };
}

let rest: DiscordRest | null = null;

export async function feedTick(): Promise<number> {
  const c = config();
  const channel = feedChannelId(c);
  if (!c.DISCORD_BOT_TOKEN || !c.DISCORD_ENABLE_FEED || !channel) return 0;
  rest ??= new DiscordRest(c.DISCORD_BOT_TOKEN);
  const rows = await many<SwapRow & { fm_message_id: string | null; fm_hash: string | null }>(
    db(),
    `SELECT s.*, fm.message_id AS fm_message_id, fm.rendered_hash AS fm_hash
       FROM swaps s LEFT JOIN feed_messages fm ON fm.swap_id = s.id
      WHERE s.updated_at > now() - interval '6 hours' OR fm.swap_id IS NULL
      ORDER BY s.created_at ASC LIMIT 200`,
  );
  let changes = 0;
  for (const s of rows) {
    if (changes >= 8) break; // stay well under channel rate limits; the rest catch up next tick
    const [buyer, seller] = await Promise.all([
      one<UserRow>(db(), 'SELECT * FROM users WHERE id = $1', [s.buyer_user_id]),
      one<UserRow>(db(), 'SELECT * FROM users WHERE id = $1', [s.seller_user_id]),
    ]);
    const embed = renderSwapEmbed(s, buyer, seller, btqStatus.tip);
    const { timestamp: _ts, ...stable } = embed;
    const hash = sha256Hex(JSON.stringify({ ...stable, fields: (stable.fields as Array<{ name: string; value: string }>).map((f) => ({ ...f, value: f.value.replace(/\(tip \d+\)/, '') })) }));
    if (s.fm_hash === hash) continue;
    try {
      if (!s.fm_message_id) {
        const id = await rest.postMessage(channel, { embeds: [embed], allowed_mentions: { parse: [] } });
        await db().query(
          `INSERT INTO feed_messages (swap_id, channel_id, message_id, rendered_hash) VALUES ($1, $2, $3, $4)
           ON CONFLICT (swap_id) DO UPDATE SET message_id = EXCLUDED.message_id, rendered_hash = EXCLUDED.rendered_hash, updated_at = now()`,
          [s.id, channel, id, hash],
        );
      } else {
        await rest.editMessage(channel, s.fm_message_id, { embeds: [embed] });
        await db().query('UPDATE feed_messages SET rendered_hash = $2, updated_at = now() WHERE swap_id = $1', [s.id, hash]);
      }
      changes++;
    } catch (err) {
      log.warn('feed update failed', { swap: s.short_id, err: (err as Error).message });
      break;
    }
  }
  return changes;
}
