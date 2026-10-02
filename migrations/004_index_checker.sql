-- Phase 8: Index Checker, part 1 (indexability signals).

-- Every scan belongs to one tool. Index checks can be copied from a Link Health scan.
ALTER TABLE scans ADD COLUMN tool text NOT NULL DEFAULT 'links' CHECK (tool IN ('links', 'index'));
ALTER TABLE scans ADD COLUMN source_scan_id uuid REFERENCES scans(id) ON DELETE SET NULL;
ALTER TABLE scans ADD COLUMN indexable_count integer NOT NULL DEFAULT 0;
ALTER TABLE scans ADD COLUMN index_issue_count integer NOT NULL DEFAULT 0;
ALTER TABLE scans ADD COLUMN index_unknown_count integer NOT NULL DEFAULT 0;
DROP INDEX idx_scans_user_created;
CREATE INDEX idx_scans_user_tool_created ON scans (user_id, tool, created_at DESC);

-- The result for each link, and the evidence behind it ([{signal, text, bad}]).
ALTER TABLE unique_urls ADD COLUMN index_status text;
ALTER TABLE unique_urls ADD COLUMN index_reason text;
ALTER TABLE unique_urls ADD COLUMN index_evidence jsonb;

-- robots.txt is fetched once per site and reused for a day (Google caches it
-- for up to 24 hours too); a failed fetch is retried after 30 minutes.
CREATE TABLE robots_cache (
  origin      text PRIMARY KEY,                 -- "https://example.com"
  outcome     text NOT NULL CHECK (outcome IN ('file', 'no-file', 'unknown')),
  http_status integer,
  body        text,                             -- at most 500 KiB
  why         text,
  fetched_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE robots_cache ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE robots_cache FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE robots_cache FROM authenticated;
  END IF;
END $$;
