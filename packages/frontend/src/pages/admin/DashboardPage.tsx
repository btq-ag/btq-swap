import { useEffect, useState } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { api } from '../../lib/api';

interface DashboardStats {
  totalVolumeBtq: string;
  totalVolumeUsdt: string;
  activeSwaps: number;
  completedSwaps: number;
  successRate: number;
  btqBalance: string;
  ethBalance: string;
  usdtBalance: string;
}

interface VolumePoint {
  date: string;
  volume: number;
}

const STAT_CARDS = [
  { key: 'totalVolumeUsdt', label: 'Total Volume', prefix: '$', suffix: ' USDT', color: 'from-blue-600 to-blue-400' },
  { key: 'activeSwaps', label: 'Active Swaps', prefix: '', suffix: '', color: 'from-amber-600 to-amber-400' },
  { key: 'completedSwaps', label: 'Completed Swaps', prefix: '', suffix: '', color: 'from-emerald-600 to-emerald-400' },
  { key: 'successRate', label: 'Success Rate', prefix: '', suffix: '%', color: 'from-purple-600 to-purple-400' },
] as const;

export function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [volume, setVolume] = useState<VolumePoint[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.get<DashboardStats>('/admin/stats'),
      api.get<VolumePoint[]>('/admin/volume'),
    ])
      .then(([s, v]) => {
        setStats(s);
        setVolume(v);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="space-y-6 p-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-28 animate-pulse rounded-xl bg-slate-800" />
          ))}
        </div>
        <div className="h-72 animate-pulse rounded-xl bg-slate-800" />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-2xl font-bold text-white">Dashboard</h1>

      {/* Stat cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {STAT_CARDS.map(({ key, label, prefix, suffix, color }) => (
          <div key={key} className="rounded-xl border border-slate-700/50 bg-slate-800/50 p-5">
            <p className="text-sm text-slate-400">{label}</p>
            <p className="mt-1 text-2xl font-bold text-white">
              {prefix}
              {stats ? formatNumber(stats[key as keyof DashboardStats]) : '—'}
              {suffix}
            </p>
            <div className={`mt-3 h-1 w-12 rounded-full bg-gradient-to-r ${color}`} />
          </div>
        ))}
      </div>

      {/* Wallet balances */}
      {stats && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {[
            { label: 'BTQ Balance', value: stats.btqBalance, unit: 'BTQ' },
            { label: 'ETH Balance', value: stats.ethBalance, unit: 'ETH' },
            { label: 'USDT Balance', value: stats.usdtBalance, unit: 'USDT' },
          ].map(({ label, value, unit }) => (
            <div key={label} className="rounded-xl border border-slate-700/50 bg-slate-800/50 p-5">
              <p className="text-sm text-slate-400">{label}</p>
              <p className="mt-1 font-mono text-lg font-semibold text-white">
                {Number(value).toFixed(unit === 'BTQ' ? 8 : unit === 'ETH' ? 4 : 2)} {unit}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Volume chart */}
      <div className="rounded-xl border border-slate-700/50 bg-slate-800/50 p-5">
        <h3 className="mb-4 text-base font-semibold text-white">Daily Volume (USDT)</h3>
        {volume.length > 0 ? (
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={volume}>
              <defs>
                <linearGradient id="volumeGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#3B82F6" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#3B82F6" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="date"
                axisLine={false}
                tickLine={false}
                tick={{ fill: '#64748b', fontSize: 12 }}
              />
              <YAxis
                axisLine={false}
                tickLine={false}
                tick={{ fill: '#64748b', fontSize: 12 }}
                tickFormatter={(v) => `$${v}`}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#1e293b',
                  border: '1px solid #334155',
                  borderRadius: '0.75rem',
                  color: '#fff',
                }}
              />
              <Area
                type="monotone"
                dataKey="volume"
                stroke="#3B82F6"
                strokeWidth={2}
                fill="url(#volumeGrad)"
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex h-48 items-center justify-center text-sm text-slate-500">
            No volume data yet
          </div>
        )}
      </div>
    </div>
  );
}

function formatNumber(val: string | number): string {
  const num = typeof val === 'string' ? Number(val) : val;
  if (isNaN(num)) return '0';
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return num.toLocaleString();
}
