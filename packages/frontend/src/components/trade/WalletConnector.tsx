import { useState } from 'react';
import type { DeskProfile } from '../../lib/deskApi';
import { shortAddr } from '../../lib/format';
import { walletError } from '../../lib/evmWallet';
import { connectWallet, walletsFor, type SettlementRail } from '../../lib/walletConnector';

export function WalletConnector({ rail, profile, busy, termsAccepted, onLinked, onNotice, onError }: {
  rail: SettlementRail;
  profile: DeskProfile | null;
  busy: boolean;
  termsAccepted: boolean;
  onLinked: (profile: DeskProfile) => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const linked = rail === 'solana' ? profile?.solLinked : profile?.evmLinked;
  const address = rail === 'solana' ? profile?.sol : profile?.eth;
  const wallets = walletsFor(rail);
  const label = rail === 'solana' ? 'Solana' : 'EVM';

  async function connect(id: string, name: string) {
    onError('');
    if (!termsAccepted && !profile?.tos) {
      onError('Accept the terms before connecting a wallet.');
      return;
    }
    setPending(id);
    try {
      const next = await connectWallet(id);
      onLinked(next);
      const shown = rail === 'solana' ? next.sol : next.eth;
      onNotice(`${name} ${shortAddr(shown)} is linked for ${label}.`);
    } catch (err) {
      onError(walletError(err));
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="rounded-control border border-white/10 bg-ink px-3 py-2">
      <div className="flex items-center justify-between gap-3 text-[12px]">
        <span className="text-fog-2">{label} wallet</span>
        {linked && address ? <span className="num text-positive">{shortAddr(address)}</span> : <span className="text-fog-4">Not linked</span>}
      </div>
      {!linked && (
        <div className="mt-2 flex flex-wrap gap-2">
          {wallets.length === 0 && <span className="text-[12px] text-fog-4">No {label} wallet is installed in this browser.</span>}
          {wallets.map((wallet) => (
            <button
              key={wallet.id}
              type="button"
              disabled={busy || !!pending}
              onClick={() => void connect(wallet.id, wallet.name)}
              className="rounded-control border border-white/10 px-2 py-1 text-[12px] text-fog disabled:opacity-40"
            >
              {pending === wallet.id ? 'Confirm…' : `Connect ${wallet.name}`}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
