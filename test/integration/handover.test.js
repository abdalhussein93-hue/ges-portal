'use strict';
/**
 * A deploy (e.g. Railway) starts the new server while the old one still runs.
 * The new one must wait, answer "updating" meanwhile, then take over with identical data.
 */
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const Patch = require('../../src/domain/patch');
const { start } = require('../../src/server');
const { testDatabaseUrl, wipeDatabase, makeConfig, ADMIN_PASSWORD } = require('./harness');
const { campDoc } = require('../fixtures/data');

const URL_ = testDatabaseUrl();
const quiet = { log: () => { } };
const wait = ms => new Promise(r => setTimeout(r, ms));

async function call(port, method, path, { cookie, body } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, text, json, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

async function waitUntil(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await wait(200); }
  return false;
}

describe('zero-downtime deploy handover', () => {
  before(() => wipeDatabase(URL_));

  it('a new server waits for the old one, then takes over with the same data', async () => {
    const A = await start(Object.assign(makeConfig(URL_), { port: 0, host: '127.0.0.1' }), quiet);
    const portA = A.server.address().port;
    assert.ok(await waitUntil(async () => (await call(portA, 'GET', '/api/me')).status === 401, 10000), 'A becomes ready');

    const cookie = (await call(portA, 'POST', '/api/login', { body: { username: 'admin', password: ADMIN_PASSWORD } })).cookie;
    const saved = await call(portA, 'POST', '/api/apps/camp/patch', { cookie, body: { baseRev: 0, ops: Patch.diff({}, campDoc()) } });
    assert.equal(saved.status, 200, saved.text);
    const docA = A.container.documents.get('camp');

    let listeningB;
    const startedB = start(Object.assign(makeConfig(URL_), { port: 0, host: '127.0.0.1', lockWaitSeconds: 60 }),
      { log: () => { }, onListening: info => { listeningB = info; } });
    assert.ok(await waitUntil(async () => !!listeningB, 10000), 'B listens at once');
    const portB = listeningB.server.address().port;
    await wait(500);
    const health = await call(portB, 'GET', '/healthz');
    assert.equal(health.status, 200, 'health check passes so the platform can switch traffic');
    assert.equal(health.text, 'starting');
    const busy = await call(portB, 'GET', '/api/me', { cookie });
    assert.equal(busy.status, 503, 'B does not serve data while A still holds the database');
    assert.equal(busy.json.starting, true);
    assert.equal((await call(portB, 'GET', '/')).status, 503);

    await A.stop('test');
    const B = await startedB;
    assert.equal((await call(portB, 'GET', '/api/me', { cookie })).status, 200, 'B takes over (same session still valid)');
    const docB = B.container.documents.get('camp');
    assert.equal(docB.rev, docA.rev);
    assert.deepEqual(docB.doc, docA.doc);
    await B.stop('test');
  });

  it('a server asked to stop while waiting exits cleanly', async () => {
    const A = await start(Object.assign(makeConfig(URL_), { port: 0, host: '127.0.0.1' }), quiet);
    assert.ok(await waitUntil(async () => (await call(A.server.address().port, 'GET', '/healthz')).text === 'ok', 10000));
    let listeningB;
    const startedB = start(Object.assign(makeConfig(URL_), { port: 0, host: '127.0.0.1', lockWaitSeconds: 60 }),
      { log: () => { }, onListening: info => { listeningB = info; } });
    assert.ok(await waitUntil(async () => !!listeningB, 10000));
    await wait(300);
    await listeningB.stop('test');
    await startedB; // resolves without error
    await A.stop('test');
  });
});
