import { useState, useEffect } from 'react';

interface TimeRemainingProps {
  expiresAt: string;
  compact?: boolean;
}

function formatDuration(ms: number): string {
  if (ms <= 0) return 'Expired';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function getTimelockColor(ms: number): string {
  if (ms <= 0) return 'text-red-400';
  if (ms < 300_000) return 'text-red-400';
  if (ms < 900_000) return 'text-amber-400';
  return 'text-emerald-400';
}

export function TimeRemaining({ expiresAt, compact = false }: TimeRemainingProps) {
  const [remaining, setRemaining] = useState(() => new Date(expiresAt).getTime() - Date.now());

  useEffect(() => {
    const interval = setInterval(() => {
      setRemaining(new Date(expiresAt).getTime() - Date.now());
    }, 1000);
    return () => clearInterval(interval);
  }, [expiresAt]);

  const color = getTimelockColor(remaining);
  const percent = Math.max(0, Math.min(100, (remaining / (24 * 3600_000)) * 100));

  if (compact) {
    return <span className={`font-mono text-sm ${color}`}>{formatDuration(remaining)}</span>;
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <span className="text-slate-400">Time Remaining</span>
        <span className={`font-mono ${color}`}>{formatDuration(remaining)}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-700">
        <div
          className={`h-full rounded-full transition-all duration-1000 ${
            remaining <= 0
              ? 'bg-red-500'
              : remaining < 300_000
                ? 'bg-red-500'
                : remaining < 900_000
                  ? 'bg-amber-500'
                  : 'bg-emerald-500'
          }`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
