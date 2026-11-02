-- Phase 12: suspended / unavailable sites.

-- Links whose site only shows a hosting notice ("Account Suspended", "Website
-- Expired"…) get status 'SUSPENDED'; each scan counts them separately.
ALTER TABLE scans ADD COLUMN suspended_count integer NOT NULL DEFAULT 0;

-- Extra phrases the team adds in Settings, on top of the built-in list.
-- Plain text only (never a regular expression); shared by everyone.
CREATE TABLE detection_rules (
  id         uuid PRIMARY KEY,
  kind       text NOT NULL DEFAULT 'suspended' CHECK (kind IN ('suspended')),
  phrase     text NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_detection_rules_phrase ON detection_rules (kind, lower(phrase));

ALTER TABLE detection_rules ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE detection_rules FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE detection_rules FROM authenticated;
  END IF;
END $$;
