'use strict';
/** Portal administration: users, activity log, backups (snapshots), import and export. */
const { UserError } = require('../domain/apps/common');
const { cleanValue } = require('../domain/text');
const { publicUser } = require('../services/user-admin');
const Camps = require('../domain/camps');

const SMALL_BODY = 16 * 1024;

function register(router, { apps, documents, userAdmin, users, live, audit, config, camps, summary }) {
  const admin = { auth: 'admin' };

  /**
   * The app from the URL, and which data: a per-camp app's data of ?camp=<id> (default: the first
   * camp); Camp Management has one set of data for all camps.
   */
  function mustApp(ctx) {
    const app = apps.get(ctx.params.app);
    if (!app) throw new UserError('No such app.', 404);
    let campId = null;
    if (app.perCamp) {
      campId = ctx.url.searchParams.get('camp') || Camps.PRIMARY;
      if (!camps.get(campId)) throw new UserError('No such camp.', 404);
    }
    const camp = campId ? camps.get(campId) : null;
    return { id: Camps.docKey(app.id, campId), app, campId, label: camp ? `${app.name} - ${camp.name}` : app.name };
  }

  // ---------- summary for the home page ----------
  router.get('/api/admin/summary', admin, async ctx => {
    ctx.json(200, await summary.build());
  });

  // ---------- camps ----------
  router.get('/api/admin/camps', admin, async ctx => {
    ctx.json(200, camps.list());
  });

  router.post('/api/admin/camps', admin, async ctx => {
    const body = await ctx.body(SMALL_BODY);
    const camp = await camps.add(ctx.user, body.name);
    ctx.json(200, camp);
  });

  // deleted camps (their data is kept and comes back with "restore")
  router.get('/api/admin/camps/deleted', admin, async ctx => {
    ctx.json(200, camps.deleted());
  });

  router.delete('/api/admin/camps/:id', admin, async ctx => {
    ctx.json(200, await camps.remove(ctx.user, ctx.params.id));
  });

  router.post('/api/admin/camps/:id/restore', admin, async ctx => {
    ctx.json(200, await camps.restore(ctx.user, ctx.params.id));
  });

  // ---------- users ----------
  router.get('/api/admin/users', admin, async ctx => {
    const online = live.onlineUsernames();
    ctx.json(200, (await users.list()).map(u => publicUser(u, online.has(u.username))));
  });

  router.post('/api/admin/users', admin, async ctx => {
    const body = await ctx.body(SMALL_BODY);
    ctx.json(200, await userAdmin.create(ctx.user, body));
  });

  router.post('/api/admin/users/:username', admin, async ctx => {
    const body = await ctx.body(SMALL_BODY);
    const result = await userAdmin.update(ctx.user, ctx.params.username, body);
    if (result.signedOut) live.disconnectUser(ctx.params.username);
    ctx.json(200, result);
  });

  router.delete('/api/admin/users/:username', admin, async ctx => {
    await userAdmin.remove(ctx.user, ctx.params.username);
    live.disconnectUser(ctx.params.username);
    ctx.json(200, { ok: true });
  });

  // ---------- activity ----------
  router.get('/api/admin/audit', admin, async ctx => {
    ctx.json(200, await audit.recent(500));
  });

  // ---------- backups ----------
  router.get('/api/admin/apps/:app/snapshots', admin, async ctx => {
    ctx.json(200, await documents.repo.listSnapshots(mustApp(ctx).id));
  });

  router.post('/api/admin/apps/:app/snapshots', admin, async ctx => {
    const app = mustApp(ctx);
    const body = await ctx.body(SMALL_BODY);
    const snap = await documents.snapshotNow(app.id, ctx.user.username, body.label);
    await audit.record({ username: ctx.user.username, appId: app.id, action: 'backup-create', details: { id: snap.id } });
    ctx.json(200, snap);
  });

  router.get('/api/admin/apps/:app/snapshots/:id', admin, async ctx => {
    const app = mustApp(ctx);
    const snap = await documents.repo.getSnapshot(app.id, Number(ctx.params.id));
    if (!snap) throw new UserError('No such backup.', 404);
    await audit.record({ username: ctx.user.username, appId: app.id, action: 'backup-download', details: { id: snap.id } });
    const name = `${app.id.replace('~', '_')}_${snap.kind}_${snap.createdAt.toISOString().slice(0, 10)}_rev${snap.rev}.json`;
    ctx.send(200, JSON.stringify(snap.doc), 'application/json', { 'Content-Disposition': `attachment; filename="${name}"` });
  });

  router.get('/api/admin/apps/:app/export', admin, async ctx => {
    const app = mustApp(ctx);
    const { rev, doc } = documents.get(app.id);
    if (!doc) throw new UserError('This app has no data yet.', 404);
    await audit.record({ username: ctx.user.username, appId: app.id, action: 'export', details: { rev } });
    const name = `${app.id.replace('~', '_')}_current_${new Date().toISOString().slice(0, 10)}_rev${rev}.json`;
    ctx.send(200, JSON.stringify(doc), 'application/json', { 'Content-Disposition': `attachment; filename="${name}"` });
  });

  // ---------- import (replaces all data of one app; old data kept as a snapshot) ----------
  router.post('/api/admin/apps/:app/import', admin, async ctx => {
    const target = mustApp(ctx);
    const app = target.app;
    const body = await ctx.body(config.maxUploadBytes);
    const doc = cleanValue(app.importDocument(body.file), app.textMode).value;
    app.normalise(doc);
    const note = String(body.fileName || 'file').slice(0, 100);
    const rev = await documents.replace(target.id, ctx.user.username, doc, note);
    await audit.record({ username: ctx.user.username, appId: target.id, action: 'import', details: { fileName: note, rev }, ip: ctx.ip });
    live.broadcast(target.id, 'change', { rev, by: ctx.user.username, clientId: '' });
    ctx.json(200, { ok: true, rev });
  });
}

module.exports = { register };
