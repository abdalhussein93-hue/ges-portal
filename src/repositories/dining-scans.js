'use strict';
/** dining_scans table: one row per barcode scan at a dining hall gate. */

const COLUMNS = ['at', 'day', 'meal', 'slot', 'hall', 'barcode', 'person_id', 'name', 'company', 'room', 'status', 'reason',
  'scanned_by', 'scanned_by_name', 'source', 'legacy_key'];
const UNIQUE_VIOLATION = '23505';
const BATCH = 500;

function rowOut(r) {
  return {
    id: Number(r.id), at: r.at instanceof Date ? r.at.toISOString() : r.at, day: r.day, meal: r.meal, hall: r.hall,
    barcode: r.barcode, personId: r.person_id, name: r.name, company: r.company, room: r.room,
    status: r.status, reason: r.reason, scannedBy: r.scanned_by, scannedByName: r.scanned_by_name,
    source: r.source, released: !!r.released_at,
  };
}

function values(s) {
  return [s.at, s.day, s.meal, s.slot, s.hall, s.barcode, s.personId || null, s.name || '', s.company || '', s.room || '',
    s.status, s.reason || '', s.scannedBy || '', s.scannedByName || '', s.source || 'scan', s.legacyKey || null];
}

/** WHERE clause for list / export filters. day is returned as text (YYYY-MM-DD) everywhere. */
function where(f, params) {
  const w = [];
  const add = (sql, v) => { params.push(v); w.push(sql.replace('?', `$${params.length}`)); };
  if (f.from) add('day >= ?::date', f.from);
  if (f.to) add('day <= ?::date', f.to);
  if (f.hall) add('hall = ?', f.hall);
  if (f.status) add('status = ?', f.status);
  if (f.beforeId) add('id < ?', f.beforeId);
  if (f.afterId) add('id > ?', f.afterId);
  if (f.q) {
    params.push(`%${f.q.replace(/[\\%_]/g, c => '\\' + c)}%`);
    const n = params.length;
    w.push(`(name ILIKE $${n} OR barcode ILIKE $${n} OR company ILIKE $${n} OR scanned_by_name ILIKE $${n})`);
  }
  return w.length ? 'WHERE ' + w.join(' AND ') : '';
}

const SELECT = 'SELECT id, at, day::text AS day, meal, hall, barcode, person_id, name, company, room, status, reason, scanned_by, scanned_by_name, source, released_at FROM dining_scans';

class DiningScansRepository {
  constructor(db) { this.db = db; }

  /**
   * The entry that stops this card from coming in again: same day and hall,
   * and the same meal unless `slot` is null (one entry per day).
   */
  async findEntry({ day, hall, barcode, slot }, client = this.db) {
    const params = [day, hall, barcode];
    let sql = `${SELECT} WHERE day = $1::date AND hall = $2 AND barcode = $3 AND status = 'allowed' AND source = 'scan' AND released_at IS NULL`;
    if (slot) { params.push(slot); sql += ' AND slot = $4'; }
    const { rows } = await client.query(sql + ' ORDER BY id LIMIT 1', params);
    return rows.length ? rowOut(rows[0]) : null;
  }

  /**
   * Inserts one scan.
   * @returns {Promise<object|null>} the stored row, or null if the database refused a second entry
   */
  async insert(scan, client = this.db) {
    const params = values(scan);
    const sql = `INSERT INTO dining_scans (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map((c, i) => (c === 'day' ? `$${i + 1}::date` : `$${i + 1}`)).join(', ')})
      RETURNING id, at, day::text AS day, meal, hall, barcode, person_id, name, company, room, status, reason, scanned_by, scanned_by_name, source, released_at`;
    try {
      const { rows } = await client.query(sql, params);
      return rowOut(rows[0]);
    } catch (err) {
      if (err.code === UNIQUE_VIOLATION) return null;
      throw err;
    }
  }

  /**
   * Inserts imported records; records already imported (same legacy_key) are skipped.
   * @returns {Promise<number>} how many were added
   */
  async insertImported(scans) {
    let added = 0;
    await this.db.transaction(async client => {
      for (let i = 0; i < scans.length; i += BATCH) {
        const chunk = scans.slice(i, i + BATCH);
        const params = [];
        const rows = chunk.map(s => {
          const v = values(Object.assign({}, s, { source: 'import' }));
          const start = params.length;
          params.push(...v);
          return '(' + v.map((x, j) => (COLUMNS[j] === 'day' ? `$${start + j + 1}::date` : `$${start + j + 1}`)).join(', ') + ')';
        });
        const r = await client.query(`INSERT INTO dining_scans (${COLUMNS.join(', ')}) VALUES ${rows.join(', ')}
          ON CONFLICT (legacy_key) WHERE legacy_key IS NOT NULL DO NOTHING`, params);
        added += r.rowCount;
      }
    });
    return added;
  }

  /** Allowed meals per hall, and denied scans, for one day. */
  async dayCounts(day) {
    const { rows } = await this.db.query(
      `SELECT hall, status, count(*)::int AS n FROM dining_scans WHERE day = $1::date GROUP BY hall, status`, [day]);
    const byHall = {};
    let total = 0, denied = 0;
    for (const r of rows) {
      if (r.status === 'allowed') { byHall[r.hall] = (byHall[r.hall] || 0) + r.n; total += r.n; } else denied += r.n;
    }
    return { total, denied, byHall };
  }

  /** Newest first, at most `limit`. */
  async list(filter, limit) {
    const params = [];
    const sql = `${SELECT} ${where(filter, params)} ORDER BY id DESC LIMIT ${Number(limit) + 1}`;
    const { rows } = await this.db.query(sql, params);
    return { rows: rows.slice(0, limit).map(rowOut), more: rows.length > limit };
  }

  /** Calls `onBatch(rows)` for all matching rows, oldest first, in batches (for CSV exports). */
  async each(filter, onBatch) {
    let afterId = 0;
    for (;;) {
      const params = [];
      const sql = `${SELECT} ${where(Object.assign({}, filter, { afterId }), params)} ORDER BY id LIMIT 5000`;
      const { rows } = await this.db.query(sql, params);
      if (!rows.length) return;
      await onBatch(rows.map(rowOut));
      afterId = Number(rows[rows.length - 1].id);
    }
  }

  /** Meals (allowed scans) grouped by day, meal and hall - and by company too. */
  async report(from, to) {
    const daily = await this.db.query(
      `SELECT day::text AS day, meal, hall, count(*)::int AS n FROM dining_scans
       WHERE status = 'allowed' AND day BETWEEN $1::date AND $2::date GROUP BY 1, 2, 3`, [from, to]);
    const byCompany = await this.db.query(
      `SELECT day::text AS day, meal, hall, company, count(*)::int AS n FROM dining_scans
       WHERE status = 'allowed' AND day BETWEEN $1::date AND $2::date GROUP BY 1, 2, 3, 4`, [from, to]);
    return { daily: daily.rows, byCompany: byCompany.rows };
  }

  /** Lets people in again today: their entries stop blocking (they still count as meals). */
  async release({ day, hall, username }) {
    const params = [day, username];
    let sql = `UPDATE dining_scans SET released_at = now(), released_by = $2
      WHERE day = $1::date AND status = 'allowed' AND source = 'scan' AND released_at IS NULL`;
    if (hall) { params.push(hall); sql += ' AND hall = $3'; }
    const r = await this.db.query(sql, params);
    return r.rowCount;
  }

  async firstDay() {
    const { rows } = await this.db.query('SELECT min(day)::text AS day FROM dining_scans');
    return rows[0].day || null;
  }
}

module.exports = { DiningScansRepository };
