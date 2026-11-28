'use strict';
/** The temporary emergency admin (src/emergency-admin.js) always lets the admin sign in. */
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('../../src/server');
const emergency = require('../../src/emergency-admin');
const { testDatabaseUrl, wipeDatabase, makeConfig, ADMIN_PASSWORD } = require('./harness');

const URL_ = testDatabaseUrl();
const quiet = { log: () => { } };

async function login(port, username, password) {
  const r = await fetch(`http://127.0.0.1:${port}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
  });
  return r.status;
}

describe('emergency admin', () => {
  before(() => wipeDatabase(URL_));

  it('resets an existing admin with another password, and turns off with EMERGENCY_ADMIN=off', async () => {
    // 1. normal start: admin created with a different password
    let s = await start(Object.assign(makeConfig(URL_), { port: 0, host: '127.0.0.1' }), quiet);
    let port = s.server.address().port;
    assert.equal(await login(port, 'admin', ADMIN_PASSWORD), 200);
    assert.equal(await login(port, emergency.username, emergency.password), 401);
    await s.container.users.update('admin', { disabled: true });
    await s.stop('test');

    // 2. start with the emergency admin on: fixed password works, account enabled again
    s = await start(Object.assign(makeConfig(URL_), { port: 0, host: '127.0.0.1', emergencyAdmin: true }), quiet);
    port = s.server.address().port;
    assert.equal(await login(port, emergency.username, emergency.password), 200);
    assert.equal(await login(port, 'admin', ADMIN_PASSWORD), 401);
    const admin = await s.container.users.find('admin');
    assert.equal(admin.isAdmin, true);
    assert.equal(admin.disabled, false);
    assert.equal(admin.mustChange, false);
    assert.deepEqual(admin.apps, { camp: 'admin', manpower: 'admin', costing: 'admin', duty: 'admin', dining: 'admin' });
    await s.stop('test');
  });

  it('is on unless EMERGENCY_ADMIN=off', () => {
    const { loadConfig } = require('../../src/config');
    assert.equal(loadConfig({}).emergencyAdmin, true);
    assert.equal(loadConfig({ EMERGENCY_ADMIN: 'off' }).emergencyAdmin, false);
    assert.equal(loadConfig({ EMERGENCY_ADMIN: 'false' }).emergencyAdmin, false);
  });
});
