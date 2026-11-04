import { useEffect, useState, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { SwapProgress } from '../components/swap/SwapProgress';
import { SwapDetails } from '../components/swap/SwapDetails';
import { BtqCliCommand } from '../components/swap/BtqCliCommand';
import { TxidPasteInput } from '../components/swap/TxidPasteInput';
import { StatusBadge } from '../components/common/StatusBadge';
import { useSwap } from '../hooks/useSwap';
import { useWebSocket } from '../hooks/useWebSocket';
import type { Swap, SwapStep } from '../types';
import { trackEvent } from '../lib/telemetry';

function buildSteps(swap: Swap): SwapStep[] {
  const status = swap.status;

  if (swap.direction === 'buy_btq') {
    const steps: SwapStep[] = [
      {
        label: 'BTQ Locked',
        status: ['btq_locked', 'evm_locked', 'evm_claimed', 'btq_claimed', 'completed'].includes(status) ? 'completed' : status === 'pending' ? 'active' : 'pending',
        description: 'Platform locks BTQ in a quantum-safe HTLC',
      },
      {
        label: 'USDT Locked',
        status: ['evm_locked', 'evm_claimed', 'btq_claimed', 'completed'].includes(status) ? 'completed' : status === 'btq_locked' ? 'active' : 'pending',
        description: 'Lock your USDT in the EVM HTLC contract',
      },
      {
        label: 'USDT Claimed',
        status: ['evm_claimed', 'btq_claimed', 'completed'].includes(status) ? 'completed' : status === 'evm_locked' ? 'active' : 'pending',
        description: 'Platform claims USDT, revealing the preimage',
      },
      {
        label: 'Claim BTQ',
        status: ['btq_claimed', 'completed'].includes(status) ? 'completed' : status === 'evm_claimed' ? 'active' : 'pending',
        description: 'Use the preimage to claim your BTQ via btq-cli',
      },
      {
        label: 'Complete',
        status: status === 'completed' ? 'completed' : 'pending',
        description: 'Swap finished successfully',
      },
    ];
    if (['expired', 'refunded', 'failed'].includes(status)) {
      steps.forEach((s) => { if (s.status === 'active' || s.status === 'pending') s.status = 'failed'; });
    }
    return steps;
  }

  const steps: SwapStep[] = [
    {
      label: 'Lock BTQ',
      status: ['btq_locked', 'evm_locked', 'evm_claimed', 'btq_claimed', 'completed'].includes(status) ? 'completed' : status === 'pending' ? 'active' : 'pending',
      description: 'Lock your BTQ using the btq-cli command below',
    },
    {
      label: 'BTQ Verified',
      status: ['evm_locked', 'evm_claimed', 'btq_claimed', 'completed'].includes(status) ? 'completed' : status === 'btq_locked' ? 'active' : 'pending',
      description: 'Platform verifies your BTQ lock on-chain',
    },
    {
      label: 'USDT Locked',
      status: ['evm_claimed', 'btq_claimed', 'completed'].includes(status) ? 'completed' : status === 'evm_locked' ? 'active' : 'pending',
      description: 'Platform locks USDT for you to claim',
    },
    {
      label: 'Claim USDT',
      status: ['btq_claimed', 'completed'].includes(status) ? 'completed' : status === 'evm_claimed' ? 'active' : 'pending',
      description: 'Claim your USDT from the EVM HTLC',
    },
    {
      label: 'Complete',
      status: status === 'completed' ? 'completed' : 'pending',
      description: 'Swap finished successfully',
    },
  ];
  if (['expired', 'refunded', 'failed'].includes(status)) {
    steps.forEach((s) => { if (s.status === 'active' || s.status === 'pending') s.status = 'failed'; });
  }
  return steps;
}

function buildCliCommands(swap: Swap): { label: string; command: string; description?: string }[] {
  if (swap.direction === 'sell_btq' && swap.status === 'pending') {
    return [
      {
        label: 'Lock your BTQ',
        command: `btq-cli createhtlc --amount ${swap.btqAmount} --hashlock ${swap.hashlock} --timelock ${swap.timelockBtq} --receiver-pubkey ${swap.dilithiumPubkey || '<platform_pubkey>'}`,
        description: 'This creates a BTQ HTLC with the specified hashlock and timelock.',
      },
    ];
  }
  if (swap.direction === 'buy_btq' && swap.status === 'evm_claimed' && swap.preimage) {
    return [
      {
        label: 'Claim your BTQ',
        command: `btq-cli claimhtlc --preimage ${swap.preimage} --address ${swap.btqLockAddress || '<btq_htlc_address>'}`,
        description: 'Use the revealed preimage to claim your BTQ from the HTLC.',
      },
    ];
  }
  if (swap.direction === 'buy_btq' && swap.status === 'btq_locked') {
    return [
      {
        label: 'Approve USDT spending',
        command: `(This step is done in your browser wallet — click "Lock USDT" below)`,
        description: 'Approve the HTLC contract to spend your USDT.',
      },
    ];
  }
  return [];
}

export function SwapDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { fetchSwap, submitBtqTxid, loading, error } = useSwap();
  const { joinSwapRoom, leaveSwapRoom } = useWebSocket();
  const [swap, setSwap] = useState<Swap | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (!id) return;
    fetchSwap(id).then((s) => {
      if (s) setSwap(s);
      else setLoadError(true);
    });
    joinSwapRoom(id);
    return () => leaveSwapRoom(id);
  }, [id, fetchSwap, joinSwapRoom, leaveSwapRoom]);

  // Listen for WebSocket updates and merge into local state
  useEffect(() => {
    if (!id) return;
    const handler = (event: CustomEvent<{ swapId: string; status: string }>) => {
      if (event.detail?.swapId === id) {
        fetchSwap(id).then((s) => { if (s) setSwap(s); });
      }
    };
    window.addEventListener('swap:update' as any, handler as any);
    return () => window.removeEventListener('swap:update' as any, handler as any);
  }, [id, fetchSwap]);

  const steps = useMemo(() => (swap ? buildSteps(swap) : []), [swap]);
  const cliCommands = useMemo(() => (swap ? buildCliCommands(swap) : []), [swap]);

  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center px-4 py-20">
        <p className="mb-4 text-lg text-slate-400">Swap not found</p>
        <Link to="/" className="text-sm text-blue-400 hover:text-blue-300">
          ← Back to swap
        </Link>
      </div>
    );
  }

  if (!swap) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <div className="space-y-4">
          <div className="h-8 w-48 animate-pulse rounded-lg bg-slate-800" />
          <div className="h-20 animate-pulse rounded-xl bg-slate-800" />
          <div className="h-64 animate-pulse rounded-xl bg-slate-800" />
        </div>
      </div>
    );
  }

  const handleTxidSubmit = async (txid: string) => {
    const updated = await submitBtqTxid(swap.id, txid);
    if (updated) {
      setSwap(updated);
      void trackEvent('swap_btq_txid_submit_success', { swapId: swap.id });
      return true;
    }
    void trackEvent('swap_btq_txid_submit_error', { swapId: swap.id });
    return false;
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="mb-6 flex items-center gap-3">
        <Link
          to="/"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
        </Link>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-white">Swap Details</h1>
          <p className="font-mono text-xs text-slate-500">{swap.id}</p>
        </div>
        <StatusBadge status={swap.status} size="md" />
      </div>

      <div className="mb-6 rounded-xl border border-slate-700/50 bg-slate-800/40 px-4 py-3">
        <p className="text-xs text-slate-400">
          Advanced swap record. For the main beta trading flow, use the trade terminal and manage active positions in <span className="font-medium text-slate-300">My Open Orders</span>.
        </p>
      </div>

      {/* Progress stepper */}
      <div className="mb-8 rounded-xl border border-slate-700/50 bg-slate-800/50 p-6">
        <SwapProgress steps={steps} />
      </div>

      {/* Current step instructions */}
      {steps.find((s) => s.status === 'active') && (
        <div className="mb-6 rounded-xl border border-blue-500/20 bg-blue-500/5 p-4">
          <h3 className="mb-1 text-sm font-semibold text-blue-400">
            Current Step: {steps.find((s) => s.status === 'active')!.label}
          </h3>
          <p className="text-sm text-slate-400">
            {steps.find((s) => s.status === 'active')!.description}
          </p>
        </div>
      )}

      {/* CLI commands */}
      {cliCommands.length > 0 && (
        <div className="mb-6">
          <BtqCliCommand steps={cliCommands} title="BTQ CLI Commands" />
        </div>
      )}

      {/* Txid paste input */}
      {swap.direction === 'sell_btq' && swap.status === 'pending' && (
        <div className="mb-6">
          <TxidPasteInput
            onSubmit={handleTxidSubmit}
            loading={loading}
            submitError={error}
            label="Submit BTQ Lock Transaction ID"
            placeholder="Paste the HTLC transaction ID from btq-cli output..."
          />
        </div>
      )}

      {/* Swap details */}
      <SwapDetails swap={swap} />
    </div>
  );
}
