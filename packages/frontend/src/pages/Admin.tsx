import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { adminFetch, getJson } from '../api';

interface Overview {
  settings: Record<string, string | boolean>;
  inventory: Record<string, string> | null;
  swapCounts: Record<string, number>;
}
interface Order { id: string; short_id: string; side: string; price_usdt: string; amount_btq: string; filled_btq: string; status: string; created_at: string }
interface User { id: string; discord_id: string | null; discord_username: string | null; eth_address: string | null; is_banned: boolean; is_simulated: boolean; is_platform: boolean; no_show_count: number }
interface Audit { id: string; actor: string; action: string; target: string | null; created_at: string }

function Login({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await getJson('/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
      onDone();
    } catch (x) {
      setErr((x as Error).message);
    }
  };
  return (
    <form onSubmit={submit} className="panel mx-auto mt-16 max-w-md space-y-4 p-6">
      <h1 className="text-xl font-semibold text-fog">Operator console</h1>
      <p className="text-sm text-fog-3">Enter the operator token from the server's <code className="hash">.env</code> (ADMIN_TOKEN). The session lives in an HttpOnly cookie for 12 hours.</p>
      <label className="block text-sm text-fog-2">
        Operator token
        <input type="password" value={token} onChange={(e) => setToken(e.target.value)} className="mt-1 w-full rounded-lg border border-ink-line bg-ink px-3 py-2 text-fog" autoFocus />
      </label>
      {err && <p className="text-sm text-bad">{err}</p>}
      <button className="rounded-lg bg-btq px-4 py-2 font-medium text-ink">Sign in</button>
    </form>
  );
}

export function AdminPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [ov, setOv] = useState<Overview | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [form, setForm] = useState({ side: 'sell', price: '2.55', amountBtq: '50' });

  const load = useCallback(async () => {
    const [o, mm, u, a] = await Promise.all([
      adminFetch<Overview>('/overview'),
      adminFetch<{ orders: Order[] }>('/mm/orders'),
      adminFetch<{ users: User[] }>('/users'),
      adminFetch<{ entries: Audit[] }>('/audit'),
    ]);
    setOv(o);
    setOrders(mm.orders);
    setUsers(u.users);
    setAudit(a.entries);
  }, []);

  useEffect(() => {
    getJson<{ admin: boolean }>('/admin/me').then((r) => setAuthed(r.admin)).catch(() => setAuthed(false));
  }, []);
  useEffect(() => {
    if (authed) void load().catch((e) => setMsg((e as Error).message));
  }, [authed, load]);

  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      setMsg(done);
      await load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  if (authed === null) return null;
  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  const paused = ov?.settings.book_paused === true;
  const rail = ov?.settings.settlement_rail === 'solana' ? 'solana' : 'evm';

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-5 pb-16 pt-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-fog">Operator console</h1>
        <div className="flex items-center gap-3">
          {msg && <span className="text-sm text-fog-2">{msg}</span>}
          <div className="flex rounded-lg border border-ink-line p-0.5" role="group" aria-label="Settlement rail">
            {(['evm', 'solana'] as const).map((item) => (
              <button
                key={item}
                type="button"
                aria-pressed={rail === item}
                onClick={() => { if (rail !== item) void act(() => adminFetch('/settings', 'POST', { key: 'settlement_rail', value: item }), item === 'solana' ? 'Solana rail' : 'EVM rail'); }}
                className={`rounded-md px-3 py-1.5 text-sm font-medium ${rail === item ? 'bg-btq text-ink' : 'text-fog-3'}`}
              >
                {item === 'evm' ? 'EVM' : 'Solana'}
              </button>
            ))}
          </div>
          <button
            onClick={() => act(() => adminFetch('/settings', 'POST', { key: 'book_paused', value: !paused }), paused ? 'Book resumed' : 'Book paused')}
            className={`rounded-lg px-4 py-2 text-sm font-medium ${paused ? 'bg-ok text-ink' : 'bg-warn text-ink'}`}
          >
            {paused ? 'Resume book' : 'Pause book'}
          </button>
          <button onClick={() => act(() => adminFetch('/logout', 'POST'), 'Signed out').then(() => setAuthed(false))} className="rounded-lg border border-ink-line px-3 py-2 text-sm text-fog-3">Sign out</button>
        </div>
      </header>

      <section className="grid gap-4 md:grid-cols-3">
        <div className="panel p-4">
          <h2 className="text-sm font-semibold text-fog">Inventory</h2>
          <dl className="mt-2 grid grid-cols-2 gap-1 text-sm">
            {Object.entries(ov?.inventory ?? {}).map(([k, v]) => (
              <div key={k} className="contents"><dt className="text-fog-3">{k}</dt><dd className="text-right tabular-nums text-fog-2">{v}</dd></div>
            ))}
          </dl>
        </div>
        <div className="panel p-4">
          <h2 className="text-sm font-semibold text-fog">Swaps by state</h2>
          <dl className="mt-2 grid grid-cols-2 gap-1 text-sm">
            {Object.entries(ov?.swapCounts ?? {}).map(([k, v]) => (
              <div key={k} className="contents"><dt className="text-fog-3">{k.replace(/_/g, ' ')}</dt><dd className="text-right tabular-nums text-fog-2">{v}</dd></div>
            ))}
          </dl>
        </div>
        <div className="panel p-4">
          <h2 className="text-sm font-semibold text-fog">Risk caps</h2>
          <dl className="mt-2 grid grid-cols-2 gap-1 text-sm">
            {Object.entries(ov?.settings ?? {}).map(([k, v]) => (
              <div key={k} className="contents"><dt className="text-fog-3">{k.replace(/_/g, ' ')}</dt><dd className="text-right tabular-nums text-fog-2">{String(v)}</dd></div>
            ))}
          </dl>
        </div>
      </section>

      <section className="panel p-4">
        <h2 className="text-sm font-semibold text-fog">Market-maker orders</h2>
        <form
          className="mt-3 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void act(() => adminFetch('/mm/orders', 'POST', form), `Posted ${form.side} ${form.amountBtq} @ ${form.price}`);
          }}
        >
          <label className="text-sm text-fog-3">Side
            <select value={form.side} onChange={(e) => setForm({ ...form, side: e.target.value })} className="mt-1 block rounded-lg border border-ink-line bg-ink px-2 py-1.5 text-fog">
              <option value="sell">Sell BTQ (ask)</option>
              <option value="buy">Buy BTQ (bid)</option>
            </select>
          </label>
          <label className="text-sm text-fog-3">Price USDT<input value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} className="mt-1 block w-28 rounded-lg border border-ink-line bg-ink px-2 py-1.5 text-fog" /></label>
          <label className="text-sm text-fog-3">Amount BTQ<input value={form.amountBtq} onChange={(e) => setForm({ ...form, amountBtq: e.target.value })} className="mt-1 block w-28 rounded-lg border border-ink-line bg-ink px-2 py-1.5 text-fog" /></label>
          <button className="rounded-lg bg-btq px-4 py-2 text-sm font-medium text-ink">Post order</button>
        </form>
        <table className="mt-4 w-full text-sm">
          <thead className="text-left text-fog-3"><tr><th className="py-1">#</th><th>Side</th><th>Price</th><th>Amount</th><th>Filled</th><th>Status</th><th /></tr></thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id} className="border-t border-ink-line">
                <td className="py-1.5 tabular-nums text-fog-4">{o.short_id}</td>
                <td className={o.side === 'sell' ? 'text-btq' : 'text-evm'}>{o.side}</td>
                <td className="tabular-nums">{o.price_usdt}</td>
                <td className="tabular-nums">{o.amount_btq}</td>
                <td className="tabular-nums">{o.filled_btq}</td>
                <td className="text-fog-3">{o.status}</td>
                <td className="space-x-2 text-right">
                  {['open', 'partially_filled'].includes(o.status) && <button onClick={() => act(() => adminFetch(`/mm/orders/${o.short_id}/pause`, 'POST'), `Paused #${o.short_id}`)} className="text-warn">Pause</button>}
                  {o.status === 'paused' && <button onClick={() => act(() => adminFetch(`/mm/orders/${o.short_id}/resume`, 'POST'), `Resumed #${o.short_id}`)} className="text-ok">Resume</button>}
                  {['open', 'partially_filled', 'paused'].includes(o.status) && (
                    <>
                      <button onClick={() => { const p = prompt(`New price for #${o.short_id}`, o.price_usdt); if (p) void act(() => adminFetch(`/mm/orders/${o.short_id}/reprice`, 'POST', { price: p }), `Repriced #${o.short_id}`); }} className="text-evm">Reprice</button>
                      <button onClick={() => { if (confirm(`Cancel MM order #${o.short_id}?`)) void act(() => adminFetch(`/mm/orders/${o.short_id}/cancel`, 'POST'), `Cancelled #${o.short_id}`); }} className="text-bad">Cancel</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel p-4">
        <h2 className="text-sm font-semibold text-fog">Users</h2>
        <table className="mt-3 w-full text-sm">
          <thead className="text-left text-fog-3"><tr><th className="py-1">Discord</th><th>EVM</th><th>No-shows</th><th>Flags</th><th /></tr></thead>
          <tbody>
            {users.filter((u) => !u.is_platform).map((u) => (
              <tr key={u.id} className="border-t border-ink-line">
                <td className="py-1.5">{u.discord_username} <span className="hash text-fog-4">{u.discord_id}</span></td>
                <td className="hash text-fog-3">{u.eth_address ?? '—'}</td>
                <td className="tabular-nums">{u.no_show_count}</td>
                <td className="text-fog-3">{[u.is_simulated && 'sim', u.is_banned && 'banned'].filter(Boolean).join(', ') || '—'}</td>
                <td className="text-right">
                  <button onClick={() => act(() => adminFetch(`/users/${u.id}/ban`, 'POST', { banned: !u.is_banned }), u.is_banned ? 'Unbanned' : 'Banned')} className={u.is_banned ? 'text-ok' : 'text-bad'}>{u.is_banned ? 'Unban' : 'Ban'}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel p-4">
        <h2 className="text-sm font-semibold text-fog">Audit log</h2>
        <ul className="mt-3 max-h-72 space-y-1 overflow-y-auto text-sm">
          {audit.map((a) => (
            <li key={a.id} className="flex gap-3"><span className="w-44 shrink-0 tabular-nums text-fog-4">{new Date(a.created_at).toLocaleString()}</span><span className="text-fog-2">{a.action}</span><span className="text-fog-4">{a.actor}</span></li>
          ))}
        </ul>
      </section>
    </main>
  );
}
