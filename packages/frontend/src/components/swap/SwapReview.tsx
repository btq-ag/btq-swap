import { useState } from 'react';
import type { SwapDirection } from '../../types';
import { DilithiumPubkeyInput } from './DilithiumPubkeyInput';

interface SwapReviewProps {
  direction: SwapDirection;
  btqAmount: string;
  usdtAmount: string;
  rate: string;
  onConfirm: (dilithiumPubkey?: string) => void;
  onCancel: () => void;
  loading: boolean;
}

export function SwapReview({
  direction,
  btqAmount,
  usdtAmount,
  rate,
  onConfirm,
  onCancel,
  loading,
}: SwapReviewProps) {
  const [pubkey, setPubkey] = useState('');
  const needsPubkey = direction === 'buy_btq';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative w-full max-w-md rounded-2xl border border-slate-700/50 bg-slate-800 p-6 shadow-2xl">
        <div className="mb-6 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-white">Review Swap</h3>
          <button
            onClick={onCancel}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-700 hover:text-white"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="space-y-4">
          <div className="rounded-xl bg-slate-900/80 p-4">
            <div className="mb-1 text-sm text-slate-400">You Send</div>
            <div className="flex items-center justify-between">
              <span className="text-2xl font-semibold text-white">
                {direction === 'buy_btq' ? usdtAmount : btqAmount}
              </span>
              <span className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm font-semibold text-white">
                {direction === 'buy_btq' ? 'USDT' : 'BTQ'}
              </span>
            </div>
          </div>

          <div className="flex justify-center">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-700">
              <svg className="h-4 w-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
              </svg>
            </div>
          </div>

          <div className="rounded-xl bg-slate-900/80 p-4">
            <div className="mb-1 text-sm text-slate-400">You Receive</div>
            <div className="flex items-center justify-between">
              <span className="text-2xl font-semibold text-white">
                {direction === 'buy_btq' ? btqAmount : usdtAmount}
              </span>
              <span className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm font-semibold text-white">
                {direction === 'buy_btq' ? 'BTQ' : 'USDT'}
              </span>
            </div>
          </div>

          <div className="space-y-2 rounded-xl bg-slate-900/50 p-4 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-400">Rate</span>
              <span className="text-white">1 BTQ = {rate} USDT</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Fee (0.3%)</span>
              <span className="text-white">
                {(Number(direction === 'buy_btq' ? usdtAmount : btqAmount) * 0.003).toFixed(
                  direction === 'buy_btq' ? 2 : 8
                )}{' '}
                {direction === 'buy_btq' ? 'USDT' : 'BTQ'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">EVM Timelock</span>
              <span className="text-white">24 hours</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">BTQ Timelock</span>
              <span className="text-white">12 hours</span>
            </div>
          </div>

          {needsPubkey && (
            <DilithiumPubkeyInput value={pubkey} onChange={setPubkey} />
          )}

          <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 p-3">
            <p className="text-xs text-amber-400">
              {direction === 'buy_btq'
                ? 'You will need to run btq-cli commands to claim your BTQ after the swap is initiated. Make sure you have btq-cli installed.'
                : 'You will need to lock BTQ using btq-cli commands. The platform will provide the exact commands to run.'}
            </p>
          </div>

          <button
            onClick={() => onConfirm(needsPubkey ? pubkey : undefined)}
            disabled={loading || (needsPubkey && !pubkey)}
            className="w-full rounded-xl bg-blue-600 py-4 text-base font-semibold text-white shadow-lg shadow-blue-600/20 transition-all hover:bg-blue-500 hover:shadow-blue-500/30 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500 disabled:shadow-none"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Confirming…
              </span>
            ) : (
              'Confirm Swap'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
