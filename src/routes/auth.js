'use strict';
/** Sign in / out and the signed-in user's own account. */
const { UserError } = require('../domain/apps/common');

const SMALL_BODY = 16 * 1024;

function register(router, { auth, config }) {
  router.post('/api/login', { auth: 'none' }, async ctx => {
    const body = await ctx.body(SMALL_BODY);
    const { token, user } = await auth.login(body.username, body.password, { ip: ctx.ip, userAgent: ctx.req.headers['user-agent'] });
    ctx.setSessionCookie(token, config.session.maxDays * 86400);
    ctx.json(200, { ok: true, mustChange: user.mustChange });
  });

  router.post('/api/logout', { auth: 'none' }, async ctx => {
    const current = await ctx.optionalUser();
    await auth.logout(ctx.token, current && current.user.username);
    ctx.setSessionCookie(null);
    ctx.json(200, { ok: true });
  });

  router.get('/api/me', { allowMustChange: true }, async ctx => {
    const u = ctx.user;
    ctx.json(200, { username: u.username, name: u.name, isAdmin: u.isAdmin, apps: u.apps, mustChange: u.mustChange });
  });

  router.post('/api/me/password', { allowMustChange: true }, async ctx => {
    const body = await ctx.body(SMALL_BODY);
    await auth.changePassword(ctx.user, ctx.session.tokenHash, String(body.oldPassword || ''), body.newPassword, ctx.ip);
    ctx.json(200, { ok: true });
  });

  router.post('/api/me/verify-password', async ctx => {
    const body = await ctx.body(SMALL_BODY);
    if (typeof body.password !== 'string') throw new UserError('Password missing.');
    const ok = await auth.verifyOwnPassword(ctx.user, body.password, ctx.ip);
    ctx.json(200, { ok });
  });
}

module.exports = { register };
