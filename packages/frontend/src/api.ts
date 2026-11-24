export type Tone = 'active' | 'success' | 'warning' | 'danger';
export type StepState = 'done' | 'active' | 'pending' | 'skipped' | 'failed';

export interface Step {
  key: 'matched' | 'usdt_locked' | 'btq_locked' | 'btq_claimed' | 'usdt_claimed' | 'done';
  label: string;
  state: StepState;
  tx?: string | null;
}

export interface Party {
  label: string;
  platform: boolean;
  simulated: boolean;
}

export interface SwapView {
  id: string;
  shortId: number;
  status: string;
  statusLabel: string;
  tone: Tone;
  amountBtq: string;
  amountUsdt: string;
  price: string;
  buyer: Party;
  seller: Party;
  steps: Step[];
  secretHash: string | null;
  preimage: string | null;
  rail?: 'evm' | 'solana';
  evm: { chainId: number; contract: string; agreementId: string | null; lockTx: string | null; lockConfs: number; deadline: string | null; claimTx: string | null; refundTx: string | null };
  btq: { network: string; htlcAddress: string | null; refundLocktime: number | null; lockTxid: string | null; lockVout: number | null; lockConfs: number; claimTxid: string | null; refundTxid: string | null };
  deadlines: { buyerLockBy: string; sellerLockBy: string | null };
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  durationSec: number | null;
}

export interface MonitorState {
  generatedAt: string;
  chains: {
    btq: { network: string; tip: number; tipHash: string; mempool: number; lastTickAt: number; targetBlockSec: number; minConfirmations: number };
    evm: { chainId: number; head: number; lastTickAt: number; minConfirmations: number };
    solana?: { slot: number; lastTickAt: number; reachable: boolean };
  };
  settlementRail?: 'evm' | 'solana';
  timing: { buyerLockWindowSec: number; evmLockDurationSec: number; sellerLockWindowSec: number; btqLockBlocks: number; safetyMarginSec: number; sellerBudgetSec: number };
  stats: { active: number; completed: number; refunded: number; expired: number; failed: number; volumeBtq: string; volumeUsdt: string; avgCompletionSec: number };
  book: {
    bids: Array<{ price: string; amountBtq: string; orders: number; mm: boolean }>;
    asks: Array<{ price: string; amountBtq: string; orders: number; mm: boolean }>;
    topBids: Array<{ orderNo: number; price: string; remainingBtq: string; mm: boolean }>;
    topAsks: Array<{ orderNo: number; price: string; remainingBtq: string; mm: boolean }>;
    bestBid: string | null;
    bestAsk: string | null;
    paused: boolean;
  };
  inventory: { at: number; btq: string; btqInHtlc: string; btqCommitted: string; usdt: string; usdtInHtlc: string; usdtCommitted: string; eth: string } | null;
  swaps: SwapView[];
  events: Array<{ swap: number; type: string; from: string | null; to: string | null; actor: string; meta: Record<string, unknown>; at: string }>;
  notifications: Array<{ kind: string; status: string; title: string; at: string; user: string }>;
}

export interface SwapDetail {
  swap: SwapView;
  events: Array<{ id: string; event_type: string; from_status: string | null; to_status: string | null; actor: string; metadata: Record<string, unknown>; created_at: string }>;
}

export async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, { credentials: 'same-origin', ...init });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body as T;
}

export function adminFetch<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  return getJson<T>(`/admin${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-btq-request': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
