'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword, passwordProblem, temporaryPassword } = require('../../src/services/passwords');
const { LoginLimiter } = require('../../src/services/login-limiter');
const { HtmlEditor, findLiteralEnd } = require('../../tools/lib/html-edit');
const { Router } = require('../../src/http/router');
const { safeJoin } = require('../../src/http/static-files');
const path = require('path');

test('passwords: hash and verify', async () => {
  const h = await hashPassword('sample-pass-1');
  assert.match(h, /^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.equal(await verifyPassword('sample-pass-1', h), true);
  assert.equal(await verifyPassword('sample-pass-2', h), false);
  assert.equal(await verifyPassword('x', null), false);
  assert.notEqual(await hashPassword('sample-pass-1'), h, 'random salt');
});

test('passwords: rules and temporary passwords', () => {
  assert.ok(passwordProblem('short'));
  assert.equal(passwordProblem('long enough'), null);
  const t = temporaryPassword();
  assert.match(t, /^[A-Za-z2-9]{4}-[A-Za-z2-9]{4}-[A-Za-z2-9]{4}$/);
  assert.ok(!/[01OlI]/.test(t));
});

test('login limiter: 5 failures lock the account for 15 minutes', () => {
  let now = 0;
  const l = new LoginLimiter(() => now);
  for (let i = 0; i < 4; i++) l.failure('bob', '1.1.1.1');
  assert.equal(l.accountLockedFor('bob'), 0);
  l.failure('bob', '1.1.1.1');
  assert.ok(l.accountLockedFor('bob') > 0);
  now += 15 * 60 * 1000 + 1;
  assert.equal(l.accountLockedFor('bob'), 0);
});

test('login limiter: 20 failures from one address block it', () => {
  const l = new LoginLimiter();
  for (let i = 0; i < 20; i++) l.failure(`u${i}`, '2.2.2.2');
  assert.equal(l.ipBlocked('2.2.2.2'), true);
  assert.equal(l.ipBlocked('3.3.3.3'), false);
});

test('build edits: exact match required, literals extracted', () => {
  const e = new HtmlEditor('<script>var X = [1,"a]",{"b":[2]}]; var Y=1;</script>', 'test');
  const v = e.extractLiteral('x', 'var X = ', '[]');
  assert.deepEqual(v, [1, 'a]', { b: [2] }]);
  assert.equal(e.html, '<script>var X = []; var Y=1;</script>');
  assert.throws(() => e.replaceOnce('missing', 'nothing here', ''), /expected 1 match/);
  assert.equal(findLiteralEnd('[1,[2]]x', 0), 7);
});

test('router matches parameters and reports wrong methods', () => {
  const r = new Router();
  r.get('/api/apps/:app/data', () => { });
  const m = r.match('GET', '/api/apps/camp/data');
  assert.deepEqual(m.params, { app: 'camp' });
  assert.ok(r.match('POST', '/api/apps/camp/data').methodNotAllowed);
  assert.equal(r.match('GET', '/nope'), null);
});

test('static files cannot escape their folder', () => {
  const base = path.resolve('/srv/app');
  assert.ok(safeJoin(base, 'vendor/x.js').startsWith(base));
  assert.equal(safeJoin(base, '../secret'), null);
  assert.equal(safeJoin(base, '..%2f..%2fetc'), null);
  assert.equal(safeJoin(base, '%00'), null);
});
