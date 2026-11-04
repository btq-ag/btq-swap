import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import toast from 'react-hot-toast';
import { api } from '../../lib/api';
import { useAuthStore } from '../../store/authStore';

interface Profile {
  dilithium_pubkey: string | null;
  btq_address: string | null;
}

export function BtqWalletButton() {
  const { isAuthenticated } = useAuthStore();
  const [open, setOpen] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [pubkey, setPubkey] = useState('');
  const [btqAddr, setBtqAddr] = useState('');
  const [saving, setSaving] = useState(false);
  const selectedAddress = btqAddr.trim() || '<address>';
  const regtestScantxoutsetCommand = `btq-cli -regtest scantxoutset start "[\\"addr(${selectedAddress})\\"]"`;

  const fetchProfile = useCallback(async () => {
    try {
      const res = await api.get<{ user: Record<string, unknown> }>(`/user/profile?_=${Date.now()}`);
      const u = res.user;
      setProfile({
        dilithium_pubkey: (u.dilithium_pubkey as string) || null,
        btq_address: (u.btq_address as string) || null,
      });
      setPubkey((u.dilithium_pubkey as string) || '');
      setBtqAddr((u.btq_address as string) || '');
    } catch {
      setProfile(null);
    } finally {
      setProfileLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      setProfile(null);
      setProfileLoaded(false);
      return;
    }
    void fetchProfile();
  }, [isAuthenticated, fetchProfile]);

  useEffect(() => {
    if (open && isAuthenticated) {
      void fetchProfile();
    }
  }, [open, isAuthenticated, fetchProfile]);

  const handleSave = async () => {
    setSaving(true);
    try {
      if (pubkey.trim()) {
        await api.put('/user/dilithium-pubkey', { dilithium_pubkey: pubkey.trim() });
      }
      if (btqAddr.trim()) {
        await api.put('/user/btq-address', { btq_address: btqAddr.trim() });
      }
      toast.success('BTQ wallet settings saved');
      await fetchProfile();
      setEditing(false);
    } catch (err) {
      toast.error((err as Error).message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  if (!isAuthenticated) return null;

  const isConfigured = profile?.dilithium_pubkey && profile?.btq_address;
  const statusDotClass = !profileLoaded
    ? 'bg-slate-500'
    : isConfigured
      ? 'bg-emerald-500'
      : 'bg-amber-500';
  const statusLabel = !profileLoaded
    ? 'Checking wallet setup'
    : isConfigured
      ? 'Configured'
      : 'Setup incomplete';

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="relative flex h-9 items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-3 text-sm font-medium text-slate-300 transition-colors hover:border-slate-600 hover:bg-slate-700 hover:text-white"
        title="BTQ Wallet Settings"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v3" />
        </svg>
        <span className="hidden sm:inline">BTQ Wallet</span>
        <span className={`h-2 w-2 rounded-full ${statusDotClass}`} />
      </button>

      {open && createPortal(
        <div className="fixed inset-0 z-[9999] overflow-y-auto bg-black/70 backdrop-blur-sm" onClick={() => setOpen(false)}>
          <div className="flex min-h-full items-center justify-center p-4">
          <div
            className="w-full max-w-md rounded-2xl border border-slate-700/50 bg-slate-900 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-slate-700/50 px-6 py-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-500/15">
                    <svg className="h-4.5 w-4.5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v3" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-base font-semibold text-white">BTQ Wallet Settings</h3>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className={`h-2 w-2 rounded-full ${statusDotClass}`} />
                      <span className="text-xs text-slate-400">
                        {statusLabel}
                      </span>
                    </div>
                  </div>
                </div>
                <button onClick={() => setOpen(false)} className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-800 hover:text-white">
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            <div className="px-6 py-5">
              {!editing ? (
                <div className="space-y-5">
                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-slate-500">Dilithium Public Key</label>
                    {profile?.dilithium_pubkey ? (
                      <div className="max-h-32 overflow-y-auto rounded-lg bg-slate-800/50 px-3 py-2.5">
                        <p className="break-all font-mono text-[10px] leading-relaxed text-emerald-400">
                          {profile.dilithium_pubkey}
                        </p>
                      </div>
                    ) : (
                      <p className="rounded-lg bg-amber-500/10 px-3 py-2.5 text-sm text-amber-400">Not configured</p>
                    )}
                  </div>

                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-slate-500">BTQ Receiving Address</label>
                    {profile?.btq_address ? (
                      <p className="break-all rounded-lg bg-slate-800/50 px-3 py-2.5 font-mono text-sm text-emerald-400">
                        {profile.btq_address}
                      </p>
                    ) : (
                      <p className="rounded-lg bg-amber-500/10 px-3 py-2.5 text-sm text-amber-400">Not configured</p>
                    )}
                  </div>

                  <button
                    onClick={() => setEditing(true)}
                    className="w-full rounded-xl bg-blue-600 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-500"
                  >
                    {isConfigured ? 'Edit Settings' : 'Set Up Wallet'}
                  </button>
                </div>
              ) : (
                <div className="space-y-5">
                  <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-3.5">
                    <h4 className="mb-1.5 text-xs font-semibold text-blue-300">Funded address checklist</h4>
                    <p className="text-[11px] text-slate-300">
                      BTQ shown in Place Order is for this exact receiving address. If this address has no UTXOs, balance will show 0.0000.
                    </p>
                    <div className="mt-2 space-y-1.5 text-[11px] text-slate-300">
                      <code className="block overflow-x-auto rounded bg-slate-800 px-2 py-1 font-mono text-blue-300">
                        btq-cli -regtest -rpcwallet=swap-wallet getnewaddress
                      </code>
                      <code className="block overflow-x-auto rounded bg-slate-800 px-2 py-1 font-mono text-blue-300">
                        btq-cli -regtest -rpcwallet=swap-wallet sendtoaddress &lt;that_address&gt; 25
                      </code>
                      <code className="block overflow-x-auto rounded bg-slate-800 px-2 py-1 font-mono text-blue-300">
                        btq-cli -regtest -rpcwallet=swap-wallet -generate 1
                      </code>
                    </div>
                  </div>

                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-slate-400">Dilithium Public Key</label>
                    <p className="mb-2 text-xs text-slate-500">
                      Run <code className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-blue-400">btq-cli -regtest -rpcwallet=swap-wallet getnewdilithiumaddress</code> and paste the result:
                    </p>
                    <textarea
                      value={pubkey}
                      onChange={(e) => setPubkey(e.target.value)}
                      placeholder="Paste Dilithium pubkey hex..."
                      rows={3}
                      className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2.5 font-mono text-[11px] text-white placeholder-slate-500 outline-none transition-colors focus:border-blue-500"
                    />
                  </div>

                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-slate-400">BTQ Receiving Address</label>
                    <p className="mb-2 text-xs text-slate-500">
                      Run <code className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-blue-400">btq-cli -regtest -rpcwallet=swap-wallet getnewaddress</code> and paste the result:
                    </p>
                    <input
                      value={btqAddr}
                      onChange={(e) => setBtqAddr(e.target.value)}
                      placeholder="e.g. qcrt1q..."
                      className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2.5 font-mono text-sm text-white placeholder-slate-500 outline-none transition-colors focus:border-blue-500"
                    />
                    <p className="mt-2 text-xs text-slate-500">
                      Check this exact address balance:
                      <code className="ml-1 rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[11px] text-slate-300">
                        {regtestScantxoutsetCommand}
                      </code>
                    </p>
                  </div>

                  <div className="flex gap-3">
                    <button
                      onClick={() => setEditing(false)}
                      className="flex-1 rounded-xl border border-slate-600 py-2.5 text-sm font-medium text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleSave}
                      disabled={saving}
                      className="flex-1 rounded-xl bg-blue-600 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500"
                    >
                      {saving ? 'Saving...' : 'Save'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
