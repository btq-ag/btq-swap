import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { getJson, type MonitorState, type SwapDetail, type SwapView } from '../api';
import { CandleChart, type Candle } from '../components/trade/CandleChart';
import { OrderBook, type BookRow } from '../components/trade/OrderBook';
import { WalletConnector } from '../components/trade/WalletConnector';
import { useNow, usePoll } from '../hooks';
import { btqProvider, connectBtq } from '../lib/btqWallet';
import { deskApi, deskToken, type DeskProfile, type LockPlan } from '../lib/deskApi';
import { chainId, sendTx, switchChain, walletError } from '../lib/evmWallet';
import { base64ToBytes, bytesToBase64, signSolanaTransaction } from '../lib/walletConnector';
import { btqText, hex, priceText, quoteUsdt, shortAddr, spreadBps, toUnits } from '../lib/format';
import { approveCalldata, lockCalldata, refundCalldata, withdrawCalldata } from '../lib/htlcTx';
import { Transaction } from '@solana/web3.js';

type Side = 'buy' | 'sell';

function secretKey(id: number): string {
  return `btq-secret-${id}`;
}

async function createSecret(): Promise<{ preimage: string; secretHash: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return { preimage: hex(bytes), secretHash: hex(digest) };
}

function downloadSecret(swapId: number, preimage: string, secretHash: string): void {
  const blob = new Blob(
    [JSON.stringify({ swap: String(swapId), preimage, secretHash, created: new Date().toISOString() }, null, 2)],
    { type: 'application/json' },
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = swapId ? `${swapId}.json` : 'btq-htlc-secret.json';
  a.click();
  URL.revokeObjectURL(url);
}

function statusLine(plan: LockPlan | null): string {
  if (!plan) return 'Choose a price in the book.';
  if (plan.evmLock) return 'MetaMask locks the USDT. The secret stays in the file you saved.';
  if (plan.btqSend) return 'The BTQ wallet sends the exact amount to the HTLC address.';
  if (plan.solLock) return 'The Solana wallet locks the tokens. The secret stays in the file you saved.';
  if (plan.solClaim) return 'The secret is on-chain. Collect the tokens in the Solana wallet before the timelock.';
  if (plan.solRefund) return 'The timeout has passed. The Solana wallet can refund the tokens.';
  if (plan.usdtClaim) return 'The secret is on-chain. Collect the USDT before the timelock.';
  if (plan.usdtRefund) return 'The timeout has passed. MetaMask can refund the USDT.';
  if (plan.role === 'buyer' && plan.status === 'awaiting_buyer_claim') return 'Claim the BTQ before the refund height. The browser wallet cannot sign this script.';
  return `Swap #${plan.shortId} is ${plan.status.replace(/_/g, ' ')}.`;
}

function yourTurn(plan: LockPlan | null): boolean {
  if (!plan) return false;
  return !!(plan.evmLock || plan.btqSend || plan.usdtClaim || plan.usdtRefund || plan.solLock || plan.solClaim || plan.solRefund || (plan.role === 'buyer' && plan.status === 'awaiting_buyer_claim'));
}

function clock(targetMs: number, now: number): string {
  const s = Math.max(0, Math.round((targetMs - now) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (s === 0) return '0s';
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

export function TradeDesk() {
  const monitor = usePoll(() => getJson<MonitorState>('/public/monitor'), 2000);
  const liveBook = usePoll(() => getJson<MonitorState['book']>('/public/book'), 400);
  const data = monitor.data;
  const error = monitor.error ?? liveBook.error;
  const at = Math.max(monitor.at, liveBook.at);
  const [intervalSec, setIntervalSec] = useState<1 | 5 | 60>(5);
  const candlePoll = usePoll(() => getJson<{ intervalSec: number; candles: Candle[] }>(`/public/candles?interval=${intervalSec}`), 500);
  const [side, setSide] = useState<Side>('buy');
  const [price, setPrice] = useState('');
  const [amount, setAmount] = useState('');
  const [orderNo, setOrderNo] = useState<number | null>(null);
  const [profile, setProfile] = useState<DeskProfile | null>(null);
  const [terms, setTerms] = useState(false);
  const [stage, setStage] = useState<'edit' | 'preview' | 'secret'>('edit');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  const [swapId, setSwapId] = useState<number | null>(null);
  const [plan, setPlan] = useState<LockPlan | null>(null);
  const now = useNow(1000);
  const swapPoll = usePoll(
    () => (swapId ? getJson<SwapDetail>(`/public/swaps/${swapId}`) : Promise.resolve(null)),
    2000,
    [swapId],
  );
  const holding = yourTurn(plan);

  const book = liveBook.data ?? data?.book;
  const asks = (book?.asks ?? []).map((level, i) => ({ orderNo: i + 1, price: level.price, remainingBtq: level.amountBtq, mm: level.mm, orders: level.orders }));
  const bids = (book?.bids ?? []).map((level, i) => ({ orderNo: i + 1, price: level.price, remainingBtq: level.amountBtq, mm: level.mm, orders: level.orders }));
  const fresh = at > 0 && Date.now() - at < 8_000 && !error;

  useEffect(() => {
    const row = book?.topAsks[0];
    if (orderNo || !row) return;
    setPrice(row.price);
    setOrderNo(row.orderNo);
    setAmount(btqText(row.remainingBtq));
  }, [book?.topAsks, orderNo]);

  useEffect(() => {
    const token = deskToken();
    if (!token) return;
    deskApi.me().then((r) => setProfile(r.profile)).catch(() => setProfile(null));
  }, []);

  useEffect(() => {
    if (!swapId || !deskToken()) return;
    let alive = true;
    const tick = () => {
      deskApi.plan(swapId).then((p) => { if (alive) setPlan(p); }).catch((e) => { if (alive) setFault((e as Error).message); });
    };
    tick();
    const timer = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(timer); };
  }, [swapId]);

  const level = useMemo(() => {
    const rows = side === 'buy' ? asks : bids;
    return rows.find((r) => price && r.price === price) ?? rows[0] ?? null;
  }, [asks, bids, orderNo, price, side]);

  const total = useMemo(() => {
    try {
      if (!amount || !price) return null;
      if (toUnits(amount, 8) <= 0n) return null;
      return quoteUsdt(amount, price);
    } catch {
      return null;
    }
  }, [amount, price]);

  function select(takerSide: Side, row: BookRow) {
    if (yourTurn(plan)) return;
    setSide(takerSide);
    setPrice(row.price);
    setOrderNo(row.orderNo);
    setAmount(btqText(row.remainingBtq));
    setStage('edit');
    setFault(null);
  }

  function chooseSide(next: Side) {
    setSide(next);
    const row = (next === 'buy' ? asks : bids)[0];
    setPrice(row?.price ?? '');
    setOrderNo(row?.orderNo ?? null);
    setStage('edit');
  }

  async function connectBtqWallet() {
    setFault(null);
    setBusy('BTQ wallet');
    try {
      await connectBtq();
      const { challenge } = await deskApi.btqStart();
      const btq = btqProvider();
      if (!btq) throw new Error('The BTQ wallet extension is not installed in this browser.');
      const proof = await btq.signMessage({ message: challenge });
      const done = await deskApi.btqFinish(proof);
      setProfile(done.profile);
      setNotice(`BTQ wallet ${shortAddr(done.profile.btq)} is linked.`);
    } catch (err) {
      setFault(walletError(err));
    } finally {
      setBusy(null);
    }
  }

  async function runPlan(current: LockPlan, eth: string) {
    if (current.solLock || current.solClaim || current.solRefund) {
      const action = current.solLock ? 'lock' : current.solClaim ? 'withdraw' : 'refund';
      let secretHash: string | undefined;
      if (action === 'lock') {
        const saved = sessionStorage.getItem(secretKey(current.shortId));
        if (!saved) throw new Error('The secret file for this swap is not in this browser. Download it before locking.');
        secretHash = (JSON.parse(saved) as { secretHash: string }).secretHash;
      }
      setNotice('Approve the Solana transaction in the wallet.');
      const prepared = await deskApi.solPrepare(current.shortId, action, secretHash);
      const signed = await signSolanaTransaction(Transaction.from(base64ToBytes(prepared.tx)));
      const sent = await deskApi.solSubmit(current.shortId, bytesToBase64(signed.serialize()));
      setNotice(`Solana transaction ${sent.signature.slice(0, 8)} confirmed.`);
      return;
    }
    if (current.evmLock) {
      const saved = sessionStorage.getItem(secretKey(current.shortId));
      if (!saved) throw new Error('The secret file for this swap is not in this browser. Download it before locking.');
      const { secretHash } = JSON.parse(saved) as { secretHash: string };
      const on = await chainId();
      if (on !== current.evmLock.chainId) await switchChain(current.evmLock.chainId);
      setNotice('Approve the USDT spend in MetaMask.');
      await sendTx(eth, current.evmLock.token, approveCalldata(current.evmLock.htlc, current.evmLock.amountUnits));
      setNotice('Lock the USDT in the HTLC.');
      const hash = await sendTx(eth, current.evmLock.htlc, lockCalldata(current.evmLock, secretHash));
      setNotice(`USDT lock sent ${shortAddr(hash)}. Waiting for the chain.`);
      return;
    }
    if (current.btqSend) {
      const btq = btqProvider();
      if (!btq) throw new Error('The BTQ wallet extension is not installed in this browser.');
      setNotice('Confirm the BTQ send in the wallet.');
      const { txid } = await btq.requestSend({ to: current.btqSend.address, amountSats: current.btqSend.amountSats });
      await deskApi.btqLock(current.shortId, txid);
      setNotice(`BTQ lock sent ${shortAddr(txid)}.`);
      return;
    }
    if (current.usdtClaim) {
      const on = await chainId();
      if (on !== current.chainId) await switchChain(current.chainId);
      setNotice('Collect the USDT in MetaMask.');
      const hash = await sendTx(eth, current.contract, withdrawCalldata(current.usdtClaim.agreementId, current.usdtClaim.preimage));
      setNotice(`USDT claim sent ${shortAddr(hash)}.`);
      return;
    }
    if (current.usdtRefund) {
      setNotice('Refund the USDT in MetaMask.');
      const hash = await sendTx(eth, current.contract, refundCalldata(current.usdtRefund.agreementId));
      setNotice(`USDT refund sent ${shortAddr(hash)}.`);
    }
  }

  async function confirm() {
    setFault(null);
    const needsSol = (data?.settlementRail ?? 'evm') === 'solana';
    if ((needsSol ? !profile?.solLinked : !profile?.evmLinked) || !profile?.btqLinked) {
      setFault(needsSol ? 'Link a Solana wallet and the BTQ wallet before locking.' : 'Link MetaMask and the BTQ wallet before locking.');
      return;
    }
    if (!level) {
      setFault('Select a row in the book. The price has to be a resting order.');
      return;
    }
    try {
      toUnits(amount, 8);
    } catch (err) {
      setFault((err as Error).message);
      return;
    }
    if (side === 'buy' && stage !== 'secret') {
      const secret = await createSecret();
      sessionStorage.setItem('btq-secret-pending', JSON.stringify(secret));
      const blobNote = secret.secretHash;
      downloadSecret(0, secret.preimage, secret.secretHash);
      setStage('secret');
      setNotice(`Secret file downloaded. Its hash starts ${blobNote.slice(0, 8)}. Save it into ~/.btq-htlc/secrets/ before you lock.`);
      return;
    }
    setBusy(side === 'buy' ? 'Locking USDT' : 'Locking BTQ');
    try {
      const taken = await deskApi.take(level.orderNo, amount);
      setSwapId(taken.shortId);
      if (side === 'buy') {
        const pending = sessionStorage.getItem('btq-secret-pending');
        if (pending) {
          const secret = JSON.parse(pending) as { preimage: string; secretHash: string };
          sessionStorage.setItem(secretKey(taken.shortId), JSON.stringify(secret));
          downloadSecret(taken.shortId, secret.preimage, secret.secretHash);
          sessionStorage.removeItem('btq-secret-pending');
        }
      }
      const next = await deskApi.plan(taken.shortId);
      setPlan(next);
      const eth = profile.eth;
      if (!eth) throw new Error('The EVM wallet address is missing.');
      await runPlan(next, eth);
      setStage('edit');
    } catch (err) {
      setFault(walletError(err));
    } finally {
      setBusy(null);
    }
  }

  async function continueSwap() {
    if (!plan || !profile?.eth) return;
    setFault(null);
    setBusy('Wallet');
    try {
      await runPlan(plan, profile.eth);
    } catch (err) {
      setFault(walletError(err));
    } finally {
      setBusy(null);
    }
  }

  const spread = spreadBps(book?.bestBid ?? null, book?.bestAsk ?? null);
  const lastTrade = candlePoll.data?.candles.at(-1);
  const displayPrice = lastTrade ? priceText(lastTrade.c) : priceText(book?.bestAsk ?? book?.bestBid);
  const rail = data?.settlementRail ?? 'evm';
  const stableLinked = rail === 'solana' ? profile?.solLinked : profile?.evmLinked;
  const ready = !!stableLinked && !!profile?.btqLinked && !book?.paused && !!level && !!total;

  return (
    <div className="flex h-[calc(100vh-48px)] flex-col">
      <section className="flex flex-wrap items-end gap-x-8 gap-y-2 border-b border-white/10 bg-ink px-4 py-3">
        <div className="flex items-center gap-3">
          <img src="/btq-mark.svg" alt="" width="32" height="32" className="h-8 w-8" />
          <div>
            <div className="font-mono text-[15px] font-bold text-fog">BTQ/USDT</div>
            <div className="text-[11px] text-fog-3">Spot · {rail === 'solana' ? 'Solana' : 'EVM'} HTLC</div>
          </div>
        </div>
          <div>
            <div className="text-[28px] font-bold leading-none num text-fog">{displayPrice}</div>
            <div className="mt-1 text-[11px] text-fog-3">{lastTrade ? 'Last trade, USDT per BTQ' : 'Ask, USDT per BTQ'}</div>
          </div>
        <Stat label="Bid" value={priceText(book?.bestBid)} />
        <Stat label="Ask" value={priceText(book?.bestAsk)} />
        <Stat label="Spread" value={spread ? `${spread} bps` : '—'} />
        <Stat label="Settled" value={data ? `${btqText(data.stats.volumeBtq)} BTQ` : '—'} />
        <div className="ml-auto flex items-center gap-2 text-[12px] text-fog-2">
          <span className={`h-1.5 w-1.5 rounded-full ${fresh ? 'bg-positive pulse-dot' : 'bg-negative'}`} />
          {fresh ? 'Live' : error ? 'Disconnected' : 'Connecting'}
          <span className="text-fog-4">BTQ {data?.chains.btq.tip ?? '—'} · EVM {data?.chains.evm.head ?? '—'}</span>
        </div>
      </section>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)_340px]">
        <OrderBook
          asks={asks}
          bids={bids}
          paused={!!book?.paused}
          selected={orderNo}
          onSelect={(bookSide, row) => select(bookSide, row)}
        />
        <div className="flex min-h-0 flex-1 flex-col border-white/10 lg:border-r">
          <div className="flex items-center gap-1 px-4 pt-2">
            {([1, 5, 60] as const).map((step) => (
              <button
                key={step}
                type="button"
                onClick={() => setIntervalSec(step)}
                className={`rounded-control px-2 py-0.5 text-[11px] ${intervalSec === step ? 'bg-white/10 text-fog' : 'text-fog-3'}`}
              >
                {step === 60 ? '1m' : `${step}s`}
              </button>
            ))}
          </div>
          <CandleChart candles={candlePoll.data?.candles ?? []} intervalSec={intervalSec} />
          <div className="border-t border-white/10 px-4 py-3">
            <h2 className="text-[13px] font-semibold text-fog">{swapId ? `Swap #${swapId}` : 'No swap in progress'}</h2>
            <p className="mt-1 max-w-xl text-[12px] text-fog-3">{holding ? 'Finish the step on the right before the timelock.' : statusLine(plan)}</p>
            {swapId && <Link to={`/swap/${swapId}`} className="mt-2 inline-block text-[12px] text-evm">Open the settlement view</Link>}
          </div>
        </div>

        {holding && plan ? (
          <TurnGate
            plan={plan}
            swap={swapPoll.data?.swap ?? null}
            tip={data?.chains.btq.tip ?? 0}
            blockSec={data?.chains.btq.targetBlockSec ?? 5}
            now={now}
            busy={busy}
            notice={notice}
            fault={fault}
            btqAddress={profile?.btq ?? null}
            onAct={() => void continueSwap()}
          />
        ) : (
        <form
          className="flex flex-col bg-ink-2 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (stage === 'edit') setStage('preview');
            else void confirm();
          }}
        >
          <div className="grid grid-cols-2 gap-1 rounded-control bg-ink p-1" role="tablist" aria-label="Side">
            {(['buy', 'sell'] as const).map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={side === item}
                onClick={() => chooseSide(item)}
                className={`rounded-control py-2 text-[13px] font-semibold ${side === item ? (item === 'buy' ? 'bg-positive text-ink' : 'bg-negative text-white') : 'text-fog-2'}`}
              >
                {item === 'buy' ? 'Buy BTQ' : 'Sell BTQ'}
              </button>
            ))}
          </div>

          <label className="mt-4 text-[12px] text-fog-3">
            Price
            <input value={priceText(price)} readOnly className="mt-1 w-full rounded-control border border-white/10 bg-ink px-3 py-2 num text-fog" />
          </label>
          <label className="mt-3 text-[12px] text-fog-3">
            Amount BTQ
            <span className="float-right">
              <button type="button" className="text-evm" onClick={() => level && setAmount(level.remainingBtq)}>Max {level ? btqText(level.remainingBtq) : ''}</button>
            </span>
            <input
              value={amount}
              onChange={(e) => { setAmount(e.target.value); setStage('edit'); }}
              inputMode="decimal"
              className="mt-1 w-full rounded-control border border-white/10 bg-ink px-3 py-2 num text-fog"
            />
          </label>
          <div className="mt-3 flex items-baseline justify-between text-[12px]">
            <span className="text-fog-3">Total</span>
            <span className="num text-fog">{total ? `${total} USDT` : '—'}</span>
          </div>
          <p className="mt-3 text-[12px] leading-5 text-fog-3">
            {side === 'buy'
              ? rail === 'solana'
                ? 'You lock tokens in a Solana HTLC. The seller locks BTQ. Fee 0.'
                : 'You lock USDT in an HTLC from MetaMask. The seller locks BTQ. Fee 0.'
              : 'You send BTQ to the HTLC from the BTQ wallet. The buyer has locked the stablecoin. Fee 0.'}
          </p>

          <div className="mt-4 space-y-2 text-[12px]">
            <WalletConnector
              rail={rail}
              profile={profile}
              busy={!!busy}
              termsAccepted={terms || !!profile?.tos}
              onLinked={setProfile}
              onNotice={setNotice}
              onError={(message) => setFault(message || null)}
            />
            <WalletRow name="BTQ wallet" ok={!!profile?.btqLinked} detail={profile?.btq ? shortAddr(profile.btq) : btqProvider() ? 'Not linked' : 'Not installed'} onClick={() => void connectBtqWallet()} disabled={!!busy || !(rail === 'solana' ? profile?.solLinked : profile?.evmLinked)} />
          </div>
          {!profile?.tos && (
            <label className="mt-3 flex items-start gap-2 text-[12px] text-fog-2">
              <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} className="mt-0.5" />
              <span>I lock funds myself. I have to claim before the timelock, or the other side can take the funds back.</span>
            </label>
          )}

          {stage !== 'edit' && total && (
            <div className="mt-3 rounded-control border border-white/10 bg-ink px-3 py-2 text-[12px] text-fog-2">
              {side === 'buy' ? `Lock ${total} USDT to buy ${btqText(amount)} BTQ at ${priceText(price)}.` : `Send ${btqText(amount)} BTQ to receive ${total} USDT at ${priceText(price)}.`}
              {stage === 'secret' && ' The secret file has been downloaded.'}
            </div>
          )}
          {notice && <p className="mt-3 text-[12px] text-fog-2">{notice}</p>}
          {fault && <p className="mt-3 text-[12px] text-negative" role="alert">{fault}</p>}

          <button
            type="submit"
            disabled={!!busy || (stage !== 'edit' && !ready) || (!!book?.paused)}
            className={`mt-4 rounded-control py-2.5 text-[13px] font-semibold disabled:opacity-40 ${side === 'buy' ? 'bg-positive text-ink' : 'bg-negative text-white'}`}
          >
            {busy ?? (book?.paused ? 'Book paused' : stage === 'edit' ? 'Review order' : stage === 'secret' ? 'Lock USDT' : side === 'buy' ? 'Continue' : 'Lock BTQ')}
          </button>
        </form>
        )}
      </div>
    </div>
  );
}

function turnCopy(plan: LockPlan, swap: SwapView | null, tip: number, blockSec: number, now: number): { title: string; clock: string; detail: string; action: string | null } {
  if (plan.solLock) {
    const at = swap?.deadlines.buyerLockBy ? new Date(swap.deadlines.buyerLockBy).getTime() : 0;
    return { title: 'Lock the tokens on Solana', clock: at ? clock(at, now) : '—', detail: 'The Solana wallet locks the tokens. The order book stays closed until this is sent.', action: 'Lock tokens' };
  }
  if (plan.solClaim) {
    const at = swap?.evm.deadline ? new Date(swap.evm.deadline).getTime() : 0;
    return { title: 'Collect the tokens', clock: at ? clock(at, now) : '—', detail: 'The buyer already has the BTQ. The Solana wallet has to send this claim before the clock ends.', action: 'Collect tokens' };
  }
  if (plan.solRefund) {
    return { title: 'Refund the tokens', clock: 'Open', detail: 'The timelock has passed. The Solana wallet returns the tokens to you.', action: 'Refund tokens' };
  }
  if (plan.usdtClaim) {
    const at = swap?.evm.deadline ? new Date(swap.evm.deadline).getTime() : 0;
    return {
      title: 'Collect the USDT',
      clock: at ? clock(at, now) : '—',
      detail: 'The buyer already has the BTQ. MetaMask has to send this claim before the clock ends. After that, the buyer can take the USDT back.',
      action: 'Collect USDT',
    };
  }
  if (plan.role === 'buyer' && plan.status === 'awaiting_buyer_claim') {
    const height = swap?.btq.refundLocktime;
    const blocks = height ? height - tip : -1;
    return {
      title: 'Claim the BTQ',
      clock: blocks > 0 ? `${blocks} blocks · ${clock(now + blocks * blockSec * 1000, now)}` : height ? 'Refund is open' : '—',
      detail: 'The browser wallet cannot sign this script. Put the secret file in ~/.btq-htlc/secrets/ and run the claim before the refund height. After that, the seller can take the BTQ back.',
      action: null,
    };
  }
  if (plan.evmLock) {
    const at = swap?.deadlines.buyerLockBy ? new Date(swap.deadlines.buyerLockBy).getTime() : 0;
    return { title: 'Lock the USDT', clock: at ? clock(at, now) : '—', detail: 'MetaMask locks the USDT. The order book stays closed until this is sent.', action: 'Lock USDT' };
  }
  if (plan.btqSend) {
    const at = swap?.deadlines.sellerLockBy ? new Date(swap.deadlines.sellerLockBy).getTime() : 0;
    return { title: 'Lock the BTQ', clock: at ? clock(at, now) : '—', detail: 'The BTQ wallet sends the exact amount to the HTLC. The order book stays closed until this is sent.', action: 'Send BTQ' };
  }
  return { title: 'Refund the USDT', clock: 'Open', detail: 'The timelock has passed. MetaMask returns the USDT to you.', action: 'Refund USDT' };
}

function TurnGate({ plan, swap, tip, blockSec, now, busy, notice, fault, btqAddress, onAct }: {
  plan: LockPlan;
  swap: SwapView | null;
  tip: number;
  blockSec: number;
  now: number;
  busy: string | null;
  notice: string | null;
  fault: string | null;
  btqAddress: string | null;
  onAct: () => void;
}) {
  const step = turnCopy(plan, swap, tip, blockSec, now);
  const claim = plan.role === 'buyer' && plan.status === 'awaiting_buyer_claim';
  const command = `btq-htlc claim --swap ${plan.shortId} --api ${window.location.origin}/api${btqAddress ? ` --to ${btqAddress}` : ''} --broadcast`;
  return (
    <section className="flex flex-col bg-ink-2 p-4" aria-label="Required step">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-negative">Required now · swap #{plan.shortId}</p>
      <p className="mt-3 font-mono text-[28px] font-bold leading-none text-fog">{step.clock}</p>
      <h2 className="mt-3 text-[16px] font-semibold text-fog">{step.title}</h2>
      <p className="mt-2 text-[12px] leading-5 text-fog-2">{step.detail}</p>
      {claim && (
        <div className="mt-4">
          <p className="text-[11px] text-fog-3">Claim command</p>
          <pre className="mt-1 overflow-x-auto rounded-control border border-white/10 bg-ink p-3 text-[11px] leading-5 text-fog">{command}</pre>
          <button
            type="button"
            className="mt-2 rounded-control border border-white/10 px-3 py-1.5 text-[12px] text-fog"
            onClick={() => void navigator.clipboard.writeText(command)}
          >
            Copy command
          </button>
        </div>
      )}
      {step.action && (
        <button type="button" onClick={onAct} disabled={!!busy} className="mt-4 rounded-control bg-accent py-2.5 text-[13px] font-semibold text-white disabled:opacity-50">
          {busy ?? step.action}
        </button>
      )}
      {notice && <p className="mt-3 text-[12px] text-fog-2">{notice}</p>}
      {fault && <p className="mt-3 text-[12px] text-negative" role="alert">{fault}</p>}
      <Link to={`/swap/${plan.shortId}`} className="mt-4 text-[12px] text-evm">Open the settlement view</Link>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] text-fog-3">{label}</div>
      <div className="text-[13px] font-medium num text-fog">{value}</div>
    </div>
  );
}

function WalletRow({ name, ok, detail, onClick, disabled }: { name: string; ok: boolean; detail: string; onClick: () => void; disabled: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-fog-2">{name}</span>
      {ok ? (
        <span className="num text-positive">{detail}</span>
      ) : (
        <button type="button" onClick={onClick} disabled={disabled || detail === 'Not installed'} className="rounded-control border border-white/10 px-2 py-1 text-fog disabled:opacity-40">{detail === 'Not installed' ? 'Not installed' : 'Connect'}</button>
      )}
    </div>
  );
}
