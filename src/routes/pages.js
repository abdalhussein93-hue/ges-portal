'use strict';
/**
 * Pages and browser files.
 *   /            portal home (app tiles)
 *   /login       sign in / change password
 *   /admin       users, backups, activity, import (portal admins)
 *   /camp/ /manpower/ /costing/   the apps (see app.js for their files)
 */
const path = require('path');

function register(router, { config, staticFiles }) {
  const pub = config.publicDir;
  const page = (ctx, file) => {
    if (!staticFiles.serve(ctx.req, ctx.res, path.join(pub, file))) ctx.send(404, 'Not found');
  };

  router.get('/healthz', { auth: 'none' }, async ctx => ctx.send(200, 'ok'));
  router.get('/login', { auth: 'none' }, async ctx => page(ctx, 'login.html'));
  router.get('/', { auth: 'page' }, async ctx => page(ctx, 'index.html'));
  router.get('/admin', { auth: 'page-admin' }, async ctx => page(ctx, 'admin.html'));

  router.get('/favicon.ico', { auth: 'none' }, async ctx => page(ctx, 'favicon.ico'));
  router.get('/patch.js', { auth: 'page' }, async ctx => {
    staticFiles.serve(ctx.req, ctx.res, path.join(config.root, 'src', 'domain', 'patch.js'));
  });
  router.get('/shared/kv.js', { auth: 'page' }, async ctx => {
    staticFiles.serve(ctx.req, ctx.res, path.join(config.root, 'src', 'domain', 'kv.js'));
  });
  router.get('/shared/:file', { auth: 'page' }, async ctx => {
    if (!/^[a-z0-9-]+\.(js|css)$/.test(ctx.params.file)) return ctx.send(404, 'Not found');
    page(ctx, path.join('shared', ctx.params.file));
  });

  // old address of the camp app
  router.get('/app/', { auth: 'none' }, async ctx => ctx.redirect('/camp/'));
  router.get('/app', { auth: 'none' }, async ctx => ctx.redirect('/camp/'));
}

module.exports = { register };
