-- Limits inside an app, per user. Example: {"duty": {"depts": ["h7pcydm", "bcxeb4y"]}}
-- = in Duty Board this user only sees and works on those departments.
ALTER TABLE users ADD COLUMN app_scopes jsonb NOT NULL DEFAULT '{}'::jsonb;
