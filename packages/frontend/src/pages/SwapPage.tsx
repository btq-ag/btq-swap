import { Link, useParams } from 'react-router-dom';
import { getJson, type MonitorState, type SwapDetail } from '../api';
import { Braid } from '../components/Braid';
import { Clocks, StatusChip } from '../components/SwapCard';
import { ago, trimAmount, useNow, usePoll } from '../hooks';

function Row({ label, value, mono = true, tone }: { label: string; value: string | number | null | undefined; mono?: boolean; tone?: string }) {
  return (
    <div className="grid grid-cols-[150px_minmax(0,1fr)] gap-3 py-1.5">
      <dt className="text-sm text-fog-3">{label}</dt>
      <dd className={`${mono ? 'hash' : 'text-sm'} break-all ${tone ?? 'text-fog-2'}`}>{value ?? '—'}</dd>
    </div>
  );
}

export function SwapPage() {
  const { id } = useParams();
  const now = useNow(1000);
  const detail = usePoll(() => getJson<SwapDetail>(`/public/swaps/${id}`), 2000, [id]);
  const mon = usePoll(() => getJson<MonitorState>('/public/monitor'), 5000);
  const d = detail.data;
  if (!d) return <main className="mx-auto max-w-5xl px-5 py-16 text-fog-3">{detail.error ? <p className="text-bad">{detail.error}</p> : 'Loading swap…'}</main>;
  const s = d.swap;
  return (
    <main className="mx-auto max-w-5xl px-5 pb-16 pt-6">
      <Link to="/" className="text-sm text-fog-3 hover:text-fog">← All swaps</Link>
      <header className="mt-3 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-2xl font-semibold text-fog">
          Swap #{s.shortId}: <span className="text-btq">{trimAmount(s.amountBtq, 8)} BTQ</span> <span className="text-fog-4">⇄</span> <span className="text-evm">{trimAmount(s.amountUsdt, 6)} USDT</span>
        </h1>
        <StatusChip swap={s} />
      </header>
      <p className="mt-1 text-sm text-fog-3">
        {s.buyer.label} pays USDT and receives BTQ · {s.seller.label} pays BTQ and receives USDT · price {s.price} · opened {ago(s.createdAt, now)}
        {s.durationSec !== null && ` · settled in ${s.durationSec}s`}
      </p>

      <section className="panel mt-5 p-5">
        <Braid swap={s} />
        {mon.data && <div className="mt-2"><Clocks swap={s} chains={mon.data.chains} now={now} /></div>}
      </section>

      <div className="mt-5 grid gap-5 md:grid-cols-2">
        <section className="panel p-5" aria-labelledby="evm-h">
          <h2 id="evm-h" className="font-semibold text-evm">USDT leg · EVM chain {s.evm.chainId}</h2>
          <dl className="mt-2">
            <Row label="HTLC contract" value={s.evm.contract} />
            <Row label="Agreement id" value={s.evm.agreementId} />
            <Row label="Lock tx" value={s.evm.lockTx} />
            <Row label="Confirmations" value={s.evm.lockConfs} mono={false} />
            <Row label="Deadline" value={s.evm.deadline ? new Date(s.evm.deadline).toLocaleString() : null} mono={false} />
            <Row label="Claim tx" value={s.evm.claimTx} tone="text-ok" />
            <Row label="Refund tx" value={s.evm.refundTx} tone="text-warn" />
          </dl>
        </section>
        <section className="panel p-5" aria-labelledby="btq-h">
          <h2 id="btq-h" className="font-semibold text-btq">BTQ leg · {s.btq.network} P2MR</h2>
          <dl className="mt-2">
            <Row label="HTLC address" value={s.btq.htlcAddress} />
            <Row label="Refund height" value={s.btq.refundLocktime} mono={false} />
            <Row label="Lock outpoint" value={s.btq.lockTxid ? `${s.btq.lockTxid}:${s.btq.lockVout}` : null} />
            <Row label="Confirmations" value={s.btq.lockConfs} mono={false} />
            <Row label="Claim tx" value={s.btq.claimTxid} tone="text-ok" />
            <Row label="Refund tx" value={s.btq.refundTxid} tone="text-warn" />
          </dl>
        </section>
      </div>

      <section className="panel mt-5 p-5" aria-labelledby="sec-h">
        <h2 id="sec-h" className="font-semibold text-key">Secret</h2>
        <dl className="mt-2">
          <Row label="SHA-256 (locked)" value={s.secretHash} />
          <Row label="Preimage (revealed)" value={s.preimage ?? 'not revealed yet — only the buyer knows it'} tone={s.preimage ? 'text-key' : 'text-fog-4'} />
        </dl>
      </section>

      <section className="panel mt-5 p-5" aria-labelledby="tl-h">
        <h2 id="tl-h" className="font-semibold text-fog">Timeline</h2>
        <ol className="mt-3 space-y-2">
          {d.events.map((e) => (
            <li key={e.id} className="grid grid-cols-[90px_minmax(0,1fr)] gap-3 text-sm">
              <span className="tabular-nums text-fog-4">{new Date(e.created_at).toLocaleTimeString()}</span>
              <div>
                <span className="text-fog-2">{e.event_type.replace(/_/g, ' ')}</span>
                {e.to_status && <span className="text-fog-4"> → {e.to_status.replace(/_/g, ' ')}</span>}
                <span className="text-fog-4"> · {e.actor}</span>
                {Object.keys(e.metadata ?? {}).length > 0 && <pre className="hash mt-0.5 whitespace-pre-wrap break-all text-fog-4">{JSON.stringify(e.metadata)}</pre>}
              </div>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
