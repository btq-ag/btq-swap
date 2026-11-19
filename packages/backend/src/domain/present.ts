import type { SwapRow, SwapStatus, UserRow } from './types';

export type StepState = 'done' | 'active' | 'pending' | 'skipped' | 'failed';

export interface StepView {
  key: string;
  label: string;
  state: StepState;
  tx?: string | null;
}

/** Party label safe for public surfaces. */
export function partyLabel(u: Pick<UserRow, 'is_platform' | 'is_simulated' | 'discord_username' | 'discord_id'> | null | undefined): string {
  if (!u) return 'unknown';
  if (u.is_platform) return 'BTQ MM (platform)';
  const name = u.discord_username ?? 'user';
  if (u.is_simulated) return `${name} (sim)`;
  return name.length <= 3 ? `${name[0] ?? '?'}…` : `${name.slice(0, 3)}…${name.slice(-1)}`;
}

const REFUND_STATES: SwapStatus[] = ['awaiting_buyer_refund', 'awaiting_refunds', 'refunded'];

/** Six protocol checkpoints with per-step state, used by the feed, the bot and the monitor. */
export function protocolSteps(s: SwapRow): StepView[] {
  const st = s.status;
  const usdtLocked = !!s.evm_agreement_id;
  const usdtConfirmed = usdtLocked && !['buyer_lock_confirming'].includes(st);
  const btqLocked = !!s.btq_lock_txid;
  const btqClaimed = !!s.btq_claim_txid;
  const usdtClaimed = !!s.evm_claim_tx;
  const step = (key: string, label: string, done: boolean, active: boolean, tx?: string | null): StepView => ({
    key,
    label,
    state: done ? 'done' : active ? 'active' : 'pending',
    tx,
  });
  const steps: StepView[] = [
    step('matched', 'Matched', true, false),
    step('usdt_locked', usdtConfirmed || !usdtLocked ? 'USDT locked' : 'USDT locked (confirming)', usdtConfirmed, st === 'awaiting_buyer_lock' || st === 'buyer_lock_confirming', s.evm_lock_tx),
    step('btq_locked', 'BTQ locked', btqLocked && st !== 'seller_lock_confirming', st === 'awaiting_seller_lock' || st === 'seller_lock_confirming', s.btq_lock_txid),
    step('btq_claimed', 'BTQ claimed · secret revealed', btqClaimed, st === 'awaiting_buyer_claim', s.btq_claim_txid),
    step('usdt_claimed', 'USDT claimed', usdtClaimed, st === 'awaiting_seller_claim', s.evm_claim_tx),
    step('done', st === 'completed' ? 'Completed' : 'Settled', st === 'completed', false),
  ];
  if (st === 'expired') {
    for (const x of steps.slice(1)) x.state = 'skipped';
    steps[5] = { key: 'done', label: 'Expired — nothing locked', state: 'failed' };
  } else if (REFUND_STATES.includes(st) || (st === 'failed' && !usdtClaimed)) {
    for (const x of steps) if (x.state === 'active' || x.state === 'pending') x.state = 'skipped';
    steps[5] = {
      key: 'done',
      label: st === 'refunded' ? 'Refunded' : st === 'failed' ? 'Failed' : 'Refunds pending',
      state: st === 'refunded' ? 'done' : st === 'failed' ? 'failed' : 'active',
    };
  }
  return steps;
}

export function statusTone(st: SwapStatus): 'active' | 'success' | 'warning' | 'danger' {
  if (st === 'completed') return 'success';
  if (st === 'failed') return 'danger';
  if (['expired', 'awaiting_buyer_refund', 'awaiting_refunds', 'refunded'].includes(st)) return 'warning';
  return 'active';
}

export function short(v: string | null | undefined, n = 8): string {
  if (!v) return '—';
  return v.length <= n * 2 + 1 ? v : `${v.slice(0, n)}…${v.slice(-4)}`;
}
