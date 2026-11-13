import type { Queryable } from '../lib/db';

export async function writeAudit(q: Queryable, actor: string, action: string, target: string | null, details: Record<string, unknown> = {}): Promise<void> {
  await q.query('INSERT INTO audit_log (actor, action, target, details) VALUES ($1, $2, $3, $4)', [
    actor,
    action,
    target,
    JSON.stringify(details, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
  ]);
}
