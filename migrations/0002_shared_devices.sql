ALTER TABLE pairings ADD COLUMN mda_device_hash TEXT;
CREATE INDEX IF NOT EXISTS pairings_mda_device_hash ON pairings(mda_device_hash);

CREATE TABLE IF NOT EXISTS account_profiles (
  device_id TEXT PRIMARY KEY NOT NULL,
  encrypted_profile TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
