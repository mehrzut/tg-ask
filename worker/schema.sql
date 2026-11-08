-- tg-ask relay database (Cloudflare D1). Safe to re-run.

-- One row per connected computer. The key itself is never stored, only its hash.
CREATE TABLE IF NOT EXISTS users (
  key_hash   TEXT PRIMARY KEY,
  tg_user_id INTEGER NOT NULL,
  chat_id    INTEGER NOT NULL,
  name       TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS users_tg ON users (tg_user_id);

-- `tg-ask setup` links waiting for the user to press Start. Expire after 15 min.
CREATE TABLE IF NOT EXISTS pairings (
  code       TEXT PRIMARY KEY,
  key_hash   TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Open questions. The text is blanked when the question closes, and the row is
-- deleted as soon as the asking computer has read the outcome.
CREATE TABLE IF NOT EXISTS questions (
  id         TEXT PRIMARY KEY,
  key_hash   TEXT NOT NULL,
  tg_user_id INTEGER NOT NULL,
  chat_id    INTEGER NOT NULL,
  message_id INTEGER,
  text       TEXT NOT NULL,
  options    TEXT NOT NULL,
  status     TEXT NOT NULL,          -- pending | answered | cancelled | expired
  answer     TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS questions_open ON questions (tg_user_id, status);
