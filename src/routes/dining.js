'use strict';
/** Dining Halls Management: gate scans, today's numbers, records, reports, exports, imports. */
const { UserError } = require('../domain/apps/common');
const { atLeast } = require('../domain/roles');
const { APP_ID } = require('../services/dining');

const SMALL_BODY = 4 * 1024;

/** The user's role in Dining Halls; refuses if it is below `minRole`. */
function role(ctx, minRole) {
  const r = ctx.user.apps[APP_ID];
  if (!r) throw new UserError('You do not have access to Dining Halls.', 403);
  if (!atLeast(r, minRole)) {
    throw new UserError(minRole === 'admin' ? 'Only an Admin of Dining Halls can do this.' : 'Your account can only view Dining Halls.', 403);
  }
  return r;
}

/**
 * Sends a download written in pieces (`produce(write)`), waiting when the connection is slow.
 * If something fails half way the file ends with a line saying so - a broken file is never
 * mistaken for a complete one (a backup file then fails to open, and must be downloaded again).
 */
async function stream(ctx, type, fileName, produce) {
  const res = ctx.res;
  res.writeHead(200, { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${fileName}"`, 'Cache-Control': 'no-store' });
  ctx.handled();
  try {
    await produce(chunk => (res.write(chunk) ? null : new Promise(resolve => res.once('drain', resolve))));
  } catch (err) {
    console.error(`[dining] download ${fileName} failed:`, err.message);
    res.write('\r\nTHE DOWNLOAD STOPPED BECAUSE OF A SERVER ERROR. PLEASE DOWNLOAD IT AGAIN.\r\n');
  }
  res.end();
}

function register(router, { dining, audit, config }) {
  // a guard (Operator) or Admin scans a card
  router.post('/api/dining/scan', async ctx => {
    const r = role(ctx, 'operator');
    const body = await ctx.body(SMALL_BODY);
    ctx.json(200, await dining.scan(ctx.user, r, body));
  });

  router.get('/api/dining/today', async ctx => {
    role(ctx, 'viewer');
    ctx.json(200, await dining.today());
  });

  router.get('/api/dining/scans', async ctx => {
    role(ctx, 'viewer');
    ctx.json(200, await dining.list(ctx.url.searchParams));
  });

  router.get('/api/dining/report', async ctx => {
    role(ctx, 'viewer');
    ctx.json(200, await dining.report(ctx.url.searchParams));
  });

  router.get('/api/dining/scans.csv', async ctx => {
    role(ctx, 'viewer');
    const q = ctx.url.searchParams;
    dining.filter(q, true); // check the range before the download starts
    await audit.record({ username: ctx.user.username, appId: APP_ID, action: 'dining-export', details: { from: q.get('from'), to: q.get('to') }, ip: ctx.ip });
    await stream(ctx, 'text/csv; charset=utf-8', `dining_scans_${q.get('from')}_to_${q.get('to')}.csv`, write => dining.exportCsv(q, write));
  });

  // Admin: download a backup file (people, cards, companies, settings + scan records)
  router.get('/api/dining/backup', async ctx => {
    role(ctx, 'admin');
    const q = ctx.url.searchParams;
    if (q.get('from') || q.get('to')) dining.filter(q, true); // check the range before the download starts
    dining.setup();
    await audit.record({ username: ctx.user.username, appId: APP_ID, action: 'dining-backup', details: { from: q.get('from') || 'all', to: q.get('to') || 'all' }, ip: ctx.ip });
    const stamp = new Date().toISOString().slice(0, 10);
    const name = q.get('from') ? `dining_backup_${q.get('from')}_to_${q.get('to')}.json` : `dining_backup_all_${stamp}.json`;
    await stream(ctx, 'application/json; charset=utf-8', name, write => dining.backup(q, write));
  });

  // Admin: let people in again today
  router.post('/api/dining/release', async ctx => {
    role(ctx, 'admin');
    const body = await ctx.body(SMALL_BODY);
    ctx.json(200, await dining.release(ctx.user, body.hall || null, ctx.ip));
  });

  // Admin: bring in backup files of the old offline app
  router.post('/api/dining/import', async ctx => {
    role(ctx, 'admin');
    const body = await ctx.body(config.maxUploadBytes);
    const setupFrom = body.setupFrom === null || body.setupFrom === undefined ? -1 : Number(body.setupFrom);
    ctx.json(200, await dining.importBackups(ctx.user, body.files, setupFrom, ctx.ip));
  });
}

module.exports = { register };
