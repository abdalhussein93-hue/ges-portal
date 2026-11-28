-- Dining Halls Management: every barcode scan at a dining hall gate, one row each, kept forever.
--   day / meal / slot are worked out on the server in camp time (Asia/Dubai) when the scan happens.
--   slot = the meal (one entry per person per meal) or 'Day' (one entry per day), per the app's setting.
--   source 'import' = records brought in from the old offline app's backup files.
--   released_at: an Admin allowed this person in again (the meal still counts; it no longer blocks).
CREATE TABLE dining_scans (
  id               bigserial PRIMARY KEY,
  at               timestamptz NOT NULL DEFAULT now(),
  day              date NOT NULL,
  meal             text NOT NULL,
  slot             text NOT NULL,
  hall             text NOT NULL,
  barcode          text NOT NULL,
  person_id        text,
  name             text NOT NULL DEFAULT '',
  company          text NOT NULL DEFAULT '',
  room             text NOT NULL DEFAULT '',
  status           text NOT NULL CHECK (status IN ('allowed', 'denied')),
  reason           text NOT NULL DEFAULT '',
  scanned_by       text NOT NULL DEFAULT '',
  scanned_by_name  text NOT NULL DEFAULT '',
  source           text NOT NULL DEFAULT 'scan' CHECK (source IN ('scan', 'import')),
  legacy_key       text,
  released_at      timestamptz,
  released_by      text
);

-- The database itself refuses a second entry for the same person, hall and meal (or day),
-- even when two gates scan the same card at the same moment.
CREATE UNIQUE INDEX dining_scans_one_entry_idx ON dining_scans (day, hall, barcode, slot)
  WHERE status = 'allowed' AND source = 'scan' AND released_at IS NULL;

-- An old backup file imported twice adds nothing the second time.
CREATE UNIQUE INDEX dining_scans_legacy_idx ON dining_scans (legacy_key) WHERE legacy_key IS NOT NULL;

CREATE INDEX dining_scans_day_idx ON dining_scans (day, hall);
