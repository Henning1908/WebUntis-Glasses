CREATE TABLE IF NOT EXISTS app_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  encrypted_profile TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pairings (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting'
);
CREATE INDEX IF NOT EXISTS pairings_code_created ON pairings(code, created_at);
