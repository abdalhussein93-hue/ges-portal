'use strict';
/** app_files table: files an app keeps on the server (e.g. the Manpower timesheet workbook). */

class FilesRepository {
  constructor(db) { this.db = db; }

  async put({ appId, name, fileName, savedLabel, content, username }) {
    await this.db.query(
      `INSERT INTO app_files (app_id, name, file_name, saved_label, content, size_bytes, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (app_id, name) DO UPDATE SET file_name = EXCLUDED.file_name, saved_label = EXCLUDED.saved_label,
         content = EXCLUDED.content, size_bytes = EXCLUDED.size_bytes, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [appId, name, fileName || '', savedLabel || '', content, content.length, username]);
  }

  async get(appId, name) {
    const { rows } = await this.db.query(
      'SELECT file_name, saved_label, content, updated_at, updated_by FROM app_files WHERE app_id = $1 AND name = $2', [appId, name]);
    const r = rows[0];
    return r ? { fileName: r.file_name, savedLabel: r.saved_label, content: r.content, updatedAt: r.updated_at, updatedBy: r.updated_by } : null;
  }
}

module.exports = { FilesRepository };
