'use strict';
/**
 * Only one process may change the data at a time: the portal server keeps its data in memory
 * and numbers changes itself. A PostgreSQL advisory lock enforces this across machines.
 */
const LOCK_ID = 774411;

/**
 * @returns {Promise<{release: () => void}>}
 * @throws if another process holds the lock
 */
async function acquireInstanceLock(db, purpose = 'The portal server') {
  const client = await db.pool.connect();
  let ok = false;
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_ID]);
    ok = rows[0].ok;
  } finally {
    if (!ok) client.release();
  }
  if (!ok) throw new Error(`${purpose} cannot start: another portal process is using this database. Stop it first.`);
  return {
    release: async () => {
      try { await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]); } finally { client.release(); }
    },
  };
}

module.exports = { acquireInstanceLock };
