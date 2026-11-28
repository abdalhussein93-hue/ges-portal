'use strict';
/**
 * Builds the HTTP request handler from the services (no network listening here,
 * so tests can use it directly).
 */
const path = require('path');
const { Router } = require('./http/router');
const { parseCookies, isHttps, clientIp, readBuffer, readJson } = require('./http/request');
const { send, json, redirect } = require('./http/response');
const { StaticFiles, safeJoin } = require('./http/static-files');
const { setSecurityHeaders, isCrossSite } = require('./http/security');
const { UserError } = require('./domain/apps/common');

const COOKIE = 'ges_sid';
const SMALL_JSON = 64 * 1024;

/**
 * @param {object} deps  {config, apps, auth, userAdmin, users, documents, files, live, audit, dining}
 * @returns {(req, res) => void}
 */
function createApp(deps) {
  const { config, apps, auth } = deps;
  const staticFiles = new StaticFiles();
  const router = new Router();
  const shared = Object.assign({ staticFiles }, deps);
  require('./routes/pages').register(router, shared);
  require('./routes/auth').register(router, shared);
  require('./routes/apps').register(router, shared);
  require('./routes/admin').register(router, shared);
  require('./routes/dining').register(router, shared);

  function makeContext(req, res, url) {
    const https = isHttps(req, config.trustProxy);
    let done = false;
    const ctx = {
      req, res, url, https,
      ip: clientIp(req, config.trustProxy),
      token: parseCookies(req)[COOKIE] || null,
      params: {}, user: null, session: null,
      send: (status, body, type, headers) => { done = true; send(req, res, status, body, type, headers); },
      json: (status, data) => { done = true; json(req, res, status, data); },
      redirect: location => { done = true; redirect(res, location); },
      handled: () => { done = true; },
      isDone: () => done || res.headersSent,
      body: (limit = SMALL_JSON) => readJson(req, limit),
      buffer: limit => readBuffer(req, limit),
      optionalUser: async () => (ctx.token ? auth.authenticate(ctx.token) : null),
      setSessionCookie: (token, maxAgeSeconds = 0) => {
        res.setHeader('Set-Cookie', `${COOKIE}=${token ? encodeURIComponent(token) : ''}; Path=/; HttpOnly; SameSite=Strict` +
          `${https ? '; Secure' : ''}; Max-Age=${token ? maxAgeSeconds : 0}`);
      },
    };
    return ctx;
  }

  /** @returns {boolean} true if the request may continue */
  async function checkAccess(ctx, options, isApi) {
    if (options.auth === 'none') return true;
    const found = await ctx.optionalUser();
    if (!found) {
      if (isApi) ctx.json(401, { error: 'Please sign in.', login: true });
      else ctx.redirect(`/login?next=${encodeURIComponent(ctx.url.pathname)}`);
      return false;
    }
    ctx.user = found.user;
    ctx.session = found.session;
    if (ctx.user.mustChange && !options.allowMustChange) {
      if (isApi) ctx.json(403, { error: 'Please choose a new password first.', mustChange: true });
      else ctx.redirect('/login?change=1');
      return false;
    }
    if ((options.auth === 'admin' || options.auth === 'page-admin') && !ctx.user.isAdmin) {
      if (isApi) ctx.json(403, { error: 'Only portal admins can do this.' });
      else ctx.redirect('/');
      return false;
    }
    return true;
  }

  /** /camp/, /manpower/, /costing/ and their files */
  async function serveAppFiles(ctx) {
    const pathname = ctx.url.pathname;
    const app = apps.list().find(a => pathname === a.path.slice(0, -1) || pathname.startsWith(a.path));
    if (!app) return false;
    if (pathname === app.path.slice(0, -1)) { ctx.redirect(app.path); return true; }
    if (!(await checkAccess(ctx, { auth: 'page' }, false))) return true;
    if (!ctx.user.apps[app.id]) { ctx.redirect(`/?denied=${app.id}`); return true; }
    const dir = path.join(config.publicDir, 'apps', app.id);
    const rest = pathname.slice(app.path.length) || 'index.html';
    const file = safeJoin(dir, rest);
    const cache = rest.startsWith('vendor/') ? 'private, max-age=604800' : 'no-cache';
    if (file && staticFiles.serve(ctx.req, ctx.res, file, cache)) { ctx.handled(); return true; }
    ctx.send(404, rest === 'index.html' ? 'This app has not been built. Run: npm run build:apps' : 'Not found');
    return true;
  }

  function handleError(ctx, err, isApi) {
    if (ctx.isDone()) { try { ctx.res.end(); } catch (e) { /* closed */ } return; }
    const status = err instanceof UserError || err.expose ? err.status || 400 : 500;
    if (status === 500) console.error(new Date().toISOString(), ctx.req.method, ctx.url.pathname, err);
    const message = status === 500 ? 'Something went wrong on the server. Please try again.' : err.message;
    if (isApi) ctx.json(status, { error: message, denied: !!err.denied });
    else ctx.send(status, message);
  }

  return async function handle(req, res) {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch (e) { res.writeHead(400); res.end(); return; }
    const ctx = makeContext(req, res, url);
    setSecurityHeaders(res, ctx.https);
    const isApi = url.pathname.startsWith('/api/');
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD' && isCrossSite(req)) {
        return ctx.json(403, { error: 'Cross-site request blocked.' });
      }
      const match = router.match(req.method, url.pathname);
      if (match && match.route) {
        ctx.params = match.params;
        if (!(await checkAccess(ctx, match.route.options, isApi))) return;
        await match.route.handler(ctx);
        if (!ctx.isDone()) ctx.send(204, '');
        return;
      }
      if (match && match.methodNotAllowed) return ctx.send(405, 'Method not allowed');
      if (!isApi && (req.method === 'GET' || req.method === 'HEAD') && (await serveAppFiles(ctx))) return;
      return isApi ? ctx.json(404, { error: 'Not found.' }) : ctx.send(404, 'Not found');
    } catch (err) {
      handleError(ctx, err, isApi);
    }
  };
}

module.exports = { createApp, COOKIE };
