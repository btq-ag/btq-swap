-- Every escrow is bound to one swap before a wallet signs. Keep the binding after account closure.
CREATE TABLE solana_escrows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  swap_id UUID NOT NULL UNIQUE REFERENCES swaps(id),
  program_id TEXT NOT NULL,
  address TEXT NOT NULL,
  agreement_id TEXT NOT NULL,
  terms JSONB NOT NULL,
  vault TEXT,
  lock_signature TEXT,
  lock_time BIGINT,
  settlement_signature TEXT,
  settlement_kind TEXT CHECK (settlement_kind IN ('withdraw','refund')),
  preimage TEXT,
  scan_until TEXT,
  scan_before TEXT,
  scan_head TEXT,
  retired BOOLEAN NOT NULL DEFAULT false,
  last_polled_at TIMESTAMPTZ NOT NULL DEFAULT '-infinity',
  UNIQUE(program_id,address)
);
CREATE TABLE solana_preparations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  escrow_id UUID NOT NULL REFERENCES solana_escrows(id),
  swap_id UUID NOT NULL REFERENCES swaps(id),
  user_id UUID NOT NULL REFERENCES users(id),
  action TEXT NOT NULL CHECK(action IN ('lock','withdraw','refund')),
  message TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '10 minutes',
  signature TEXT UNIQUE,
  signed_tx TEXT,
  superseded BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Receipt IDs preserve reverse RPC order within each bounded history scan.
CREATE TABLE solana_receipts (
  id BIGSERIAL PRIMARY KEY,
  escrow_id UUID NOT NULL REFERENCES solana_escrows(id),
  signature TEXT NOT NULL,
  slot BIGINT NOT NULL,
  block_time BIGINT,
  actions JSONB NOT NULL,
  processed BOOLEAN NOT NULL DEFAULT false,
  UNIQUE(escrow_id,signature)
);

CREATE INDEX solana_pending_scan ON solana_escrows(last_polled_at,id) WHERE settlement_signature IS NULL AND NOT retired;
