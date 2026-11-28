-- Live data: Camp Management's second camp is called "AL FARAH". Migration 005 had added a camp
-- "Alfarah Asab" (id 'alfarah'), and at start-up the server added "AL FARAH" (id 'al-farah') from
-- Camp Management - two entries for one camp. Agreed fix: keep AL FARAH.
--   1. everybody who was given "Alfarah Asab" also gets AL FARAH (their real camp)
--   2. "Alfarah Asab" is deleted the safe way (hidden; nothing erased; "Restore" brings it back)
-- Only acts when both camps exist (on a new installation this does nothing).
UPDATE users SET camps = camps || '["al-farah"]'::jsonb
 WHERE camps ? 'alfarah' AND NOT camps ? 'al-farah'
   AND EXISTS (SELECT 1 FROM camps WHERE id = 'al-farah' AND deleted_at IS NULL);

UPDATE camps SET deleted_at = now(), deleted_by = 'system: duplicate of AL FARAH'
 WHERE id = 'alfarah' AND deleted_at IS NULL
   AND EXISTS (SELECT 1 FROM camps WHERE id = 'al-farah' AND deleted_at IS NULL);
