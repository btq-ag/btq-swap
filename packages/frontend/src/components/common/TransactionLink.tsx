import { ETH_EXPLORER_URL, BTQ_EXPLORER_URL } from '../../lib/constants';

interface TransactionLinkProps {
  hash: string;
  type: 'eth' | 'btq';
  label?: string;
}

export function TransactionLink({ hash, type, label }: TransactionLinkProps) {
  const baseUrl = type === 'eth' ? ETH_EXPLORER_URL : BTQ_EXPLORER_URL;
  const path = type === 'eth' ? `/tx/${hash}` : `/tx/${hash}`;
  const shortHash = `${hash.slice(0, 8)}...${hash.slice(-6)}`;

  return (
    <a
      href={`${baseUrl}${path}`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-sm text-blue-400 hover:text-blue-300 transition-colors"
    >
      <span className="font-mono">{label || shortHash}</span>
      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
      </svg>
    </a>
  );
}
