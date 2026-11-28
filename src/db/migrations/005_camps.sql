-- Camps: one list for the whole portal, and the camps each person may use.
--   Camp Management keeps all camps in its own data (blocks are tagged with the camp name);
--   Manpower, Costing, Duty Board and Dining Halls keep separate data per camp.
--   'gv' (Global Village) is the first camp: the data that existed before camps keeps its place
--   (app_documents rows 'manpower', 'costing', ...); other camps use 'manpower~<camp id>', ...
CREATE TABLE camps (
  id          text PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  position    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO camps (id, name, position) VALUES ('gv', 'Global Village', 1), ('alfarah', 'Alfarah Asab', 2);

-- the camps a person may use (portal admins: all). Everybody keeps the access they had: all camps.
ALTER TABLE users ADD COLUMN camps jsonb NOT NULL DEFAULT '[]'::jsonb;
UPDATE users SET camps = '["gv", "alfarah"]'::jsonb;

-- Dining Halls: every scan belongs to a camp; the scans so far are Global Village's.
ALTER TABLE dining_scans ADD COLUMN camp_id text NOT NULL DEFAULT 'gv';
DROP INDEX dining_scans_one_entry_idx;
CREATE UNIQUE INDEX dining_scans_one_entry_idx ON dining_scans (camp_id, day, hall, barcode, slot)
  WHERE status = 'allowed' AND source = 'scan' AND released_at IS NULL;
DROP INDEX dining_scans_legacy_idx;
CREATE UNIQUE INDEX dining_scans_legacy_idx ON dining_scans (camp_id, legacy_key) WHERE legacy_key IS NOT NULL;
DROP INDEX dining_scans_day_idx;
CREATE INDEX dining_scans_day_idx ON dining_scans (camp_id, day, hall);
