import { useEffect, useState } from 'react';
import { getJson, type MonitorState, type SwapView } from '../api';
import { BookPanel, EventStream, InventoryPanel, NotificationPanel } from '../components/Side';
import { SwapCard } from '../components/SwapCard';
import { ago, trimAmount, useNow, usePoll } from '../hooks';

interface SwapSearch {
  swaps: SwapView[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

type Filter = 'active' | 'completed' | 'refunds' | 'all';
const FILTERS: Array<{ id: Filter; label: string; match: (s: SwapView) => boolean }> = [
  { id: 'active', label: 'In flight', match: (s) => s.tone === 'active' || ['awaiting_buyer_refund', 'awaiting_refunds'].includes(s.status) },
  { id: 'completed', label: 'Completed', match: (s) => s.status === 'completed' },
  { id: 'refunds', label: 'Refunded and expired', match: (s) => ['refunded', 'expired', 'failed'].includes(s.status) },
  { id: 'all', label: 'All', match: () => true },
];

function ChainPill({ name, color, detail, fresh }: { name: string; color: string; detail: string; fresh: boolean }) {
  return (
    <div className="flex items-center gap-2 rounded-full border border-ink-line bg-ink-2 px-3 py-1 text-sm">
      <span className={`h-2 w-2 rounded-full ${fresh ? 'bg-ok' : 'bg-bad'}`} aria-label={fresh ? 'watcher live' : 'watcher stale'} />
      <span className={`font-medium ${color}`}>{name}</span>
      <span className="tabular-nums text-fog-3">{detail}</span>
    </div>
  );
}

function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (n: number) => void }) {
  return (
    <div className="flex items-center justify-between text-sm text-fog-3">
      <button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)} className="rounded-md border border-ink-line px-3 py-1 disabled:opacity-40">Previous</button>
      <span className="tabular-nums">{page} / {pages}</span>
      <button type="button" disabled={page >= pages} onClick={() => onPage(page + 1)} className="rounded-md border border-ink-line px-3 py-1 disabled:opacity-40">Next</button>
    </div>
  );
}

export function MonitorPage() {
  const { data, error, at } = usePoll(() => getJson<MonitorState>('/public/monitor'), 2000);
  const now = useNow(1000);
  const [filter, setFilter] = useState<Filter>('active');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const list = usePoll(
    () => getJson<SwapSearch>(`/public/swaps?filter=${filter}&page=${page}&limit=8&q=${encodeURIComponent(query.trim())}`),
    2000,
    [filter, page, query],
  );
  useEffect(() => { setPage(1); }, [filter, query]);

  if (!data) {
    return (
      <main className="mx-auto max-w-7xl px-5 py-16 text-fog-3">
        {error ? <p className="text-bad">The swap API is not answering: {error}</p> : <p>Connecting to the settlement monitor…</p>}
      </main>
    );
  }
  const { chains, stats } = data;
  const solana = data.settlementRail === 'solana';
  const btqFresh = now - chains.btq.lastTickAt < 15_000;
  const evmFresh = now - chains.evm.lastTickAt < 15_000;
  const solFresh = !!chains.solana?.reachable && now - (chains.solana?.lastTickAt ?? 0) < 15_000;
  const swaps = list.data?.swaps ?? [];
  const pages = list.data?.pages ?? 1;
  const shownPage = list.data?.page ?? page;

  return (
    <main className="mx-auto max-w-7xl px-5 pb-16 pt-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-fog">Settlement</h1>
          <p className="mt-1 max-w-2xl text-sm text-fog-3">
            {solana ? 'USDT on Solana, BTQ in a Dilithium HTLC.' : 'USDT on the EVM chain, BTQ in a Dilithium HTLC.'} The buyer’s secret is what lets the seller collect.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <ChainPill name={`BTQ ${chains.btq.network}`} color="text-btq" detail={`height ${chains.btq.tip} · mempool ${chains.btq.mempool}`} fresh={btqFresh} />
          {solana ? (
            <ChainPill name="Solana" color="text-evm" detail={`slot ${chains.solana?.slot ?? '—'}`} fresh={solFresh} />
          ) : (
            <ChainPill name={`EVM ${chains.evm.chainId}`} color="text-evm" detail={`block ${chains.evm.head}`} fresh={evmFresh} />
          )}
        </div>
      </header>

      <section className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-ink-line bg-ink-line sm:grid-cols-3 lg:grid-cols-6" aria-label="Totals">
        {[
          ['In flight', String(stats.active), 'text-evm'],
          ['Completed', String(stats.completed), 'text-ok'],
          ['Refunded', String(stats.refunded), 'text-warn'],
          ['Expired', String(stats.expired), 'text-fog-2'],
          ['Settled volume', `${trimAmount(stats.volumeBtq, 2)} BTQ`, 'text-btq'],
          ['Average settle time', stats.avgCompletionSec ? `${stats.avgCompletionSec}s` : '—', 'text-fog'],
        ].map(([label, value, tone]) => (
          <div key={label} className="bg-ink-2 px-4 py-3">
            <div className="text-xs text-fog-3">{label}</div>
            <div className={`mt-0.5 text-xl font-semibold tabular-nums ${tone}`}>{value}</div>
          </div>
        ))}
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <section aria-labelledby="swaps-h">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="swaps-h" className="text-sm font-semibold text-fog">Swaps</h2>
            <div role="tablist" className="flex gap-1 rounded-lg border border-ink-line bg-ink-2 p-1">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  role="tab"
                  aria-selected={filter === f.id}
                  onClick={() => setFilter(f.id)}
                  className={`rounded-md px-3 py-1 text-sm ${filter === f.id ? 'bg-ink-3 text-fog' : 'text-fog-3 hover:text-fog-2'}`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
          <form className="mt-3" onSubmit={(e) => e.preventDefault()}>
            <label className="block text-sm text-fog-3">
              Find a transaction
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Swap number, Solana signature, BTQ txid, or agreement id"
                className="mt-1 w-full rounded-lg border border-ink-line bg-ink px-3 py-2 text-fog"
              />
            </label>
          </form>
          <div className="mt-3 space-y-3">
            {list.error && <p className="text-sm text-bad">{list.error}</p>}
            {swaps.length === 0 && (
              <div className="panel p-6 text-sm text-fog-3">
                {query.trim() ? 'No transaction matches that.' : filter === 'active' ? 'No swap is in flight.' : 'Nothing here yet.'}
              </div>
            )}
            {swaps.map((s) => <SwapCard key={s.id} swap={s} chains={chains} now={now} />)}
          </div>
          <div className="mt-3">
            <Pager page={shownPage} pages={pages} onPage={setPage} />
          </div>
          {list.data && <p className="mt-2 text-xs text-fog-4">{list.data.total} matching swaps</p>}
        </section>
        <aside className="space-y-6">
          <BookPanel book={data.book} />
          <InventoryPanel inv={data.inventory} />
          <EventStream events={data.events} now={now} />
          <NotificationPanel items={data.notifications} now={now} />
        </aside>
      </div>
      <footer className="mt-10 flex flex-wrap justify-between gap-2 text-xs text-fog-4">
        <span>
          Timelocks: buyer window {data.timing.buyerLockWindowSec}s · {solana ? 'Solana' : 'USDT'} lock {data.timing.evmLockDurationSec}s · BTQ lock {data.timing.btqLockBlocks} blocks · seller budget {data.timing.sellerBudgetSec}s
        </span>
        <span>{error ? <span className="text-bad">last refresh failed: {error}</span> : `updated ${ago(at, now)}`}</span>
      </footer>
    </main>
  );
}
