import { useState } from 'react';
import { ConnectButton as RainbowConnect } from '@rainbow-me/rainbowkit';
import { useAuth } from '../../hooks/useAuth';

export function ConnectButton() {
  const { isAuthenticated, signIn, signOut } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <RainbowConnect.Custom>
      {({ account, chain, openConnectModal, openChainModal, mounted }) => {
        const connected = mounted && account && chain;

        if (!mounted) {
          return <div className="h-9 w-32 animate-pulse rounded-xl bg-slate-700" />;
        }

        if (!connected) {
          return (
            <button
              onClick={openConnectModal}
              className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-blue-600/20 transition-all hover:bg-blue-500 active:scale-[0.98]"
            >
              Connect Wallet
            </button>
          );
        }

        if (chain.unsupported) {
          return (
            <button
              onClick={openChainModal}
              className="rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white transition-all hover:bg-red-500"
            >
              Wrong Network
            </button>
          );
        }

        if (!isAuthenticated) {
          return (
            <button
              onClick={signIn}
              className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-blue-600/20 transition-all hover:bg-blue-500 active:scale-[0.98]"
            >
              Sign In
            </button>
          );
        }

        return (
          <div className="relative">
            <button
              onClick={() => setMenuOpen(!menuOpen)}
              className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm font-medium text-white transition-colors hover:border-slate-600 hover:bg-slate-700"
            >
              <span className="h-2 w-2 rounded-full bg-emerald-400" />
              {account.displayName}
              <svg className={`h-3.5 w-3.5 text-slate-400 transition-transform ${menuOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {menuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-0 top-full z-50 mt-2 w-56 overflow-hidden rounded-xl border border-slate-700/50 bg-slate-900 shadow-2xl">
                  <div className="border-b border-slate-700/50 px-4 py-3">
                    <p className="font-mono text-xs text-slate-400">{account.address.slice(0, 6)}...{account.address.slice(-4)}</p>
                    {account.balanceFormatted && (
                      <p className="mt-0.5 text-xs text-slate-500">{parseFloat(account.balanceFormatted).toFixed(4)} {account.balanceSymbol}</p>
                    )}
                  </div>
                  <div className="py-1">
                    <button
                      onClick={() => { openChainModal(); setMenuOpen(false); }}
                      className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-slate-300 transition-colors hover:bg-slate-800"
                    >
                      {chain.hasIcon && chain.iconUrl && (
                        <img src={chain.iconUrl} alt="" className="h-4 w-4 rounded-full" />
                      )}
                      {chain.name}
                      <span className="ml-auto text-xs text-slate-500">Switch</span>
                    </button>
                    <button
                      onClick={() => { navigator.clipboard.writeText(account.address); setMenuOpen(false); }}
                      className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-slate-300 transition-colors hover:bg-slate-800"
                    >
                      <svg className="h-4 w-4 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                      Copy Address
                    </button>
                    <button
                      onClick={() => { signOut(); setMenuOpen(false); }}
                      className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-red-400 transition-colors hover:bg-slate-800"
                    >
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" />
                      </svg>
                      Disconnect
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        );
      }}
    </RainbowConnect.Custom>
  );
}
