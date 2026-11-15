'use strict';
/**
 * Creating and managing accounts (portal admins only), plus the first admin account.
 */
const { hashPassword, passwordProblem, temporaryPassword } = require('./passwords');
const { isRole } = require('../domain/roles');
const { UserError } = require('../domain/apps/common');

const USERNAME = /^[a-z0-9._-]{3,32}$/;

/** Same app roles, whatever the key order (PostgreSQL reorders jsonb keys). */
function sameRoles(a, b) {
  const ka = Object.keys(a || {}), kb = Object.keys(b || {});
  return ka.length === kb.length && ka.every(k => a[k] === b[k]);
}

/** What the browser may see about a user (never the password hash). */
function publicUser(u, online = false) {
  return {
    username: u.username, name: u.name, isAdmin: u.isAdmin, apps: u.apps,
    disabled: u.disabled, mustChange: u.mustChange,
    createdAt: u.createdAt, lastLoginAt: u.lastLoginAt, online,
  };
}

class UserAdminService {
  /** @param {{users, sessions, audit, appIds: string[]}} deps */
  constructor({ users, sessions, audit, appIds }) {
    this.users = users;
    this.sessions = sessions;
    this.audit = audit;
    this.appIds = appIds;
  }

  /** Keeps only known apps and valid roles: {camp: 'operator', ...} */
  cleanAppRoles(input) {
    const out = {};
    if (!input || typeof input !== 'object') return out;
    for (const id of this.appIds) if (isRole(input[id])) out[id] = input[id];
    return out;
  }

  allAppsAdmin() {
    return Object.fromEntries(this.appIds.map(id => [id, 'admin']));
  }

  /** @returns {Promise<{user: object, tempPassword: string}>} */
  async create(actor, { username, name, isAdmin, apps }) {
    username = String(username || '').trim().toLowerCase();
    if (!USERNAME.test(username)) throw new UserError('Username: 3-32 characters - lowercase letters, numbers, dot, dash or underscore.');
    if (await this.users.find(username)) throw new UserError('That username already exists.');
    const tempPassword = temporaryPassword();
    const user = await this.users.create({
      username, name: String(name || '').trim().slice(0, 80), isAdmin: !!isAdmin,
      apps: isAdmin ? this.allAppsAdmin() : this.cleanAppRoles(apps),
      passwordHash: await hashPassword(tempPassword), mustChange: true,
    });
    await this.audit.record({ username: actor.username, action: 'user-create', details: { target: username, isAdmin: !!isAdmin, apps: user.apps } });
    return { user: publicUser(user), tempPassword };
  }

  /**
   * Changes name / portal admin / app roles / disabled, or resets the password.
   * @returns {Promise<{user: object, tempPassword: string|null, signedOut: boolean}>}
   */
  async update(actor, username, changes) {
    const target = await this.users.find(username);
    if (!target) throw new UserError('No such user.', 404);
    const self = target.username === actor.username;
    const lastAdmin = target.isAdmin && !target.disabled && (await this.users.countActiveAdmins()) <= 1;
    const fields = {};
    let signOut = false;

    if (changes.name !== undefined) fields.name = String(changes.name).trim().slice(0, 80);
    if (changes.isAdmin !== undefined && !!changes.isAdmin !== target.isAdmin) {
      if (self) throw new UserError('You cannot change your own admin rights.');
      if (lastAdmin) throw new UserError('You cannot remove the last admin.');
      fields.isAdmin = !!changes.isAdmin;
      signOut = true;
    }
    const willBeAdmin = fields.isAdmin !== undefined ? fields.isAdmin : target.isAdmin;
    if (willBeAdmin) {
      // portal admins are Admin in every app
      const all = this.allAppsAdmin();
      if (!sameRoles(all, target.apps)) fields.apps = all;
    } else if (changes.apps !== undefined) {
      const apps = this.cleanAppRoles(changes.apps);
      if (!sameRoles(apps, target.apps)) { fields.apps = apps; signOut = signOut || !self; }
    }
    if (changes.disabled !== undefined && !!changes.disabled !== target.disabled) {
      if (self) throw new UserError('You cannot disable your own account.');
      if (changes.disabled && lastAdmin) throw new UserError('You cannot disable the last admin.');
      fields.disabled = !!changes.disabled;
      signOut = true;
    }
    let tempPassword = null;
    if (changes.resetPassword) {
      tempPassword = temporaryPassword();
      await this.users.setPassword(target.username, await hashPassword(tempPassword), true);
      signOut = true;
    }
    const user = await this.users.update(target.username, fields);
    if (signOut && !self) await this.sessions.removeAllFor(target.username);
    await this.audit.record({ username: actor.username, action: 'user-update', details: { target: target.username, changed: Object.keys(fields).concat(tempPassword ? ['password'] : []) } });
    return { user: publicUser(user), tempPassword, signedOut: signOut && !self };
  }

  async remove(actor, username) {
    const target = await this.users.find(username);
    if (!target) throw new UserError('No such user.', 404);
    if (target.username === actor.username) throw new UserError('You cannot delete your own account.');
    if (target.isAdmin && !target.disabled && (await this.users.countActiveAdmins()) <= 1) throw new UserError('You cannot delete the last admin.');
    await this.users.remove(target.username); // sessions are removed by ON DELETE CASCADE
    await this.audit.record({ username: actor.username, action: 'user-delete', details: { target: target.username } });
  }

  /**
   * Creates the first admin when there are no users yet.
   * @returns {Promise<{username: string, password: string|null}|null>} password is null when it came from the settings
   */
  async ensureFirstAdmin({ username, password, mustChange }) {
    if ((await this.users.count()) > 0) return null;
    const usePassword = password && !passwordProblem(password) ? password : temporaryPassword();
    if (password && passwordProblem(password)) console.warn('[setup] ADMIN_PASSWORD is too short - a random password was used instead.');
    await this.users.create({
      username, name: 'Administrator', isAdmin: true, apps: this.allAppsAdmin(),
      passwordHash: await hashPassword(usePassword), mustChange: usePassword !== password ? true : mustChange,
    });
    await this.audit.record({ username: 'system', action: 'create-first-admin', details: { target: username } });
    return { username, password: usePassword === password ? null : usePassword };
  }

  /**
   * Emergency access: makes sure `username` exists, is enabled, is a portal admin and has `password`.
   * @returns {Promise<'created'|'reset'>}
   */
  async forceAdmin(username, password) {
    const hash = await hashPassword(password);
    const existing = await this.users.find(username);
    if (existing) {
      await this.users.update(username, { isAdmin: true, disabled: false, apps: this.allAppsAdmin() });
      await this.users.setPassword(username, hash, false);
    } else {
      await this.users.create({ username, name: 'Administrator', isAdmin: true, apps: this.allAppsAdmin(), passwordHash: hash, mustChange: false });
    }
    await this.audit.record({ username: 'system', action: 'emergency-admin', details: { target: username } });
    return existing ? 'reset' : 'created';
  }

  /** Command line recovery: new temporary password for an admin account (created if missing). */
  async resetAdmin(username) {
    const tempPassword = temporaryPassword();
    const existing = await this.users.find(username);
    if (existing) {
      await this.users.update(username, { isAdmin: true, disabled: false, apps: this.allAppsAdmin() });
      await this.users.setPassword(username, await hashPassword(tempPassword), true);
      await this.sessions.removeAllFor(username);
    } else {
      await this.users.create({ username, name: 'Administrator', isAdmin: true, apps: this.allAppsAdmin(), passwordHash: await hashPassword(tempPassword), mustChange: true });
    }
    await this.audit.record({ username: 'console', action: 'reset-admin', details: { target: username } });
    return tempPassword;
  }
}

module.exports = { UserAdminService, publicUser };
