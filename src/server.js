'use strict';
/**
 * GES Operations Portal - entry point.
 *   node src/server.js
 */
const http = require('http');
const { loadConfig } = require('./config');
const { createContainer } = require('./container');
const { createApp } = require('./app');
const { acquireInstanceLock } = require('./db/instance-lock');

const HOUSEKEEPING_MS = 6 * 3600 * 1000;
const CHECKPOINT_MS = 10 * 60 * 1000;

async function start(config = loadConfig()) {
  const c = await createContainer(config);
  let lock;
  try { lock = await acquireInstanceLock(c.db); } catch (err) { await c.db.close(); c.live.close(); throw err; }

  const first = await c.userAdmin.ensureFirstAdmin(config.admin);
  if (first) {
    console.log('\n==================================================');
    console.log(` First start: admin account "${first.username}" was created.`);
    console.log(first.password ? `   temporary password: ${first.password}` : '   password: the ADMIN_PASSWORD from your settings');
    console.log('==================================================\n');
  }
  await c.documents.init();

  const server = http.createServer(createApp(c));
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
  console.log(`GES Operations Portal listening on http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);

  const housekeeping = setInterval(async () => {
    try {
      const sessions = await c.auth.cleanup();
      const snapshots = await c.documents.pruneSnapshots();
      if (sessions || snapshots) console.log(`[housekeeping] removed ${sessions} expired sessions, ${snapshots} old daily backups`);
    } catch (err) { console.error('[housekeeping]', err.message); }
  }, HOUSEKEEPING_MS);
  const checkpoints = setInterval(() => c.documents.checkpointAll().catch(err => console.error('[checkpoint]', err.message)), CHECKPOINT_MS);
  housekeeping.unref();
  checkpoints.unref();

  let stopping = false;
  async function stop(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`${signal}: shutting down...`);
    clearInterval(housekeeping);
    clearInterval(checkpoints);
    c.live.close();
    await new Promise(resolve => server.close(resolve));
    try { await c.documents.checkpointAll(); } catch (err) { console.error('[shutdown] checkpoint failed:', err.message); }
    await lock.release();
    await c.db.close();
    console.log('stopped.');
  }
  process.on('SIGINT', () => stop('SIGINT').then(() => process.exit(0)));
  process.on('SIGTERM', () => stop('SIGTERM').then(() => process.exit(0)));

  return { server, container: c, stop };
}

if (require.main === module) {
  start().catch(err => {
    console.error('Could not start:', err.message);
    process.exit(1);
  });
}

module.exports = { start };
