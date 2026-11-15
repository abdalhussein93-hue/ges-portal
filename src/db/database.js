'use strict';
/**
 * PostgreSQL access: a connection pool plus a transaction helper.
 */
const { Pool } = require('pg');

class Database {
  /**
   * @param {string} connectionString  postgres://user:pass@host:5432/dbname
   * @param {{max?: number}} [options]
   */
  constructor(connectionString, options = {}) {
    if (!connectionString) throw new Error('DATABASE_URL is not set.');
    this.pool = new Pool({ connectionString, max: options.max || 10 });
    this.pool.on('error', err => console.error('[db] idle client error:', err.message));
  }

  /** Runs one statement. */
  query(text, params) {
    return this.pool.query(text, params);
  }

  /**
   * Runs `fn(client)` inside BEGIN/COMMIT. Any error rolls everything back,
   * so a change is either saved completely or not at all.
   */
  async transaction(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (e) { /* connection already broken */ }
      throw err;
    } finally {
      client.release();
    }
  }

  close() {
    return this.pool.end();
  }
}

module.exports = { Database };
