'use strict';
/**
 * End-to-end tests against a real PostgreSQL database.
 *   TEST_DATABASE_URL=postgres://user:pass@host:5432/portal_test node --test test/integration/
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Patch = require('../../src/domain/patch');
const { acquireInstanceLock } = require('../../src/db/instance-lock');
const { testDatabaseUrl, wipeDatabase, startPortal, ADMIN_PASSWORD } = require('./harness');
const { campDoc, manpowerDesktopFile, costingDoc } = require('../fixtures/data');

const URL_ = testDatabaseUrl();
const wait = ms => new Promise(r => setTimeout(r, ms));

describe('GES Operations Portal (PostgreSQL)', () => {
  let P; // running portal
  let admin, oper, viewer;
  const pw = { oper: 'operator-pass-1', viewer: 'viewer-pass-1' };
  let rev = 0;

  before(async () => {
    await wipeDatabase(URL_);
    P = await startPortal(URL_, { documents: { checkpointEvery: 3, snapshotDays: 60 } });
  });
  after(async () => { if (P) await P.close(); });

  // ------------------------------------------------------------ access
  it('sends visitors to sign in and protects every API and app', async () => {
    const home = await P.request('GET', '/');
    assert.equal(home.status, 302); assert.match(home.headers.get('location'), /^\/login/);
    assert.equal((await P.request('GET', '/camp/')).status, 302);
    assert.equal((await P.request('GET', '/api/me')).status, 401);
    assert.equal((await P.request('GET', '/api/apps/camp/data')).status, 401);
    assert.equal((await P.request('GET', '/login')).status, 200);
    assert.equal((await P.request('GET', '/healthz')).text, 'ok');
  });

  it('sets security headers and a safe session cookie', async () => {
    const r = await P.request('GET', '/login');
    assert.ok(r.headers.get('content-security-policy'));
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    const l = await P.request('POST', '/api/login', { body: { username: 'admin', password: ADMIN_PASSWORD } });
    assert.match(l.setCookie, /HttpOnly/); assert.match(l.setCookie, /SameSite=Strict/);
    admin = l.cookie;
  });

  it('the first super user (from ADMIN_PASSWORD) is a portal admin and Admin in every app', async () => {
    const me = (await P.request('GET', '/api/me', { cookie: admin })).json;
    assert.equal(me.username, 'admin');
    assert.equal(me.isAdmin, true);
    assert.equal(me.mustChange, false);
    assert.deepEqual(me.apps, { camp: 'admin', manpower: 'admin', costing: 'admin' });
  });

  it('refuses wrong passwords and requests from other websites', async () => {
    assert.equal((await P.request('POST', '/api/login', { body: { username: 'admin', password: 'wrong-password' } })).status, 401);
    const r = await P.request('POST', '/api/admin/users', { cookie: admin, body: { username: 'evil1' }, headers: { Origin: 'https://evil.example' } });
    assert.equal(r.status, 403);
  });

  it('serves the portal, the admin page and each app to an admin', async () => {
    for (const p of ['/', '/admin', '/camp/', '/manpower/', '/costing/', '/shared/portal-bar.js', '/patch.js', '/shared/kv.js']) {
      const r = await P.request('GET', p, { cookie: admin });
      assert.equal(r.status, 200, p);
    }
    assert.equal((await P.request('GET', '/camp', { cookie: admin })).status, 302);
    assert.equal((await P.request('GET', '/camp/..%2f..%2fsrc%2fconfig.js', { cookie: admin })).status, 404);
    assert.equal((await P.request('GET', '/app/', { cookie: admin })).headers.get('location'), '/camp/');
  });

  // ------------------------------------------------------------ first setup
  it('an empty app is set up by its admin (starting data offered)', async () => {
    const d = await P.request('GET', '/api/apps/camp/data', { cookie: admin });
    assert.equal(d.json.doc, null);
    assert.equal((await P.request('GET', '/api/apps/camp/seed', { cookie: admin })).status, 200);
    const r = await P.request('POST', '/api/apps/camp/patch', { cookie: admin, body: { baseRev: 0, ops: Patch.diff({}, campDoc()) } });
    assert.equal(r.status, 200, r.text);
    rev = r.json.rev;
    assert.equal(rev, 1);
  });

  // ------------------------------------------------------------ users
  it('admin creates users with a role per app; they must choose a password first', async () => {
    const o = await P.request('POST', '/api/admin/users', { cookie: admin, body: { username: 'op.one', name: 'Operator One', apps: { camp: 'operator', manpower: 'viewer' } } });
    assert.equal(o.status, 200, o.text);
    assert.deepEqual(o.json.user.apps, { camp: 'operator', manpower: 'viewer' });
    const v = await P.request('POST', '/api/admin/users', { cookie: admin, body: { username: 'view.one', name: 'Viewer One', apps: { camp: 'viewer' } } });
    assert.equal((await P.request('POST', '/api/admin/users', { cookie: admin, body: { username: 'Bad Name' } })).status, 400);
    assert.equal((await P.request('POST', '/api/admin/users', { cookie: admin, body: { username: 'op.one' } })).status, 400);

    oper = await P.login('op.one', o.json.tempPassword);
    assert.equal((await P.request('GET', '/api/apps/camp/data', { cookie: oper })).status, 403, 'must change password first');
    assert.equal((await P.request('POST', '/api/me/password', { cookie: oper, body: { oldPassword: o.json.tempPassword, newPassword: pw.oper } })).status, 200);
    viewer = await P.login('view.one', v.json.tempPassword);
    await P.request('POST', '/api/me/password', { cookie: viewer, body: { oldPassword: v.json.tempPassword, newPassword: pw.viewer } });
    assert.equal((await P.request('GET', '/api/apps/camp/data', { cookie: oper })).status, 200);
  });

  it('users only reach the apps they have a role in', async () => {
    const apps = (await P.request('GET', '/api/apps', { cookie: oper })).json;
    assert.deepEqual(apps.map(a => [a.id, a.role]), [['camp', 'operator'], ['manpower', 'viewer'], ['costing', null]]);
    assert.equal((await P.request('GET', '/api/apps/costing/data', { cookie: oper })).status, 403);
    const page = await P.request('GET', '/costing/', { cookie: oper });
    assert.equal(page.status, 302); assert.equal(page.headers.get('location'), '/?denied=costing');
    assert.equal((await P.request('GET', '/admin', { cookie: oper })).status, 302);
    assert.equal((await P.request('GET', '/api/admin/users', { cookie: oper })).status, 403);
  });

  // ------------------------------------------------------------ camp rules
  it('location profit is hidden from non-admins', async () => {
    const o = await P.request('GET', '/api/apps/camp/data', { cookie: oper });
    assert.ok(o.json.doc.campData.A && !o.json.doc.campData._profit);
    assert.ok((await P.request('GET', '/api/apps/camp/data', { cookie: admin })).json.doc.campData._profit);
  });

  let stream;
  it('an operator checks a resident in and a viewer sees it live', async () => {
    stream = await P.events(viewer, 'camp');
    await wait(100);
    const ops = [
      { o: 's', p: ['campData', 'A', 'rooms', 'A-1', 'beds', 0, 'status'], v: 'occupied' },
      { o: 's', p: ['campData', 'A', 'rooms', 'A-1', 'beds', 0, 'name'], v: 'New Resident' },
      { o: 'ai', p: ['historyLog'], v: { id: 'h3', action: 'Check In', name: 'New Resident', by: 'op.one' }, at: 0, after: null },
    ];
    const r = await P.request('POST', '/api/apps/camp/patch', { cookie: oper, body: { baseRev: rev, ops, clientId: 'c1' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.reload, false);
    rev = r.json.rev;
    await wait(150);
    assert.match(stream.text(), /event: hello/);
    assert.match(stream.text(), /event: presence/);
    assert.match(stream.text(), new RegExp(`event: change\\ndata: \\{"rev":${rev}`));
  });

  it('an operator cannot change structure, lists, profit or delete records', async () => {
    const tries = [
      { o: 's', p: ['BLOCKS_META', 'Z'], v: { name: 'Z' } },
      { o: 'pi', p: ['companies'], v: 'NEW CO', at: 0 },
      { o: 's', p: ['campData', 'A', 'rooms', 'A-1', 'capacity'], v: 9 },
      { o: 'd', p: ['campData', 'A', 'rooms', 'A-2'] },
      { o: 'ad', p: ['historyLog'], id: 'h1' },
      { o: 's', p: ['campData', '_profit', 'x'], v: 1 },
    ];
    for (const op of tries) {
      const r = await P.request('POST', '/api/apps/camp/patch', { cookie: oper, body: { baseRev: rev, ops: [op] } });
      assert.equal(r.status, 403, JSON.stringify(op.p));
      assert.equal(r.json.denied, true);
    }
    const audit = (await P.request('GET', '/api/admin/audit', { cookie: admin })).json;
    assert.ok(audit.some(a => a.action === 'change-denied' && a.username === 'op.one'));
  });

  it('a viewer cannot change anything', async () => {
    const r = await P.request('POST', '/api/apps/camp/patch', { cookie: viewer, body: { baseRev: rev, ops: [{ o: 's', p: ['campData', 'A', 'rooms', 'A-2', 'beds', 0, 'name'], v: 'x' }] } });
    assert.equal(r.status, 403);
  });

  it('saving from an older version merges and returns the changes that were missed', async () => {
    const r = await P.request('POST', '/api/apps/camp/patch', { cookie: admin, body: { baseRev: 1, ops: [{ o: 's', p: ['campData', 'B', 'rooms', 'B-1', 'beds', 0, 'notes'], v: 'admin note' }] } });
    assert.equal(r.status, 200, r.text);
    assert.ok(JSON.stringify(r.json.missed).includes('New Resident'));
    rev = r.json.rev;
    const doc = (await P.request('GET', '/api/apps/camp/data', { cookie: admin })).json.doc;
    assert.equal(doc.campData.A.rooms['A-1'].beds[0].name, 'New Resident');
    assert.equal(doc.campData.B.rooms['B-1'].beds[0].notes, 'admin note');
  });

  it('a change lost to someone else\'s simultaneous change is reported, not hidden', async () => {
    const r = await P.request('POST', '/api/apps/camp/patch', { cookie: oper, body: { baseRev: rev, ops: [{ o: 'ai', p: ['historyLog'], v: { id: 'h3', action: 'DIFFERENT' }, at: 0, after: null }] } });
    assert.equal(r.status, 200);
    assert.equal(r.json.conflicts, 1);
    assert.equal(r.json.reload, true);
    rev = r.json.rev;
    const audit = (await P.request('GET', '/api/admin/audit', { cookie: admin })).json;
    assert.ok(audit.some(a => a.action === 'change-conflict'));
  });

  it('text that could run code in another user\'s browser is cleaned', async () => {
    const r = await P.request('POST', '/api/apps/camp/patch', { cookie: oper, body: { baseRev: rev, ops: [{ o: 's', p: ['campData', 'A', 'rooms', 'A-2', 'beds', 0, 'notes'], v: '<img src=x onerror=alert(1)> it\'s' }] } });
    assert.equal(r.json.reload, true);
    rev = r.json.rev;
    const notes = (await P.request('GET', '/api/apps/camp/data', { cookie: oper })).json.doc.campData.A.rooms['A-2'].beds[0].notes;
    assert.ok(!/[<>']/.test(notes), notes);
  });

  it('the catch-up feed hides profit changes from non-admins', async () => {
    const p = await P.request('POST', '/api/apps/camp/patch', { cookie: admin, body: { baseRev: rev, ops: [{ o: 's', p: ['campData', '_profit', 'Global Village', 'rates', 'Senior_1'], v: 75 }] } });
    const c = await P.request('GET', `/api/apps/camp/changes?since=${rev}`, { cookie: oper });
    assert.equal(c.json.changes.length, 1);
    assert.deepEqual(c.json.changes[0].ops, []);
    rev = p.json.rev;
  });

  // ------------------------------------------------------------ manpower
  it('manpower: admin imports the desktop data file; a viewer can read but not change it', async () => {
    const imp = await P.request('POST', '/api/admin/apps/manpower/import', { cookie: admin, body: { file: manpowerDesktopFile(), fileName: 'app_data.json' } });
    assert.equal(imp.status, 200, imp.text);
    const d = await P.request('GET', '/api/apps/manpower/data', { cookie: oper });
    assert.equal(d.json.doc.keys.gesStaffV4.j.length, 2);
    assert.deepEqual(d.json.doc.keys.gesCampName, { s: 'GES CAMP' });
    const deny = await P.request('POST', '/api/apps/manpower/patch', { cookie: oper, body: { baseRev: d.json.rev, ops: [{ o: 's', p: ['keys', 'gesCampName', 's'], v: 'X' }] } });
    assert.equal(deny.status, 403);
  });

  it('manpower: an edit to one staff member is merged by record id', async () => {
    const d = (await P.request('GET', '/api/apps/manpower/data', { cookie: admin })).json;
    const r = await P.request('POST', '/api/apps/manpower/patch', { cookie: admin, body: { baseRev: d.rev, ops: [{ o: 's', p: ['keys', 'gesStaffV4', 'j', { id: 2 }, 'dept'], v: 'Kitchen' }] } });
    assert.equal(r.status, 200, r.text);
    const after = (await P.request('GET', '/api/apps/manpower/data', { cookie: admin })).json.doc.keys.gesStaffV4.j;
    assert.equal(after.find(s => s.id === 2).dept, 'Kitchen');
    assert.equal(after.find(s => s.id === 1).dept, 'Kitchen');
  });

  it('manpower: the timesheet workbook is stored on the server for everyone', async () => {
    const bytes = Buffer.from([0x50, 0x4b, 3, 4, 1, 2, 3, 250, 251, 252]);
    const put = await P.request('PUT', '/api/apps/manpower/files/workbook?fileName=Timesheet%20Nov.xlsx&saved=2026-11-15', { cookie: admin, raw: bytes, headers: { 'Content-Type': 'application/octet-stream' } });
    assert.equal(put.status, 200, put.text);
    const get = await P.request('GET', '/api/apps/manpower/files/workbook', { cookie: oper });
    assert.equal(get.status, 200);
    assert.deepEqual(get.buffer, bytes);
    assert.equal(decodeURIComponent(get.headers.get('x-file-name')), 'Timesheet Nov.xlsx');
    const denied = await P.request('PUT', '/api/apps/manpower/files/workbook', { cookie: oper, raw: bytes, headers: { 'Content-Type': 'application/octet-stream' } });
    assert.equal(denied.status, 403);
    assert.equal((await P.request('GET', '/api/apps/manpower/files/other', { cookie: admin })).status, 404);
  });

  // ------------------------------------------------------------ costing
  it('costing: admin sets up the app and records consumption', async () => {
    const r1 = await P.request('POST', '/api/apps/costing/patch', { cookie: admin, body: { baseRev: 0, ops: Patch.diff({}, costingDoc()) } });
    assert.equal(r1.status, 200, r1.text);
    const r2 = await P.request('POST', '/api/apps/costing/patch', { cookie: admin, body: { baseRev: r1.json.rev, ops: [{ o: 's', p: ['months', '2026-11', 'cons', '15'], v: { i0: { g_sen: 3 } } }] } });
    assert.equal(r2.status, 200, r2.text);
    const doc = (await P.request('GET', '/api/apps/costing/data', { cookie: admin })).json.doc;
    assert.deepEqual(doc.months['2026-11'].cons['15'], { i0: { g_sen: 3 } });
  });

  // ------------------------------------------------------------ data safety
  it('a full copy is kept at the start of the day, before imports, and on request', async () => {
    const camp = (await P.request('GET', '/api/admin/apps/camp/snapshots', { cookie: admin })).json;
    assert.ok(camp.some(s => s.kind === 'daily'), 'daily copy taken before the first change of the day');
    const imp = await P.request('POST', '/api/admin/apps/camp/import', { cookie: admin, body: { file: campDoc(), fileName: 'app_data.json' } });
    assert.equal(imp.status, 200, imp.text);
    const manual = await P.request('POST', '/api/admin/apps/camp/snapshots', { cookie: admin, body: { label: 'test' } });
    assert.equal(manual.status, 200);
    const list = (await P.request('GET', '/api/admin/apps/camp/snapshots', { cookie: admin })).json;
    const pre = list.find(s => s.kind === 'pre-import');
    assert.ok(pre && list.some(s => s.kind === 'manual'));
    const dl = await P.request('GET', `/api/admin/apps/camp/snapshots/${pre.id}`, { cookie: admin });
    assert.equal(dl.json.campData.A.rooms['A-1'].beds[0].name, 'New Resident', 'the pre-import copy holds the data as it was');
    assert.match(dl.headers.get('content-disposition'), /attachment/);
    const c = await P.request('GET', `/api/apps/camp/changes?since=${rev}`, { cookie: admin });
    assert.equal(c.json.reload, true, 'browsers reload everything after an import');
  });

  it('after a restart every app has exactly the same data (checkpoint + journal replay)', async () => {
    const before = {};
    for (const id of ['camp', 'manpower', 'costing']) before[id] = P.container.documents.get(id);
    await P.container.documents.checkpointAll();
    // make more changes after the checkpoint so the restart must replay the journal
    let r = (await P.request('GET', '/api/apps/costing/data', { cookie: admin })).json;
    const p = await P.request('POST', '/api/apps/costing/patch', { cookie: admin, body: { baseRev: r.rev, ops: [{ o: 's', p: ['settings', 'lowStock'], v: 12 }] } });
    assert.equal(p.status, 200);
    before.costing = P.container.documents.get('costing');

    stream.close();
    await P.close();
    P = await startPortal(URL_, { documents: { checkpointEvery: 3, snapshotDays: 60 } });
    for (const id of ['camp', 'manpower', 'costing']) {
      const now = P.container.documents.get(id);
      assert.equal(now.rev, before[id].rev, `${id} revision`);
      assert.deepEqual(now.doc, before[id].doc, `${id} data`);
    }
    admin = await P.login('admin', ADMIN_PASSWORD);
    r = (await P.request('GET', '/api/apps/costing/data', { cookie: admin })).json;
    assert.equal(r.doc.settings.lowStock, 12);
  });

  it('only one server can write to the database at a time', async () => {
    const first = await acquireInstanceLock(P.container.db);
    await assert.rejects(() => acquireInstanceLock(P.container.db), /another portal process/);
    await first.release();
    const again = await acquireInstanceLock(P.container.db);
    await again.release();
  });

  // ------------------------------------------------------------ account management
  it('the last admin cannot be removed and admins cannot lock themselves out', async () => {
    assert.equal((await P.request('POST', '/api/admin/users/admin', { cookie: admin, body: { isAdmin: false } })).status, 400);
    assert.equal((await P.request('POST', '/api/admin/users/admin', { cookie: admin, body: { disabled: true } })).status, 400);
    assert.equal((await P.request('DELETE', '/api/admin/users/admin', { cookie: admin })).status, 400);
  });

  it('changing roles takes effect immediately; disabling signs the user out', async () => {
    oper = await P.login('op.one', pw.oper);
    const r = await P.request('POST', '/api/admin/users/op.one', { cookie: admin, body: { apps: { camp: 'viewer' } } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.user.apps, { camp: 'viewer' });
    assert.equal((await P.request('GET', '/api/me', { cookie: oper })).status, 401, 'signed out after a role change');
    oper = await P.login('op.one', pw.oper);
    assert.equal((await P.request('GET', '/api/apps/manpower/data', { cookie: oper })).status, 403);
    await P.request('POST', '/api/admin/users/op.one', { cookie: admin, body: { disabled: true } });
    assert.equal((await P.request('GET', '/api/me', { cookie: oper })).status, 401);
    assert.equal((await P.request('POST', '/api/login', { body: { username: 'op.one', password: pw.oper } })).status, 403);
  });

  it('making someone a portal admin gives them Admin in every app', async () => {
    const r = await P.request('POST', '/api/admin/users/view.one', { cookie: admin, body: { isAdmin: true } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.user.apps, { camp: 'admin', manpower: 'admin', costing: 'admin' });
  });

  it('a reset password works once and forces a new password', async () => {
    const r = await P.request('POST', '/api/admin/users/view.one', { cookie: admin, body: { resetPassword: true } });
    const c = await P.login('view.one', r.json.tempPassword);
    assert.equal((await P.request('GET', '/api/me', { cookie: c })).json.mustChange, true);
    assert.equal((await P.request('POST', '/api/login', { body: { username: 'view.one', password: pw.viewer } })).status, 401);
  });

  it('5 wrong passwords lock an account for 15 minutes', async () => {
    await P.request('POST', '/api/admin/users', { cookie: admin, body: { username: 'lock.test', apps: { camp: 'viewer' } } });
    for (let i = 0; i < 5; i++) await P.request('POST', '/api/login', { body: { username: 'lock.test', password: `bad-${i}-xxxx` } });
    const r = await P.request('POST', '/api/login', { body: { username: 'lock.test', password: 'whatever-x' } });
    assert.equal(r.status, 429);
  });

  it('deleting a user removes their sessions', async () => {
    const r = await P.request('DELETE', '/api/admin/users/lock.test', { cookie: admin });
    assert.equal(r.status, 200);
    const users = (await P.request('GET', '/api/admin/users', { cookie: admin })).json;
    assert.ok(!users.some(u => u.username === 'lock.test'));
    assert.ok(users.every(u => !('passwordHash' in u)), 'password hashes are never sent to the browser');
  });

  it('the activity log records the important events', async () => {
    const actions = new Set((await P.request('GET', '/api/admin/audit', { cookie: admin })).json.map(a => a.action));
    for (const a of ['login', 'login-failed', 'change-denied', 'user-create', 'user-update', 'user-delete', 'import', 'file-upload', 'backup-create', 'backup-download', 'create-first-admin']) {
      assert.ok(actions.has(a), a);
    }
  });
});
