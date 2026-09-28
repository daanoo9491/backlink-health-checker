-- Backlink Health Checker schema for Postgres (Supabase).
-- Applied by scripts/migrate.mjs, which records each file in schema_migrations.
-- Never edit a file that has been applied; add a new numbered file instead.

CREATE TABLE users (
  id            uuid PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE scans (
  id               uuid PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_name        text NOT NULL,
  file_size        integer NOT NULL,
  -- uploading -> ready -> queued -> running -> completed | failed
  status           text NOT NULL DEFAULT 'uploading'
                   CHECK (status IN ('uploading', 'ready', 'queued', 'running', 'completed', 'failed')),
  worksheets       integer NOT NULL DEFAULT 0,
  sheets_json      jsonb NOT NULL DEFAULT '[]',   -- per-sheet summary from the import
  headers_json     jsonb NOT NULL DEFAULT '[]',   -- original column order, for export
  expected_rows    integer NOT NULL DEFAULT 0,    -- declared at creation, verified on completion
  expected_urls    integer NOT NULL DEFAULT 0,
  total_rows       integer NOT NULL DEFAULT 0,
  valid_urls       integer NOT NULL DEFAULT 0,
  invalid_rows     integer NOT NULL DEFAULT 0,
  blank_rows       integer NOT NULL DEFAULT 0,
  unique_urls      integer NOT NULL DEFAULT 0,
  duplicate_rows   integer NOT NULL DEFAULT 0,
  checked_count    integer NOT NULL DEFAULT 0,
  active_count     integer NOT NULL DEFAULT 0,
  dead_count       integer NOT NULL DEFAULT 0,
  soft_404_count   integer NOT NULL DEFAULT 0,
  redirected_count integer NOT NULL DEFAULT 0,
  blocked_count    integer NOT NULL DEFAULT 0,
  error_count      integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  completed_at     timestamptz
);
CREATE INDEX idx_scans_user_created ON scans (user_id, created_at DESC);

-- Each unique link is checked once; every row that uses it shares the result.
CREATE TABLE unique_urls (
  scan_id          uuid NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  url_index        integer NOT NULL,              -- position in the import's unique list
  url              text NOT NULL,
  status           text NOT NULL DEFAULT 'PENDING',
  http_status      integer,
  final_url        text,
  redirected       boolean NOT NULL DEFAULT false,
  response_time_ms integer,
  error_message    text,
  check_reason     text,
  attempts         integer NOT NULL DEFAULT 0,
  checked_at       timestamptz,
  claimed_at       bigint,                        -- unix seconds; reservation while being checked
  PRIMARY KEY (scan_id, url_index)
);
CREATE INDEX idx_unique_urls_status ON unique_urls (scan_id, status);

CREATE TABLE scan_rows (
  seq            bigint GENERATED ALWAYS AS IDENTITY, -- keeps the workbook's order
  scan_id        uuid NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  sheet_name     text NOT NULL,
  row_number     integer NOT NULL,                  -- as shown in Excel
  original_value text NOT NULL,
  url_index      integer,                           -- NULL when the row was invalid
  is_duplicate   boolean NOT NULL DEFAULT false,
  invalid_reason text,
  target_url     text,
  anchor_text    text,
  backlink_found text,                              -- Phase 9: FOUND | MISSING | UNKNOWN
  cells_json     jsonb NOT NULL DEFAULT '{}',       -- every original column, for export
  PRIMARY KEY (scan_id, sheet_name, row_number)
);
CREATE INDEX idx_scan_rows_url ON scan_rows (scan_id, url_index);
CREATE INDEX idx_scan_rows_seq ON scan_rows (scan_id, seq);

-- Failed sign-in counters (by IP and by email) to slow down password guessing.
CREATE TABLE login_attempts (
  key          text PRIMARY KEY,
  failures     integer NOT NULL,
  window_start bigint NOT NULL                      -- unix seconds
);

-- Keep-alive: a daily write so Supabase's free plan never pauses the project.
CREATE TABLE heartbeat (
  id      smallint PRIMARY KEY CHECK (id = 1),
  beat_at timestamptz NOT NULL
);

-- Supabase publishes the "public" schema through its web API. This app only
-- connects directly (via Hyperdrive), so switch that door off: row level
-- security with no policies means the API's anon/authenticated roles see
-- nothing, and their table rights are removed as well.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users', 'scans', 'unique_urls', 'scan_rows', 'login_attempts', 'heartbeat'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM anon', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM authenticated', t);
    END IF;
  END LOOP;
END $$;
