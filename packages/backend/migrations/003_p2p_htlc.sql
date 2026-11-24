-- BTQ Swap v2: Discord identity + P2P HTLC settlement.
-- Legacy custody-flow tables are preserved as legacy_* (no data loss, FKs follow the rename).

ALTER TABLE IF EXISTS trades      RENAME TO legacy_trades;
ALTER TABLE IF EXISTS swap_events RENAME TO legacy_swap_events;
ALTER TABLE IF EXISTS swaps       RENAME TO legacy_swaps;
ALTER TABLE IF EXISTS orders      RENAME TO legacy_orders;
ALTER TABLE IF EXISTS daily_stats RENAME TO legacy_daily_stats;

-- ── users: Discord snowflake is the identity; wallets are linked attributes ──
ALTER TABLE users ALTER COLUMN eth_address DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_id             TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_username       TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS tos_accepted_at        TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS tos_version            TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS notifications_enabled  BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_simulated           BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_platform            BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS eth_verified_at        TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS btq_pubkey_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_at              TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS no_show_count          INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at             TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS users_one_platform ON users (is_platform) WHERE is_platform;

CREATE TABLE IF NOT EXISTS admin_users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discord_id  TEXT NOT NULL UNIQUE,
  role        TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'viewer')),
  disabled_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGSERIAL PRIMARY KEY,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT,
  details    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS link_challenges (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id),
  kind        TEXT NOT NULL CHECK (kind IN ('evm', 'btq')),
  challenge   TEXT NOT NULL UNIQUE,
  message     TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS link_challenges_user ON link_challenges (user_id, kind, created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO settings (key, value) VALUES
  ('book_paused',          'false'),
  ('min_order_btq',        '"0.1"'),
  ('max_order_btq',        '"1000"'),
  ('mm_max_notional_usdt', '"100000"'),
  ('mm_max_order_btq',     '"500"'),
  ('mm_min_spread_pct',    '"0.5"')
ON CONFLICT (key) DO NOTHING;

-- ── order book (intents; never pre-funded) ──
CREATE TABLE orders (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  short_id     BIGSERIAL UNIQUE,
  user_id      UUID NOT NULL REFERENCES users(id),
  side         TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  price_usdt   NUMERIC(20, 6) NOT NULL CHECK (price_usdt > 0),
  amount_btq   NUMERIC(20, 8) NOT NULL CHECK (amount_btq > 0),
  filled_btq   NUMERIC(20, 8) NOT NULL DEFAULT 0 CHECK (filled_btq >= 0),
  is_mm        BOOLEAN NOT NULL DEFAULT false,
  tif          TEXT NOT NULL DEFAULT 'gtc' CHECK (tif IN ('gtc', 'ioc')),
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'partially_filled', 'filled', 'cancelled', 'paused')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (filled_btq <= amount_btq)
);
CREATE INDEX orders_matching ON orders (side, status, price_usdt, created_at) WHERE status IN ('open', 'partially_filled');
CREATE INDEX orders_user ON orders (user_id, created_at DESC);

-- ── swaps: one per fill, both parties bound at match time ──
CREATE TABLE swaps (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  short_id             BIGSERIAL UNIQUE,
  maker_order_id       UUID NOT NULL REFERENCES orders(id),
  taker_order_id       UUID NOT NULL REFERENCES orders(id),
  maker_user_id        UUID NOT NULL REFERENCES users(id),
  taker_user_id        UUID NOT NULL REFERENCES users(id),
  buyer_user_id        UUID NOT NULL REFERENCES users(id),
  seller_user_id       UUID NOT NULL REFERENCES users(id),
  status               TEXT NOT NULL,
  amount_btq           NUMERIC(20, 8) NOT NULL,
  amount_sats          BIGINT NOT NULL CHECK (amount_sats > 0),
  price_usdt           NUMERIC(20, 6) NOT NULL,
  amount_usdt          NUMERIC(20, 6) NOT NULL,
  amount_usdt_units    NUMERIC(40, 0) NOT NULL CHECK (amount_usdt_units > 0),
  buyer_eth            TEXT NOT NULL,
  seller_eth           TEXT NOT NULL,
  buyer_btq_pubkey     TEXT NOT NULL,
  seller_btq_pubkey    TEXT NOT NULL,
  buyer_btq_address    TEXT,
  seller_btq_address   TEXT,
  secret_hash          TEXT,                 -- hex, set from the buyer's on-chain EVM lock (or by the platform when it is the buyer)
  platform_secret_enc  TEXT,                 -- AES-256-GCM preimage, only when the platform is the buyer
  revealed_preimage    TEXT,                 -- hex, public once the buyer claims BTQ
  -- EVM leg: buyer → seller
  evm_chain_id         INTEGER NOT NULL,
  evm_htlc_contract    TEXT NOT NULL,
  evm_token            TEXT NOT NULL,
  evm_agreement_id     TEXT UNIQUE,
  evm_lock_tx          TEXT,
  evm_lock_block       BIGINT,
  evm_deadline         TIMESTAMPTZ,
  evm_lock_confs       INTEGER NOT NULL DEFAULT 0,
  evm_claim_tx         TEXT,
  evm_refund_tx        TEXT,
  -- BTQ leg: seller → buyer
  btq_network          TEXT NOT NULL,
  btq_refund_locktime  INTEGER,
  btq_htlc_address     TEXT,
  btq_htlc_spk         TEXT,
  btq_lock_txid        TEXT,
  btq_lock_vout        INTEGER,
  btq_lock_sats        BIGINT,
  btq_lock_height      INTEGER,
  btq_lock_confs       INTEGER NOT NULL DEFAULT 0,
  btq_claim_txid       TEXT,
  btq_refund_txid      TEXT,
  -- off-chain step deadlines
  buyer_lock_by        TIMESTAMPTZ NOT NULL,
  seller_lock_by       TIMESTAMPTZ,
  failure_reason       TEXT,
  admin_notes          TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at         TIMESTAMPTZ,
  CHECK (buyer_user_id <> seller_user_id)
);
CREATE INDEX swaps_status ON swaps (status);
CREATE INDEX swaps_buyer ON swaps (buyer_user_id, created_at DESC);
CREATE INDEX swaps_seller ON swaps (seller_user_id, created_at DESC);
CREATE INDEX swaps_btq_spk ON swaps (btq_htlc_spk) WHERE btq_htlc_spk IS NOT NULL;

CREATE TABLE swap_events (
  id          BIGSERIAL PRIMARY KEY,
  swap_id     UUID NOT NULL REFERENCES swaps(id),
  from_status TEXT,
  to_status   TEXT,
  event_type  TEXT NOT NULL,
  actor       TEXT NOT NULL DEFAULT 'system',
  action_key  TEXT UNIQUE,                 -- idempotency key for side-effecting platform actions
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX swap_events_swap ON swap_events (swap_id, id);
CREATE INDEX swap_events_recent ON swap_events (created_at DESC);

CREATE TABLE trades (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  swap_id        UUID NOT NULL REFERENCES swaps(id),
  maker_order_id UUID NOT NULL REFERENCES orders(id),
  taker_order_id UUID NOT NULL REFERENCES orders(id),
  maker_user_id  UUID NOT NULL REFERENCES users(id),
  taker_user_id  UUID NOT NULL REFERENCES users(id),
  taker_side     TEXT NOT NULL CHECK (taker_side IN ('buy', 'sell')),
  price_usdt     NUMERIC(20, 6) NOT NULL,
  amount_btq     NUMERIC(20, 8) NOT NULL,
  amount_usdt    NUMERIC(20, 6) NOT NULL,
  maker_fee      NUMERIC(20, 6) NOT NULL DEFAULT 0,
  taker_fee      NUMERIC(20, 6) NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX trades_created ON trades (created_at DESC);

-- ── transactional outbox → Discord DMs ──
CREATE TABLE notifications (
  id              BIGSERIAL PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id),
  swap_id         UUID REFERENCES swaps(id),
  kind            TEXT NOT NULL,
  dedupe_key      TEXT NOT NULL UNIQUE,
  payload         JSONB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed', 'skipped', 'simulated')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error      TEXT,
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notifications_due ON notifications (status, next_attempt_at) WHERE status = 'queued';

-- ── public Discord feed: one message per swap, edited as it progresses ──
CREATE TABLE feed_messages (
  swap_id       UUID PRIMARY KEY REFERENCES swaps(id),
  channel_id    TEXT NOT NULL,
  message_id    TEXT,
  rendered_hash TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── chain watcher cursors ──
CREATE TABLE chain_cursors (
  chain      TEXT PRIMARY KEY,           -- 'btq' | 'evm'
  height     BIGINT NOT NULL,
  block_hash TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── devnet bookkeeping (contract addresses, bootstrap markers) ──
CREATE TABLE devnet_state (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
