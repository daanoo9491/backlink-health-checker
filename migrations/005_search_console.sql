-- Phase 9: Index Checker, part 2 (Google Search Console for your own sites).

-- Where each index result came from: 'search_console' (Google's own record)
-- or 'signals' (what our crawler saw).
ALTER TABLE unique_urls ADD COLUMN index_source text;

-- URL inspections used per Search Console property per day (Pacific time,
-- as Google counts). Google allows 2,000 a day per property.
CREATE TABLE gsc_usage (
  property text NOT NULL,
  day      date NOT NULL,
  used     integer NOT NULL DEFAULT 0,
  PRIMARY KEY (property, day)
);

ALTER TABLE gsc_usage ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE gsc_usage FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE gsc_usage FROM authenticated;
  END IF;
END $$;
