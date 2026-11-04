import { useEffect, useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import toast from 'react-hot-toast';
import { useAccount, usePublicClient, useWriteContract } from 'wagmi';
import { decodeEventLog } from 'viem';
import { useOrders } from '../../hooks/useOrders';
import { useAuthStore } from '../../store/authStore';
import { FundOrderModal } from './FundOrderModal';
import { api } from '../../lib/api';
import { HTLC_CONTRACT_ADDRESS } from '../../lib/constants';
import type { Order } from '../../types';

const HTLC_TIMELOCK_MS = 3600 * 1000;

function TimelockBar({
  fundedAt,
  expiresAt,
  settledState,
  isSyncing,
}: {
  fundedAt: string;
  expiresAt?: string | null;
  settledState?: 'redeemed' | 'claimed' | null;
  isSyncing?: boolean;
}) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);

  const start = new Date(fundedAt).getTime();
  const end = expiresAt ? new Date(expiresAt).getTime() : (start + HTLC_TIMELOCK_MS);
  const totalDuration = Number.isFinite(start) && Number.isFinite(end) && end > start
    ? (end - start)
    : HTLC_TIMELOCK_MS;
  const elapsed = now - start;
  const remaining = Math.max(0, end - now);
  const pct = Math.min(100, (elapsed / totalDuration) * 100);

  const mins = Math.floor(remaining / 60000);
  const secs = Math.floor((remaining % 60000) / 1000);

  const isExpired = remaining <= 0;
  const isWarning = !isExpired && remaining < 600_000;
  const isSettled = settledState === 'redeemed' || settledState === 'claimed';

  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-700">
        <div
          className={`h-full rounded-full transition-all ${
            isSettled
              ? 'bg-emerald-500'
              : isSyncing
                ? 'bg-slate-500'
              : isExpired
                ? 'bg-red-500'
                : isWarning
                  ? 'bg-amber-500'
                  : 'bg-blue-500'
          }`}
          style={{ width: `${isSettled ? 100 : pct}%` }}
        />
      </div>
      <span className={`whitespace-nowrap font-mono text-[10px] ${
        isSettled
          ? 'text-emerald-400'
          : isSyncing
            ? 'text-slate-400'
          : isExpired
            ? 'text-red-400'
            : isWarning
              ? 'text-amber-400'
              : 'text-slate-400'
      }`}>
        {isSettled
          ? (settledState === 'redeemed' ? 'Redeemed' : 'Claimed')
          : isSyncing
            ? 'Syncing...'
          : (isExpired ? 'Redeemable' : `${mins}m ${secs.toString().padStart(2, '0')}s`)}
      </span>
    </div>
  );
}

function CancelConfirmModal({ onConfirm, onCancel }: { onConfirm: (dontAsk: boolean) => void; onCancel: () => void }) {
  const [dontAsk, setDontAsk] = useState(false);

  return createPortal(
    <div className="fixed inset-0 z-[9999] overflow-y-auto bg-black/70 backdrop-blur-sm" onClick={onCancel}>
      <div className="flex min-h-full items-center justify-center p-4">
        <div className="w-full max-w-sm rounded-2xl border border-slate-700/50 bg-slate-900 shadow-2xl" onClick={(e) => e.stopPropagation()}>
          <div className="px-6 py-5">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-red-500/10">
              <svg className="h-6 w-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126z" />
              </svg>
            </div>
            <h3 className="text-base font-semibold text-white">Cancel Order</h3>
            <p className="mt-1 text-sm text-slate-400">
              Are you sure you want to cancel this order? This action cannot be undone.
            </p>
          </div>
          <div className="px-6 pb-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-slate-600 bg-slate-800 text-blue-500 focus:ring-0" />
              <span className="text-xs text-slate-500">Don't ask me again</span>
            </label>
          </div>
          <div className="flex gap-3 px-6 py-4">
            <button onClick={onCancel}
              className="flex-1 rounded-xl border border-slate-600 py-2.5 text-sm font-medium text-slate-400 transition-colors hover:bg-slate-800 hover:text-white">
              Keep Order
            </button>
            <button onClick={() => onConfirm(dontAsk)}
              className="flex-1 rounded-xl bg-red-600 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-red-500">
              Cancel Order
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

interface OrderDetailResponse {
  order: {
    id: string;
    status: string;
    direction: string;
    amount_btq: string;
    filled_btq: string;
    price_usdt: string;
    is_funded: boolean;
    secret_hash?: unknown;
    btq_htlc_txid?: string | null;
    btq_htlc_vout?: number | null;
    user_dilithium_pubkey?: string | null;
    user_btq_address?: string | null;
    expires_at?: string | null;
    created_at: string;
    locked_by_swap_id?: string | null;
  };
}

interface FundingStatusResponse {
  status: {
    orderId: string;
    direction: string;
    status: string;
    isFunded: boolean;
    txid: string | null;
    submittedVout: number | null;
    inspectedAt: string;
    btq?: {
      txFound: boolean;
      confirmations: number;
      expectedAmountBtq: number;
      resolvedVout: number | null;
      outputValueBtq: number | null;
      outputType: string | null;
      outputAddress: string | null;
      isP2mrOutput: boolean;
      amountSufficient: boolean;
      verified: boolean;
      reason: string;
    };
    evm?: {
      txFound: boolean;
      txSuccess: boolean;
      blockNumber: number | null;
      confirmations: number;
      agreementId: string | null;
      partyA: string | null;
      partyB: string | null;
      secretlock: string | null;
      deadline: number | null;
      expiresAt: string | null;
      tokenAmount: string | null;
      tokenContract: string | null;
      htlcContract: string;
      verified: boolean;
      reason: string;
    };
  };
}

interface OrderSettlementResponse {
  settlement: {
    swapId: string | null;
    swap: {
      id: string;
      status: string;
      rawStatus?: string;
      direction: string;
      btq_claim_txid?: string | null;
      evm_htlc_tx_hash?: string | null;
      evmSwapIdHex?: `0x${string}` | null;
      counterparty?: {
        orderId: string;
        isFunded: boolean;
        btqHtlcTxid: string | null;
        btqHtlcVout: number | null;
        userDilithiumPubkey: string | null;
        userBtqAddress: string | null;
      } | null;
      events?: Array<{ event_type?: string; to_status?: string; created_at?: string }>;
    } | null;
    commands: Record<string, string> | null;
  };
}

const HTLC_ERC20_UI_ABI = [
  {
    type: 'event',
    name: 'HTLCERC20Lockup',
    inputs: [
      { indexed: true, name: 'agreementId', type: 'bytes32' },
      { indexed: true, name: 'partyA', type: 'address' },
      { indexed: true, name: 'partyB', type: 'address' },
      { indexed: false, name: 'secretlock', type: 'bytes32' },
      { indexed: false, name: 'deadline', type: 'uint32' },
      { indexed: false, name: 'tokenAmount', type: 'uint256' },
      { indexed: false, name: 'erc20Contract', type: 'address' },
      { indexed: false, name: 'otherNetwork', type: 'string' },
      { indexed: false, name: 'otherAsset', type: 'string' },
      { indexed: false, name: 'otherAmount', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'getHTLCInstance',
    stateMutability: 'view',
    inputs: [{ name: '_htlcInstanceId', type: 'bytes32' }],
    outputs: [
      { name: 'partyA', type: 'address' },
      { name: 'partyB', type: 'address' },
      { name: 'erc20Contract', type: 'address' },
      { name: 'tokenAmount', type: 'uint256' },
      { name: 'secretlock', type: 'bytes32' },
      { name: 'deadline', type: 'uint32' },
      { name: 'tokensWithdrawn', type: 'bool' },
      { name: 'tokensRefunded', type: 'bool' },
      { name: 'key', type: 'bytes32' },
      { name: 'otherNetwork', type: 'string' },
      { name: 'otherAsset', type: 'string' },
      { name: 'otherAmount', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'withdrawTokens',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_htlcInstanceId', type: 'bytes32' },
      { name: '_secretKey', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'refundTokens',
    stateMutability: 'nonpayable',
    inputs: [{ name: '_htlcInstanceId', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

type EvmAgreementSnapshot = {
  agreementId: `0x${string}`;
  partyA: string;
  deadline: number;
  tokensWithdrawn: boolean;
  tokensRefunded: boolean;
};

async function resolveEvmAgreementSnapshot(
  publicClient: NonNullable<ReturnType<typeof usePublicClient>>,
  lockTxid: `0x${string}`,
): Promise<EvmAgreementSnapshot | null> {
  const receipt = await publicClient.getTransactionReceipt({ hash: lockTxid });
  let foundAgreement: `0x${string}` | null = null;

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== HTLC_CONTRACT_ADDRESS.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: HTLC_ERC20_UI_ABI,
        data: log.data,
        topics: log.topics,
        strict: false,
      });
      if (decoded.eventName === 'HTLCERC20Lockup') {
        foundAgreement = (decoded.args.agreementId ?? null) as `0x${string}` | null;
        break;
      }
    } catch {
      // ignore unmatched logs
    }
  }

  if (!foundAgreement) return null;

  const instance = await publicClient.readContract({
    address: HTLC_CONTRACT_ADDRESS,
    abi: HTLC_ERC20_UI_ABI,
    functionName: 'getHTLCInstance',
    args: [foundAgreement],
  });

  const vals = instance as unknown as readonly unknown[];
  return {
    agreementId: foundAgreement,
    partyA: String(vals[0] ?? ''),
    deadline: Number(vals[5] ?? 0),
    tokensWithdrawn: Boolean(vals[6]),
    tokensRefunded: Boolean(vals[7]),
  };
}

function formatDateTime(value?: string | null): string {
  if (!value) return 'Unknown';
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return 'Unknown';
  return dt.toLocaleString();
}

function StatusHeroIcon({ status }: { status: 'redeemed' | 'claimed' | 'ready' | 'active' | 'pending' }) {
  if (status === 'redeemed' || status === 'claimed') {
    return (
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/15">
        <svg className="h-10 w-10 text-emerald-400" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
          <path d="M229.66,77.66l-96,96a8,8,0,0,1-11.32,0l-48-48a8,8,0,0,1,11.32-11.32L128,156.69l90.34-90.35a8,8,0,0,1,11.32,11.32Z" />
        </svg>
      </div>
    );
  }
  if (status === 'ready') {
    return (
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-amber-500/15">
        <svg className="h-8 w-8 text-amber-300" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
          <path d="M224,128A96,96,0,1,1,128,32a96.11,96.11,0,0,1,96,96Zm-88-56a8,8,0,0,0-16,0v64a8,8,0,0,0,8,8h40a8,8,0,0,0,0-16H136Z" />
        </svg>
      </div>
    );
  }
  return (
    <div className="flex h-14 w-14 items-center justify-center rounded-full bg-blue-500/15">
      <svg className="h-8 w-8 text-blue-300" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
        <path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm8,96a8,8,0,0,1-16,0V72a8,8,0,0,1,16,0Zm-8,64a12,12,0,1,1,12-12A12,12,0,0,1,128,184Z" />
      </svg>
    </div>
  );
}

function RedeemButton({
  enabled,
  loading,
  onClick,
  tooltip,
}: {
  enabled: boolean;
  loading: boolean;
  onClick: () => void;
  tooltip: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="relative block w-full"
      onMouseEnter={() => setOpen(!enabled)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        onClick={onClick}
        disabled={!enabled || loading}
        className={`w-full rounded-xl px-5 py-3 text-sm font-semibold transition-colors ${
          enabled
            ? 'bg-emerald-600 text-white hover:bg-emerald-500'
            : 'cursor-not-allowed bg-slate-700 text-slate-400'
        }`}
      >
        {loading ? 'Recovering...' : 'Recover Funds'}
      </button>
      {open && (
        <div className="pointer-events-none absolute left-1/2 top-full z-10 mt-2 w-64 -translate-x-1/2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200 shadow-lg">
          {tooltip}
        </div>
      )}
    </div>
  );
}

function ModalTimelockProgress({
  createdAt,
  expiresAt,
}: {
  createdAt?: string | null;
  expiresAt?: string | null;
}) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);

  const startMs = createdAt ? new Date(createdAt).getTime() : NaN;
  const endMs = expiresAt ? new Date(expiresAt).getTime() : NaN;

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return (
      <div className="rounded-lg border border-slate-700/60 bg-slate-800/60 p-3">
        <p className="text-xs text-slate-500">Timelock progress unavailable</p>
      </div>
    );
  }

  const duration = endMs - startMs;
  const elapsed = Math.max(0, now - startMs);
  const remaining = Math.max(0, endMs - now);
  const pct = Math.min(100, (elapsed / duration) * 100);
  const mins = Math.floor(remaining / 60000);
  const secs = Math.floor((remaining % 60000) / 1000);
  const expired = remaining <= 0;
  const warning = !expired && remaining < 10 * 60 * 1000;

  return (
    <div className="rounded-lg border border-slate-700/60 bg-slate-800/60 p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-medium text-slate-400">Order expiry in</p>
        <span className={`font-mono text-xs ${expired ? 'text-red-400' : warning ? 'text-amber-300' : 'text-blue-300'}`}>
          {expired ? 'Expired' : `${mins}m ${secs.toString().padStart(2, '0')}s left`}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-700">
        <div
          className={`h-full rounded-full transition-all ${expired ? 'bg-red-500' : warning ? 'bg-amber-500' : 'bg-blue-500'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function RedeemUrgentModal({
  order,
  onOpen,
  onDismiss,
}: {
  order: Order;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  return createPortal(
    <div className="fixed inset-0 z-[9999] overflow-y-auto bg-black/70 backdrop-blur-sm" onClick={onDismiss}>
      <div className="flex min-h-full items-center justify-center p-4">
        <div className="w-full max-w-md rounded-2xl border border-red-500/40 bg-slate-900 shadow-2xl" onClick={(e) => e.stopPropagation()}>
          <div className="px-6 py-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-red-400">Action required</p>
            <h3 className="mt-1 text-lg font-semibold text-white">Recover Funds Now</h3>
            <p className="mt-2 text-sm text-slate-300">
              A funded lock is ready for recovery. Open details now and recover funds immediately.
            </p>
            <p className="mt-2 font-mono text-xs text-slate-500">{order.id}</p>
          </div>
          <div className="flex gap-3 border-t border-slate-700/50 px-6 py-4">
            <button
              onClick={onDismiss}
              className="flex-1 rounded-xl border border-slate-600 py-2.5 text-sm font-medium text-slate-400 hover:bg-slate-800 hover:text-white"
            >
              Later
            </button>
            <button
              onClick={onOpen}
              className="flex-1 rounded-xl bg-red-600 py-2.5 text-sm font-semibold text-white hover:bg-red-500"
            >
              Open Now
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function OrderDetailsModal({
  order,
  onClose,
  onCancel,
  onSettlementStateChange,
}: {
  order: Order;
  onClose: () => void;
  onCancel?: (orderId: string) => void;
  onSettlementStateChange?: (orderId: string, state: 'redeemed' | 'claimed') => void;
}) {
  const [detail, setDetail] = useState<OrderDetailResponse['order'] | null>(null);
  const [fundingStatus, setFundingStatus] = useState<FundingStatusResponse['status'] | null>(null);
  const [fundingStatusLoading, setFundingStatusLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [settlement, setSettlement] = useState<OrderSettlementResponse['settlement'] | null>(null);
  const [settlementLoading, setSettlementLoading] = useState(false);
  const [claimTxid, setClaimTxid] = useState('');
  const [confirmingClaim, setConfirmingClaim] = useState(false);
  const [secretInput, setSecretInput] = useState('');
  const [claimingUsdt, setClaimingUsdt] = useState(false);
  const [agreementId, setAgreementId] = useState<`0x${string}` | null>(null);
  const [htlcState, setHtlcState] = useState<{
    partyA: string;
    deadline: number;
    tokensWithdrawn: boolean;
    tokensRefunded: boolean;
  } | null>(null);
  const [redeeming, setRedeeming] = useState(false);
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    api.get<OrderDetailResponse>(`/orders/${order.id}`)
      .then((res) => {
        if (mounted) setDetail(res.order);
      })
      .catch(() => {
        if (mounted) setDetail(null);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => { mounted = false; };
  }, [order.id]);

  const refreshSettlement = useCallback(async () => {
    setSettlementLoading(true);
    try {
      const res = await api.get<OrderSettlementResponse>(`/orders/${order.id}/settlement`);
      setSettlement(res.settlement);
    } catch {
      setSettlement(null);
    } finally {
      setSettlementLoading(false);
    }
  }, [order.id]);

  useEffect(() => {
    void refreshSettlement();
    const iv = setInterval(() => {
      void refreshSettlement();
    }, 12_000);
    return () => clearInterval(iv);
  }, [refreshSettlement]);

  const refreshFundingStatus = useCallback(async () => {
    setFundingStatusLoading(true);
    try {
      const res = await api.get<FundingStatusResponse>(`/orders/${order.id}/funding-status`);
      setFundingStatus(res.status);
    } catch {
      setFundingStatus(null);
    } finally {
      setFundingStatusLoading(false);
    }
  }, [order.id]);

  useEffect(() => {
    void refreshFundingStatus();
    const iv = setInterval(() => {
      void refreshFundingStatus();
    }, 12_000);
    return () => clearInterval(iv);
  }, [refreshFundingStatus]);

  useEffect(() => {
    let cancelled = false;
    const resolveEvmAgreementAndState = async () => {
      if (!publicClient || !detail?.btq_htlc_txid?.startsWith('0x')) {
        setAgreementId(null);
        setHtlcState(null);
        return;
      }
      try {
        const txHash = detail.btq_htlc_txid as `0x${string}`;
        const snapshot = await resolveEvmAgreementSnapshot(publicClient, txHash);
        if (!snapshot) {
          if (!cancelled) {
            setAgreementId(null);
            setHtlcState(null);
          }
          return;
        }

        if (!cancelled) {
          setAgreementId(snapshot.agreementId);
          setHtlcState({
            partyA: snapshot.partyA,
            deadline: snapshot.deadline,
            tokensWithdrawn: snapshot.tokensWithdrawn,
            tokensRefunded: snapshot.tokensRefunded,
          });
        }
      } catch {
        if (!cancelled) {
          setAgreementId(null);
          setHtlcState(null);
        }
      }
    };
    void resolveEvmAgreementAndState();
    return () => { cancelled = true; };
  }, [detail?.btq_htlc_txid, publicClient]);

  useEffect(() => {
    if (!htlcState) return;
    if (htlcState.tokensRefunded) {
      onSettlementStateChange?.(order.id, 'redeemed');
      return;
    }
    if (htlcState.tokensWithdrawn) {
      onSettlementStateChange?.(order.id, 'claimed');
    }
  }, [htlcState, order.id, onSettlementStateChange]);

  const isFunded = detail?.is_funded ?? (order as any).isFunded ?? false;
  const isEvmFunding = (detail?.btq_htlc_txid || '').startsWith('0x');
  const remaining = detail
    ? Math.max(0, parseFloat(detail.amount_btq || '0') - parseFloat(detail.filled_btq || '0'))
    : Math.max(0, parseFloat(order.btqAmount || '0') - parseFloat(order.filledAmount || '0'));
  const status = detail?.status ?? order.status;
  const nowSec = Math.floor(Date.now() / 1000);
  const effectiveExpirySec = (isEvmFunding && (htlcState?.deadline ?? 0) > 0)
    ? (htlcState?.deadline ?? 0)
    : null;
  const effectiveExpiresAt = effectiveExpirySec
    ? new Date(effectiveExpirySec * 1000).toISOString()
    : (detail?.expires_at ?? null);
  const isExpiredOnChain = (htlcState?.deadline ?? 0) > 0 && nowSec >= (htlcState?.deadline ?? 0);
  const connectedMatchesPartyA = !!address && !!htlcState?.partyA && address.toLowerCase() === htlcState.partyA.toLowerCase();
  const settled = settledStateFromChain(htlcState);
  const canRedeem =
    isFunded &&
    isEvmFunding &&
    !!agreementId &&
    !!htlcState &&
    isExpiredOnChain &&
    !htlcState.tokensWithdrawn &&
    !htlcState.tokensRefunded &&
    connectedMatchesPartyA;
  const showRedeemControl = isFunded && settled !== 'redeemed' && settled !== 'claimed';
  const showCancelPendingFunding = !isFunded && order.side === 'sell' && (status === 'open' || status === 'partially_filled');
  const redeemTooltip = !isExpiredOnChain
    ? 'You can redeem the funds when the timer runs out.'
    : !connectedMatchesPartyA
      ? 'Connect the wallet that funded this order to redeem.'
      : 'Redeem will unlock once on-chain details finish loading.';

  const handleRedeem = async () => {
    if (!canRedeem || !agreementId || !publicClient) return;
    setRedeeming(true);
    try {
      const txHash = await writeContractAsync({
        address: HTLC_CONTRACT_ADDRESS,
        abi: HTLC_ERC20_UI_ABI,
        functionName: 'refundTokens',
        args: [agreementId],
      });
      toast.loading('Waiting for redeem confirmation...', { id: 'redeem-order' });
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      toast.success('Funds recovered successfully.', { id: 'redeem-order' });
      onSettlementStateChange?.(order.id, 'redeemed');
      onClose();
    } catch (err) {
      toast.dismiss('redeem-order');
      toast.error(err instanceof Error ? err.message : 'Failed to recover funds');
    } finally {
      setRedeeming(false);
    }
  };

  const handleConfirmBtqClaim = async () => {
    if (!claimTxid.trim()) return;
    setConfirmingClaim(true);
    try {
      await api.post(`/orders/${order.id}/confirm-btq-claim`, { btq_claim_txid: claimTxid.trim() });
      toast.success('BTQ claim recorded. Swap marked complete.');
      await refreshSettlement();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to confirm BTQ claim');
    } finally {
      setConfirmingClaim(false);
    }
  };

  const copyCommand = async (value: string) => {
    await navigator.clipboard.writeText(value);
    toast.success('Command copied');
  };

  const handleClaimUsdtOnEvm = async () => {
    const swapIdHex = settlement?.swap?.evmSwapIdHex;
    const cleanSecret = secretInput.trim().replace(/^0x/, '');
    if (!swapIdHex) {
      toast.error('Missing EVM swap id');
      return;
    }
    if (!/^[0-9a-fA-F]{64}$/.test(cleanSecret)) {
      toast.error('Secret must be 32-byte hex');
      return;
    }
    if (!publicClient) {
      toast.error('Wallet client unavailable');
      return;
    }
    setClaimingUsdt(true);
    try {
      const txHash = await writeContractAsync({
        address: HTLC_CONTRACT_ADDRESS,
        abi: HTLC_ERC20_UI_ABI,
        functionName: 'withdrawTokens',
        args: [swapIdHex, `0x${cleanSecret}` as `0x${string}`],
      });
      toast.loading('Waiting for EVM claim confirmation...', { id: 'claim-usdt' });
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      toast.success('USDT claim transaction confirmed.', { id: 'claim-usdt' });
      await refreshSettlement();
    } catch (err) {
      toast.dismiss('claim-usdt');
      toast.error(err instanceof Error ? err.message : 'Failed to claim USDT');
    } finally {
      setClaimingUsdt(false);
    }
  };

  const visualStatus = settledStateLabel(settled, isFunded, isExpiredOnChain);
  const heroStatus: 'redeemed' | 'claimed' | 'ready' | 'active' | 'pending' =
    settled === 'redeemed'
      ? 'redeemed'
      : settled === 'claimed'
        ? 'claimed'
        : !isFunded
          ? 'pending'
          : isExpiredOnChain
            ? 'ready'
            : 'active';
  const amountBtq = parseFloat(detail?.amount_btq ?? order.btqAmount ?? '0');
  const amountUsdt = amountBtq * parseFloat(order.price || '0');
  const summary = buildOrderSummarySentence({
    side: order.side,
    isFunded,
    settled,
    isExpiredOnChain,
    canRedeem,
    amountUsdt,
    amountBtq,
  });
  const orderedClaimCommands = settlement?.commands
    ? (['createSpend', 'signTransaction', 'broadcastTransaction'] as const)
      .filter((name) => typeof settlement.commands?.[name] === 'string')
      .map((name) => [name, settlement.commands![name] as string] as const)
    : [];
  const destinationAddress =
    (detail?.user_btq_address && detail.user_btq_address.trim().length > 0)
      ? detail.user_btq_address.trim()
      : '<your_btq_address>';
  const generatedClaimCommands = settlement?.swap?.counterparty?.btqHtlcTxid
    ? [
      `btq-cli -regtest getrawtransaction ${settlement.swap.counterparty.btqHtlcTxid} true`,
      'btq-cli -regtest -rpcwallet=swap-wallet listp2mr',
      `btq-cli -regtest -rpcwallet=swap-wallet createp2mrspend "<p2mr_id_from_listp2mr>" "${destinationAddress}" <amount_minus_fee> 0.00001`,
      `btq-cli -regtest -rpcwallet=swap-wallet signp2mrtransaction "<unsigned_hex>" "<p2mr_id_from_listp2mr>" '["${secretInput.trim().replace(/^0x/, '') || '<your_secret_hex>'}"]' "<claim_leaf_hex>" "<control_block_hex>"`,
      'btq-cli -regtest sendrawtransaction "<signed_hex>"',
    ]
    : [];

  return createPortal(
    <div className="fixed inset-0 z-[9999] overflow-y-auto bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className="flex min-h-full items-center justify-center p-4">
        <div
          className="w-full max-w-2xl rounded-2xl border border-slate-700/50 bg-slate-900 shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-start justify-between border-b border-slate-700/50 px-6 py-4">
            <div>
              <h3 className="text-lg font-semibold text-white">Order Update</h3>
            </div>
            <button onClick={onClose} className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-800 hover:text-white">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="px-6 py-5">
            <div className="mb-3 flex items-center gap-3">
              <StatusHeroIcon status={heroStatus} />
              <div>
                <p className="text-sm font-medium text-white">{visualStatus}</p>
                <p className="text-sm leading-relaxed text-slate-200">{summary}</p>
              </div>
            </div>
          </div>

          <div className="px-6 pb-5">
            <ModalTimelockProgress
              createdAt={detail?.created_at ?? order.createdAt}
              expiresAt={effectiveExpiresAt}
            />
          </div>

          <div className="border-t border-slate-700/50 px-6 py-5">
            {showRedeemControl ? (
              <RedeemButton
                enabled={canRedeem}
                loading={redeeming}
                onClick={handleRedeem}
                tooltip={redeemTooltip}
              />
            ) : null}
            {showCancelPendingFunding ? (
              <button
                onClick={() => {
                  onCancel?.(order.id);
                  onClose();
                }}
                className="w-full rounded-xl border border-red-500/40 bg-red-500/10 px-5 py-3 text-sm font-semibold text-red-300 transition-colors hover:bg-red-500/20 hover:text-red-200"
              >
                Cancel Order
              </button>
            ) : null}

            <div className="mt-4 rounded-lg border border-slate-700/60 bg-slate-800/30 p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Transaction Verification</p>
                <div className="flex items-center gap-2">
                  {fundingStatus?.btq || fundingStatus?.evm ? (
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                      ((fundingStatus.evm?.verified ?? false) || (fundingStatus.btq?.verified ?? false))
                        ? 'bg-emerald-500/15 text-emerald-400'
                        : 'bg-amber-500/15 text-amber-300'
                    }`}>
                      {((fundingStatus.evm?.verified ?? false) || (fundingStatus.btq?.verified ?? false)) ? 'Verified' : 'Needs attention'}
                    </span>
                  ) : null}
                  <button
                    onClick={() => void refreshFundingStatus()}
                    className="rounded-md border border-slate-600 px-2 py-0.5 text-[10px] text-slate-300 hover:bg-slate-700"
                  >
                    {fundingStatusLoading ? 'Refreshing...' : 'Refresh'}
                  </button>
                </div>
              </div>
              <div className="space-y-1.5 text-xs text-slate-300">
                {fundingStatus?.evm ? (
                  <>
                    <p>
                      Chain:
                      <span className="ml-1 font-mono text-slate-200">EVM (USDT HTLC)</span>
                    </p>
                    <p>
                      Txid:
                      <span className="ml-1 break-all font-mono text-slate-200">{fundingStatus.txid ?? 'n/a'}</span>
                    </p>
                    <p>
                      HTLC Contract:
                      <span className="ml-1 break-all font-mono text-slate-200">{fundingStatus.evm.htlcContract}</span>
                    </p>
                    <p>
                      Agreement ID:
                      <span className="ml-1 break-all font-mono text-slate-200">{fundingStatus.evm.agreementId ?? 'n/a'}</span>
                    </p>
                    <p>
                      Party A:
                      <span className="ml-1 break-all font-mono text-slate-200">{fundingStatus.evm.partyA ?? 'n/a'}</span>
                    </p>
                    <p>
                      Party B:
                      <span className="ml-1 break-all font-mono text-slate-200">{fundingStatus.evm.partyB ?? 'n/a'}</span>
                    </p>
                    <p>
                      Secretlock:
                      <span className="ml-1 break-all font-mono text-slate-200">{fundingStatus.evm.secretlock ?? 'n/a'}</span>
                    </p>
                    <p>
                      Token Contract:
                      <span className="ml-1 break-all font-mono text-slate-200">{fundingStatus.evm.tokenContract ?? 'n/a'}</span>
                    </p>
                    <p>
                      Token Amount:
                      <span className="ml-1 font-mono text-slate-200">{fundingStatus.evm.tokenAmount ?? 'n/a'}</span>
                    </p>
                    <p>
                      Deadline:
                      <span className="ml-1 font-mono text-slate-200">
                        {fundingStatus.evm.expiresAt ? formatDateTime(fundingStatus.evm.expiresAt) : 'n/a'}
                      </span>
                    </p>
                    <p>
                      Confirmations:
                      <span className="ml-1 font-mono text-slate-200">{fundingStatus.evm.confirmations}</span>
                    </p>
                    <p>
                      Tx Success:
                      <span className="ml-1 font-mono text-slate-200">{fundingStatus.evm.txSuccess ? 'yes' : 'no'}</span>
                    </p>
                    <p>
                      Check result:
                      <span className="ml-1 text-slate-200">{fundingStatus.evm.reason}</span>
                    </p>
                  </>
                ) : null}
                {fundingStatus?.btq ? (
                  <>
                <p>
                  Txid:
                  <span className="ml-1 break-all font-mono text-slate-200">{fundingStatus?.txid ?? detail?.btq_htlc_txid ?? 'n/a'}</span>
                </p>
                <p>
                  Submitted vout:
                  <span className="ml-1 font-mono text-slate-200">{fundingStatus?.submittedVout ?? detail?.btq_htlc_vout ?? 'n/a'}</span>
                </p>
                <p>
                  Resolved vout:
                  <span className="ml-1 font-mono text-slate-200">{fundingStatus?.btq?.resolvedVout ?? 'n/a'}</span>
                </p>
                <p>
                  Output type:
                  <span className="ml-1 font-mono text-slate-200">{fundingStatus?.btq?.outputType ?? 'n/a'}</span>
                </p>
                <p>
                  Output amount:
                  <span className="ml-1 font-mono text-slate-200">
                    {fundingStatus?.btq?.outputValueBtq != null
                      ? `${Number(fundingStatus.btq.outputValueBtq).toFixed(8)} BTQ`
                      : 'n/a'}
                  </span>
                </p>
                <p>
                  Expected amount:
                  <span className="ml-1 font-mono text-slate-200">
                    {fundingStatus?.btq?.expectedAmountBtq != null
                      ? `${Number(fundingStatus.btq.expectedAmountBtq).toFixed(8)} BTQ`
                      : 'n/a'}
                  </span>
                </p>
                <p>
                  Confirmations:
                  <span className="ml-1 font-mono text-slate-200">{fundingStatus?.btq?.confirmations ?? 'n/a'}</span>
                </p>
                <p>
                  Output address:
                  <span className="ml-1 break-all font-mono text-slate-200">{fundingStatus?.btq?.outputAddress ?? 'n/a'}</span>
                </p>
                <p>
                  Check result:
                  <span className="ml-1 text-slate-200">{fundingStatus?.btq?.reason ?? 'Waiting for chain check...'}</span>
                </p>
                  </>
                ) : null}
                <p className="text-[11px] text-slate-500">
                  Last checked: {fundingStatus?.inspectedAt ? formatDateTime(fundingStatus.inspectedAt) : 'n/a'}
                </p>
              </div>
            </div>

            {settlement ? (
              <div className="mt-4 rounded-lg border border-blue-500/20 bg-blue-500/5 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-wide text-blue-300">Next Step</p>
                  <button
                    onClick={() => void refreshSettlement()}
                    className="rounded-md border border-slate-600 px-2 py-0.5 text-[10px] text-slate-300 hover:bg-slate-700"
                  >
                    {settlementLoading ? 'Refreshing...' : 'Refresh'}
                  </button>
                </div>
                {!settlement.swapId ? (
                  <p className="text-xs text-slate-300">Waiting for a linked swap to be created...</p>
                ) : (
                  <div className="space-y-2 text-xs text-slate-300">
                    <p>
                      Swap:
                      <span className="ml-1 font-mono text-slate-200">{settlement.swapId}</span>
                    </p>
                    <p>
                      Status:
                      <span className="ml-1 font-mono text-slate-200">{settlement.swap?.status ?? 'unknown'}</span>
                    </p>
                    {(settlement.swap?.status === 'awaiting_user_btq_claim' || settlement.swap?.status === 'secret_revealed') ? (
                      <>
                        <p className="text-slate-200">
                          Claim BTQ via CLI now, then confirm claim txid below.
                        </p>
                        {orderedClaimCommands.length ? (
                          <ol className="space-y-2">
                            {orderedClaimCommands.map(([name, cmd], idx) => (
                              <li key={name}>
                                <p className="text-[10px] uppercase tracking-wide text-slate-400">
                                  {idx + 1}) {name}
                                </p>
                                <code className="mt-1 block overflow-x-auto rounded bg-slate-800 px-2 py-1.5 font-mono text-[11px] text-blue-300">
                                  {cmd}
                                </code>
                                <button
                                  onClick={() => void copyCommand(cmd)}
                                  className="mt-1 rounded-md border border-slate-600 px-2 py-0.5 text-[10px] text-slate-300 hover:bg-slate-700"
                                >
                                  Copy
                                </button>
                              </li>
                            ))}
                          </ol>
                        ) : (
                          <div className="space-y-2">
                            <p className="text-xs text-slate-400">
                              Chain-derived claim flow:
                            </p>
                            {generatedClaimCommands.map((cmd, idx) => (
                              <div key={`fallback-${idx}`}>
                                <p className="text-[10px] uppercase tracking-wide text-slate-400">{idx + 1}) step</p>
                                <code className="mt-1 block overflow-x-auto rounded bg-slate-800 px-2 py-1.5 font-mono text-[11px] text-blue-300">
                                  {cmd}
                                </code>
                                <button
                                  onClick={() => void copyCommand(cmd)}
                                  className="mt-1 rounded-md border border-slate-600 px-2 py-0.5 text-[10px] text-slate-300 hover:bg-slate-700"
                                >
                                  Copy
                                </button>
                              </div>
                            ))}
                            <p className="text-[11px] text-slate-400">
                              Destination address auto-filled from your wallet profile: <span className="font-mono text-slate-300">{destinationAddress}</span>
                            </p>
                          </div>
                        )}
                        <div>
                          <label className="mb-1.5 block text-xs font-medium text-slate-400">BTQ claim txid</label>
                          <input
                            value={claimTxid}
                            onChange={(e) => setClaimTxid(e.target.value)}
                            placeholder="Paste BTQ claim transaction id..."
                            className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm font-mono text-white placeholder-slate-500 outline-none focus:border-blue-500"
                          />
                          <button
                            onClick={handleConfirmBtqClaim}
                            disabled={confirmingClaim || !claimTxid.trim()}
                            className="mt-2 w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500"
                          >
                            {confirmingClaim ? 'Confirming...' : 'Confirm BTQ Claim Complete'}
                          </button>
                        </div>
                        <p className="text-[11px] text-slate-400">
                          After BTQ claim confirms, continue to EVM claim if status becomes <span className="font-mono text-slate-300">awaiting_user_usdt_claim</span>.
                        </p>
                      </>
                    ) : settlement.swap?.status === 'awaiting_user_usdt_claim' ? (
                      <>
                        <p className="text-slate-200">
                          Claim USDT on EVM now. Use the same 32-byte secret/preimage from your BTQ claim flow.
                        </p>
                        <p>
                          EVM Swap ID:
                          <span className="ml-1 break-all font-mono text-slate-200">{settlement.swap?.evmSwapIdHex ?? 'n/a'}</span>
                        </p>
                        <p>
                          EVM HTLC TX:
                          <span className="ml-1 break-all font-mono text-slate-200">{settlement.swap?.evm_htlc_tx_hash ?? 'n/a'}</span>
                        </p>
                        <div>
                          <label className="mb-1.5 block text-xs font-medium text-slate-400">Secret / preimage (32-byte hex)</label>
                          <input
                            value={secretInput}
                            onChange={(e) => setSecretInput(e.target.value)}
                            placeholder="Paste 64-char secret hex..."
                            className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm font-mono text-white placeholder-slate-500 outline-none focus:border-blue-500"
                          />
                          <button
                            onClick={handleClaimUsdtOnEvm}
                            disabled={claimingUsdt || !secretInput.trim()}
                            className="mt-2 w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500"
                          >
                            {claimingUsdt ? 'Claiming...' : 'Claim USDT on EVM'}
                          </button>
                        </div>
                      </>
                    ) : settlement.swap?.status === 'completed' ? (
                      <p className="text-emerald-300">Swap is complete.</p>
                    ) : (
                      <p className="text-slate-300">
                        Waiting for the next worker/state transition. This panel auto-refreshes.
                      </p>
                    )}
                  </div>
                )}
              </div>
            ) : null}

            <details className="mt-4 rounded-lg border border-slate-700/50 bg-slate-800/30 p-3">
              <summary className="cursor-pointer text-xs font-medium text-slate-400">Advanced on-chain details</summary>
              {loading ? (
                <p className="mt-2 text-xs text-slate-500">Loading details...</p>
              ) : (
                <div className="mt-2 space-y-1.5 text-xs text-slate-400">
                  <p>
                    Order ID:
                    <span className="ml-1 break-all font-mono text-slate-300">{order.id}</span>
                  </p>
                  <p>
                    Lock TX:
                    <span className="ml-1 break-all font-mono text-slate-300">{detail?.btq_htlc_txid || 'n/a'}</span>
                  </p>
                  <p>
                    Expiry:
                    <span className="ml-1 font-mono text-slate-300">{formatDateTime(effectiveExpiresAt)}</span>
                  </p>
                  {!isEvmFunding && (
                    <p>
                      Vout:
                      <span className="ml-1 font-mono text-slate-300">{detail?.btq_htlc_vout ?? 'n/a'}</span>
                    </p>
                  )}
                </div>
              )}
            </details>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function settledStateFromChain(
  state: { tokensWithdrawn: boolean; tokensRefunded: boolean } | null,
): 'redeemed' | 'claimed' | null {
  if (!state) return null;
  if (state.tokensRefunded) return 'redeemed';
  if (state.tokensWithdrawn) return 'claimed';
  return null;
}

function settledStateLabel(
  settled: 'redeemed' | 'claimed' | null,
  isFunded: boolean,
  expired: boolean,
): string {
  if (settled === 'redeemed') return 'Redeemed';
  if (settled === 'claimed') return 'Claimed';
  if (!isFunded) return 'Pending Funding';
  if (expired) return 'Ready to Recover';
  return 'Active';
}

function buildOrderSummarySentence(args: {
  side: 'buy' | 'sell';
  isFunded: boolean;
  settled: 'redeemed' | 'claimed' | null;
  isExpiredOnChain: boolean;
  canRedeem: boolean;
  amountUsdt: number;
  amountBtq: number;
}): string {
  const sideText = args.side === 'buy' ? 'buy' : 'sell';
  const fundedAmountText = args.side === 'buy'
    ? `${args.amountUsdt.toFixed(2)} USDT`
    : `${args.amountBtq.toFixed(8)} BTQ`;
  const receiveAmountText = args.side === 'buy'
    ? `${args.amountBtq.toFixed(8)} BTQ`
    : `${args.amountUsdt.toFixed(2)} USDT`;
  if (!args.isFunded) {
    return `You placed a ${sideText} order, but funding is not complete yet.`;
  }
  if (args.settled === 'redeemed') {
    return `You funded this order with ${fundedAmountText} and later recovered those funds after expiry.`;
  }
  if (args.settled === 'claimed') {
    return 'This order has already been claimed and completed.';
  }
  if (args.canRedeem) {
    return `You funded this order with ${fundedAmountText}, and you can recover funds now.`;
  }
  if (args.isExpiredOnChain) {
    return `You funded this order with ${fundedAmountText}, but it has expired and needs recovery.`;
  }
  return `You funded this order with ${fundedAmountText} and it is active to receive ${receiveAmountText}.`;
}

export function OpenOrders() {
  const { isAuthenticated } = useAuthStore();
  const { orders, fetchOrders, cancelOrder } = useOrders();
  const publicClient = usePublicClient();
  const [fundingOrder, setFundingOrder] = useState<Order | null>(null);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [urgentOrder, setUrgentOrder] = useState<Order | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [expiryOverrides, setExpiryOverrides] = useState<Record<string, string | null>>({});
  const [settledStates, setSettledStates] = useState<Record<string, 'redeemed' | 'claimed'>>({});
  const [settlementChecked, setSettlementChecked] = useState<Record<string, boolean>>({});
  const chainSyncedOrderIds = useRef<Set<string>>(new Set());
  const seenMatchPrompts = useRef<Set<string>>(new Set());
  const [skipConfirm, setSkipConfirm] = useState(() => localStorage.getItem('btq_skip_cancel_confirm') === '1');

  useEffect(() => {
    if (isAuthenticated) fetchOrders();
  }, [isAuthenticated, fetchOrders]);

  useEffect(() => {
    const handler = () => { if (isAuthenticated) fetchOrders(); };
    window.addEventListener('btq:order-placed', handler);
    return () => window.removeEventListener('btq:order-placed', handler);
  }, [isAuthenticated, fetchOrders]);

  useEffect(() => {
    const handleOrdersRefresh = () => {
      if (!isAuthenticated) return;
      void fetchOrders();
    };
    const handleSwapUpdate = () => {
      if (!isAuthenticated) return;
      void fetchOrders();
    };
    const handleMatchActionRequired = (event: Event) => {
      if (!isAuthenticated) return;
      const custom = event as CustomEvent<{
        swapId: string;
        orderId: string;
        role: 'maker' | 'taker';
        side: 'buy' | 'sell';
        amountBtq: string;
        priceUsdt: string;
      }>;
      const payload = custom.detail;
      if (!payload?.swapId || !payload?.orderId) return;
      const dedupeKey = `${payload.swapId}:${payload.orderId}:${payload.role}`;
      if (seenMatchPrompts.current.has(dedupeKey)) return;
      seenMatchPrompts.current.add(dedupeKey);
      void fetchOrders();
      const actionCopy = payload.role === 'maker'
        ? 'Your order was matched. Continue now to finish settlement.'
        : 'You matched an order. Continue now to finish settlement.';
      toast((t) => (
        <div className="w-[320px] rounded-xl border border-blue-500/30 bg-slate-900 p-3 shadow-xl">
          <p className="text-xs font-semibold uppercase tracking-wide text-blue-300">Matched</p>
          <p className="mt-1 text-sm text-slate-200">{actionCopy}</p>
          <p className="mt-1 font-mono text-xs text-slate-400">
            {parseFloat(payload.amountBtq || '0').toFixed(4)} BTQ @ {parseFloat(payload.priceUsdt || '0').toFixed(4)}
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <button
              onClick={() => toast.dismiss(t.id)}
              className="rounded-md border border-slate-600 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-800"
            >
              Later
            </button>
            <button
              onClick={() => {
                toast.dismiss(t.id);
                const found = orders.find((o) => o.id === payload.orderId);
                if (found) {
                  setSelectedOrder(found);
                } else {
                  void fetchOrders();
                }
              }}
              className="rounded-md bg-blue-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-blue-500"
            >
              Open
            </button>
          </div>
        </div>
      ), { duration: 10_000, id: `match:${dedupeKey}` });
    };

    window.addEventListener('orders:refresh', handleOrdersRefresh);
    window.addEventListener('swap:update', handleSwapUpdate);
    window.addEventListener('match:action-required', handleMatchActionRequired as EventListener);
    return () => {
      window.removeEventListener('orders:refresh', handleOrdersRefresh);
      window.removeEventListener('swap:update', handleSwapUpdate);
      window.removeEventListener('match:action-required', handleMatchActionRequired as EventListener);
    };
  }, [isAuthenticated, fetchOrders, orders]);

  useEffect(() => {
    let mounted = true;
    const syncMissingExpiries = async () => {
      const fundedMissing = orders.filter((o) => {
        const isFunded = Boolean((o as any).isFunded);
        const hasExpiry = Boolean((o as Order & { expiresAt?: string | null }).expiresAt);
        return isFunded && !hasExpiry;
      });
      if (!fundedMissing.length) return;

      const updates: Record<string, string | null> = {};
      await Promise.all(
        fundedMissing.map(async (o) => {
          try {
            const res = await api.get<{ order: { expires_at: string | null } }>(`/orderbook/orders/${o.id}`);
            updates[o.id] = res.order?.expires_at ?? null;
            return;
          } catch {
            try {
              const fallback = await api.get<{ order: { expires_at: string | null } }>(`/orders/orderbook/orders/${o.id}`);
              updates[o.id] = fallback.order?.expires_at ?? null;
            } catch {
              updates[o.id] = null;
            }
          }
        }),
      );
      if (mounted && Object.keys(updates).length) {
        setExpiryOverrides((prev) => ({ ...prev, ...updates }));
      }
    };
    void syncMissingExpiries();
    return () => { mounted = false; };
  }, [orders]);

  useEffect(() => {
    let cancelled = false;
    const syncChainSettlementState = async () => {
      if (!publicClient) return;
      const candidates = orders.filter((o) => {
        const isFunded = Boolean((o as any).isFunded);
        return isFunded && !chainSyncedOrderIds.current.has(o.id);
      });
      if (!candidates.length) return;

      if (!cancelled) {
        setSettlementChecked((prev) => ({
          ...prev,
          ...Object.fromEntries(candidates.map((o) => [o.id, false])),
        }));
      }

      const settledUpdates: Record<string, 'redeemed' | 'claimed'> = {};
      const expiryUpdates: Record<string, string | null> = {};
      const checkedUpdates: Record<string, boolean> = {};

      await Promise.all(
        candidates.map(async (order) => {
          try {
            const detailRes = await api.get<OrderDetailResponse>(`/orders/${order.id}`);
            const txid = detailRes.order?.btq_htlc_txid;
            if (!txid || !txid.startsWith('0x')) {
              checkedUpdates[order.id] = true;
              chainSyncedOrderIds.current.add(order.id);
              return;
            }

            const snapshot = await resolveEvmAgreementSnapshot(publicClient, txid as `0x${string}`);
            if (snapshot) {
              if (snapshot.tokensRefunded) settledUpdates[order.id] = 'redeemed';
              if (snapshot.tokensWithdrawn) settledUpdates[order.id] = 'claimed';
              if (snapshot.deadline > 0) {
                expiryUpdates[order.id] = new Date(snapshot.deadline * 1000).toISOString();
              }
            }
          } catch {
            // keep current UI state when chain lookup fails
          } finally {
            checkedUpdates[order.id] = true;
            chainSyncedOrderIds.current.add(order.id);
          }
        }),
      );

      if (cancelled) return;
      if (Object.keys(settledUpdates).length) {
        setSettledStates((prev) => ({ ...prev, ...settledUpdates }));
      }
      if (Object.keys(expiryUpdates).length) {
        setExpiryOverrides((prev) => ({ ...prev, ...expiryUpdates }));
      }
      if (Object.keys(checkedUpdates).length) {
        setSettlementChecked((prev) => ({ ...prev, ...checkedUpdates }));
      }
    };

    void syncChainSettlementState();
    return () => { cancelled = true; };
  }, [orders, publicClient]);

  const handleCancelClick = useCallback(async (id: string) => {
    if (skipConfirm) {
      const ok = await cancelOrder(id);
      if (!ok) toast.error('Unable to cancel this order right now.');
      return;
    }
    setCancellingId(id);
  }, [skipConfirm, cancelOrder]);

  const handleConfirmCancel = useCallback(async (dontAsk: boolean) => {
    if (cancellingId) {
      const ok = await cancelOrder(cancellingId);
      if (!ok) {
        toast.error('Unable to cancel this order right now.');
        setCancellingId(null);
        return;
      }
      if (dontAsk) {
        setSkipConfirm(true);
        localStorage.setItem('btq_skip_cancel_confirm', '1');
      }
    }
    setCancellingId(null);
  }, [cancellingId, cancelOrder]);

  useEffect(() => {
    if (!orders.length) return;
    const now = Date.now();
    const redeemable = orders.find((o) => {
      const isFunded = Boolean((o as any).isFunded);
      if (!isFunded) return false;
      if (settledStates[o.id]) return false;
      if (!settlementChecked[o.id]) return false;
      const created = new Date(o.createdAt).getTime();
      const expires = (o as Order & { expiresAt?: string | null }).expiresAt
        ? new Date((o as Order & { expiresAt?: string | null }).expiresAt as string).getTime()
        : (created + HTLC_TIMELOCK_MS);
      if (!Number.isFinite(expires)) return false;
      const isExpired = now >= expires;
      if (!isExpired) return false;
      const dismissed = sessionStorage.getItem(`btq_redeem_urgent_dismissed_${o.id}`) === '1';
      return !dismissed;
    });
    if (redeemable) {
      setUrgentOrder(redeemable);
    }
  }, [orders, settledStates, settlementChecked]);

  const handleSettlementStateChange = useCallback((orderId: string, state: 'redeemed' | 'claimed') => {
    setSettledStates((prev) => ({ ...prev, [orderId]: state }));
  }, []);

  return (
    <>
      <div className="flex h-full flex-col overflow-hidden">
        <div className="border-b border-slate-700/50 px-4 py-3">
          <h3 className="text-sm font-semibold text-white">My Open Orders</h3>
        </div>

        {!isAuthenticated ? (
          <div className="flex flex-1 items-center justify-center text-sm text-slate-500">
            Connect wallet to view orders
          </div>
        ) : !orders || orders.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-sm text-slate-500">
            No open orders
          </div>
        ) : (
          <div className="flex-1 overflow-auto">
            <div className="divide-y divide-slate-700/30">
              {orders.map((order) => {
                const isFunded = (order as any).isFunded;
                const isFilled = order.status === 'filled';
                const canCancel = order.status === 'open' || order.status === 'partially_filled';
                return (
                  <div
                    key={order.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedOrder(order)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelectedOrder(order);
                      }
                    }}
                    className="block w-full cursor-pointer px-4 py-3 text-left hover:bg-slate-800/40 focus:outline-none focus:ring-1 focus:ring-blue-500/50"
                  >
                    {/* Row 1: Side, Price, Amount */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className={`rounded-md px-2 py-0.5 text-[11px] font-bold ${
                          order.side === 'buy'
                            ? 'bg-emerald-500/15 text-emerald-400'
                            : 'bg-red-500/15 text-red-400'
                        }`}>
                          {(order.side || '').toUpperCase()}
                        </span>
                        <span className="font-mono text-xs text-white">
                          {parseFloat(order.btqAmount || '0').toFixed(4)} BTQ
                        </span>
                        <span className="text-xs text-slate-500">@</span>
                        <span className="font-mono text-xs text-slate-300">
                          {parseFloat(order.price || '0').toFixed(4)} USDT
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        {isFunded ? (
                          <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
                            {isFilled ? 'Matched' : 'Funded'}
                          </span>
                        ) : order.side === 'buy' ? (
                          <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-300">
                            Awaiting Buy Setup
                          </span>
                        ) : (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setFundingOrder(order);
                            }}
                            className="rounded-md bg-blue-500/15 px-2 py-0.5 text-[10px] font-medium text-blue-400 transition-colors hover:bg-blue-500/25"
                          >
                            Fund
                          </button>
                        )}
                        {canCancel ? (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleCancelClick(order.id);
                            }}
                            className="rounded-md p-1 text-slate-500 transition-colors hover:bg-red-500/10 hover:text-red-400"
                            title="Cancel order"
                          >
                            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        ) : null}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedOrder(order);
                          }}
                          className="rounded-md bg-slate-700/70 px-2 py-0.5 text-[10px] font-medium text-slate-300 transition-colors hover:bg-slate-600"
                          title="View lock details"
                        >
                          Details
                        </button>
                      </div>
                    </div>

                    {/* Row 2: Timelock bar for funded orders */}
                    {isFunded && (
                      <div className="mt-2">
                        <TimelockBar
                          fundedAt={order.createdAt}
                          expiresAt={
                            (order as Order & { expiresAt?: string | null }).expiresAt
                            ?? expiryOverrides[order.id]
                            ?? null
                          }
                          settledState={settledStates[order.id] ?? null}
                          isSyncing={!settlementChecked[order.id]}
                        />
                      </div>
                    )}

                    {/* Row 3: Fill progress */}
                    {parseFloat(order.filledAmount || '0') > 0 && (
                      <div className="mt-1.5 flex items-center gap-2">
                        <div className="h-1 flex-1 overflow-hidden rounded-full bg-slate-700">
                          <div
                            className="h-full rounded-full bg-emerald-500"
                            style={{ width: `${(parseFloat(order.filledAmount) / parseFloat(order.btqAmount)) * 100}%` }}
                          />
                        </div>
                        <span className="font-mono text-[10px] text-slate-500">
                          {parseFloat(order.filledAmount || '0').toFixed(4)} filled
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {cancellingId && (
        <CancelConfirmModal
          onConfirm={handleConfirmCancel}
          onCancel={() => setCancellingId(null)}
        />
      )}

      {fundingOrder && (
        <FundOrderModal
          orderId={fundingOrder.id}
          direction={fundingOrder.side}
          amountBtq={fundingOrder.btqAmount}
          priceUsdt={fundingOrder.price}
          onClose={() => setFundingOrder(null)}
          onFunded={() => {
            setFundingOrder(null);
            fetchOrders();
          }}
        />
      )}

      {selectedOrder && (
        <OrderDetailsModal
          order={selectedOrder}
          onClose={() => setSelectedOrder(null)}
          onCancel={handleCancelClick}
          onSettlementStateChange={handleSettlementStateChange}
        />
      )}

      {urgentOrder && (
        <RedeemUrgentModal
          order={urgentOrder}
          onOpen={() => {
            setSelectedOrder(urgentOrder);
            setUrgentOrder(null);
            sessionStorage.setItem(`btq_redeem_urgent_dismissed_${urgentOrder.id}`, '1');
          }}
          onDismiss={() => {
            sessionStorage.setItem(`btq_redeem_urgent_dismissed_${urgentOrder.id}`, '1');
            setUrgentOrder(null);
          }}
        />
      )}
    </>
  );
}
