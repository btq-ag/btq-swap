import type { Swap } from '../../types';
import { TransactionLink } from '../common/TransactionLink';
import { TimeRemaining } from '../common/TimeRemaining';

interface SwapDetailsProps {
  swap: Swap;
}

export function SwapDetails({ swap }: SwapDetailsProps) {
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-700/50 bg-slate-800/50 p-4">
        <h4 className="mb-3 text-sm font-medium text-slate-400">Swap Information</h4>
        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-slate-400">Direction</span>
            <span className="text-white">
              {swap.direction === 'buy_btq' ? 'Buy BTQ (send USDT)' : 'Sell BTQ (receive USDT)'}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-slate-400">BTQ Amount</span>
            <span className="font-mono text-white">{swap.btqAmount} BTQ</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-slate-400">USDT Amount</span>
            <span className="font-mono text-white">{swap.usdtAmount} USDT</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-slate-400">Rate</span>
            <span className="text-white">1 BTQ = {swap.rate} USDT</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-slate-400">Fee</span>
            <span className="text-white">{swap.fee} USDT</span>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-slate-700/50 bg-slate-800/50 p-4">
        <h4 className="mb-3 text-sm font-medium text-slate-400">Timelocks</h4>
        <div className="space-y-3">
          <div>
            <div className="mb-1 flex justify-between text-sm">
              <span className="text-slate-400">EVM Timelock</span>
              <span className="font-mono text-white">{swap.timelockEvm}s</span>
            </div>
            <TimeRemaining expiresAt={swap.expiresAt} />
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-slate-700/50 bg-slate-800/50 p-4">
        <h4 className="mb-3 text-sm font-medium text-slate-400">Transaction Links</h4>
        <div className="space-y-2">
          {swap.evmTxHash && (
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-400">EVM Transaction</span>
              <TransactionLink hash={swap.evmTxHash} type="eth" />
            </div>
          )}
          {swap.btqTxid && (
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-400">BTQ Transaction</span>
              <TransactionLink hash={swap.btqTxid} type="btq" />
            </div>
          )}
          {!swap.evmTxHash && !swap.btqTxid && (
            <p className="text-sm text-slate-500">No transactions yet</p>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-slate-700/50 bg-slate-800/50 p-4">
        <h4 className="mb-3 text-sm font-medium text-slate-400">Hash Lock</h4>
        <p className="break-all font-mono text-xs text-slate-300">{swap.hashlock}</p>
      </div>
    </div>
  );
}
