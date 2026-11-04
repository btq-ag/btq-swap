export enum SwapDirection {
  BUY_BTQ = 'buy_btq',
  SELL_BTQ = 'sell_btq',
}

export enum SwapStatus {
  PENDING = 'pending',

  // Buy-BTQ flow: platform creates BTQ HTLC first, user locks USDT on EVM
  BTQ_HTLC_CREATED = 'btq_htlc_created',
  AWAITING_EVM_LOCK = 'awaiting_evm_lock',
  EVM_HTLC_VERIFIED = 'evm_htlc_verified',
  PLATFORM_CLAIMING_USDT = 'platform_claiming_usdt',
  SECRET_REVEALED = 'secret_revealed',
  AWAITING_USER_BTQ_CLAIM = 'awaiting_user_btq_claim',

  // Sell-BTQ flow: user creates BTQ HTLC, platform locks USDT on EVM
  AWAITING_USER_BTQ_HTLC = 'awaiting_user_btq_htlc',
  BTQ_HTLC_VERIFIED = 'btq_htlc_verified',
  BTQ_HTLC_CONFIRMED = 'btq_htlc_confirmed',
  PLATFORM_LOCKING_USDT = 'platform_locking_usdt',
  EVM_HTLC_CREATED = 'evm_htlc_created',
  AWAITING_USER_USDT_CLAIM = 'awaiting_user_usdt_claim',
  USER_CLAIMED_USDT = 'user_claimed_usdt',
  PLATFORM_CLAIMING_BTQ = 'platform_claiming_btq',

  // Terminal states
  COMPLETED = 'completed',
  REFUNDED = 'refunded',
  EXPIRED = 'expired',
  FAILED = 'failed',
}

export const BUY_BTQ_FLOW: SwapStatus[] = [
  SwapStatus.PENDING,
  SwapStatus.BTQ_HTLC_CREATED,
  SwapStatus.AWAITING_EVM_LOCK,
  SwapStatus.EVM_HTLC_VERIFIED,
  SwapStatus.PLATFORM_CLAIMING_USDT,
  SwapStatus.SECRET_REVEALED,
  SwapStatus.AWAITING_USER_BTQ_CLAIM,
  SwapStatus.COMPLETED,
];

export const SELL_BTQ_FLOW: SwapStatus[] = [
  SwapStatus.PENDING,
  SwapStatus.AWAITING_USER_BTQ_HTLC,
  SwapStatus.BTQ_HTLC_VERIFIED,
  SwapStatus.BTQ_HTLC_CONFIRMED,
  SwapStatus.PLATFORM_LOCKING_USDT,
  SwapStatus.EVM_HTLC_CREATED,
  SwapStatus.AWAITING_USER_USDT_CLAIM,
  SwapStatus.USER_CLAIMED_USDT,
  SwapStatus.PLATFORM_CLAIMING_BTQ,
  SwapStatus.COMPLETED,
];

export const TERMINAL_STATUSES: SwapStatus[] = [
  SwapStatus.COMPLETED,
  SwapStatus.REFUNDED,
  SwapStatus.EXPIRED,
  SwapStatus.FAILED,
];

export interface SwapRow {
  id: string;
  order_id: string | null;
  user_id: string;
  direction: SwapDirection;
  amount_btq: string;
  amount_usdt: string;
  price_usdt: string;
  secret_hash: Buffer | null;
  secret: Buffer | null;
  timelock_btq: number | null;
  timelock_evm: Date | null;
  user_dilithium_pubkey: string | null;
  user_btq_address: string | null;
  btq_htlc_txid: string | null;
  btq_htlc_vout: number | null;
  btq_htlc_created_by: string | null;
  btq_htlc_confs: number;
  btq_claim_txid: string | null;
  btq_refund_txid: string | null;
  btq_merkle_root: string | null;
  claim_leaf_hex: string | null;
  refund_leaf_hex: string | null;
  control_block_hex: string | null;
  evm_htlc_swap_id: Buffer | null;
  evm_htlc_tx_hash: string | null;
  evm_claim_tx_hash: string | null;
  evm_refund_tx_hash: string | null;
  status: SwapStatus;
  error_message: string | null;
  admin_notes: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export interface CreateSwapInput {
  direction: SwapDirection;
  amount_btq: string;
  user_dilithium_pubkey?: string;
  user_btq_address?: string;
}

export interface SubmitBtqHtlcInput {
  swap_id: string;
  btq_htlc_txid: string;
  btq_htlc_vout: number;
  btq_merkle_root: string;
  claim_leaf_hex: string;
  refund_leaf_hex: string;
  control_block_hex: string;
}

export interface ConfirmBtqClaimInput {
  swap_id: string;
  btq_claim_txid: string;
}

export interface SwapEventRow {
  id: number;
  swap_id: string;
  from_status: SwapStatus | null;
  to_status: SwapStatus;
  event_type: string;
  metadata: Record<string, unknown> | null;
  created_at: Date;
}

export interface SwapWithEvents extends SwapRow {
  events: SwapEventRow[];
}
