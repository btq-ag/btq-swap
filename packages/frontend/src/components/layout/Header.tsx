import { Link, useLocation } from 'react-router-dom';
import { ConnectButton } from '../wallet/ConnectButton';
import { BtqWalletButton } from '../wallet/BtqWalletButton';
import { useAuthStore } from '../../store/authStore';
import { useSwap } from '../../hooks/useSwap';

const NAV_ITEMS = [
  { to: '/', label: 'Trade' },
  { to: '/history', label: 'Activity' },
];

export function Header() {
  const location = useLocation();
  const { isAdmin } = useAuthStore();
  const { currentRate } = useSwap();

  const isAdminRoute = location.pathname.startsWith('/admin');
  if (isAdminRoute) return null;

  return (
    <header className="sticky top-0 z-50 border-b border-slate-800/80 bg-slate-950/95 backdrop-blur-xl">
      <div className="flex h-14 items-center justify-between px-4">
        <div className="flex items-center gap-6">
          <Link to="/" className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-emerald-500">
              <span className="text-xs font-bold text-white">B</span>
            </div>
            <span className="text-base font-bold text-white">
              BTQ<span className="text-blue-400">Swap</span>
            </span>
          </Link>

          <nav className="flex items-center gap-0.5">
            {NAV_ITEMS.map(({ to, label }) => {
              const active = to === '/' ? location.pathname === '/' : location.pathname.startsWith(to);
              return (
                <Link
                  key={to}
                  to={to}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    active
                      ? 'bg-slate-800 text-white'
                      : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-200'
                  }`}
                >
                  {label}
                </Link>
              );
            })}
            {isAdmin && (
              <Link
                to="/admin"
                className="rounded-md px-3 py-1.5 text-sm font-medium text-amber-400 transition-colors hover:bg-slate-800/50 hover:text-amber-300"
              >
                Admin
              </Link>
            )}
          </nav>
        </div>

        <div className="flex items-center gap-2">
          {currentRate && (
            <div className="hidden items-center gap-2 rounded-lg bg-slate-800/50 px-3 py-1.5 sm:flex">
              <span className="text-xs text-slate-400">BTQ/USDT</span>
              <span className="font-mono text-sm font-medium text-white">{currentRate.ask}</span>
            </div>
          )}
          <BtqWalletButton />
          <ConnectButton />
        </div>
      </div>
    </header>
  );
}
