-- Browser desk sessions. The raw token is returned once; only its SHA-256 is stored.
CREATE TABLE IF NOT EXISTS desk_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS desk_sessions_user ON desk_sessions (user_id, expires_at DESC);
