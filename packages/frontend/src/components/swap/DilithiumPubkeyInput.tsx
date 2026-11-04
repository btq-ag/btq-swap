interface DilithiumPubkeyInputProps {
  value: string;
  onChange: (value: string) => void;
}

export function DilithiumPubkeyInput({ value, onChange }: DilithiumPubkeyInputProps) {
  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      onChange(text.trim());
    } catch {
      /* clipboard access denied */
    }
  };

  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-slate-300">
        Dilithium Public Key
      </label>
      <p className="mb-2 text-xs text-slate-500">
        Your BTQ quantum-safe public key for receiving funds. Get it with:{' '}
        <code className="rounded bg-slate-900 px-1 py-0.5 text-emerald-400">
          btq-cli getdilithiumpubkey
        </code>
      </p>
      <div className="relative">
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Enter your Dilithium public key..."
          rows={3}
          className="w-full rounded-lg border border-slate-600 bg-slate-900 p-3 pr-16 font-mono text-xs text-white placeholder-slate-500 outline-none transition-colors focus:border-blue-500"
        />
        <button
          onClick={handlePaste}
          className="absolute right-2 top-2 rounded-md bg-slate-700 px-2 py-1 text-xs text-slate-300 transition-colors hover:bg-slate-600 hover:text-white"
        >
          Paste
        </button>
      </div>
    </div>
  );
}
