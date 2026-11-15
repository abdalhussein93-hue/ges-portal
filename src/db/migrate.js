'use strict';
/**
 * Applies the SQL files in db/migrations in name order, each once, each in its own transaction.
 */
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function migrate(db, log = console.log) {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const { rows } = await db.query('SELECT version FROM schema_migrations');
  const done = new Set(rows.map(r => r.version));
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => /^\d+_.+\.sql$/.test(f)).sort();
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    await db.transaction(async client => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
    });
    log(`[db] applied migration ${file}`);
  }
}

module.exports = { migrate };
