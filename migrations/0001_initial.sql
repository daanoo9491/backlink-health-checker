-- Phase 3: users, scans, source rows, unique URLs, login throttling.
-- Check results (Phase 4+) are stored on unique_urls: each unique link is
-- checked once and every row that points at it shares that result.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE scans (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_name       TEXT NOT NULL,
  file_size       INTEGER NOT NULL,
  -- uploading -> ready -> queued -> running -> completed | failed
  status          TEXT NOT NULL DEFAULT 'uploading'
                  CHECK (status IN ('uploading', 'ready', 'queued', 'running', 'completed', 'failed')),
  worksheets      INTEGER NOT NULL DEFAULT 0,
  sheets_json     TEXT NOT NULL DEFAULT '[]',   -- per-sheet summary from the import
  headers_json    TEXT NOT NULL DEFAULT '[]',   -- original column order, for export
  expected_rows   INTEGER NOT NULL DEFAULT 0,   -- declared at creation, verified on completion
  expected_urls   INTEGER NOT NULL DEFAULT 0,
  total_rows      INTEGER NOT NULL DEFAULT 0,
  valid_urls      INTEGER NOT NULL DEFAULT 0,
  invalid_rows    INTEGER NOT NULL DEFAULT 0,
  blank_rows      INTEGER NOT NULL DEFAULT 0,
  unique_urls     INTEGER NOT NULL DEFAULT 0,
  duplicate_rows  INTEGER NOT NULL DEFAULT 0,
  checked_count   INTEGER NOT NULL DEFAULT 0,
  active_count    INTEGER NOT NULL DEFAULT 0,
  dead_count      INTEGER NOT NULL DEFAULT 0,
  soft_404_count  INTEGER NOT NULL DEFAULT 0,
  redirected_count INTEGER NOT NULL DEFAULT 0,
  blocked_count   INTEGER NOT NULL DEFAULT 0,
  error_count     INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  started_at      TEXT,
  completed_at    TEXT
);
CREATE INDEX idx_scans_user_created ON scans (user_id, created_at DESC);

CREATE TABLE unique_urls (
  scan_id          TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  url_index        INTEGER NOT NULL,           -- position in the import's unique list
  url              TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'PENDING',
  http_status      INTEGER,
  final_url        TEXT,
  redirected       INTEGER NOT NULL DEFAULT 0,
  response_time_ms INTEGER,
  error_message    TEXT,
  check_reason     TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  checked_at       TEXT,
  PRIMARY KEY (scan_id, url_index)
);
CREATE INDEX idx_unique_urls_status ON unique_urls (scan_id, status);

CREATE TABLE scan_rows (
  scan_id        TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  sheet_name     TEXT NOT NULL,
  row_number     INTEGER NOT NULL,             -- as shown in Excel
  original_value TEXT NOT NULL,
  url_index      INTEGER,                      -- NULL when the row was invalid
  is_duplicate   INTEGER NOT NULL DEFAULT 0,
  invalid_reason TEXT,
  target_url     TEXT,
  anchor_text    TEXT,
  backlink_found TEXT,                         -- Phase 9: FOUND | MISSING | UNKNOWN
  cells_json     TEXT NOT NULL DEFAULT '{}',   -- every original column, for export
  PRIMARY KEY (scan_id, sheet_name, row_number)
);
CREATE INDEX idx_scan_rows_url ON scan_rows (scan_id, url_index);

-- Failed sign-in counters (by IP and by email) to slow down password guessing.
CREATE TABLE login_attempts (
  key              TEXT PRIMARY KEY,
  failures         INTEGER NOT NULL,
  window_start     INTEGER NOT NULL            -- unix seconds
);
