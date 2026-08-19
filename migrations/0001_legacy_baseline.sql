-- Baseline compatible with the first Athar Console schema.
-- IF NOT EXISTS makes this safe when the remote database already contains v1 data.

CREATE TABLE IF NOT EXISTS clients (
  id          TEXT PRIMARY KEY,
  product     TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  contact     TEXT DEFAULT '',
  plan        TEXT NOT NULL,
  price_usd   REAL NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  paid_until  TEXT DEFAULT '',
  notes       TEXT DEFAULT '',
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id         TEXT PRIMARY KEY,
  client_id  TEXT NOT NULL,
  amount_usd REAL NOT NULL,
  paid_on    TEXT NOT NULL,
  method     TEXT DEFAULT 'cash',
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_clients_product ON clients(product);
CREATE INDEX IF NOT EXISTS idx_payments_client ON payments(client_id);
