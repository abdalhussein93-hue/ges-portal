'use strict';
/** sessions table (only SHA-256 hashes of tokens are stored) */

class SessionsRepository {
  constructor(db) { this.db = db; }

  async create({ tokenHash, username, ip, userAgent }) {
    await this.db.query(
      'INSERT INTO sessions (token_hash, username, ip, user_agent) VALUES ($1, $2, $3, $4)',
      [tokenHash, username, ip || null, userAgent || null]);
  }

  async find(tokenHash) {
    const { rows } = await this.db.query(
      'SELECT token_hash, username, created_at, last_seen_at FROM sessions WHERE token_hash = $1', [tokenHash]);
    const r = rows[0];
    return r ? { tokenHash: r.token_hash, username: r.username, createdAt: r.created_at, lastSeenAt: r.last_seen_at } : null;
  }

  async touch(tokenHash) {
    await this.db.query('UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1', [tokenHash]);
  }

  async remove(tokenHash) {
    await this.db.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
  }

  /** Signs a user out everywhere, optionally keeping one session. */
  async removeAllFor(username, exceptTokenHash = null) {
    await this.db.query('DELETE FROM sessions WHERE username = $1 AND token_hash IS DISTINCT FROM $2', [username, exceptTokenHash]);
  }

  async removeExpired(idleHours, maxDays) {
    const { rowCount } = await this.db.query(
      `DELETE FROM sessions WHERE last_seen_at < now() - make_interval(secs => $1)
                               OR created_at < now() - make_interval(secs => $2)`,
      [idleHours * 3600, maxDays * 86400]);
    return rowCount;
  }
}

module.exports = { SessionsRepository };
