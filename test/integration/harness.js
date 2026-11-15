'use strict';
/**
 * Starts the portal on a real PostgreSQL test database (TEST_DATABASE_URL), wiped first.
 * Never point TEST_DATABASE_URL at a database with real data.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');
const { loadConfig } = require('../../src/config');
const { createContainer } = require('../../src/container');
const { createApp } = require('../../src/app');
const { campDoc } = require('../fixtures/data');

const ADMIN_PASSWORD = 'test-only-admin-pass';

function testDatabaseUrl() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('Set TEST_DATABASE_URL to an EMPTY test database (it is wiped).');
  if (!/test/i.test(url)) throw new Error('TEST_DATABASE_URL must contain "test" in its name - it is wiped by the tests.');
  return url;
}

async function wipeDatabase(url) {
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  } finally {
    await pool.end();
  }
}

function makeConfig(url, overrides = {}) {
  const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ges-seed-'));
  fs.writeFileSync(path.join(seedDir, 'camp.json'), JSON.stringify({ campData: campDoc().campData, historyLog: campDoc().historyLog }));
  const config = loadConfig({ DATABASE_URL: url, ADMIN_PASSWORD, SEED_DIR: seedDir, DATABASE_POOL_SIZE: '5' });
  return Object.assign(config, overrides, { documents: Object.assign({}, config.documents, overrides.documents || {}) });
}

/** Starts a server; returns {base, container, close, request, login} */
async function startPortal(url, overrides) {
  const config = makeConfig(url, overrides);
  const container = await createContainer(config, { log: () => { } });
  await container.userAdmin.ensureFirstAdmin(config.admin);
  await container.documents.init();
  const server = http.createServer(createApp(container));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const streams = new Set();

  async function close() {
    for (const s of streams) s.destroy();
    container.live.close();
    await new Promise(resolve => server.close(resolve));
    await container.db.close();
  }

  /** Low-level request. Returns {status, headers, json, text, buffer, cookie} */
  async function request(method, p, { body, cookie, headers = {}, raw } = {}) {
    const h = Object.assign({}, headers);
    let payload;
    if (raw !== undefined) { payload = raw; }
    else if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
    if (cookie) h.Cookie = cookie;
    const res = await fetch(base + p, { method, headers: h, body: payload, redirect: 'manual' });
    const buffer = Buffer.from(await res.arrayBuffer());
    const text = buffer.toString('utf-8');
    let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
    const setCookie = res.headers.get('set-cookie');
    return { status: res.status, headers: res.headers, json, text, buffer, cookie: setCookie ? setCookie.split(';')[0] : null, setCookie };
  }

  async function login(username, password) {
    const r = await request('POST', '/api/login', { body: { username, password } });
    if (r.status !== 200) throw new Error(`login ${username} failed: ${r.status} ${r.text}`);
    return r.cookie;
  }

  /** Opens an event stream and collects events. */
  function events(cookie, appId) {
    const received = [];
    return new Promise((resolve, reject) => {
      const req = http.request(`${base}/api/apps/${appId}/events`, { headers: { Cookie: cookie } }, res => {
        res.setEncoding('utf-8');
        res.on('data', chunk => received.push(chunk));
        resolve({ text: () => received.join(''), close: () => req.destroy() });
      });
      req.on('error', err => { if (err.code !== 'ECONNRESET') reject(err); });
      req.end();
      streams.add(req);
    });
  }

  return { base, container, config, close, request, login, events };
}

module.exports = { testDatabaseUrl, wipeDatabase, startPortal, makeConfig, ADMIN_PASSWORD };
