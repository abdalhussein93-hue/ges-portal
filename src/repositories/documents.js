'use strict';
/**
 * app_documents (checkpoints), app_changes (journal of every change) and app_snapshots (backups).
 * Methods that take a `client` run inside the caller's transaction.
 */

function toChange(r) {
  return { rev: Number(r.rev), kind: r.kind, username: r.username, at: r.created_at, ops: r.ops };
}

class DocumentsRepository {
  constructor(db) { this.db = db; }

  async getCheckpoint(appId) {
    const { rows } = await this.db.query('SELECT rev, doc FROM app_documents WHERE app_id = $1', [appId]);
    return rows[0] ? { rev: Number(rows[0].rev), doc: rows[0].doc } : null;
  }

  async saveCheckpoint(client, appId, rev, doc) {
    await client.query(
      `INSERT INTO app_documents (app_id, rev, doc, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (app_id) DO UPDATE SET rev = EXCLUDED.rev, doc = EXCLUDED.doc, updated_at = now()
       WHERE app_documents.rev <= EXCLUDED.rev`,
      [appId, rev, JSON.stringify(doc)]);
  }

  async latestRev(appId) {
    const { rows } = await this.db.query('SELECT max(rev) AS rev FROM app_changes WHERE app_id = $1', [appId]);
    return rows[0].rev == null ? 0 : Number(rows[0].rev);
  }

  /** Changes after `sinceRev`, oldest first. */
  async changesAfter(appId, sinceRev, limit = 5000, client = this.db) {
    const { rows } = await client.query(
      'SELECT rev, kind, username, created_at, ops FROM app_changes WHERE app_id = $1 AND rev > $2 ORDER BY rev LIMIT $3',
      [appId, sinceRev, limit]);
    return rows.map(toChange);
  }

  async insertChange(client, { appId, rev, kind, username, ops }) {
    await client.query('INSERT INTO app_changes (app_id, rev, kind, username, ops) VALUES ($1, $2, $3, $4, $5)',
      [appId, rev, kind, username, JSON.stringify(ops)]);
  }

  // ---------- snapshots ----------

  async insertSnapshot(client, { appId, rev, kind, label = '', createdBy = 'system', doc }) {
    const { rows } = await client.query(
      `INSERT INTO app_snapshots (app_id, rev, kind, label, created_by, doc) VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, created_at`,
      [appId, rev, kind, label, createdBy, JSON.stringify(doc)]);
    return { id: Number(rows[0].id), createdAt: rows[0].created_at };
  }

  /** Time of the newest daily snapshot, or null. */
  async lastDailySnapshotAt(appId) {
    const { rows } = await this.db.query(
      `SELECT max(created_at) AS at FROM app_snapshots WHERE app_id = $1 AND kind = 'daily'`, [appId]);
    return rows[0].at || null;
  }

  async listSnapshots(appId) {
    const { rows } = await this.db.query(
      `SELECT id, rev, kind, label, created_at, created_by, pg_column_size(doc) AS size_bytes
       FROM app_snapshots WHERE app_id = $1 ORDER BY created_at DESC, id DESC`, [appId]);
    return rows.map(r => ({ id: Number(r.id), rev: Number(r.rev), kind: r.kind, label: r.label, createdAt: r.created_at, createdBy: r.created_by, sizeBytes: Number(r.size_bytes) }));
  }

  async getSnapshot(appId, id) {
    const { rows } = await this.db.query(
      'SELECT id, rev, kind, created_at, doc FROM app_snapshots WHERE app_id = $1 AND id = $2', [appId, id]);
    const r = rows[0];
    return r ? { id: Number(r.id), rev: Number(r.rev), kind: r.kind, createdAt: r.created_at, doc: r.doc } : null;
  }

  /** Deletes daily snapshots older than `days`. Imports and manual copies are kept. */
  async pruneDailySnapshots(appId, days) {
    const { rowCount } = await this.db.query(
      `DELETE FROM app_snapshots WHERE app_id = $1 AND kind = 'daily' AND created_at < now() - make_interval(days => $2)`,
      [appId, days]);
    return rowCount;
  }
}

module.exports = { DocumentsRepository };
