-- ─────────────────────────────────────────────────────────────────
-- Post Machine — D1 Schema
-- Run: wrangler d1 execute post-machine-db --file=./schema.sql
-- ─────────────────────────────────────────────────────────────────

-- ── Users ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id           TEXT    PRIMARY KEY,          -- UUIDv4
  email        TEXT    NOT NULL UNIQUE,      -- login identifier
  display_name TEXT    NOT NULL,
  password_hash TEXT   NOT NULL,             -- PBKDF2-SHA256, base64url
  password_salt TEXT   NOT NULL,             -- 16-byte random, base64url
  is_active    INTEGER NOT NULL DEFAULT 1,   -- 0 = disabled
  created_at   INTEGER NOT NULL,             -- Unix ms
  last_login   INTEGER                       -- Unix ms, nullable
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ── Sessions (also stored in KV for fast lookup; D1 is audit record) ──
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT    PRIMARY KEY,          -- session token (secure random)
  user_id      TEXT    NOT NULL REFERENCES users(id),
  user_email   TEXT    NOT NULL,
  ip_address   TEXT,
  user_agent   TEXT,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  revoked      INTEGER NOT NULL DEFAULT 0    -- 1 = logged out
);

CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ── Share Log ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS share_log (
  id            TEXT    PRIMARY KEY,
  user_id       TEXT    REFERENCES users(id),
  session_id    TEXT,
  article_url   TEXT    NOT NULL,
  article_title TEXT,
  channel       TEXT    NOT NULL,             -- 'email' | 'telegram'
  recipient     TEXT,                         -- SHA-256 hashed
  message_id    TEXT,                         -- provider delivery ID
  status        TEXT    NOT NULL DEFAULT 'sent', -- 'sent'|'failed'
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_share_user    ON share_log(user_id);
CREATE INDEX IF NOT EXISTS idx_share_created ON share_log(created_at);
CREATE INDEX IF NOT EXISTS idx_share_channel ON share_log(channel);

-- ── Application Logs ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_logs (
  id           TEXT    PRIMARY KEY,
  level        INTEGER NOT NULL,
  level_label  TEXT    NOT NULL,
  source       TEXT    NOT NULL,
  message      TEXT    NOT NULL,
  meta         TEXT,
  user_id      TEXT,
  session_id   TEXT,
  request_id   TEXT,
  duration_ms  INTEGER,
  status_code  INTEGER,
  error_stack  TEXT,
  env          TEXT    NOT NULL DEFAULT 'production',
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_logs_level    ON app_logs(level);
CREATE INDEX IF NOT EXISTS idx_logs_source   ON app_logs(source);
CREATE INDEX IF NOT EXISTS idx_logs_user     ON app_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_logs_request  ON app_logs(request_id);
CREATE INDEX IF NOT EXISTS idx_logs_created  ON app_logs(created_at);
