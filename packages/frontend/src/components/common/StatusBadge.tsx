import { SWAP_STATUS_LABELS, SWAP_STATUS_COLORS } from '../../lib/constants';

interface StatusBadgeProps {
  status: string;
  size?: 'sm' | 'md';
}

export function StatusBadge({ status, size = 'sm' }: StatusBadgeProps) {
  const label = SWAP_STATUS_LABELS[status] || status;
  const color = SWAP_STATUS_COLORS[status] || 'bg-slate-500/20 text-slate-400';
  const sizeClasses = size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-sm';

  return (
    <span
      className={`inline-flex items-center rounded-full font-medium ${color} ${sizeClasses}`}
    >
      <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}
