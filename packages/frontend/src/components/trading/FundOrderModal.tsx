import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import toast from 'react-hot-toast';
import { useAccount, useWriteContract, usePublicClient } from 'wagmi';
import { parseUnits } from 'viem';
import { api } from '../../lib/api';
import { HTLC_CONTRACT_ADDRESS, USDT_CONTRACT_ADDRESS, ERC20_ABI } from '../../lib/constants';
import { showError } from '../common/ErrorToast';

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

async function sha256hex(hex: string): Promise<string> {
  const bytes = new Uint8Array(hex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface Props {
  orderId: string;
  direction: string;
  amountBtq: string;
  priceUsdt: string;
  onClose: () => void;
  onFunded: () => void;
}

interface SellFundingContext {
  buyOrderId: string;
  counterpartyDilithiumPubkey: string;
  buyExpiresAt: string | null;
  remainingMs: number;
  minRequiredMs: number;
}

interface SellFundingCommands {
  timelockBlocks: number;
  counterpartyDilithiumPubkey: string;
  refundDilithiumPubkey: string;
  claimLeafHex: string;
  refundLeafHex: string;
  createAddressCommand: string;
  listP2mrCommand: string;
  sendToAddressCommand: string;
  verifyTxCommand: string;
}

export function FundOrderModal({ orderId, direction, amountBtq, priceUsdt, onClose, onFunded }: Props) {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();

  const isSell = direction === 'sell';
  const isBuy = !isSell;
  const totalUsdt = (parseFloat(amountBtq) * parseFloat(priceUsdt)).toFixed(2);
  const totalUsdtWei = parseUnits(totalUsdt, 6);

  const [secret, setSecret] = useState('');
  const [secretHash, setSecretHash] = useState('');
  const [txid, setTxid] = useState('');
  const [htlcVout, setHtlcVout] = useState(0);
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<'approve' | 'lock' | 'submit'>('approve');
  const [sellFundingContext, setSellFundingContext] = useState<SellFundingContext | null>(null);
  const [sellContextLoading, setSellContextLoading] = useState(false);
  const [sellContextError, setSellContextError] = useState<string | null>(null);
  const [sellFundingCommands, setSellFundingCommands] = useState<SellFundingCommands | null>(null);
  const [sellCommandsLoading, setSellCommandsLoading] = useState(false);
  const [sellCommandsError, setSellCommandsError] = useState<string | null>(null);
  const [timelockMinutes, setTimelockMinutes] = useState(() => {
    const raw = Number(localStorage.getItem('btq_default_htlc_lock_minutes') || '60');
    if (Number.isNaN(raw)) return 60;
    return Math.min(10080, Math.max(1, Math.floor(raw)));
  });

  // Auto-generate secret + hash on mount
  useEffect(() => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const s = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
    setSecret(s);
    sha256hex(s).then(setSecretHash);
  }, []);

  useEffect(() => {
    if (!isSell) return;
    let cancelled = false;
    const loadSellFundingContext = async () => {
      setSellContextLoading(true);
      setSellContextError(null);
      try {
        const res = await api.get<{ context: SellFundingContext }>(`/orders/${orderId}/sell-funding-context`);
        if (cancelled) return;
        setSellFundingContext(res.context);
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Failed to load sell funding context';
        setSellFundingContext(null);
        setSellContextError(message);
      } finally {
        if (!cancelled) {
          setSellContextLoading(false);
        }
      }
    };
    void loadSellFundingContext();
    return () => { cancelled = true; };
  }, [isSell, orderId]);

  const activeHash = secretHash;
  const hashReady = activeHash.length === 64;
  const timelockSeconds = Math.max(60, Math.floor(timelockMinutes) * 60);

  const updateTimelockMinutes = (value: number) => {
    const next = Math.min(10080, Math.max(1, Math.floor(value)));
    setTimelockMinutes(next);
    localStorage.setItem('btq_default_htlc_lock_minutes', String(next));
  };

  useEffect(() => {
    if (!isSell || !hashReady) return;
    let cancelled = false;
    const loadSellFundingCommands = async () => {
      setSellCommandsLoading(true);
      setSellCommandsError(null);
      try {
        const res = await api.get<{ commands: SellFundingCommands }>(
          `/orders/${orderId}/sell-funding-commands?secret_hash=${activeHash}&timelock_minutes=${timelockMinutes}`,
        );
        if (cancelled) return;
        setSellFundingCommands(res.commands);
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Failed to load sell funding commands';
        setSellFundingCommands(null);
        setSellCommandsError(message);
      } finally {
        if (!cancelled) {
          setSellCommandsLoading(false);
        }
      }
    };
    void loadSellFundingCommands();
    return () => { cancelled = true; };
  }, [isSell, hashReady, orderId, activeHash, timelockMinutes]);

  const handleSellSubmit = async () => {
    if (!activeHash || !txid.trim()) { toast.error('Missing fields'); return; }
    if (!Number.isInteger(htlcVout) || htlcVout < 0) {
      toast.error('HTLC output index must be 0 or greater');
      return;
    }
    setLoading(true);
    const payload = {
      secret_hash: activeHash,
      btq_htlc_txid: txid.trim(),
      btq_htlc_vout: htlcVout,
    };
    try {
      console.log('[FundOrderModal] submitting sell funding', {
        orderId,
        payload,
      });
      await api.post(`/orders/${orderId}/fund`, payload);
      toast.success('Sell order funded');
      onFunded();
    } catch (err) {
      console.error('[FundOrderModal] sell funding failed', {
        orderId,
        payload,
        error: err instanceof Error ? err.message : String(err),
      });
      showError(err);
    } finally { setLoading(false); }
  };

  const handleBuyApprove = async () => {
    setLoading(true);
    try {
      const txHash = await writeContractAsync({
        address: USDT_CONTRACT_ADDRESS,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [HTLC_CONTRACT_ADDRESS, totalUsdtWei],
      });
      toast.loading('Waiting for approval confirmation...', { id: 'approve' });
      await publicClient!.waitForTransactionReceipt({ hash: txHash });
      toast.success('USDT approved', { id: 'approve' });
      setStep('lock');
    } catch (err) {
      toast.dismiss('approve');
      showError(err);
    } finally { setLoading(false); }
  };

  const handleBuyLock = async () => {
    setLoading(true);
    try {
      const deadline = Math.floor(Date.now() / 1000) + timelockSeconds;
      const txHash = await writeContractAsync({
        address: HTLC_CONTRACT_ADDRESS,
        abi: HTLC_ERC20_ABI,
        functionName: 'createHTLCProposal',
        args: [{
          partyB: HTLC_CONTRACT_ADDRESS,
          secretlock: `0x${activeHash}` as `0x${string}`,
          deadline,
          erc20Contract: USDT_CONTRACT_ADDRESS,
          tokenAmount: totalUsdtWei,
          otherNetwork: 'BTQ',
          otherAsset: 'BTQ',
          otherAmount: parseUnits(amountBtq, 8),
        }],
        gas: BigInt(500_000),
      });
      toast.loading('Waiting for HTLC confirmation...', { id: 'lock' });
      await publicClient!.waitForTransactionReceipt({ hash: txHash });
      toast.dismiss('lock');

      console.debug('[FundOrderModal] submitting buy funding', {
        orderId,
        evmTxHash: txHash,
        hashPrefix: activeHash.slice(0, 16),
        timelockSeconds,
      });
      await api.post(`/orders/${orderId}/fund`, {
        secret_hash: activeHash,
        btq_htlc_txid: txHash,
        btq_htlc_vout: 0,
      });
      toast.success('USDT locked! Order is now funded.');
      onFunded();
    } catch (err) {
      toast.dismiss('lock');
      showError(err);
    } finally { setLoading(false); }
  };

  return createPortal(
    <div className="fixed inset-0 z-[9999] overflow-y-auto bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className="flex min-h-full items-center justify-center p-4">
        <div className="w-full max-w-md rounded-2xl border border-slate-700/50 bg-slate-900 shadow-2xl" onClick={(e) => e.stopPropagation()}>

          {/* Header */}
          <div className="border-b border-slate-700/50 px-6 py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`flex h-12 w-12 items-center justify-center rounded-2xl ${isBuy ? 'bg-emerald-500/15' : 'bg-blue-500/15'}`}>
                  <svg className={`h-7 w-7 ${isBuy ? 'text-emerald-400' : 'text-blue-400'}`} viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
                    {isBuy ? (
                      <path d="M228.24,67.76a8,8,0,0,0-11.31,0L112,172.69,67.31,128a8,8,0,0,0-11.31,11.31l50.34,50.35a8,8,0,0,0,11.31,0L228.24,79.07A8,8,0,0,0,228.24,67.76Z" />
                    ) : (
                      <path d="M224,128a8,8,0,0,1-8,8H82.34l29.83,29.86a8,8,0,0,1-11.34,11.28l-43.5-43.5a8,8,0,0,1,0-11.31l43.5-43.5a8,8,0,0,1,11.34,11.28L82.34,120H216A8,8,0,0,1,224,128Z" />
                    )}
                  </svg>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-slate-400">{isSell ? 'Fund Sell Order' : 'Fund Buy Order'}</p>
                  <h2 className="mt-0.5 text-2xl font-bold text-white">
                    {isSell ? 'Sell' : 'Buy'} {amountBtq} BTQ at {priceUsdt} USDT
                  </h2>
                  <p className="mt-0.5 text-sm text-slate-400">{totalUsdt} USDT total</p>
                </div>
              </div>
              <button onClick={onClose} className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-800 hover:text-white">
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          <div className="px-6 py-5 space-y-4">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-400">Lock duration (minutes)</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  max={10080}
                  step={1}
                  value={timelockMinutes}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isNaN(n)) return;
                    updateTimelockMinutes(n);
                  }}
                  className="w-32 rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-white outline-none focus:border-blue-500 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                />
                <div className="flex gap-1">
                  {[15, 30, 60, 120].map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => updateTimelockMinutes(m)}
                      className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                        timelockMinutes === m
                          ? 'bg-blue-600 text-white'
                          : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-200'
                      }`}
                    >
                      {m}m
                    </button>
                  ))}
                </div>
              </div>
              <p className="mt-1 text-[11px] text-slate-500">
                Sets how long funds stay locked before recovery is available (now + {timelockMinutes} minutes).
              </p>
              {isSell && (
                <p className="mt-1 text-[11px] text-amber-400/90">
                  For sell orders, this is a target only. Make sure your BTQ CLI lock uses a compatible duration.
                </p>
              )}
            </div>

            {isSell && (
              <div className="rounded-xl border border-slate-700/70 bg-slate-800/40 px-4 py-3">
                <p className="text-xs text-slate-300">
                  Verification hash
                </p>
                <p className="mt-1 break-all font-mono text-[11px] text-blue-300">
                  {activeHash || 'Computing...'}
                </p>
              </div>
            )}

            {isSell && (
              <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 px-4 py-3">
                <p className="text-xs font-semibold text-blue-300">Run these CLI steps in order</p>
                {sellContextLoading ? (
                  <p className="mt-2 text-[11px] text-slate-300">Loading matching buy order context...</p>
                ) : sellContextError ? (
                  <p className="mt-2 text-[11px] text-amber-300">
                    {sellContextError}
                  </p>
                ) : null}
                {sellFundingContext?.counterpartyDilithiumPubkey ? (
                  <div className="mt-2 rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5">
                    <p className="text-[10px] uppercase tracking-wide text-slate-400">Counterparty claim pubkey</p>
                    <p className="mt-1 break-all font-mono text-[11px] text-slate-200">
                      {sellFundingContext.counterpartyDilithiumPubkey}
                    </p>
                  </div>
                ) : null}
                <ol className="mt-2 space-y-2 text-[11px] text-slate-300">
                  <li>
                    1) Create a P2MR HTLC address:
                    <code className="mt-1 block overflow-x-auto rounded bg-slate-800 px-2 py-1.5 font-mono text-blue-300">
                      {sellFundingCommands?.createAddressCommand || 'Loading command...'}
                    </code>
                  </li>
                  <li>
                    2) Find the created entry (get address + p2mr_id from output):
                    <code className="mt-1 block overflow-x-auto rounded bg-slate-800 px-2 py-1.5 font-mono text-blue-300">
                      {sellFundingCommands?.listP2mrCommand || 'Loading command...'}
                    </code>
                  </li>
                  <li>
                    3) Fund that P2MR address:
                    <code className="mt-1 block overflow-x-auto rounded bg-slate-800 px-2 py-1.5 font-mono text-blue-300">
                      {sellFundingCommands?.sendToAddressCommand || 'Loading command...'}
                    </code>
                  </li>
                  <li>
                    4) Confirm tx details and output index:
                    <code className="mt-1 block overflow-x-auto rounded bg-slate-800 px-2 py-1.5 font-mono text-blue-300">
                      {sellFundingCommands?.verifyTxCommand || 'Loading command...'}
                    </code>
                  </li>
                  <li>
                    5) Check that the HTLC output is P2MR and has at least {amountBtq} BTQ.
                    Set the exact P2MR output index below (for your tx, this is often <span className="font-mono text-slate-200">1</span>).
                  </li>
                  <li>
                    6) Paste that txid below and submit funding.
                  </li>
                </ol>
                {sellCommandsLoading ? (
                  <p className="mt-2 text-[10px] text-slate-400">Refreshing commands for current hash/timelock...</p>
                ) : null}
                {sellCommandsError ? (
                  <p className="mt-2 text-[10px] text-amber-300">{sellCommandsError}</p>
                ) : null}
                <p className="mt-2 text-[10px] text-slate-400">
                  This app validates txid/vout/amount on-chain today. If there is no matching buy pubkey context yet, wait for an active funded buy order.
                </p>
              </div>
            )}

            {/* Sell: BTQ lock transaction id */}
            {isSell && (
              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-400">BTQ lock transaction ID</label>
                <p className="mb-2 text-[11px] text-slate-500">
                  Create the BTQ lock with the hash above, then paste the txid:
                </p>
                <input
                  value={txid}
                  onChange={(e) => setTxid(e.target.value)}
                  placeholder="64-character transaction hash..."
                  className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2.5 font-mono text-sm text-white placeholder-slate-500 outline-none focus:border-blue-500"
                />
                <label className="mb-1.5 mt-3 block text-xs font-medium text-slate-400">HTLC output index (vout)</label>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={htlcVout}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    if (Number.isNaN(next)) return;
                    setHtlcVout(Math.max(0, Math.floor(next)));
                  }}
                  className="w-32 rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-white outline-none focus:border-blue-500 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                />
                <p className="mt-1 text-[11px] text-slate-500">
                  Use the P2MR output index from <span className="font-mono text-slate-300">getrawtransaction</span> (e.g. <span className="font-mono text-slate-300">1</span>).
                </p>
              </div>
            )}

            {/* Buy: step indicators */}
            {isBuy && (
              <>
                <div className="flex items-center gap-2">
                  {['Approve USDT', 'Lock funds'].map((label, i) => {
                    const isApprove = step === 'approve';
                    const isLock = step === 'lock';
                    const isDone = i === 0 && isLock;
                    const isActive = (i === 0 && isApprove) || (i === 1 && isLock);
                    return (
                      <div key={label} className="flex flex-1 flex-col items-center gap-1">
                        <div className={`flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold ${
                          isDone ? 'bg-emerald-500 text-white' : isActive ? 'bg-blue-500 text-white' : 'bg-slate-700 text-slate-400'
                        }`}>
                          {isDone ? '✓' : i + 1}
                        </div>
                        <span className={`text-[10px] ${isActive ? 'text-white' : 'text-slate-500'}`}>{label}</span>
                      </div>
                    );
                  })}
                </div>

                {step === 'approve' && (
                  <div className="rounded-xl bg-slate-800/50 px-4 py-3 text-center">
                    <p className="text-sm text-slate-300">
                      Approve the lock contract to spend <strong className="text-white">{totalUsdt} USDT</strong>
                    </p>
                  </div>
                )}

                {step === 'lock' && (
                  <div className="rounded-xl bg-slate-800/50 px-4 py-3 text-center">
                    <p className="text-sm text-slate-300">
                      Lock <strong className="text-white">{totalUsdt} USDT</strong> with your selected lock duration
                    </p>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-3 border-t border-slate-700/50 px-6 py-4">
            <button onClick={onClose}
              className="rounded-xl border border-slate-600 px-4 py-2 text-sm font-medium text-slate-400 transition-colors hover:bg-slate-800 hover:text-white">
              Cancel
            </button>

            {isSell && (
              <button onClick={handleSellSubmit} disabled={loading || !hashReady || !txid.trim() || sellContextLoading || !sellFundingContext?.counterpartyDilithiumPubkey || sellCommandsLoading || !!sellCommandsError}
                className="rounded-xl bg-blue-600 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500">
                {loading ? 'Submitting...' : 'Submit Funding'}
              </button>
            )}

            {isBuy && step === 'approve' && (
              <button onClick={handleBuyApprove} disabled={loading || !hashReady}
                className="rounded-xl bg-emerald-600 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500">
                {loading ? 'Approving...' : 'Approve in MetaMask'}
              </button>
            )}

            {isBuy && step === 'lock' && (
              <button onClick={handleBuyLock} disabled={loading}
                className="rounded-xl bg-emerald-600 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500">
                {loading ? 'Locking...' : 'Lock USDT'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
