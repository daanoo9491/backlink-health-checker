-- Phase 10: Google check through the browser helper (a Chrome extension that
-- searches Google from a team member's own browser and reports back).

-- Connection codes for the helper. Only a SHA-256 hash is stored; the code
-- itself is shown once, when it is created.
CREATE TABLE helper_tokens (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  label        text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX idx_helper_tokens_user ON helper_tokens (user_id);

-- Per link: the Google search result. 'FOUND' / 'NOT_FOUND', or 'ERROR'
-- after repeated failures (then it isn't tried again automatically).
ALTER TABLE unique_urls ADD COLUMN google_status text;
ALTER TABLE unique_urls ADD COLUMN google_checked_at timestamptz;
ALTER TABLE unique_urls ADD COLUMN google_claimed_at timestamptz;
ALTER TABLE unique_urls ADD COLUMN google_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE unique_urls ADD COLUMN google_detail text;
CREATE INDEX idx_unique_urls_google_queue ON unique_urls (scan_id)
  WHERE google_status IS NULL AND index_status IS NOT NULL;

ALTER TABLE helper_tokens ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE helper_tokens FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE helper_tokens FROM authenticated;
  END IF;
END $$;
