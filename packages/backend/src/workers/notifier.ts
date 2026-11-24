import { config } from '../config';
import { DiscordApiError, DiscordRest } from '../discord/rest';
import { db, many } from '../lib/db';
import { createLogger } from '../lib/logger';

const log = createLogger('notifier');
const BACKOFF_SEC = [30, 120, 600];
const BRAND = 0x3b82f6;

interface Row {
  id: string;
  user_id: string;
  kind: string;
  payload: { title: string; body: string; commands?: string[] };
  attempts: number;
  discord_id: string;
}

export function renderDm(p: Row['payload']): unknown {
  const cmd = p.commands?.length ? '\n```sh\n' + p.commands.join('\n') + '\n```' : '';
  return {
    embeds: [{ title: p.title.slice(0, 250), description: (p.body + cmd).slice(0, 4000), color: BRAND, footer: { text: 'BTQ Swap · reply with /swap in the server' } }],
    allowed_mentions: { parse: [] },
  };
}

let rest: DiscordRest | null = null;

export async function notifierTick(): Promise<number> {
  const c = config();
  if (!c.DISCORD_BOT_TOKEN || !c.DISCORD_ENABLE_DMS) return 0;
  rest ??= new DiscordRest(c.DISCORD_BOT_TOKEN);
  const due = await many<Row>(
    db(),
    `SELECT n.id, n.user_id, n.kind, n.payload, n.attempts, u.discord_id
       FROM notifications n JOIN users u ON u.id = n.user_id
      WHERE n.status = 'queued' AND n.next_attempt_at <= now() AND u.discord_id IS NOT NULL
      ORDER BY n.id LIMIT 20`,
  );
  let sent = 0;
  for (const n of due) {
    try {
      await rest.dm(n.discord_id, renderDm(n.payload));
      await db().query(`UPDATE notifications SET status = 'sent', sent_at = now(), attempts = attempts + 1 WHERE id = $1`, [n.id]);
      sent++;
    } catch (err) {
      const code = err instanceof DiscordApiError ? err.code : undefined;
      const permanent = code === 50007 || code === 10013; // cannot DM user / unknown user
      const attempts = n.attempts + 1;
      if (permanent || attempts > BACKOFF_SEC.length) {
        await db().query(`UPDATE notifications SET status = 'failed', attempts = $2, last_error = $3 WHERE id = $1`, [n.id, attempts, (err as Error).message.slice(0, 500)]);
        log.warn('DM failed permanently', { id: n.id, code });
      } else {
        await db().query(
          `UPDATE notifications SET attempts = $2, last_error = $3, next_attempt_at = now() + ($4::text || ' seconds')::interval WHERE id = $1`,
          [n.id, attempts, (err as Error).message.slice(0, 500), String(BACKOFF_SEC[attempts - 1])],
        );
      }
    }
  }
  return sent;
}
