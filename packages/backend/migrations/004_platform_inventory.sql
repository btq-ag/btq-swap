-- Shared platform inventory snapshot (written by the platform agent, read by every process that matches orders).
CREATE TABLE IF NOT EXISTS platform_inventory (
  id         SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  snapshot   JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
