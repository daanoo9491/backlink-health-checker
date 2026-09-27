-- Phase 4: link checking.
-- claimed_at lets a batch "reserve" links while it checks them, so two
-- browser tabs (or later, two queue consumers) never check the same link at
-- once. Reservations older than 2 minutes are considered abandoned.
ALTER TABLE unique_urls ADD COLUMN claimed_at INTEGER;
