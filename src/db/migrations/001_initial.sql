-- GES Operations Portal - initial schema

-- People who can sign in. app_roles: {"camp": "admin", "manpower": "viewer", ...}
CREATE TABLE users (
  username              text PRIMARY KEY,
  display_name          text NOT NULL DEFAULT '',
  is_admin              boolean NOT NULL DEFAULT false,      -- portal admin: manages users, imports, backups
  app_roles             jsonb NOT NULL DEFAULT '{}'::jsonb,
  password_hash         text NOT NULL,
  must_change_password  boolean NOT NULL DEFAULT true,
  disabled              boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  last_login_at         timestamptz,
  password_changed_at   timestamptz
);

-- Signed-in browsers. Only a SHA-256 of the session token is stored.
CREATE TABLE sessions (
  token_hash    text PRIMARY KEY,
  username      text NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  ip            text,
  user_agent    text
);
CREATE INDEX sessions_username_idx ON sessions (username);

-- Latest full copy ("checkpoint") of each app's data.
CREATE TABLE app_documents (
  app_id      text PRIMARY KEY,
  rev         bigint NOT NULL,
  doc         jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Every saved change, forever. checkpoint + the changes after it = the current data.
--   kind 'patch'   : ops is a list of small operations
--   kind 'replace' : ops is the complete new document (imports)
CREATE TABLE app_changes (
  app_id      text NOT NULL,
  rev         bigint NOT NULL,
  kind        text NOT NULL DEFAULT 'patch' CHECK (kind IN ('patch', 'replace')),
  username    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  ops         jsonb NOT NULL,
  PRIMARY KEY (app_id, rev)
);

-- Full copies kept as backups: one per day ('daily'), before every import ('pre-import'),
-- and on request ('manual').
CREATE TABLE app_snapshots (
  id          bigserial PRIMARY KEY,
  app_id      text NOT NULL,
  rev         bigint NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('daily', 'pre-import', 'manual')),
  label       text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text NOT NULL DEFAULT 'system',
  doc         jsonb NOT NULL
);
CREATE INDEX app_snapshots_app_created_idx ON app_snapshots (app_id, created_at DESC);

-- Files an app keeps (e.g. the Manpower timesheet workbook).
CREATE TABLE app_files (
  app_id       text NOT NULL,
  name         text NOT NULL,
  file_name    text NOT NULL DEFAULT '',
  saved_label  text NOT NULL DEFAULT '',
  content      bytea NOT NULL,
  size_bytes   integer NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text NOT NULL,
  PRIMARY KEY (app_id, name)
);

-- Sign-ins, account changes, blocked changes, imports, downloads.
CREATE TABLE audit_log (
  id        bigserial PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  username  text,
  app_id    text,
  action    text NOT NULL,
  details   jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip        text
);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
