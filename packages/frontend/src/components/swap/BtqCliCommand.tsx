import { useState } from 'react';

interface CommandStep {
  label: string;
  command: string;
  description?: string;
}

interface BtqCliCommandProps {
  steps: CommandStep[];
  title?: string;
}

export function BtqCliCommand({ steps, title }: BtqCliCommandProps) {
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  const handleCopy = async (command: string, idx: number) => {
    await navigator.clipboard.writeText(command);
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 2000);
  };

  return (
    <div className="rounded-xl border border-slate-700/50 bg-slate-800/50 overflow-hidden">
      {title && (
        <div className="border-b border-slate-700/50 px-4 py-3">
          <h4 className="text-sm font-medium text-white">{title}</h4>
        </div>
      )}
      <div className="divide-y divide-slate-700/30">
        {steps.map((step, i) => (
          <div key={i} className="group relative">
            <div className="flex items-start gap-3 p-4">
              <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-blue-500/20 text-xs font-bold text-blue-400">
                {i + 1}
              </div>
              <div className="min-w-0 flex-1">
                <p className="mb-1.5 text-sm font-medium text-slate-300">{step.label}</p>
                {step.description && (
                  <p className="mb-2 text-xs text-slate-500">{step.description}</p>
                )}
                <div className="group/code relative">
                  <pre className="overflow-x-auto rounded-lg bg-slate-950 p-3 text-sm leading-relaxed">
                    <code className="text-emerald-400">
                      {highlightCommand(step.command)}
                    </code>
                  </pre>
                  <button
                    onClick={() => handleCopy(step.command, i)}
                    className="absolute right-2 top-2 flex items-center gap-1 rounded-md bg-slate-800 px-2 py-1 text-xs text-slate-400 opacity-0 transition-all hover:bg-slate-700 hover:text-white group-hover/code:opacity-100"
                  >
                    {copiedIdx === i ? (
                      <>
                        <svg className="h-3.5 w-3.5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                        <span className="text-emerald-400">Copied</span>
                      </>
                    ) : (
                      <>
                        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                        Copy
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function highlightCommand(cmd: string): JSX.Element {
  const parts = cmd.split(/(\s+)/);
  return (
    <>
      {parts.map((part, i) => {
        if (i === 0) {
          return <span key={i} className="text-blue-400 font-semibold">{part}</span>;
        }
        if (part.startsWith('--')) {
          return <span key={i} className="text-amber-400">{part}</span>;
        }
        if (part.startsWith('-') && part.length === 2) {
          return <span key={i} className="text-amber-400">{part}</span>;
        }
        if (/^0x[a-fA-F0-9]+$/.test(part)) {
          return <span key={i} className="text-purple-400">{part}</span>;
        }
        if (/^\d+(\.\d+)?$/.test(part)) {
          return <span key={i} className="text-orange-400">{part}</span>;
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}
