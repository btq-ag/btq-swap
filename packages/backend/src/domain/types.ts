export type Side = 'buy' | 'sell';

export const SWAP_STATUSES = [
  'awaiting_buyer_lock',
  'buyer_lock_confirming',
  'awaiting_seller_lock',
  'seller_lock_confirming',
  'awaiting_buyer_claim',
  'awaiting_seller_claim',
  'completed',
  'expired',
  'awaiting_buyer_refund',
  'awaiting_refunds',
  'refunded',
  'failed',
] as const;
export type SwapStatus = (typeof SWAP_STATUSES)[number];

export const TERMINAL_STATUSES: readonly SwapStatus[] = ['completed', 'expired', 'refunded', 'failed'];
export const ACTIVE_STATUSES: readonly SwapStatus[] = SWAP_STATUSES.filter((s) => !TERMINAL_STATUSES.includes(s));

export function isTerminal(s: SwapStatus): boolean {
  return TERMINAL_STATUSES.includes(s);
}

export interface UserRow {
  id: string;
  discord_id: string | null;
  discord_username: string | null;
  eth_address: string | null;
  sol_address: string | null;
  btq_address: string | null;
  dilithium_pubkey: string | null;
  role: string | null;
  is_banned: boolean;
  is_simulated: boolean;
  is_platform: boolean;
  notifications_enabled: boolean;
  tos_accepted_at: Date | null;
  tos_version: string | null;
  eth_verified_at: Date | null;
  btq_pubkey_verified_at: Date | null;
  no_show_count: number;
  created_at: Date;
}

export interface OrderRow {
  id: string;
  short_id: string;
  user_id: string;
  side: Side;
  price_usdt: string;
  amount_btq: string;
  filled_btq: string;
  is_mm: boolean;
  tif: 'gtc' | 'ioc';
  status: 'open' | 'partially_filled' | 'filled' | 'cancelled' | 'paused';
  created_at: Date;
  updated_at: Date;
}

export interface SwapRow {
  id: string;
  short_id: string;
  maker_order_id: string;
  taker_order_id: string;
  maker_user_id: string;
  taker_user_id: string;
  buyer_user_id: string;
  seller_user_id: string;
  status: SwapStatus;
  amount_btq: string;
  amount_sats: string;
  price_usdt: string;
  amount_usdt: string;
  amount_usdt_units: string;
  buyer_eth: string;
  seller_eth: string;
  settlement_rail: 'evm' | 'solana';
  buyer_sol: string | null;
  seller_sol: string | null;
  buyer_btq_pubkey: string;
  seller_btq_pubkey: string;
  buyer_btq_address: string | null;
  seller_btq_address: string | null;
  secret_hash: string | null;
  platform_secret_enc: string | null;
  revealed_preimage: string | null;
  evm_chain_id: number;
  evm_htlc_contract: string;
  evm_token: string;
  evm_agreement_id: string | null;
  evm_lock_tx: string | null;
  evm_lock_block: string | null;
  evm_deadline: Date | null;
  evm_lock_confs: number;
  evm_claim_tx: string | null;
  evm_refund_tx: string | null;
  btq_network: string;
  btq_refund_locktime: number | null;
  btq_htlc_address: string | null;
  btq_htlc_spk: string | null;
  btq_lock_txid: string | null;
  btq_lock_vout: number | null;
  btq_lock_sats: string | null;
  btq_lock_height: number | null;
  btq_lock_confs: number;
  btq_claim_txid: string | null;
  btq_refund_txid: string | null;
  buyer_lock_by: Date;
  seller_lock_by: Date | null;
  failure_reason: string | null;
  admin_notes: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export interface SwapEventRow {
  id: string;
  swap_id: string;
  from_status: SwapStatus | null;
  to_status: SwapStatus | null;
  event_type: string;
  actor: string;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export type Role = 'buyer' | 'seller';

export function roleOf(swap: Pick<SwapRow, 'buyer_user_id' | 'seller_user_id'>, userId: string): Role | null {
  if (swap.buyer_user_id === userId) return 'buyer';
  if (swap.seller_user_id === userId) return 'seller';
  return null;
}

/** Human labels used by the bot, feed and monitor. */
export const STATUS_LABEL: Record<SwapStatus, string> = {
  awaiting_buyer_lock: 'Waiting for buyer to lock USDT',
  buyer_lock_confirming: 'Buyer USDT lock confirming',
  awaiting_seller_lock: 'Waiting for seller to lock BTQ',
  seller_lock_confirming: 'Seller BTQ lock confirming',
  awaiting_buyer_claim: 'Waiting for buyer to claim BTQ',
  awaiting_seller_claim: 'Secret revealed — seller claiming USDT',
  completed: 'Completed',
  expired: 'Expired (buyer never locked)',
  awaiting_buyer_refund: 'Seller no-show — buyer refund pending',
  awaiting_refunds: 'Timed out — refunds pending',
  refunded: 'Refunded',
  failed: 'Failed',
};

/** The six protocol checkpoints shown as a progress bar. */
export const PROTOCOL_STEPS = ['matched', 'usdt_locked', 'btq_locked', 'btq_claimed', 'usdt_claimed', 'done'] as const;
