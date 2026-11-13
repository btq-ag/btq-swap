-- Solana settlement rail. Existing swaps stay on EVM.
ALTER TABLE users ADD COLUMN IF NOT EXISTS sol_address TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_sol_address ON users (sol_address) WHERE sol_address IS NOT NULL;

ALTER TABLE swaps ADD COLUMN IF NOT EXISTS settlement_rail TEXT NOT NULL DEFAULT 'evm';
ALTER TABLE swaps ADD COLUMN IF NOT EXISTS buyer_sol TEXT;
ALTER TABLE swaps ADD COLUMN IF NOT EXISTS seller_sol TEXT;
ALTER TABLE swaps DROP CONSTRAINT IF EXISTS swaps_settlement_rail_check;
ALTER TABLE swaps ADD CONSTRAINT swaps_settlement_rail_check CHECK (settlement_rail IN ('evm', 'solana'));

ALTER TABLE link_challenges DROP CONSTRAINT IF EXISTS link_challenges_kind_check;
ALTER TABLE link_challenges ADD CONSTRAINT link_challenges_kind_check CHECK (kind IN ('evm', 'btq', 'sol'));

INSERT INTO settings (key, value) VALUES ('settlement_rail', '"evm"')
ON CONFLICT (key) DO NOTHING;
