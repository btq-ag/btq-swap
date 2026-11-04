import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { PlatformConfig } from '../../types';

export function ConfigPage() {
  const [config, setConfig] = useState<PlatformConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<PlatformConfig>('/admin/config')
      .then(setConfig)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    setSaved(false);
    try {
      const updated = await api.put<PlatformConfig>('/admin/config', config);
      setConfig(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      console.error('Failed to save config:', err);
    } finally {
      setSaving(false);
    }
  };

  const update = (key: keyof PlatformConfig, value: string | number | boolean) => {
    if (!config) return;
    setConfig({ ...config, [key]: value });
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

  if (!config) {
    return (
      <div className="p-6 text-slate-400">Failed to load configuration</div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Platform Configuration</h1>
        <div className="flex items-center gap-3">
          {saved && (
            <span className="text-sm text-emerald-400">Saved successfully</span>
          )}
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-all hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-400"
          >
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>

      {/* Pricing */}
      <div className="rounded-xl border border-slate-700/50 bg-slate-800/50 p-5">
        <h3 className="mb-4 text-base font-semibold text-white">Pricing</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label className="mb-1 block text-sm text-slate-400">Bid Price (USDT per BTQ)</label>
            <input
              type="number"
              value={config.bidPrice}
              onChange={(e) => update('bidPrice', e.target.value)}
              step="0.01"
              className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2.5 text-sm text-white outline-none focus:border-blue-500 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-slate-400">Ask Price (USDT per BTQ)</label>
            <input
              type="number"
              value={config.askPrice}
              onChange={(e) => update('askPrice', e.target.value)}
              step="0.01"
              className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2.5 text-sm text-white outline-none focus:border-blue-500 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-slate-400">Spread (bps)</label>
            <input
              type="number"
              value={config.spreadBps}
              onChange={(e) => update('spreadBps', Number(e.target.value))}
              className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2.5 text-sm text-white outline-none focus:border-blue-500 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
          </div>
        </div>
      </div>

      {/* Limits */}
      <div className="rounded-xl border border-slate-700/50 bg-slate-800/50 p-5">
        <h3 className="mb-4 text-base font-semibold text-white">Limits & Fees</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label className="mb-1 block text-sm text-slate-400">Min BTQ per Swap</label>
            <input
              type="number"
              value={config.minBtq}
              onChange={(e) => update('minBtq', e.target.value)}
              step="0.00000001"
              className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2.5 text-sm text-white outline-none focus:border-blue-500 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-slate-400">Max BTQ per Swap</label>
            <input
              type="number"
              value={config.maxBtq}
              onChange={(e) => update('maxBtq', e.target.value)}
              step="0.00000001"
              className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2.5 text-sm text-white outline-none focus:border-blue-500 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-slate-400">Fee (bps)</label>
            <input
              type="number"
              value={config.feeBps}
              onChange={(e) => update('feeBps', Number(e.target.value))}
              className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2.5 text-sm text-white outline-none focus:border-blue-500 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
          </div>
        </div>
      </div>

      {/* Emergency controls */}
      <div className="rounded-xl border border-slate-700/50 bg-slate-800/50 p-5">
        <h3 className="mb-4 text-base font-semibold text-white">Emergency Controls</h3>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-white">Pause Platform</p>
            <p className="text-xs text-slate-400">
              Disable new swaps while keeping active ones running
            </p>
          </div>
          <button
            onClick={() => update('paused', !config.paused)}
            className={`relative h-7 w-12 rounded-full transition-colors ${
              config.paused ? 'bg-red-600' : 'bg-slate-600'
            }`}
          >
            <span
              className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow-md transition-transform ${
                config.paused ? 'left-[22px]' : 'left-0.5'
              }`}
            />
          </button>
        </div>
        {config.paused && (
          <div className="mt-3 rounded-lg border border-red-500/20 bg-red-500/10 p-3">
            <p className="text-xs text-red-400">
              Platform is paused. No new swaps can be created.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
