import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { SystemHealth } from '../../types';

export function SystemPage() {
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [logs, setLogs] = useState<string[]>([]);

  useEffect(() => {
    api
      .get<SystemHealth>('/admin/health')
      .then(setHealth)
      .catch(console.error)
      .finally(() => setLoading(false));

    api
      .get<string[]>('/admin/logs?limit=50')
      .then(setLogs)
      .catch(() => setLogs([]));
  }, []);

  const refresh = () => {
    setLoading(true);
    api
      .get<SystemHealth>('/admin/health')
      .then(setHealth)
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  const services = health
    ? [
        { name: 'BTQ Core', status: health.btqCore, description: 'Bitcoin Quantum node connection' },
        { name: 'ETH RPC', status: health.ethRpc, description: 'Ethereum JSON-RPC provider' },
        { name: 'Database', status: health.database, description: 'PostgreSQL connection' },
        { name: 'Redis', status: health.redis, description: 'Redis cache/queue connection' },
      ]
    : [];

  const formatUptime = (seconds: number): string => {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  };

  if (loading) {
    return (
      <div className="space-y-4 p-6">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-16 animate-pulse rounded-xl bg-slate-800" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">System Health</h1>
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

      {/* Uptime / version */}
      {health && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-slate-700/50 bg-slate-800/50 p-5">
            <p className="text-sm text-slate-400">Uptime</p>
            <p className="mt-1 text-xl font-bold text-white">{formatUptime(health.uptime)}</p>
          </div>
          <div className="rounded-xl border border-slate-700/50 bg-slate-800/50 p-5">
            <p className="text-sm text-slate-400">Version</p>
            <p className="mt-1 font-mono text-xl font-bold text-white">{health.version}</p>
          </div>
        </div>
      )}

      {/* Service health */}
      <div className="rounded-xl border border-slate-700/50 bg-slate-800/50 p-5">
        <h3 className="mb-4 text-base font-semibold text-white">Services</h3>
        <div className="space-y-3">
          {services.map(({ name, status, description }) => (
            <div
              key={name}
              className="flex items-center justify-between rounded-lg bg-slate-900/50 px-4 py-3"
            >
              <div className="flex items-center gap-3">
                <div
                  className={`h-3 w-3 rounded-full ${
                    status ? 'bg-emerald-400 shadow-lg shadow-emerald-400/30' : 'bg-red-400 shadow-lg shadow-red-400/30'
                  }`}
                />
                <div>
                  <p className="text-sm font-medium text-white">{name}</p>
                  <p className="text-xs text-slate-500">{description}</p>
                </div>
              </div>
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                  status
                    ? 'bg-emerald-500/20 text-emerald-400'
                    : 'bg-red-500/20 text-red-400'
                }`}
              >
                {status ? 'Healthy' : 'Down'}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Recent logs */}
      <div className="rounded-xl border border-slate-700/50 bg-slate-800/50 p-5">
        <h3 className="mb-4 text-base font-semibold text-white">Recent Logs</h3>
        {logs.length > 0 ? (
          <div className="max-h-96 overflow-y-auto rounded-lg bg-slate-950 p-3">
            {logs.map((log, i) => (
              <div key={i} className="border-b border-slate-800/50 py-1 font-mono text-xs text-slate-400 last:border-0">
                {log}
              </div>
            ))}
          </div>
        ) : (
          <div className="flex h-32 items-center justify-center text-sm text-slate-500">
            No logs available
          </div>
        )}
      </div>
    </div>
  );
}
