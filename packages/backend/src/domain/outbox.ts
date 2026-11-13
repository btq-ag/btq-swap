import { config } from '../config';
import { one, type Queryable } from '../lib/db';

export type NotificationKind =
  | 'swap_matched'
  | 'action_required'
  | 'swap_completed'
  | 'swap_expired'
  | 'swap_refunded'
  | 'swap_failed'
  | 'info';

export interface NotificationInput {
  userId: string;
  swapId?: string | null;
  kind: NotificationKind;
  dedupeKey: string;
  payload: { title: string; body: string; swapShortId?: string | number; status?: string; commands?: string[] };
}

/**
 * Transactional outbox. Must be called with the same client as the state change.
 * Users with DMs off get `skipped`, simulated users get `simulated` (visible on the monitor),
 * platform user gets nothing.
 */
export async function enqueueNotification(q: Queryable, n: NotificationInput): Promise<void> {
  const user = await one<{ is_platform: boolean; is_simulated: boolean; notifications_enabled: boolean; discord_id: string | null }>(
    q,
    'SELECT is_platform, is_simulated, notifications_enabled, discord_id FROM users WHERE id = $1',
    [n.userId],
  );
  if (!user || user.is_platform) return;
  let status: 'queued' | 'skipped' | 'simulated' = 'queued';
  if (user.is_simulated) status = 'simulated';
  else if (!user.notifications_enabled || !config().DISCORD_ENABLE_DMS || !user.discord_id) status = 'skipped';
  await q.query(
    `INSERT INTO notifications (user_id, swap_id, kind, dedupe_key, payload, status)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (dedupe_key) DO NOTHING`,
    [n.userId, n.swapId ?? null, n.kind, n.dedupeKey, JSON.stringify(n.payload), status],
  );
}
