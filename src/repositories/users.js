'use strict';
/** users table */

const COLUMNS = `username, display_name, is_admin, app_roles, app_scopes, camps, password_hash, must_change_password,
  disabled, created_at, last_login_at, password_changed_at`;
const JSON_FIELDS = new Set(['apps', 'scopes', 'camps']);

function toUser(row) {
  if (!row) return null;
  return {
    username: row.username,
    name: row.display_name,
    isAdmin: row.is_admin,
    apps: row.app_roles || {},
    scopes: row.app_scopes || {},
    camps: Array.isArray(row.camps) ? row.camps : [], // ids of the camps this person may use (portal admins: all)
    passwordHash: row.password_hash,
    mustChange: row.must_change_password,
    disabled: row.disabled,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    passwordChangedAt: row.password_changed_at,
  };
}

class UsersRepository {
  constructor(db) { this.db = db; }

  async find(username) {
    const { rows } = await this.db.query(`SELECT ${COLUMNS} FROM users WHERE username = $1`, [username]);
    return toUser(rows[0]);
  }

  async list() {
    const { rows } = await this.db.query(`SELECT ${COLUMNS} FROM users ORDER BY is_admin DESC, username`);
    return rows.map(toUser);
  }

  async count() {
    const { rows } = await this.db.query('SELECT count(*)::int AS n FROM users');
    return rows[0].n;
  }

  async countActiveAdmins() {
    const { rows } = await this.db.query('SELECT count(*)::int AS n FROM users WHERE is_admin AND NOT disabled');
    return rows[0].n;
  }

  async create({ username, name, isAdmin, apps, scopes, camps, passwordHash, mustChange }) {
    const { rows } = await this.db.query(
      `INSERT INTO users (username, display_name, is_admin, app_roles, app_scopes, camps, password_hash, must_change_password, password_changed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now()) RETURNING ${COLUMNS}`,
      [username, name || '', !!isAdmin, JSON.stringify(apps || {}), JSON.stringify(scopes || {}), JSON.stringify(camps || []), passwordHash, mustChange !== false]);
    return toUser(rows[0]);
  }

  /** Updates only the given fields. */
  async update(username, fields) {
    const map = { name: 'display_name', isAdmin: 'is_admin', apps: 'app_roles', scopes: 'app_scopes', camps: 'camps', disabled: 'disabled', mustChange: 'must_change_password' };
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries(map)) {
      if (fields[key] === undefined) continue;
      values.push(JSON_FIELDS.has(key) ? JSON.stringify(fields[key]) : fields[key]);
      sets.push(`${column} = $${values.length}`);
    }
    if (!sets.length) return this.find(username);
    values.push(username);
    const { rows } = await this.db.query(`UPDATE users SET ${sets.join(', ')} WHERE username = $${values.length} RETURNING ${COLUMNS}`, values);
    return toUser(rows[0]);
  }

  async setPassword(username, passwordHash, mustChange) {
    await this.db.query(
      'UPDATE users SET password_hash = $2, must_change_password = $3, password_changed_at = now() WHERE username = $1',
      [username, passwordHash, !!mustChange]);
  }

  async touchLogin(username) {
    await this.db.query('UPDATE users SET last_login_at = now() WHERE username = $1', [username]);
  }

  async remove(username) {
    await this.db.query('DELETE FROM users WHERE username = $1', [username]);
  }
}

module.exports = { UsersRepository };
