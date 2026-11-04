import { useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';
import { useAccount, useBalance, useReadContract, useWriteContract, usePublicClient } from 'wagmi';
import { formatUnits, parseUnits } from 'viem';
import { useSwap } from '../../hooks/useSwap';
import { useAuthStore } from '../../store/authStore';
import { api } from '../../lib/api';
import { USDT_CONTRACT_ADDRESS, HTLC_CONTRACT_ADDRESS, ERC20_ABI, SUPPORTED_CHAIN_ID } from '../../lib/constants';
import { showError } from '../common/ErrorToast';
import { trackEvent } from '../../lib/telemetry';

type Tab = 'limit' | 'market';
type Side = 'buy' | 'sell';

interface OrderbookSummary {
  hasBids: boolean;
  hasAsks: boolean;
  bestBid: string | null;
  bestAsk: string | null;
}

interface CreatedOrderPayload {
  id: string;
  direction: 'buy' | 'sell';
  amount_btq: string;
  price_usdt: string;
}

interface BtqBalanceResponse {
  configured: boolean;
  available?: boolean;
  address?: string;
  balance: number | null;
}

const HTLC_ERC20_ABI = [
  {
    inputs: [
      {
        components: [
          { name: 'partyB', type: 'address' },
          { name: 'secretlock', type: 'bytes32' },
          { name: 'deadline', type: 'uint32' },
          { name: 'erc20Contract', type: 'address' },
          { name: 'tokenAmount', type: 'uint256' },
          { name: 'otherNetwork', type: 'string' },
          { name: 'otherAsset', type: 'string' },
          { name: 'otherAmount', type: 'uint256' },
        ],
        name: 'params',
        type: 'tuple',
      },
    ],
    name: 'createHTLCProposal',
    outputs: [{ name: 'agreementId', type: 'bytes32' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

async function makeSecretHash(): Promise<string> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const secret = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  const secretBytes = new Uint8Array(secret.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
  const hashBuffer = await crypto.subtle.digest('SHA-256', secretBytes);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function TradeForm() {
  const { isAuthenticated } = useAuthStore();
  const { currentRate } = useSwap();
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const [tab, setTab] = useState<Tab>('limit');
  const [side, setSide] = useState<Side>('buy');
  const [price, setPrice] = useState('');
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [book, setBook] = useState<OrderbookSummary>({ hasBids: false, hasAsks: false, bestBid: null, bestAsk: null });
  const [wsConnected, setWsConnected] = useState(false);
  const [btqBalance, setBtqBalance] = useState<string | null>(null);
  const [btqConfigured, setBtqConfigured] = useState(false);
  const [defaultLockMinutes, setDefaultLockMinutes] = useState(() => {
    const raw = Number(localStorage.getItem('btq_default_htlc_lock_minutes') || '60');
    if (Number.isNaN(raw)) return 60;
    return Math.min(10080, Math.max(1, Math.floor(raw)));
  });

  const { data: ethBalance } = useBalance({ address, chainId: SUPPORTED_CHAIN_ID, query: { refetchInterval: 15000 } });

  const { data: usdtRaw } = useReadContract({
    address: USDT_CONTRACT_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: SUPPORTED_CHAIN_ID,
    query: { enabled: !!address, refetchInterval: 15000 },
  });

  const usdtBalance = usdtRaw ? formatUnits(usdtRaw as bigint, 6) : '0';

  const fetchBook = useCallback(async () => {
    try {
      const res = await api.get<{ orderbook: { bids: unknown[]; asks: unknown[]; spread: string | null } }>('/orderbook');
      const ob = res.orderbook;
      setBook({
        hasBids: ob.bids.length > 0,
        hasAsks: ob.asks.length > 0,
        bestBid: ob.bids.length > 0 ? (ob.bids[0] as { price: string }).price : null,
        bestAsk: ob.asks.length > 0 ? (ob.asks[0] as { price: string }).price : null,
      });
    } catch {
      setBook({ hasBids: false, hasAsks: false, bestBid: null, bestAsk: null });
    }
  }, []);

  useEffect(() => {
    fetchBook();
  }, [fetchBook]);

  useEffect(() => {
    const onWsConnection = (event: Event) => {
      const custom = event as CustomEvent<{ connected?: boolean }>;
      setWsConnected(Boolean(custom.detail?.connected));
    };
    const onOrderbookUpdate = (event: Event) => {
      const custom = event as CustomEvent<{ bids?: Array<{ price: string }>; asks?: Array<{ price: string }> }>;
      const bids = custom.detail?.bids ?? [];
      const asks = custom.detail?.asks ?? [];
      setBook({
        hasBids: bids.length > 0,
        hasAsks: asks.length > 0,
        bestBid: bids.length > 0 ? bids[0].price : null,
        bestAsk: asks.length > 0 ? asks[0].price : null,
      });
    };
    window.addEventListener('ws:connection', onWsConnection as EventListener);
    window.addEventListener('orderbook:update', onOrderbookUpdate as EventListener);
    return () => {
      window.removeEventListener('ws:connection', onWsConnection as EventListener);
      window.removeEventListener('orderbook:update', onOrderbookUpdate as EventListener);
    };
  }, []);

  useEffect(() => {
    if (wsConnected) return;
    const iv = setInterval(fetchBook, 30000);
    return () => clearInterval(iv);
  }, [fetchBook, wsConnected]);

  useEffect(() => {
    if (!isAuthenticated) {
      setBtqBalance(null);
      setBtqConfigured(false);
      return;
    }
    let cancelled = false;
    const fetchBtqBalance = async () => {
      try {
        const res = await api.get<BtqBalanceResponse>('/user/btq-balance');
        if (cancelled) return;
        setBtqConfigured(Boolean(res.configured));
        if (!res.configured || res.available === false || res.balance === null || Number.isNaN(Number(res.balance))) {
          setBtqBalance(null);
          return;
        }
        setBtqBalance(Number(res.balance).toFixed(8));
      } catch {
        if (cancelled) return;
        setBtqBalance(null);
      }
    };
    void fetchBtqBalance();
    const interval = setInterval(fetchBtqBalance, 20_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [isAuthenticated]);

  useEffect(() => {
    const handler = (event: Event) => {
      const custom = event as CustomEvent<{
        side?: Side;
        tab?: Tab;
        price?: string;
        amount?: string;
      }>;
      const payload = custom.detail;
      if (!payload) return;
      if (payload.side === 'buy' || payload.side === 'sell') setSide(payload.side);
      if (payload.tab === 'limit' || payload.tab === 'market') setTab(payload.tab);
      if (typeof payload.price === 'string') setPrice(payload.price);
      if (typeof payload.amount === 'string') setAmount(payload.amount);
    };
    window.addEventListener('btq:prefill-order', handler as EventListener);
    return () => window.removeEventListener('btq:prefill-order', handler as EventListener);
  }, []);

  const hasLiquidity = side === 'buy' ? book.hasAsks : book.hasBids;

  const marketDisabledReason = !hasLiquidity
    ? `No ${side === 'buy' ? 'sell' : 'buy'} orders available to fill`
    : null;

  const total = (() => {
    if (tab === 'limit' && price && amount) {
      return (parseFloat(price) * parseFloat(amount)).toFixed(2);
    }
    if (tab === 'market' && amount) {
      const bestPrice = side === 'buy' ? book.bestAsk : book.bestBid;
      if (bestPrice) return (parseFloat(bestPrice) * parseFloat(amount)).toFixed(2);
    }
    return '';
  })();

  const maxBtqForPercent = (() => {
    if (side === 'buy') {
      const bestPrice = tab === 'market' ? (side === 'buy' ? book.bestAsk : book.bestBid) : price;
      const priceNum = Number(bestPrice);
      const usdtNum = Number(usdtBalance);
      if (!Number.isFinite(priceNum) || priceNum <= 0 || !Number.isFinite(usdtNum) || usdtNum <= 0) {
        return null;
      }
      return usdtNum / priceNum;
    }
    return null;
  })();

  const handlePercentage = (pct: number) => {
    if (!maxBtqForPercent) return;
    setAmount((maxBtqForPercent * pct).toFixed(8));
  };

  const setLockMinutes = (minutes: number) => {
    const next = Math.min(10080, Math.max(1, Math.floor(minutes)));
    setDefaultLockMinutes(next);
    localStorage.setItem('btq_default_htlc_lock_minutes', String(next));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!amount) return;
    if (tab === 'limit' && !price) return;
    if (tab === 'market' && !hasLiquidity) return;
    setLoading(true);
    let createdOrderId: string | null = null;
    try {
      const orderPrice = tab === 'market'
        ? (side === 'buy' ? book.bestAsk! : book.bestBid!)
        : price;
      const direction = side === 'buy' ? 'buy' : 'sell';

      if (side === 'buy') {
        if (!publicClient) throw new Error('Wallet provider unavailable');
        const createRes = await api.post<{ order: CreatedOrderPayload; fills: number }>('/orders', {
          direction,
          amount_btq: amount,
          price_usdt: orderPrice,
          funded: false,
        });
        createdOrderId = createRes.order.id;

        const hash = await makeSecretHash();
        const totalUsdt = (parseFloat(amount) * parseFloat(orderPrice)).toFixed(2);
        const totalUsdtWei = parseUnits(totalUsdt, 6);

        toast.loading('Approve USDT in wallet...', { id: 'buy-approve' });
        const approveTx = await writeContractAsync({
          address: USDT_CONTRACT_ADDRESS,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [HTLC_CONTRACT_ADDRESS, totalUsdtWei],
        });
        await publicClient.waitForTransactionReceipt({ hash: approveTx });
        toast.success('USDT approved', { id: 'buy-approve' });

        const deadline = Math.floor(Date.now() / 1000) + (defaultLockMinutes * 60);
        toast.loading('Creating lock on-chain...', { id: 'buy-lock' });
        const lockTx = await writeContractAsync({
          address: HTLC_CONTRACT_ADDRESS,
          abi: HTLC_ERC20_ABI,
          functionName: 'createHTLCProposal',
          args: [{
            partyB: HTLC_CONTRACT_ADDRESS,
            secretlock: `0x${hash}` as `0x${string}`,
            deadline,
            erc20Contract: USDT_CONTRACT_ADDRESS,
            tokenAmount: totalUsdtWei,
            otherNetwork: 'BTQ',
            otherAsset: 'BTQ',
            otherAmount: parseUnits(amount, 8),
          }],
          gas: BigInt(500_000),
        });
        await publicClient.waitForTransactionReceipt({ hash: lockTx });
        toast.success('Funds locked', { id: 'buy-lock' });

        await api.post(`/orders/${createdOrderId}/fund`, {
          secret_hash: hash,
          btq_htlc_txid: lockTx,
          btq_htlc_vout: 0,
        });

        void trackEvent('order_submit_success', {
          side,
          tab,
          amount,
          price: orderPrice,
          fills: createRes.fills,
        });
        const fillMsg = createRes.fills > 0 ? ` (${createRes.fills} fill${createRes.fills > 1 ? 's' : ''})` : '';
        toast.success(`Buy order placed and funded${fillMsg}`);
      } else {
        const res = await api.post<{ order: CreatedOrderPayload; fills: number }>('/orders', {
          direction,
          amount_btq: amount,
          price_usdt: orderPrice,
          funded: tab === 'market',
        });
        void trackEvent('order_submit_success', {
          side,
          tab,
          amount,
          price: orderPrice,
          fills: res.fills,
        });
        const fillMsg = res.fills > 0 ? ` (${res.fills} fill${res.fills > 1 ? 's' : ''})` : '';
        toast.success('Sell order placed' + fillMsg);
      }
      setPrice('');
      setAmount('');
      fetchBook();
      window.dispatchEvent(new CustomEvent('btq:order-placed'));
    } catch (err) {
      if (createdOrderId) {
        try {
          await api.post(`/orders/${createdOrderId}/cancel`, {});
        } catch {
          // Ignore rollback failures and surface original error.
        }
      }
      void trackEvent('order_submit_error', {
        side,
        tab,
        message: err instanceof Error ? err.message : String(err),
      });
      showError(err);
    } finally {
      setLoading(false);
    }
  };

  if (!isAuthenticated) {
    return (
      <div className="flex flex-col rounded-xl border border-slate-700/50 bg-slate-800/30 overflow-hidden">
        <div className="border-b border-slate-700/50 px-4 py-3">
          <h3 className="text-sm font-semibold text-white">Place Order</h3>
        </div>
        <div className="flex flex-col items-center justify-center px-4 py-12">
          <svg className="mb-3 h-10 w-10 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
          <p className="text-sm text-slate-400">Connect wallet to trade</p>
        </div>
      </div>
    );
  }

  const submitDisabled =
    loading ||
    !amount ||
    (tab === 'limit' && !price) ||
    (tab === 'market' && !hasLiquidity);

  return (
    <form onSubmit={handleSubmit} className="flex flex-col rounded-xl border border-slate-700/50 bg-slate-800/30 overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-700/50 px-4 py-3">
        <h3 className="text-sm font-semibold text-white">Place Order</h3>
        <div className="flex rounded-md bg-slate-900 p-0.5">
          {(['limit', 'market'] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`rounded px-2.5 py-1 text-[11px] font-medium capitalize transition-all ${
                tab === t ? 'bg-slate-700 text-white' : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="p-4">
        {/* Balance display */}
        {address && (
          <div className="mb-3 flex items-center justify-between rounded-lg bg-slate-900/60 px-3 py-2">
            <div className="flex items-center gap-3">
              <div>
                <p className="text-[10px] font-medium uppercase text-slate-500">ETH</p>
                <p className="font-mono text-xs text-white">{ethBalance ? parseFloat(ethBalance.formatted).toFixed(4) : '...'}</p>
              </div>
              <div className="h-6 w-px bg-slate-700" />
              <div>
                <p className="text-[10px] font-medium uppercase text-slate-500">USDT</p>
                <p className="font-mono text-xs text-white">{parseFloat(usdtBalance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
              </div>
              <div className="h-6 w-px bg-slate-700" />
              <div>
                <p className="text-[10px] font-medium uppercase text-slate-500">BTQ</p>
                <p className="font-mono text-xs text-white">
                  {btqConfigured
                    ? (btqBalance !== null ? parseFloat(btqBalance).toFixed(4) : '...')
                    : '--'}
                </p>
              </div>
            </div>
          </div>
        )}

        <div className="mb-4 flex rounded-lg bg-slate-900 p-1">
          <button
            type="button"
            onClick={() => setSide('buy')}
            className={`flex-1 rounded-md py-2.5 text-sm font-semibold transition-all ${
              side === 'buy'
                ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-600/25'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Buy
          </button>
          <button
            type="button"
            onClick={() => setSide('sell')}
            className={`flex-1 rounded-md py-2.5 text-sm font-semibold transition-all ${
              side === 'sell'
                ? 'bg-red-600 text-white shadow-lg shadow-red-600/25'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Sell
          </button>
        </div>

        <div className="space-y-3">
          {tab === 'limit' && (
            <div>
              <label className="mb-1 flex items-center justify-between text-xs text-slate-400">
                <span>Price</span>
                <span>USDT</span>
              </label>
              <input
                type="number"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder={currentRate ? (side === 'buy' ? currentRate.ask : currentRate.bid) : '0.00'}
                step="0.0001"
                className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2.5 font-mono text-sm text-white placeholder-slate-600 outline-none transition-colors focus:border-blue-500 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
            </div>
          )}

          {tab === 'market' && (
            <div>
              <label className="mb-1 flex items-center justify-between text-xs text-slate-400">
                <span>Price</span>
                <span>USDT</span>
              </label>
              <div className="flex items-center rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2.5">
                {hasLiquidity ? (
                  <span className="font-mono text-sm text-slate-300">
                    {side === 'buy' ? book.bestAsk : book.bestBid} (best available)
                  </span>
                ) : (
                  <span className="text-sm text-red-400/80">No liquidity</span>
                )}
              </div>
            </div>
          )}

          <div>
            <label className="mb-1 flex items-center justify-between text-xs text-slate-400">
              <span>Amount</span>
              {side === 'buy' && address ? (
                <span>Available: <span className="font-mono text-slate-300">{parseFloat(usdtBalance).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span> USDT</span>
              ) : (
                <span>BTQ</span>
              )}
            </label>
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00000000"
              step="0.00000001"
              className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2.5 font-mono text-sm text-white placeholder-slate-600 outline-none transition-colors focus:border-blue-500 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
          </div>

          <div className="flex gap-1.5">
            {[25, 50, 75, 100].map((pct) => (
              <button
                key={pct}
                type="button"
                onClick={() => handlePercentage(pct / 100)}
                disabled={!maxBtqForPercent}
                title={!maxBtqForPercent ? 'Set a valid price to calculate balance percentage.' : undefined}
                className="flex-1 rounded-md bg-slate-900 py-1.5 text-[11px] font-medium text-slate-400 transition-colors hover:bg-slate-700 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                {pct}%
              </button>
            ))}
          </div>

          <div>
            <label className="mb-1 flex items-center justify-between text-xs text-slate-400">
              <span>Default lock duration</span>
              <span>{defaultLockMinutes} min</span>
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={10080}
                step={1}
                value={defaultLockMinutes}
                onChange={(e) => setLockMinutes(Number(e.target.value))}
                className="w-24 rounded-lg border border-slate-600 bg-slate-900 px-2.5 py-1.5 text-xs text-white outline-none focus:border-blue-500 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
              <div className="flex flex-1 gap-1.5">
                {[15, 30, 60, 120].map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setLockMinutes(m)}
                    className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                      defaultLockMinutes === m
                        ? 'bg-blue-600 text-white'
                        : 'bg-slate-900 text-slate-400 hover:bg-slate-700 hover:text-slate-200'
                    }`}
                  >
                    {m}m
                  </button>
                ))}
              </div>
            </div>
          </div>

          {total && (
            <div className="flex items-center justify-between rounded-lg bg-slate-900/60 px-3 py-2">
              <span className="text-xs text-slate-400">Total</span>
              <span className="font-mono text-sm text-white">{total} USDT</span>
            </div>
          )}

          {tab === 'market' && marketDisabledReason && (
            <div className="rounded-lg bg-amber-500/10 px-3 py-2">
              <p className="text-xs text-amber-400">{marketDisabledReason}</p>
            </div>
          )}
        </div>

        <button
          type="submit"
          disabled={submitDisabled}
          className={`mt-4 w-full rounded-lg py-3 text-sm font-semibold text-white transition-all disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500 ${
            side === 'buy'
              ? 'bg-emerald-600 shadow-lg shadow-emerald-600/20 hover:bg-emerald-500'
              : 'bg-red-600 shadow-lg shadow-red-600/20 hover:bg-red-500'
          }`}
        >
          {loading
            ? (side === 'buy' ? 'Processing…' : 'Placing…')
            : tab === 'market' && !hasLiquidity
              ? 'No Liquidity'
              : side === 'buy'
                ? 'Approve + Create Buy'
                : 'Sell BTQ'}
        </button>
      </div>
    </form>
  );
}
