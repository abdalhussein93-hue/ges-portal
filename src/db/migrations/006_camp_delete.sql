-- Camps can be deleted by a portal admin. Nothing is erased: a deleted camp disappears from every
-- app and from everyone's access, and all its data stays in the database; "Restore" brings it back.
ALTER TABLE camps ADD COLUMN deleted_at timestamptz;
ALTER TABLE camps ADD COLUMN deleted_by text;
