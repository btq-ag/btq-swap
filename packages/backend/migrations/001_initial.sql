CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    eth_address     VARCHAR(42) UNIQUE NOT NULL,
    btq_address     VARCHAR(128),
    dilithium_pubkey TEXT,
    role            VARCHAR(20) DEFAULT 'user',
    is_banned       BOOLEAN DEFAULT false,
    created_at      TIMESTAMPTZ DEFAULT now(),
    last_login_at   TIMESTAMPTZ
);

CREATE TABLE orders (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID REFERENCES users(id),
    direction       VARCHAR(10) NOT NULL,
    amount_btq      NUMERIC(20, 8) NOT NULL,
    price_usdt      NUMERIC(20, 6) NOT NULL,
    amount_usdt     NUMERIC(20, 6) NOT NULL,
    filled_btq      NUMERIC(20, 8) DEFAULT 0,
    status          VARCHAR(20) DEFAULT 'open',
    expires_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE swaps (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id        UUID REFERENCES orders(id),
    user_id         UUID REFERENCES users(id),
    direction       VARCHAR(10) NOT NULL,
    amount_btq      NUMERIC(20, 8) NOT NULL,
    amount_usdt     NUMERIC(20, 6) NOT NULL,
    price_usdt      NUMERIC(20, 6) NOT NULL,
    secret_hash     BYTEA,
    secret          BYTEA,
    timelock_btq    INTEGER,
    timelock_evm    TIMESTAMPTZ,
    user_dilithium_pubkey TEXT,
    user_btq_address     VARCHAR(128),
    btq_htlc_txid       VARCHAR(64),
    btq_htlc_vout       INTEGER,
    btq_htlc_created_by VARCHAR(10),
    btq_htlc_confs      INTEGER DEFAULT 0,
    btq_claim_txid      VARCHAR(64),
    btq_refund_txid     VARCHAR(64),
    btq_merkle_root     VARCHAR(64),
    claim_leaf_hex      TEXT,
    refund_leaf_hex     TEXT,
    control_block_hex   TEXT,
    evm_htlc_swap_id    BYTEA,
    evm_htlc_tx_hash    VARCHAR(66),
    evm_claim_tx_hash   VARCHAR(66),
    evm_refund_tx_hash  VARCHAR(66),
    status          VARCHAR(30) DEFAULT 'pending',
    error_message   TEXT,
    admin_notes     TEXT,
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now(),
    completed_at    TIMESTAMPTZ
);

CREATE TABLE swap_events (
    id              BIGSERIAL PRIMARY KEY,
    swap_id         UUID REFERENCES swaps(id),
    from_status     VARCHAR(30),
    to_status       VARCHAR(30) NOT NULL,
    event_type      VARCHAR(50) NOT NULL,
    metadata        JSONB,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE config (
    key             VARCHAR(100) PRIMARY KEY,
    value           JSONB NOT NULL,
    updated_by      UUID REFERENCES users(id),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE daily_stats (
    date            DATE PRIMARY KEY,
    total_swaps     INTEGER DEFAULT 0,
    completed_swaps INTEGER DEFAULT 0,
    failed_swaps    INTEGER DEFAULT 0,
    volume_btq      NUMERIC(20, 8) DEFAULT 0,
    volume_usdt     NUMERIC(20, 6) DEFAULT 0,
    unique_users    INTEGER DEFAULT 0,
    avg_completion_time_sec INTEGER
);

CREATE INDEX idx_swaps_user ON swaps(user_id);
CREATE INDEX idx_swaps_status ON swaps(status);
CREATE INDEX idx_swaps_created ON swaps(created_at);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_direction_price ON orders(direction, price_usdt);
CREATE INDEX idx_swap_events_swap ON swap_events(swap_id);

INSERT INTO config (key, value) VALUES
  ('btq_usdt_bid', '"2.45"'),
  ('btq_usdt_ask', '"2.55"'),
  ('spread_pct', '"0.04"'),
  ('min_swap_btq', '"1.0"'),
  ('max_swap_btq', '"10000.0"'),
  ('platform_fee_pct', '"0.001"'),
  ('swaps_paused', 'false'),
  ('btq_timelock_blocks', '144'),
  ('evm_timelock_seconds', '3600');
