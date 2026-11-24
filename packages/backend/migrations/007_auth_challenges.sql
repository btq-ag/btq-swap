-- Existing pending challenges predate explicit selection and cannot be completed by the new API.
ALTER TABLE link_challenges ADD COLUMN purpose TEXT NOT NULL DEFAULT 'identity'
  CHECK (purpose IN ('identity', 'desk_signin', 'desk_link'));
ALTER TABLE link_challenges ADD COLUMN target_address TEXT;
CREATE UNIQUE INDEX users_btq_key ON users (dilithium_pubkey) WHERE dilithium_pubkey IS NOT NULL;
CREATE UNIQUE INDEX users_evm_address ON users (lower(eth_address)) WHERE eth_address IS NOT NULL;
