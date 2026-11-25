'use strict';
/** Data, changes, live updates and files of each app. */
const fs = require('fs');
const path = require('path');
const { UserError } = require('../domain/apps/common');
const { validateOp, cleanOps } = require('../domain/operations');
const { atLeast } = require('../domain/roles');

const MAX_OPS = 500000;

/** Resolves the app from the URL and checks the user's role in it. */
function appAccess(ctx, apps, minRole = 'viewer') {
  const app = apps.get(ctx.params.app);
  if (!app) throw new UserError('No such app.', 404);
  const role = ctx.user.apps[app.id];
  if (!role || !atLeast(role, minRole)) throw new UserError(role ? 'Your role in this app does not allow this.' : 'You do not have access to this app.', 403);
  return { app, role };
}

function shareChange(app, role, c) {
  return { rev: c.rev, by: c.username, ops: app.filterOps(c.ops, role) };
}

function register(router, { apps, documents, files, live, audit, config }) {
  router.get('/api/apps', async ctx => {
    const list = apps.list().map(app => ({
      id: app.id, name: app.name, description: app.description, icon: app.icon, color: app.color, path: app.path,
      role: ctx.user.apps[app.id] || null,
      online: live.presence(app.id).length,
      hasData: !!documents.get(app.id).doc,
    }));
    ctx.json(200, list);
  });

  router.get('/api/apps/:app/data', async ctx => {
    const { app, role } = appAccess(ctx, apps);
    const { rev, doc } = documents.get(app.id);
    ctx.json(200, { rev, role, doc: doc ? app.filterDoc(doc, role) : null });
  });

  router.get('/api/apps/:app/changes', async ctx => {
    const { app, role } = appAccess(ctx, apps);
    const since = Number(ctx.url.searchParams.get('since'));
    const list = await documents.changesSince(app.id, since);
    const { rev } = documents.get(app.id);
    if (!list) return ctx.json(200, { rev, reload: true });
    ctx.json(200, { rev, changes: list.map(c => shareChange(app, role, c)) });
  });

  router.post('/api/apps/:app/patch', async ctx => {
    const { app, role } = appAccess(ctx, apps);
    const body = await ctx.body(config.maxUploadBytes);
    const ops = body.ops;
    const baseRev = Number(body.baseRev);
    if (!Array.isArray(ops) || !Number.isInteger(baseRev)) throw new UserError('Bad request.');
    if (ops.length > MAX_OPS) throw new UserError('Too many changes at once.', 413);
    const { rev, doc } = documents.get(app.id);
    if (!ops.length) return ctx.json(200, { rev, missed: [], reload: false });
    if (!doc && role !== 'admin') throw new UserError('This app has not been set up yet. An admin of this app must open it first.', 409);

    const permissionContext = { doc, user: ctx.user };
    for (const op of ops) {
      const malformed = validateOp(op, app);
      if (malformed) throw Object.assign(new UserError(`Invalid change: ${malformed}`), { denied: true });
      const denied = app.checkPermission(role, op, permissionContext);
      if (denied) {
        await audit.record({ username: ctx.user.username, appId: app.id, action: 'change-denied', details: { reason: denied }, ip: ctx.ip });
        throw Object.assign(new UserError(denied, 403), { denied: true });
      }
    }
    const prepared = app.prepareOps ? app.prepareOps(role, ctx.user, ops, doc) : { ops, changed: false };
    const cleaned = cleanOps(prepared.ops, app.textMode);
    const result = await documents.applyChange(app.id, ctx.user.username, baseRev, cleaned.ops);
    if (result.conflicts.length) {
      await audit.record({ username: ctx.user.username, appId: app.id, action: 'change-conflict', details: { lost: result.conflicts.length, rev: result.rev } });
    }
    live.broadcast(app.id, 'change', { rev: result.rev, by: ctx.user.username, clientId: String(body.clientId || '').slice(0, 64) });
    ctx.json(200, {
      rev: result.rev,
      reload: prepared.changed || cleaned.changed || result.normalised || result.missed === null || result.conflicts.length > 0,
      conflicts: result.conflicts.length,
      missed: result.missed ? result.missed.map(c => shareChange(app, role, c)) : null,
    });
  });

  router.get('/api/apps/:app/events', async ctx => {
    const { app } = appAccess(ctx, apps);
    const disconnect = live.connect(app.id, ctx.res, ctx.user);
    live.send({ res: ctx.res }, 'hello', { rev: documents.get(app.id).rev });
    ctx.req.on('close', disconnect);
    ctx.handled();
  });

  router.get('/api/apps/:app/seed', async ctx => {
    const { app } = appAccess(ctx, apps, 'admin');
    const file = app.seedFile && path.join(config.seedDir, app.seedFile);
    if (!file || !fs.existsSync(file)) throw new UserError('No starting data for this app.', 404);
    ctx.send(200, fs.readFileSync(file), 'application/json; charset=utf-8');
  });

  router.get('/api/apps/:app/files/:name', async ctx => {
    const { app } = appAccess(ctx, apps);
    if (!app.files[ctx.params.name]) throw new UserError('Unknown file.', 404);
    const file = await files.get(app.id, ctx.params.name);
    if (!file) throw new UserError('No file has been saved yet.', 404);
    ctx.send(200, file.content, 'application/octet-stream', {
      'X-File-Name': encodeURIComponent(file.fileName),
      'X-File-Saved': encodeURIComponent(file.savedLabel),
      'X-File-Updated-By': encodeURIComponent(file.updatedBy),
    });
  });

  router.put('/api/apps/:app/files/:name', async ctx => {
    const { app, role } = appAccess(ctx, apps);
    const spec = app.files[ctx.params.name];
    if (!spec) throw new UserError('Unknown file.', 404);
    if (!atLeast(role, spec.writeRole)) throw new UserError('Your role in this app cannot replace this file.', 403);
    const content = await ctx.buffer(spec.maxBytes);
    if (!content.length) throw new UserError('The file is empty.');
    const fileName = String(ctx.url.searchParams.get('fileName') || '').slice(0, 200);
    const savedLabel = String(ctx.url.searchParams.get('saved') || '').slice(0, 40);
    await files.put({ appId: app.id, name: ctx.params.name, fileName, savedLabel, content, username: ctx.user.username });
    await audit.record({ username: ctx.user.username, appId: app.id, action: 'file-upload', details: { name: ctx.params.name, fileName, bytes: content.length }, ip: ctx.ip });
    live.broadcast(app.id, 'file', { name: ctx.params.name, by: ctx.user.username });
    ctx.json(200, { ok: true });
  });
}

module.exports = { register, appAccess };
