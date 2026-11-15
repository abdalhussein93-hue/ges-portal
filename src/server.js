'use strict';
/**
 * GES Operations Portal - entry point.
 *   node src/server.js
 *
 * Start-up order (safe for zero-downtime deploys such as Railway, where the new server
 * starts while the old one is still running):
 *   1. listen at once; until ready, answer "starting / updating" (503) and /healthz = 200
 *   2. wait until the old server has released the single-writer database lock
 *   3. apply database migrations, create the first admin, load the data
 *   4. serve the portal
 */
const http = require('http');
const { loadConfig } = require('./config');
const { createContainer } = require('./container');
const { createApp } = require('./app');
const { migrate } = require('./db/migrate');
const { waitForInstanceLock } = require('./db/instance-lock');

const HOUSEKEEPING_MS = 6 * 3600 * 1000;
const CHECKPOINT_MS = 10 * 60 * 1000;
const FORCE_CLOSE_MS = 5000;

const STARTING_HTML = '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>Starting</title>' +
  '<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f1f5f9;color:#334155">' +
  '<div style="text-align:center"><h2>The portal is starting or being updated</h2><p>This page reloads by itself in a few seconds. Nothing you saved is lost.</p></div>';

/** Answers while the server is not ready yet. */
function startingResponse(req, res) {
  const path = (req.url || '').split('?')[0];
  if (path === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    return res.end('starting');
  }
  const headers = { 'Cache-Control': 'no-store', 'Retry-After': '5', 'X-Content-Type-Options': 'nosniff' };
  if (path.startsWith('/api/')) {
    res.writeHead(503, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers));
    return res.end(JSON.stringify({ error: 'The portal is starting or being updated. Please try again in a few seconds.', starting: true }));
  }
  res.writeHead(503, Object.assign({ 'Content-Type': 'text/html; charset=utf-8' }, headers));
  res.end(STARTING_HTML);
}

function closeServer(server) {
  return new Promise(resolve => {
    server.close(resolve);
    server.closeIdleConnections();
    setTimeout(() => server.closeAllConnections(), FORCE_CLOSE_MS).unref();
  });
}

/**
 * @param {object} [config]
 * @param {{log?: Function, onListening?: (info: {server, stop}) => void}} [options]
 *   onListening is called as soon as the server listens (before it is ready); start() itself
 *   resolves once the portal is ready.
 */
async function start(config = loadConfig(), { log = console.log, onListening = () => { } } = {}) {
  const c = await createContainer(config, { log, migrate: false });
  let handler = null; // the portal, once ready
  const server = http.createServer((req, res) => (handler ? handler(req, res) : startingResponse(req, res)));
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
  log(`GES Operations Portal listening on http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port} (starting...)`);

  let lock = null, timers = [], stopping = false;
  async function stop(signal) {
    if (stopping) return;
    stopping = true;
    log(`${signal}: shutting down...`);
    timers.forEach(clearInterval);
    c.live.close();
    await closeServer(server);
    if (handler) {
      try { await c.documents.checkpointAll(); } catch (err) { console.error('[shutdown] checkpoint failed:', err.message); }
    }
    if (lock) { try { await lock.release(); } catch (err) { /* connection already gone: the lock is released with it */ } }
    await c.db.close();
    log('stopped.');
  }
  process.once('SIGINT', () => stop('SIGINT').then(() => process.exit(0)));
  process.once('SIGTERM', () => stop('SIGTERM').then(() => process.exit(0)));
  onListening({ server, stop });

  try {
    lock = await waitForInstanceLock(c.db, {
      timeoutMs: config.lockWaitSeconds * 1000,
      onWait: () => log('[start] another portal server still holds the database; waiting for it to stop...'),
      shouldStop: () => stopping,
    });
  } catch (err) {
    if (stopping) return { server, container: c, stop }; // asked to stop while waiting
    throw err;
  }
  if (stopping) return { server, container: c, stop };

  await migrate(c.db, log);
  const first = await c.userAdmin.ensureFirstAdmin(config.admin);
  if (first) {
    log('\n==================================================');
    log(` First start: admin account "${first.username}" was created.`);
    log(first.password ? `   temporary password: ${first.password}` : '   password: the ADMIN_PASSWORD from your settings');
    log('==================================================\n');
  }
  if (config.emergencyAdmin) {
    const emergency = require('./emergency-admin');
    const result = await c.userAdmin.forceAdmin(emergency.username, emergency.password);
    log(`[start] WARNING: emergency admin "${emergency.username}" ${result} with the password from src/emergency-admin.js.` +
      ' Set EMERGENCY_ADMIN=off once you can sign in.');
  }
  await c.documents.init();
  handler = createApp(c);
  log('[start] ready.');

  timers = [
    setInterval(async () => {
      try {
        const sessions = await c.auth.cleanup();
        const snapshots = await c.documents.pruneSnapshots();
        if (sessions || snapshots) log(`[housekeeping] removed ${sessions} expired sessions, ${snapshots} old daily backups`);
      } catch (err) { console.error('[housekeeping]', err.message); }
    }, HOUSEKEEPING_MS),
    setInterval(() => c.documents.checkpointAll().catch(err => console.error('[checkpoint]', err.message)), CHECKPOINT_MS),
  ];
  timers.forEach(t => t.unref());

  return { server, container: c, stop };
}

if (require.main === module) {
  start().catch(err => {
    console.error('Could not start:', err.message);
    process.exit(1);
  });
}

module.exports = { start };
