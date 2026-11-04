import { useState } from 'react';
import toast from 'react-hot-toast';
import { api } from '../../lib/api';
import { BtqCliCommand } from '../swap/BtqCliCommand';

interface Props {
  onComplete: () => void;
  onSkip: () => void;
}

export function BtqWalletSetup({ onComplete, onSkip }: Props) {
  const [step, setStep] = useState<1 | 2>(1);
  const [pubkey, setPubkey] = useState('');
  const [btqAddress, setBtqAddress] = useState('');
  const [saving, setSaving] = useState(false);
  const selectedAddress = btqAddress.trim() || '<address>';
  const regtestScantxoutsetCommand = `btq-cli -regtest scantxoutset start "[\\"addr(${selectedAddress})\\"]"`;

  const handleSave = async () => {
    if (!pubkey.trim() || !btqAddress.trim()) {
      toast.error('Both fields are required');
      return;
    }
    setSaving(true);
    try {
      await api.put('/user/dilithium-pubkey', { dilithium_pubkey: pubkey.trim() });
      await api.put('/user/btq-address', { btq_address: btqAddress.trim() });
      toast.success('BTQ wallet configured successfully');
      onComplete();
    } catch (err) {
      toast.error((err as Error).message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[9999] overflow-y-auto bg-black/70 backdrop-blur-sm">
      <div className="flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-slate-700/50 bg-slate-900 shadow-2xl">
        {/* Header */}
        <div className="border-b border-slate-700/50 bg-gradient-to-r from-blue-500/10 to-emerald-500/10 px-6 py-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-500/20">
              <svg className="h-5 w-5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            </div>
            <div>
              <h2 className="text-lg font-bold text-white">Connect Your BTQ Wallet</h2>
              <p className="text-sm text-slate-400">Step {step} of 2</p>
            </div>
          </div>
          {/* Progress bar */}
          <div className="mt-4 flex gap-2">
            <div className={`h-1 flex-1 rounded-full ${step >= 1 ? 'bg-blue-500' : 'bg-slate-700'}`} />
            <div className={`h-1 flex-1 rounded-full ${step >= 2 ? 'bg-blue-500' : 'bg-slate-700'}`} />
          </div>
        </div>

        {/* Body */}
        <div className="max-h-[60vh] overflow-y-auto px-6 py-5">
          {step === 1 ? (
            <div className="space-y-5">
              <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-4">
                <h3 className="mb-2 text-sm font-semibold text-blue-400">Why do we need a Dilithium public key?</h3>
                <p className="text-sm leading-relaxed text-slate-300">
                  BTQ uses <strong className="text-white">post-quantum Dilithium signatures</strong> for
                  HTLC atomic swaps. Your Dilithium public key is embedded in the P2MR HTLC script so
                  that <strong className="text-white">only you</strong> can claim the locked BTQ using the
                  secret preimage + your Dilithium signature. This makes the swap quantum-resistant from day one.
                </p>
              </div>

              <div>
                <p className="mb-3 text-sm text-slate-400">
                  Run this command in your terminal (requires btqd running locally):
                </p>
                <BtqCliCommand
                  steps={[{
                    label: 'Generate a Dilithium key pair',
                    command: 'btq-cli -regtest -rpcwallet=swap-wallet getnewdilithiumaddress',
                    description: 'This creates a new Dilithium-2 key pair in your local wallet and returns the public key. The private key stays safely in your btq-core wallet.',
                  }]}
                />
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium text-slate-300">
                  Paste your Dilithium public key
                </label>
                <textarea
                  value={pubkey}
                  onChange={(e) => setPubkey(e.target.value)}
                  placeholder="The hex string returned by getnewdilithiumaddress..."
                  rows={3}
                  className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2.5 font-mono text-xs text-white placeholder-slate-500 outline-none transition-colors focus:border-blue-500"
                />
                <p className="mt-1.5 text-xs text-slate-500">
                  This is a long hex string (Dilithium-2 public keys are 1,312 bytes). It will be used
                  in the HTLC claim leaf script with OP_CHECKSIGDILITHIUM.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-5">
              <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
                <h3 className="mb-2 text-sm font-semibold text-emerald-400">Why do we need a BTQ address?</h3>
                <p className="text-sm leading-relaxed text-slate-300">
                  After you claim BTQ from an HTLC, the coins are sent to your <strong className="text-white">BTQ
                  receiving address</strong>. This is a standard BTQ address from your local wallet where you
                  control the private keys. It is the destination address used in the
                  <code className="mx-1 rounded bg-slate-700 px-1 py-0.5 text-xs text-emerald-400">btq-cli createp2mrspend</code>
                  command during the claim step.
                </p>
              </div>

              <div>
                <p className="mb-3 text-sm text-slate-400">
                  Run this command to get a fresh receiving address:
                </p>
                <BtqCliCommand
                  steps={[{
                    label: 'Get a new BTQ receiving address',
                    command: 'btq-cli -regtest -rpcwallet=swap-wallet getnewaddress',
                    description: 'Returns a standard BTQ address. This is where your swapped BTQ will be sent after you claim from the HTLC.',
                  }]}
                />
              </div>

              <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-4">
                <h3 className="mb-2 text-sm font-semibold text-blue-300">Use an address that actually has funds</h3>
                <p className="text-xs leading-relaxed text-slate-300">
                  The exchange shows BTQ balance for the exact receiving address you save here, not your whole wallet total.
                  If you pick an unfunded address, the UI correctly shows 0.0000.
                </p>
                <div className="mt-3 space-y-2 text-[11px] text-slate-300">
                  <p className="font-medium text-slate-200">Recommended regtest flow:</p>
                  <code className="block overflow-x-auto rounded bg-slate-800 px-2 py-1.5 font-mono text-blue-300">
                    btq-cli -regtest -rpcwallet=swap-wallet getnewaddress
                  </code>
                  <code className="block overflow-x-auto rounded bg-slate-800 px-2 py-1.5 font-mono text-blue-300">
                    btq-cli -regtest -rpcwallet=swap-wallet sendtoaddress &lt;that_address&gt; 25
                  </code>
                  <code className="block overflow-x-auto rounded bg-slate-800 px-2 py-1.5 font-mono text-blue-300">
                    btq-cli -regtest -rpcwallet=swap-wallet -generate 1
                  </code>
                  <code className="block overflow-x-auto rounded bg-slate-800 px-2 py-1.5 font-mono text-blue-300">
                    btq-cli -regtest -rpcwallet=swap-wallet getreceivedbyaddress &lt;that_address&gt; 0
                  </code>
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium text-slate-300">
                  Paste your BTQ receiving address
                </label>
                <input
                  value={btqAddress}
                  onChange={(e) => setBtqAddress(e.target.value)}
                  placeholder="e.g. tbtq1q... or mN7..."
                  className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2.5 font-mono text-sm text-white placeholder-slate-500 outline-none transition-colors focus:border-blue-500"
                />
                <p className="mt-1.5 text-xs text-slate-500">
                  You can validate with
                  <code className="mx-1 rounded bg-slate-700 px-1 py-0.5 text-xs text-slate-400">btq-cli -regtest validateaddress &lt;address&gt;</code>
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  Regtest users can check this exact address balance with
                  <code className="mx-1 rounded bg-slate-700 px-1 py-0.5 font-mono text-[11px] text-slate-300">
                    {regtestScantxoutsetCommand}
                  </code>
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-slate-700/50 px-6 py-4">
          <button
            onClick={onSkip}
            className="text-sm text-slate-500 transition-colors hover:text-slate-300"
          >
            Skip for now
          </button>

          <div className="flex gap-3">
            {step === 2 && (
              <button
                onClick={() => setStep(1)}
                className="rounded-lg border border-slate-600 px-4 py-2 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-800"
              >
                Back
              </button>
            )}

            {step === 1 ? (
              <button
                onClick={() => setStep(2)}
                disabled={!pubkey.trim()}
                className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500"
              >
                Next Step
              </button>
            ) : (
              <button
                onClick={handleSave}
                disabled={saving || !pubkey.trim() || !btqAddress.trim()}
                className="rounded-lg bg-emerald-600 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500"
              >
                {saving ? 'Saving...' : 'Complete Setup'}
              </button>
            )}
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}
