-- Phase 5: background checking through Cloudflare Queues.

-- A scan can be paused by the user; checking resumes from where it stopped.
ALTER TABLE scans DROP CONSTRAINT scans_status_check;
ALTER TABLE scans ADD CONSTRAINT scans_status_check
  CHECK (status IN ('uploading', 'ready', 'queued', 'running', 'paused', 'completed', 'failed'));

-- Each scan has at most one live chain of queue messages. Starting a scan
-- mints a new chain id; messages from any older chain are ignored, so a
-- double click or a revived scan never runs two chains at once.
ALTER TABLE scans ADD COLUMN chain_id uuid;
-- Updated by every batch; a running scan whose heartbeat goes quiet is
-- restarted by the 15-minute Cron safety net.
ALTER TABLE scans ADD COLUMN heartbeat_at timestamptz;

-- Temporary failures (timeouts, 429, 5xx, connection problems) are retried
-- automatically with growing waits. retry_at = when the next attempt is due.
ALTER TABLE unique_urls ADD COLUMN retry_at bigint;
CREATE INDEX idx_unique_urls_retry ON unique_urls (scan_id, retry_at) WHERE retry_at IS NOT NULL;
CREATE INDEX idx_scans_active ON scans (status, heartbeat_at) WHERE status IN ('queued', 'running');

-- The app's own hostname, remembered when checking starts, so a restarted
-- chain still refuses to request the app itself.
ALTER TABLE scans ADD COLUMN app_host text;
