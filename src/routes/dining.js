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
    const res = ctx.res;
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="dining_scans_${q.get('from')}_to_${q.get('to')}.csv"`,
      'Cache-Control': 'no-store',
    });
    ctx.handled();
    try {
      await dining.exportCsv(q, chunk => (res.write(chunk) ? null : new Promise(resolve => res.once('drain', resolve))));
    } catch (err) {
      console.error('[dining] export failed:', err.message);
      res.write('\r\n"The export stopped because of a server error. Please download it again."\r\n');
    }
    res.end();
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
