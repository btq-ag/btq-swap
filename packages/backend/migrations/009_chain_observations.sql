ALTER TABLE swaps ADD COLUMN btq_lock_block_hash TEXT;
ALTER TABLE swaps ADD COLUMN btq_pending_spend_txid TEXT;
ALTER TABLE swaps ADD COLUMN btq_pending_spend_kind TEXT CHECK (btq_pending_spend_kind IN ('claim','refund'));
ALTER TABLE swaps ADD COLUMN btq_spend_raw TEXT;
ALTER TABLE swaps ADD COLUMN btq_spend_height INTEGER;
ALTER TABLE swaps ADD COLUMN btq_spend_block_hash TEXT;
ALTER TABLE swaps ADD COLUMN evm_lock_block_hash TEXT;
ALTER TABLE swaps ADD COLUMN evm_claim_block BIGINT;
ALTER TABLE swaps ADD COLUMN evm_claim_block_hash TEXT;
ALTER TABLE swaps ADD COLUMN evm_refund_block BIGINT;
ALTER TABLE swaps ADD COLUMN evm_refund_block_hash TEXT;

ALTER TABLE swaps ADD COLUMN evm_pending_claim_tx TEXT;
ALTER TABLE swaps ADD COLUMN evm_pending_refund_tx TEXT;

CREATE TABLE chain_checkpoints (
  chain TEXT NOT NULL,
  height BIGINT NOT NULL,
  block_hash TEXT NOT NULL,
  PRIMARY KEY (chain, height)
);
INSERT INTO chain_checkpoints (chain,height,block_hash)
SELECT chain,height,block_hash FROM chain_cursors WHERE block_hash IS NOT NULL;

ALTER TABLE swaps ADD COLUMN state_revision BIGINT NOT NULL DEFAULT 0;
