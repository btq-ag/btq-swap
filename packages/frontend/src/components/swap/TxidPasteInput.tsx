import { useState } from 'react';

interface TxidPasteInputProps {
  onSubmit: (txid: string) => Promise<boolean | void> | boolean | void;
  loading?: boolean;
  label?: string;
  placeholder?: string;
  submitError?: string | null;
}

export function TxidPasteInput({
  onSubmit,
  loading = false,
  label = 'Paste Transaction ID',
  placeholder = 'Enter the btq-cli transaction ID...',
  submitError = null,
}: TxidPasteInputProps) {
  const [txid, setTxid] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    const trimmed = txid.trim();
    if (!trimmed) {
      setError('Transaction ID is required');
      return;
    }
    if (trimmed.length < 16) {
      setError('Transaction ID is too short');
      return;
    }
    setError('');
    const ok = await onSubmit(trimmed);
    if (ok === false && !submitError) {
      setError('We could not submit this transaction ID. Please try again.');
    }
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      setTxid(text.trim());
      setError('');
    } catch {
      setError('Unable to read clipboard');
    }
  };

  return (
    <div className="rounded-xl border border-slate-700/50 bg-slate-800/50 p-4">
      <label className="mb-2 block text-sm font-medium text-white">{label}</label>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <input
            type="text"
            value={txid}
            onChange={(e) => {
              setTxid(e.target.value);
              setError('');
            }}
            placeholder={placeholder}
            className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2.5 pr-16 font-mono text-sm text-white placeholder-slate-500 outline-none transition-colors focus:border-blue-500"
          />
          <button
            onClick={handlePaste}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md bg-slate-700 px-2 py-1 text-xs text-slate-300 transition-colors hover:bg-slate-600 hover:text-white"
          >
            Paste
          </button>
        </div>
        <button
          onClick={handleSubmit}
          disabled={loading || !txid.trim()}
          className="rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-all hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500"
        >
          {loading ? (
            <svg className="h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          ) : (
            'Submit'
          )}
        </button>
      </div>
      {(error || submitError) && <p className="mt-2 text-xs text-red-400">{error || submitError}</p>}
    </div>
  );
}
