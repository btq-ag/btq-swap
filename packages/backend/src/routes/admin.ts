import { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config';
import { hmacHex, safeEqual } from '../lib/crypto';
import { db, many } from '../lib/db';
import { writeAudit } from '../domain/audit';
import { cancelMmOrder, mmOrders, postMmOrder, repriceMmOrder, setMmOrderPaused } from '../domain/book';
import { setBanned } from '../domain/identity';
import { loadInventory, refreshInventory } from '../domain/inventory';
import { fromUnits } from '../domain/money';
import { swapView } from '../domain/monitor';
import { getSettings, setSetting, SETTINGS_SCHEMA, type SettingKey } from '../domain/settings';
import { getSwap, swapEvents } from '../domain/settlement';
import type { SwapRow } from '../domain/types';

export const adminRoutes = Router();
const COOKIE = 'btq_admin';
const SESSION_TTL_MS = 12 * 3600 * 1000;

function sign(exp: number): string {
  return `${exp}.${hmacHex(config().SESSION_SECRET, `admin:${exp}`)}`;
}

function sessionValid(raw: string | undefined): boolean {
  if (!raw) return false;
  const [expStr, mac] = raw.split('.');
  const exp = Number(expStr);
  if (!exp || exp < Date.now() || !mac) return false;
  return safeEqual(mac, hmacHex(config().SESSION_SECRET, `admin:${exp}`));
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie ?? '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!sessionValid(readCookie(req, COOKIE))) {
    res.status(401).json({ error: 'admin login required' });
    return;
  }
  if (req.method !== 'GET' && req.header('x-btq-request') !== '1') {
    res.status(403).json({ error: 'missing X-BTQ-Request header' });
    return;
  }
  next();
}

const loginLimiter = rateLimit({ windowMs: 15 * 60_000, max: 20, standardHeaders: true, legacyHeaders: false });

adminRoutes.post('/login', loginLimiter, (req, res) => {
  const token = String(req.body?.token ?? '');
  if (!safeEqual(token, config().ADMIN_TOKEN)) {
    res.status(401).json({ error: 'invalid token' });
    return;
  }
  const exp = Date.now() + SESSION_TTL_MS;
  const secure = config().PUBLIC_BASE_URL.startsWith('https://') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(sign(exp))}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=${SESSION_TTL_MS / 1000}${secure}`);
  void writeAudit(db(), 'admin', 'admin.login', null, { ip: req.ip });
  res.json({ ok: true, expiresAt: new Date(exp).toISOString() });
});

adminRoutes.post('/logout', (_req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=0`);
  res.json({ ok: true });
});

adminRoutes.get('/me', (req, res) => {
  res.json({ admin: sessionValid(readCookie(req, COOKIE)) });
});

adminRoutes.use(requireAdmin);

const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

adminRoutes.get('/overview', wrap(async (_req, res) => {
  const inv = (await loadInventory()) ?? (await refreshInventory().catch(() => null));
  const counts = await many<{ status: string; n: string }>(db(), 'SELECT status, COUNT(*)::text AS n FROM swaps GROUP BY status');
  res.json({
    settings: await getSettings(),
    inventory: inv && {
      btq: fromUnits(inv.btqBalanceSats, 8),
      btqCommitted: fromUnits(inv.btqCommittedSats, 8),
      btqInHtlc: fromUnits(inv.btqInHtlcSats, 8),
      usdt: fromUnits(inv.usdtBalanceUnits, config().USDT_DECIMALS),
      usdtCommitted: fromUnits(inv.usdtCommittedUnits, config().USDT_DECIMALS),
      usdtInHtlc: fromUnits(inv.usdtInHtlcUnits, config().USDT_DECIMALS),
      openAsks: fromUnits(inv.openAskSats, 8),
      openBids: fromUnits(inv.openBidUnits, config().USDT_DECIMALS),
      eth: fromUnits(inv.ethBalanceWei, 18),
    },
    swapCounts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
  });
}));

adminRoutes.get('/mm/orders', wrap(async (_req, res) => {
  res.json({ orders: await mmOrders() });
}));

const postSchema = z.object({ side: z.enum(['buy', 'sell']), price: z.string(), amountBtq: z.string() });
adminRoutes.post('/mm/orders', wrap(async (req, res) => {
  const body = postSchema.parse(req.body);
  await refreshInventory();
  const r = await postMmOrder(body, 'admin:web');
  res.status(201).json({ order: r.order, swaps: r.swaps.length });
}));

adminRoutes.post('/mm/orders/:ref/:action', wrap(async (req, res) => {
  const ref = String(req.params.ref);
  const action = String(req.params.action);
  if (action === 'pause') res.json({ order: await setMmOrderPaused(ref, true, 'admin:web') });
  else if (action === 'resume') res.json({ order: await setMmOrderPaused(ref, false, 'admin:web') });
  else if (action === 'cancel') res.json({ order: await cancelMmOrder(ref, 'admin:web') });
  else if (action === 'reprice') res.json({ order: await repriceMmOrder(ref, z.string().parse(req.body?.price), 'admin:web') });
  else res.status(404).json({ error: 'unknown action' });
}));

adminRoutes.post('/settings', wrap(async (req, res) => {
  const key = z.string().parse(req.body?.key) as SettingKey;
  if (!(key in SETTINGS_SCHEMA)) {
    res.status(400).json({ error: 'unknown setting' });
    return;
  }
  res.json({ key, value: await setSetting(key, req.body?.value, 'admin:web') });
}));

adminRoutes.get('/users', wrap(async (_req, res) => {
  res.json({
    users: await many(
      db(),
      `SELECT id, discord_id, discord_username, eth_address, btq_address, is_banned, is_simulated, is_platform, no_show_count,
              tos_accepted_at, eth_verified_at, btq_pubkey_verified_at, created_at FROM users ORDER BY created_at DESC LIMIT 200`,
    ),
  });
}));

adminRoutes.post('/users/:id/ban', wrap(async (req, res) => {
  const banned = z.boolean().parse(req.body?.banned);
  res.json({ user: await setBanned(String(req.params.id), banned, 'admin:web') });
}));

adminRoutes.get('/swaps', wrap(async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const rows = await many<SwapRow>(db(), `SELECT * FROM swaps ${status ? 'WHERE status = $1' : ''} ORDER BY created_at DESC LIMIT 200`, status ? [status] : []);
  const ids = [...new Set(rows.flatMap((s) => [s.buyer_user_id, s.seller_user_id]))];
  const parties = new Map((await many<{ id: string; is_platform: boolean; is_simulated: boolean; discord_username: string | null; discord_id: string | null }>(db(), 'SELECT id, is_platform, is_simulated, discord_username, discord_id FROM users WHERE id = ANY($1)', [ids])).map((u) => [u.id, u]));
  res.json({ swaps: rows.map((s) => swapView(s, parties)) });
}));

adminRoutes.get('/swaps/:ref', wrap(async (req, res) => {
  const s = await getSwap(String(req.params.ref));
  if (!s) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const { platform_secret_enc: _hidden, ...safe } = s;
  res.json({ swap: safe, events: await swapEvents(s.id, 500) });
}));

adminRoutes.post('/swaps/:ref/note', wrap(async (req, res) => {
  const note = z.string().min(1).max(2000).parse(req.body?.note);
  const s = await getSwap(String(req.params.ref));
  if (!s) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  await db().query(`UPDATE swaps SET admin_notes = COALESCE(admin_notes || E'\\n', '') || $2, updated_at = now() WHERE id = $1`, [s.id, note]);
  await writeAudit(db(), 'admin:web', 'swap.note', s.id, { note });
  res.json({ ok: true });
}));

adminRoutes.get('/audit', wrap(async (_req, res) => {
  res.json({ entries: await many(db(), 'SELECT * FROM audit_log ORDER BY id DESC LIMIT 200') });
}));
