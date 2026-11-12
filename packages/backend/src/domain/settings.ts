import { z } from 'zod';
import { db, many, one, type Queryable } from '../lib/db';
import { writeAudit } from './audit';

const decimal = z.string().regex(/^\d+(\.\d+)?$/);

export const SETTINGS_SCHEMA = {
  book_paused: z.boolean(),
  min_order_btq: decimal,
  max_order_btq: decimal,
  mm_max_notional_usdt: decimal,
  mm_max_order_btq: decimal,
  mm_min_spread_pct: decimal,
} as const;

export type SettingKey = keyof typeof SETTINGS_SCHEMA;
export type Settings = { [K in SettingKey]: z.infer<(typeof SETTINGS_SCHEMA)[K]> };

const DEFAULTS: Settings = {
  book_paused: false,
  min_order_btq: '0.1',
  max_order_btq: '1000',
  mm_max_notional_usdt: '100000',
  mm_max_order_btq: '500',
  mm_min_spread_pct: '0.5',
};

export async function getSettings(q: Queryable = db()): Promise<Settings> {
  const rows = await many<{ key: string; value: unknown }>(q, 'SELECT key, value FROM settings');
  const out = { ...DEFAULTS } as Record<string, unknown>;
  for (const r of rows) {
    const schema = SETTINGS_SCHEMA[r.key as SettingKey];
    if (!schema) continue;
    const parsed = schema.safeParse(r.value);
    if (parsed.success) out[r.key] = parsed.data;
  }
  return out as Settings;
}

export async function getSetting<K extends SettingKey>(key: K, q: Queryable = db()): Promise<Settings[K]> {
  const row = await one<{ value: unknown }>(q, 'SELECT value FROM settings WHERE key = $1', [key]);
  const parsed = SETTINGS_SCHEMA[key].safeParse(row?.value);
  return (parsed.success ? parsed.data : DEFAULTS[key]) as Settings[K];
}

export async function setSetting<K extends SettingKey>(key: K, value: unknown, actor: string, q: Queryable = db()): Promise<Settings[K]> {
  const parsed = SETTINGS_SCHEMA[key].parse(value) as Settings[K];
  await q.query(
    `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, JSON.stringify(parsed), actor],
  );
  await writeAudit(q, actor, 'settings.set', key, { value: parsed });
  return parsed;
}
