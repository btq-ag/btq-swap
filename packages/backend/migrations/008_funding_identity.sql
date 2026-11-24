-- Fail explicitly on inconsistent historical data; never discard financial recovery records.
DO $$ BEGIN
  IF EXISTS (SELECT lower(secret_hash) FROM swaps WHERE secret_hash IS NOT NULL GROUP BY lower(secret_hash) HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Duplicate swap secret hashes: reconcile existing swaps before applying 008_funding_identity';
  END IF;
  IF EXISTS (SELECT btq_lock_txid, btq_lock_vout FROM swaps WHERE btq_lock_txid IS NOT NULL GROUP BY btq_lock_txid, btq_lock_vout HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Duplicate BTQ funding outpoints: reconcile existing swaps before applying 008_funding_identity';
  END IF;
END $$;
CREATE UNIQUE INDEX swaps_unique_hash ON swaps (lower(secret_hash)) WHERE secret_hash IS NOT NULL;
CREATE UNIQUE INDEX swaps_unique_btq_outpoint ON swaps (lower(btq_lock_txid), btq_lock_vout) WHERE btq_lock_txid IS NOT NULL;

CREATE TABLE secret_hash_uses (
  secret_hash TEXT PRIMARY KEY,
  swap_id UUID NOT NULL REFERENCES swaps(id),
  lock_id TEXT
);
INSERT INTO secret_hash_uses (secret_hash, swap_id, lock_id)
SELECT lower(secret_hash), id, CASE WHEN evm_agreement_id IS NOT NULL
  THEN settlement_rail || ':' || evm_chain_id || ':' || evm_htlc_contract || ':' || evm_agreement_id END
FROM swaps WHERE secret_hash IS NOT NULL;

-- Ownership survives reorgs and rejected observations. A single physical output cannot fund two swaps.
CREATE TABLE swap_locks (
  chain TEXT NOT NULL CHECK (chain IN ('evm','btq','solana')),
  network TEXT NOT NULL,
  lock_id TEXT NOT NULL,
  swap_id UUID NOT NULL REFERENCES swaps(id),
  reason TEXT,
  metadata JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chain, network, lock_id)
);
CREATE INDEX swap_locks_swap ON swap_locks (swap_id);
INSERT INTO swap_locks (chain, network, lock_id, swap_id, metadata)
SELECT 'btq', btq_network, lower(btq_lock_txid) || ':' || btq_lock_vout, id,
  jsonb_build_object('txid', lower(btq_lock_txid), 'vout', btq_lock_vout, 'valueSats', btq_lock_sats::text)
FROM swaps WHERE btq_lock_txid IS NOT NULL;
