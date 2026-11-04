export enum OrderDirection {
  BUY = 'buy',
  SELL = 'sell',
}

export enum OrderStatus {
  OPEN = 'open',
  PARTIALLY_FILLED = 'partially_filled',
  FILLED = 'filled',
  CANCELLED = 'cancelled',
  EXPIRED = 'expired',
}

export interface OrderRow {
  id: string;
  user_id: string;
  direction: OrderDirection;
  amount_btq: string;
  price_usdt: string;
  amount_usdt: string;
  filled_btq: string;
  status: OrderStatus;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
  // Funding / HTLC fields
  secret_hash: Buffer | null;
  btq_htlc_txid: string | null;
  btq_htlc_vout: number | null;
  is_funded: boolean;
  locked_by_swap_id: string | null;
  user_dilithium_pubkey: string | null;
  user_btq_address: string | null;
}

export interface CreateOrderInput {
  direction: OrderDirection;
  amount_btq: string;
  price_usdt: string;
}

export interface OrderbookEntry {
  price: string;
  amount_btq: string;
  total_usdt: string;
  order_count: number;
}

export interface Orderbook {
  bids: OrderbookEntry[];
  asks: OrderbookEntry[];
  spread: string | null;
}

export interface TradeRow {
  id: string;
  swap_id: string | null;
  maker_order_id: string;
  taker_order_id: string;
  maker_user_id: string;
  taker_user_id: string;
  direction: string;
  price_usdt: string;
  amount_btq: string;
  amount_usdt: string;
  maker_fee: string;
  taker_fee: string;
  created_at: Date;
}
