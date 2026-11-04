import { useState } from 'react';
import { createPortal } from 'react-dom';
import toast from 'react-hot-toast';

function extractShortMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);

  if (msg.includes('User rejected')) return 'Transaction rejected by user';
  if (msg.includes('User denied')) return 'Transaction rejected by user';
  if (msg.includes('Nonce too low')) return 'Nonce mismatch — reset MetaMask activity data';
  if (msg.includes('Allowance must be GTE')) return 'USDT approval not confirmed yet';
  if (msg.includes('insufficient funds')) return 'Insufficient funds for transaction';
  if (msg.includes('Duplicate HTLC')) return 'A lock with these exact parameters already exists';
  if (msg.includes('deadline time must be')) return 'Deadline must be in the future';
  if (msg.includes('Locked amount must be GT')) return 'Amount must be greater than zero';
  if (msg.includes('execution reverted')) {
    const reason = msg.match(/reason string '([^']+)'/)?.[1];
    if (reason) return reason;
    return 'Transaction reverted on-chain';
  }
  if (msg.includes('Request failed:')) return msg.split('\n')[0];

  if (msg.length > 80) return msg.slice(0, 77) + '...';
  return msg;
}

function ErrorDetailModal({ error, onClose }: { error: string; onClose: () => void }) {
  return createPortal(
    <div className="fixed inset-0 z-[99999] overflow-y-auto bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className="flex min-h-full items-center justify-center p-4">
        <div className="w-full max-w-lg rounded-2xl border border-slate-700/50 bg-slate-900 shadow-2xl" onClick={(e) => e.stopPropagation()}>
          <div className="border-b border-slate-700/50 px-6 py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-red-500/15">
                  <svg className="h-5 w-5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                  </svg>
                </div>
                <h3 className="text-base font-semibold text-white">Error Details</h3>
              </div>
              <button onClick={onClose} className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-800 hover:text-white">
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
          <div className="px-6 py-5">
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-slate-800 p-4 font-mono text-xs leading-relaxed text-slate-300">
              {error}
            </pre>
          </div>
          <div className="flex justify-end border-t border-slate-700/50 px-6 py-4">
            <button
              onClick={() => { navigator.clipboard.writeText(error); toast.success('Copied to clipboard'); }}
              className="mr-3 rounded-xl border border-slate-600 px-4 py-2 text-sm font-medium text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
            >
              Copy
            </button>
            <button
              onClick={onClose}
              className="rounded-xl bg-slate-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-600"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

let showErrorDetailFn: ((msg: string) => void) | null = null;

export function ErrorDetailProvider({ children }: { children: React.ReactNode }) {
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  showErrorDetailFn = (msg: string) => setErrorDetail(msg);

  return (
    <>
      {children}
      {errorDetail && <ErrorDetailModal error={errorDetail} onClose={() => setErrorDetail(null)} />}
    </>
  );
}

export function showError(err: unknown): void {
  const fullMessage = err instanceof Error ? err.message : String(err);
  const shortMessage = extractShortMessage(err);
  const hasDetails = fullMessage.length > 100;

  toast(
    (t) => (
      <div className="flex items-start gap-2">
        <div className="flex-1">
          <p className="text-sm font-medium text-red-400">{shortMessage}</p>
          {hasDetails && (
            <button
              onClick={() => { toast.dismiss(t.id); showErrorDetailFn?.(fullMessage); }}
              className="mt-1 text-xs text-slate-400 underline hover:text-white"
            >
              View details
            </button>
          )}
        </div>
        <button onClick={() => toast.dismiss(t.id)} className="text-slate-500 hover:text-white">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    ),
    { duration: 6000, style: { background: '#1e293b', border: '1px solid #7f1d1d40', maxWidth: '400px' } },
  );
}
