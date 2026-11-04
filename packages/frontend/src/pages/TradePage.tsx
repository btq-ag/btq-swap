import { useEffect, useState } from 'react';
import { CandlestickChart } from '../components/trading/CandlestickChart';
import { OrderbookPanel } from '../components/trading/OrderbookPanel';
import { RecentTrades } from '../components/trading/RecentTrades';
import { TradeForm } from '../components/trading/TradeForm';
import { OpenOrders } from '../components/trading/OpenOrders';
import { BtqWalletSetup } from '../components/trading/BtqWalletSetup';
import { useSwap } from '../hooks/useSwap';
import { useWebSocket } from '../hooks/useWebSocket';
import { useAuthStore } from '../store/authStore';
import { api } from '../lib/api';
import { trackEvent } from '../lib/telemetry';

type MobileTab = 'chart' | 'book' | 'trades' | 'orders' | 'trade';

const MOBILE_TABS: { key: MobileTab; label: string }[] = [
  { key: 'chart', label: 'Chart' },
  { key: 'book', label: 'Book' },
  { key: 'trades', label: 'Trades' },
  { key: 'orders', label: 'Orders' },
  { key: 'trade', label: 'Trade' },
];

export function TradePage() {
  const { fetchRate } = useSwap();
  const { isAuthenticated, user } = useAuthStore();
  useWebSocket();
  const [mobileTab, setMobileTab] = useState<MobileTab>('chart');
  const [showWalletSetup, setShowWalletSetup] = useState(false);

  useEffect(() => {
    fetchRate();
    const interval = setInterval(fetchRate, 15000);
    return () => clearInterval(interval);
  }, [fetchRate]);

  useEffect(() => {
    void trackEvent('trade_view', { path: '/' });
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;
    const dismissed = sessionStorage.getItem('btq_wallet_setup_dismissed');
    if (dismissed) return;

    api.get<{ user: Record<string, unknown> }>('/user/profile')
      .then((res) => {
        const u = res.user;
        if (!u?.dilithium_pubkey && !u?.dilithiumPubkey) {
          setShowWalletSetup(true);
        }
      })
      .catch(() => {});
  }, [isAuthenticated]);

  return (
    <>
      {/* ── Desktop Layout ── */}
      <div className="hidden h-[calc(100vh-56px)] flex-col overflow-hidden bg-slate-950 lg:flex">
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex-shrink-0">
              <CandlestickChart height={380} />
            </div>
            <div className="flex min-h-0 flex-1 border-t border-slate-800">
              <div className="w-[340px] flex-shrink-0 overflow-hidden border-r border-slate-800">
                <OrderbookPanel />
              </div>
              <div className="w-[280px] flex-shrink-0 overflow-hidden border-r border-slate-800">
                <RecentTrades />
              </div>
              <div className="min-w-0 flex-1 overflow-hidden">
                <OpenOrders />
              </div>
            </div>
          </div>
          <div className="w-[300px] flex-shrink-0 overflow-y-auto border-l border-slate-800">
            <TradeForm />
          </div>
        </div>
      </div>

      {/* ── Mobile Layout ── */}
      <div className="flex h-[calc(100vh-56px)] flex-col bg-slate-950 lg:hidden">
        {/* Tab content */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {mobileTab === 'chart' && <CandlestickChart height={320} />}
          {mobileTab === 'book' && (
            <div className="h-full">
              <OrderbookPanel />
            </div>
          )}
          {mobileTab === 'trades' && (
            <div className="h-full">
              <RecentTrades />
            </div>
          )}
          {mobileTab === 'orders' && (
            <div className="h-full">
              <OpenOrders />
            </div>
          )}
          {mobileTab === 'trade' && <TradeForm />}
        </div>

        {/* Tab bar */}
        <div className="flex flex-shrink-0 border-t border-slate-800 bg-slate-950">
          {MOBILE_TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setMobileTab(tab.key)}
              className={`flex-1 py-2.5 text-center text-xs font-medium transition-colors ${
                mobileTab === tab.key
                  ? 'border-t-2 border-blue-500 text-blue-400'
                  : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {showWalletSetup && (
        <BtqWalletSetup
          onComplete={() => {
            setShowWalletSetup(false);
            sessionStorage.setItem('btq_wallet_setup_dismissed', '1');
          }}
          onSkip={() => {
            setShowWalletSetup(false);
            sessionStorage.setItem('btq_wallet_setup_dismissed', '1');
          }}
        />
      )}
    </>
  );
}
