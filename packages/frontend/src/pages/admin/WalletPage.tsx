import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { WalletStatus } from '../../types';

export function WalletPage() {
  const [wallet, setWallet] = useState<WalletStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<WalletStatus>('/admin/wallet')
      .then(setWallet)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const refresh = () => {
    setLoading(true);
    api
      .get<WalletStatus>('/admin/wallet')
      .then(setWallet)
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  if (loading) {
    return (
      <div className="space-y-4 p-6">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-32 animate-pulse rounded-xl bg-slate-800" />
        ))}
      </div>
    );
  }

  if (!wallet) {
    return (
      <div className="p-6 text-slate-400">Failed to load wallet status</div>
    );
  }

  const balances = [
    {
      label: 'BTQ Balance',
      value: wallet.btcBalance,
      unit: 'BTQ',
      decimals: 8,
      color: 'from-blue-500 to-emerald-500',
      address: wallet.btqAddress,
      addressLabel: 'BTQ Address',
    },
    {
      label: 'ETH Balance',
      value: wallet.ethBalance,
      unit: 'ETH',
      decimals: 4,
      color: 'from-blue-500 to-purple-500',
      address: wallet.ethAddress,
      addressLabel: 'ETH Address',
    },
    {
      label: 'USDT Balance',
      value: wallet.usdtBalance,
      unit: 'USDT',
      decimals: 2,
      color: 'from-emerald-500 to-teal-400',
      address: wallet.ethAddress,
      addressLabel: 'ERC-20 on ETH',
    },
  ];

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Wallet Status</h1>
        <button
          onClick={refresh}
          className="flex items-center gap-2 rounded-lg bg-slate-800 px-3 py-2 text-sm text-slate-300 transition-colors hover:bg-slate-700"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Refresh
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {balances.map(({ label, value, unit, decimals, color, address, addressLabel }) => (
          <div
            key={label}
            className="rounded-xl border border-slate-700/50 bg-slate-800/50 p-5"
          >
            <div className="mb-4 flex items-center gap-3">
              <div className={`h-10 w-10 rounded-xl bg-gradient-to-br ${color} p-0.5`}>
                <div className="flex h-full w-full items-center justify-center rounded-[10px] bg-slate-800">
                  <span className="text-xs font-bold text-white">{unit[0]}</span>
                </div>
              </div>
              <div>
                <p className="text-sm text-slate-400">{label}</p>
                <p className="text-xl font-bold text-white">
                  {Number(value).toFixed(decimals)} <span className="text-sm text-slate-400">{unit}</span>
                </p>
              </div>
            </div>
            <div className="rounded-lg bg-slate-900/50 p-3">
              <p className="mb-1 text-xs text-slate-500">{addressLabel}</p>
              <p className="break-all font-mono text-xs text-slate-300">{address}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-4">
        <h4 className="mb-1 text-sm font-medium text-amber-400">Low Balance Warning</h4>
        <p className="text-xs text-slate-400">
          Ensure the platform wallets have sufficient funds to process swaps. BTQ balance should cover
          expected buy-BTQ volume, and USDT balance should cover sell-BTQ payouts. ETH is needed for
          gas fees on EVM transactions.
        </p>
      </div>
    </div>
  );
}
