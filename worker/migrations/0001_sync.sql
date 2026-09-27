-- One row per "space": one person's data, as a single encrypted blob.
--
-- The server cannot read any of it. The blob is encrypted on the device with
-- a key derived from a code that never leaves it, so what is stored here is
-- ciphertext and nothing else. No names, no addresses, no schedule.
CREATE TABLE IF NOT EXISTS spaces (
  space_id     TEXT PRIMARY KEY,      -- random, shown as part of the pairing code
  auth_hash    TEXT NOT NULL,         -- SHA-256 of the auth secret; proves the caller knows the code
  blob         TEXT,                  -- base64 ciphertext, opaque here
  version      INTEGER NOT NULL DEFAULT 0,
  primary_device TEXT,                -- which device may write
  updated_at   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  bytes        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS spaces_updated ON spaces(updated_at);
