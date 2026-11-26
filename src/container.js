'use strict';
/** Creates all repositories and services for one database. */
const { Database } = require('./db/database');
const { migrate } = require('./db/migrate');
const apps = require('./domain/apps');
const { UsersRepository } = require('./repositories/users');
const { SessionsRepository } = require('./repositories/sessions');
const { AuditRepository } = require('./repositories/audit');
const { DocumentsRepository } = require('./repositories/documents');
const { FilesRepository } = require('./repositories/files');
const { AuthService } = require('./services/auth');
const { UserAdminService } = require('./services/user-admin');
const { DocumentService } = require('./services/documents');
const { LiveHub } = require('./services/live');

/**
 * @param {{log?: Function, migrate?: boolean}} options  migrate=false: the caller migrates later
 *   (the server does it only after it holds the single-writer lock)
 */
async function createContainer(config, { log = console.log, migrate: runMigrations = true } = {}) {
  const db = new Database(config.databaseUrl, { max: config.databasePoolSize });
  if (runMigrations) await migrate(db, log);
  const users = new UsersRepository(db);
  const sessions = new SessionsRepository(db);
  const audit = new AuditRepository(db);
  const files = new FilesRepository(db);
  const documentsRepo = new DocumentsRepository(db);
  const auth = new AuthService({ users, sessions, audit, config });
  const userAdmin = new UserAdminService({ users, sessions, audit, appIds: apps.ids(), scopedAppIds: apps.list().filter(a => a.scoped).map(a => a.id) });
  const documents = new DocumentService({ db, documents: documentsRepo, apps, config, log });
  const live = new LiveHub();
  return { config, db, apps, users, sessions, audit, files, auth, userAdmin, documents, live };
}

module.exports = { createContainer };
