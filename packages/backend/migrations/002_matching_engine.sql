-- Orders: add funding state and HTLC linkage
ALTER TABLE orders ADD COLUMN IF NOT EXISTS secret_hash      BYTEA;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS btq_htlc_txid    VARCHAR(64);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS btq_htlc_vout    INTEGER;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_funded         BOOLEAN DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS locked_by_swap_id UUID REFERENCES swaps(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS user_dilithium_pubkey TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS user_btq_address  VARCHAR(128);

CREATE INDEX IF NOT EXISTS idx_orders_matching
  ON orders (direction, status, is_funded, price_usdt, created_at)
  WHERE status IN ('open', 'partially_filled') AND is_funded = true;

-- Trades: every fill produces a trade record (for chart + history)
CREATE TABLE IF NOT EXISTS trades (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    swap_id         UUID REFERENCES swaps(id),
    maker_order_id  UUID REFERENCES orders(id) NOT NULL,
    taker_order_id  UUID REFERENCES orders(id) NOT NULL,
    maker_user_id   UUID REFERENCES users(id) NOT NULL,
    taker_user_id   UUID REFERENCES users(id) NOT NULL,
    direction       VARCHAR(10) NOT NULL,
    price_usdt      NUMERIC(20, 6) NOT NULL,
    amount_btq      NUMERIC(20, 8) NOT NULL,
    amount_usdt     NUMERIC(20, 6) NOT NULL,
    maker_fee       NUMERIC(20, 8) DEFAULT 0,
    taker_fee       NUMERIC(20, 8) DEFAULT 0,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trades_created ON trades (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trades_maker   ON trades (maker_user_id);
CREATE INDEX IF NOT EXISTS idx_trades_taker   ON trades (taker_user_id);
CREATE INDEX IF NOT EXISTS idx_trades_price_time ON trades (created_at, price_usdt);
