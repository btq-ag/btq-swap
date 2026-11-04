import { useState, useEffect, useCallback } from 'react';
import { useAccount } from 'wagmi';
import { useSwap } from '../../hooks/useSwap';
import { useAuth } from '../../hooks/useAuth';
import type { SwapDirection } from '../../types';

interface SwapFormProps {
  onReview: (direction: SwapDirection, btqAmount: string, usdtAmount: string) => void;
}

export function SwapForm({ onReview }: SwapFormProps) {
  const { isConnected } = useAccount();
  const { isAuthenticated, signIn } = useAuth();
  const { currentRate, fetchRate } = useSwap();
  const [direction, setDirection] = useState<SwapDirection>('buy_btq');
  const [sendAmount, setSendAmount] = useState('');
  const [receiveAmount, setReceiveAmount] = useState('');
  const [showFees, setShowFees] = useState(false);

  useEffect(() => {
    fetchRate();
    const interval = setInterval(fetchRate, 15000);
    return () => clearInterval(interval);
  }, [fetchRate]);

  const sendToken = direction === 'buy_btq' ? 'USDT' : 'BTQ';
  const receiveToken = direction === 'buy_btq' ? 'BTQ' : 'USDT';

  const rate = currentRate
    ? direction === 'buy_btq'
      ? Number(currentRate.ask)
      : Number(currentRate.bid)
    : 0;

  const computeReceive = useCallback(
    (amount: string) => {
      if (!amount || !rate) return '';
      const numAmount = Number(amount);
      if (isNaN(numAmount) || numAmount <= 0) return '';
      if (direction === 'buy_btq') {
        return (numAmount / rate).toFixed(8);
      }
      return (numAmount * rate).toFixed(2);
    },
    [rate, direction]
  );

  useEffect(() => {
    setReceiveAmount(computeReceive(sendAmount));
  }, [sendAmount, computeReceive]);

  const handleFlip = () => {
    setDirection((d) => (d === 'buy_btq' ? 'sell_btq' : 'buy_btq'));
    setSendAmount('');
    setReceiveAmount('');
  };

  const feeBps = 30;
  const feeAmount = sendAmount ? (Number(sendAmount) * feeBps / 10000).toFixed(sendToken === 'USDT' ? 2 : 8) : '0';

  const btqAmount = direction === 'buy_btq' ? receiveAmount : sendAmount;
  const usdtAmount = direction === 'buy_btq' ? sendAmount : receiveAmount;

  const canReview = isAuthenticated && sendAmount && Number(sendAmount) > 0 && receiveAmount;

  return (
    <div className="w-full max-w-md mx-auto">
      <div className="rounded-2xl border border-slate-700/50 bg-slate-800/80 p-1 shadow-2xl shadow-black/20 backdrop-blur-sm">
        <div className="p-5">
          <div className="mb-5 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white">Swap</h2>
            {currentRate && (
              <div className="text-xs text-slate-400">
                1 BTQ = {Number(currentRate.ask).toFixed(2)} USDT
              </div>
            )}
          </div>

          {/* Send field */}
          <div className="rounded-xl bg-slate-900/80 p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm text-slate-400">You Send</span>
            </div>
            <div className="flex items-center gap-3">
              <input
                type="number"
                value={sendAmount}
                onChange={(e) => setSendAmount(e.target.value)}
                placeholder="0.00"
                className="flex-1 bg-transparent text-2xl font-medium text-white placeholder-slate-600 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
              <div className="flex items-center gap-2 rounded-lg bg-slate-800 px-3 py-2">
                <div className={`h-6 w-6 rounded-full ${sendToken === 'BTQ' ? 'bg-gradient-to-br from-blue-500 to-emerald-500' : 'bg-gradient-to-br from-emerald-500 to-teal-400'}`}>
                  <span className="flex h-full w-full items-center justify-center text-[10px] font-bold text-white">
                    {sendToken === 'BTQ' ? 'B' : '$'}
                  </span>
                </div>
                <span className="text-sm font-semibold text-white">{sendToken}</span>
              </div>
            </div>
          </div>

          {/* Flip button */}
          <div className="relative z-10 -my-3 flex justify-center">
            <button
              onClick={handleFlip}
              className="flex h-10 w-10 items-center justify-center rounded-xl border-4 border-slate-800/80 bg-slate-700 text-slate-300 transition-all hover:bg-slate-600 hover:text-white active:scale-95"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
              </svg>
            </button>
          </div>

          {/* Receive field */}
          <div className="rounded-xl bg-slate-900/80 p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm text-slate-400">You Receive</span>
            </div>
            <div className="flex items-center gap-3">
              <input
                type="text"
                value={receiveAmount}
                readOnly
                placeholder="0.00"
                className="flex-1 bg-transparent text-2xl font-medium text-white placeholder-slate-600 outline-none"
              />
              <div className="flex items-center gap-2 rounded-lg bg-slate-800 px-3 py-2">
                <div className={`h-6 w-6 rounded-full ${receiveToken === 'BTQ' ? 'bg-gradient-to-br from-blue-500 to-emerald-500' : 'bg-gradient-to-br from-emerald-500 to-teal-400'}`}>
                  <span className="flex h-full w-full items-center justify-center text-[10px] font-bold text-white">
                    {receiveToken === 'BTQ' ? 'B' : '$'}
                  </span>
                </div>
                <span className="text-sm font-semibold text-white">{receiveToken}</span>
              </div>
            </div>
          </div>

          {/* Rate + fee breakdown */}
          {sendAmount && Number(sendAmount) > 0 && (
            <div className="mt-4">
              <button
                onClick={() => setShowFees(!showFees)}
                className="flex w-full items-center justify-between rounded-lg px-1 py-1 text-sm text-slate-400 transition-colors hover:text-slate-300"
              >
                <span>1 {sendToken} = {direction === 'buy_btq' ? (1 / rate).toFixed(8) : rate.toFixed(2)} {receiveToken}</span>
                <svg className={`h-4 w-4 transition-transform ${showFees ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {showFees && (
                <div className="mt-2 space-y-2 rounded-lg bg-slate-900/50 p-3 text-sm">
                  <div className="flex justify-between text-slate-400">
                    <span>Rate</span>
                    <span>1 BTQ = {rate.toFixed(2)} USDT</span>
                  </div>
                  <div className="flex justify-between text-slate-400">
                    <span>Fee (0.3%)</span>
                    <span>{feeAmount} {sendToken}</span>
                  </div>
                  <div className="flex justify-between text-slate-400">
                    <span>Network</span>
                    <span>~$0.50</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Action button */}
          <div className="mt-4">
            {!isConnected ? (
              <button
                onClick={signIn}
                className="w-full rounded-xl bg-blue-600 py-4 text-base font-semibold text-white shadow-lg shadow-blue-600/20 transition-all hover:bg-blue-500 hover:shadow-blue-500/30"
              >
                Connect Wallet
              </button>
            ) : !isAuthenticated ? (
              <button
                onClick={signIn}
                className="w-full rounded-xl bg-blue-600 py-4 text-base font-semibold text-white shadow-lg shadow-blue-600/20 transition-all hover:bg-blue-500 hover:shadow-blue-500/30"
              >
                Sign In to Swap
              </button>
            ) : (
              <button
                disabled={!canReview}
                onClick={() => canReview && onReview(direction, btqAmount, usdtAmount)}
                className="w-full rounded-xl bg-blue-600 py-4 text-base font-semibold text-white shadow-lg shadow-blue-600/20 transition-all hover:bg-blue-500 hover:shadow-blue-500/30 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500 disabled:shadow-none"
              >
                {!sendAmount || Number(sendAmount) <= 0 ? 'Enter Amount' : 'Review Swap'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
