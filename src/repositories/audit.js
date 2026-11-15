'use strict';
/** audit_log table: sign-ins, account changes, blocked changes, imports, downloads. */

class AuditRepository {
  constructor(db) { this.db = db; }

  /**
   * @param {{username?: string, appId?: string, action: string, details?: object, ip?: string}} entry
   * Never throws: a failing audit write must not break the action being audited.
   */
  async record({ username = null, appId = null, action, details = {}, ip = null }) {
    try {
      await this.db.query('INSERT INTO audit_log (username, app_id, action, details, ip) VALUES ($1, $2, $3, $4, $5)',
        [username, appId, action, JSON.stringify(details), ip]);
    } catch (err) {
      console.error('[audit] could not record', action, err.message);
    }
  }

  async recent(limit = 500) {
    const { rows } = await this.db.query(
      'SELECT id, at, username, app_id, action, details, ip FROM audit_log ORDER BY id DESC LIMIT $1', [limit]);
    return rows.map(r => ({ id: Number(r.id), at: r.at, username: r.username, appId: r.app_id, action: r.action, details: r.details, ip: r.ip }));
  }
}

module.exports = { AuditRepository };
