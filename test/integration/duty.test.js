'use strict';
/**
 * Duty Board: each department head only sees and changes their own departments (PostgreSQL).
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { testDatabaseUrl, wipeDatabase, startPortal, ADMIN_PASSWORD } = require('./harness');

const URL_ = testDatabaseUrl();
const roster = () => ({
  version: 3, camp: 'Camp Roster', activeDept: 'kit01',
  depts: [
    { id: 'kit01', name: 'Kitchen', config: { start: 2 }, tasks: [{ name: 'Cook', min: 0, color: '#f00' }], staff: [{ id: 'st1', name: 'Test Cook', duties: [], off: {} }] },
    { id: 'srv01', name: 'Service', config: { start: 2 }, tasks: [], staff: [{ id: 'st2', name: 'Test Waiter', duties: [], off: {} }] },
    { id: 'hk001', name: 'House Keeping', config: { start: 2 }, tasks: [], staff: [] },
  ],
});

describe('Duty Board departments (PostgreSQL)', () => {
  let P, admin, head, rev;
  const data = async c => (await P.request('GET', '/api/apps/duty/data', { cookie: c })).json;
  async function patch(c, ops) {
    const r = await P.request('POST', '/api/apps/duty/patch', { cookie: c, body: { baseRev: rev, ops } });
    if (r.json && r.json.rev) rev = r.json.rev;
    return r;
  }

  before(async () => {
    await wipeDatabase(URL_);
    P = await startPortal(URL_);
    admin = await P.login('admin', ADMIN_PASSWORD);
    const imp = await P.request('POST', '/api/admin/apps/duty/import', { cookie: admin, body: { file: roster(), fileName: 'app_data.json' } });
    assert.equal(imp.status, 200, imp.text);
    rev = imp.json.rev;
    const c = await P.request('POST', '/api/admin/users', { cookie: admin, body: { username: 'kitchen.head', name: 'Kitchen Head', apps: { duty: 'operator' }, scopes: { duty: { depts: ['kit01', 'nope!'] } } } });
    assert.equal(c.status, 200, c.text);
    assert.deepEqual(c.json.user.scopes, { duty: { depts: ['kit01'] } }, 'invalid ids are dropped');
    let ck = await P.login('kitchen.head', c.json.tempPassword);
    await P.request('POST', '/api/me/password', { cookie: ck, body: { oldPassword: c.json.tempPassword, newPassword: 'kitchen-pass-1' } });
    head = await P.login('kitchen.head', 'kitchen-pass-1');
  });
  after(async () => { if (P) await P.close(); });

  it('the admin sees every department; a department head only theirs', async () => {
    assert.deepEqual((await data(admin)).doc.depts.map(d => d.name), ['Kitchen', 'Service', 'House Keeping']);
    const mine = (await data(head)).doc;
    assert.deepEqual(mine.depts.map(d => d.name), ['Kitchen']);
    assert.equal(mine.activeDept, undefined, 'the current department is personal');
    assert.ok(!JSON.stringify(mine).includes('Test Waiter'), "nothing from other departments reaches the head's browser");
    const apps = (await P.request('GET', '/api/apps', { cookie: head })).json;
    assert.equal(apps.find(a => a.id === 'duty').scope, 'Kitchen');
  });

  it('a department head edits their department, but not others, and cannot add or delete departments', async () => {
    let r = await patch(head, [{ o: 's', p: ['depts', { id: 'kit01' }, 'staff', { id: 'st1' }, 'name'], v: 'Renamed Cook' }]);
    assert.equal(r.status, 200, r.text);
    r = await patch(head, [{ o: 's', p: ['depts', { id: 'srv01' }, 'name'], v: 'Hacked' }]);
    assert.equal(r.status, 403);
    r = await patch(head, [{ o: 'ai', p: ['depts'], v: { id: 'new01', name: 'New', staff: [] }, at: 0, after: null }]);
    assert.equal(r.status, 403);
    r = await patch(head, [{ o: 'ad', p: ['depts'], id: 'kit01' }]);
    assert.equal(r.status, 403);
    const all = (await data(admin)).doc;
    assert.equal(all.depts.find(d => d.id === 'kit01').staff[0].name, 'Renamed Cook');
    assert.equal(all.depts.find(d => d.id === 'srv01').name, 'Service');
  });

  it("the admin's changes to other departments never reach the head; changes to theirs do", async () => {
    const since = rev;
    await patch(admin, [{ o: 's', p: ['depts', { id: 'srv01' }, 'name'], v: 'Service Hall' }]);
    await patch(admin, [{ o: 's', p: ['depts', { id: 'kit01' }, 'name'], v: 'Main Kitchen' }]);
    const feed = (await P.request('GET', `/api/apps/duty/changes?since=${since}`, { cookie: head })).json;
    const text = JSON.stringify(feed.changes);
    assert.ok(text.includes('Main Kitchen'));
    assert.ok(!text.includes('Service Hall'));
  });

  it('the current department is never saved from a browser', async () => {
    const r = await patch(admin, [{ o: 's', p: ['activeDept'], v: 'srv01' }, { o: 's', p: ['camp'], v: 'GES Camp Roster' }]);
    assert.equal(r.status, 200, r.text);
    const raw = P.container.documents.get('duty').doc;
    assert.equal(raw.camp, 'GES Camp Roster');
    assert.notEqual(raw.activeDept, 'srv01');
  });

  it('giving more departments takes effect at once (the person signs in again)', async () => {
    const r = await P.request('POST', '/api/admin/users/kitchen.head', { cookie: admin, body: { scopes: { duty: { depts: ['kit01', 'srv01'] } } } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.signedOut, true);
    head = await P.login('kitchen.head', 'kitchen-pass-1');
    assert.deepEqual((await data(head)).doc.depts.map(d => d.id), ['kit01', 'srv01']);
    const up = await patch(head, [{ o: 's', p: ['depts', { id: 'srv01' }, 'config', 'start'], v: 3 }]);
    assert.equal(up.status, 200, up.text);
  });

  it('a person with the role but no departments sees none', async () => {
    const c = await P.request('POST', '/api/admin/users', { cookie: admin, body: { username: 'no.dept', apps: { duty: 'viewer' } } });
    let ck = await P.login('no.dept', c.json.tempPassword);
    await P.request('POST', '/api/me/password', { cookie: ck, body: { oldPassword: c.json.tempPassword, newPassword: 'no-dept-pass-1' } });
    ck = await P.login('no.dept', 'no-dept-pass-1');
    assert.deepEqual((await data(ck)).doc.depts, []);
  });

  it('the Duty Board page is served with the portal connection', async () => {
    const r = await P.request('GET', '/duty/', { cookie: admin });
    assert.equal(r.status, 200);
    assert.match(r.text, /\/shared\/duty-bridge\.js/);
    assert.ok(!r.text.includes("localStorage.getItem('dutyCamp')") || r.text.includes('duty-bridge'), 'the bridge stops browser copies');
  });
});
