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

const BUSY = /another portal process/;

/**
 * Like acquireInstanceLock, but waits while another process holds the lock
 * (during a deploy the old server is still running for a few seconds).
 * @param {{timeoutMs: number, onWait?: () => void, shouldStop?: () => boolean, intervalMs?: number}} options
 */
async function waitForInstanceLock(db, { timeoutMs, onWait = () => { }, shouldStop = () => false, intervalMs = 2000 }) {
  const started = Date.now();
  let warned = false;
  for (;;) {
    try {
      return await acquireInstanceLock(db);
    } catch (err) {
      if (!BUSY.test(err.message)) throw err;
      if (shouldStop()) return null;
      if (Date.now() - started >= timeoutMs) throw err;
      if (!warned) { onWait(); warned = true; }
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }
}

module.exports = { acquireInstanceLock, waitForInstanceLock };
