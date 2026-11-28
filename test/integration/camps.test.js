'use strict';
/**
 * Camps end to end on PostgreSQL: the portal's camp list, the camps each person may use,
 * Camp Management limited per camp, and separate data per camp in the other apps.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Patch = require('../../src/domain/patch');
const { testDatabaseUrl, wipeDatabase, startPortal, ADMIN_PASSWORD } = require('./harness');
const { campDoc, costingDoc } = require('../fixtures/data');

const URL_ = testDatabaseUrl();
const GV = 'Global Village', AF = 'Alfarah Asab';

function twoCampDoc() {
  const d = campDoc();
  d.campList = [GV, AF];
  d.BLOCKS_META.AF1 = { name: 'Alfarah 1', defaultCap: 1, camp: AF };
  d.campData.AF1 = { rooms: { 'AF1-1': { number: 'AF1-1', category: 'Worker', capacity: 1, beds: [{ status: 'vacant', name: '' }] } } };
  d.campData._profit[AF] = { rates: {}, items: [], entries: [] };
  d.historyLog.push({ id: 'h3', action: 'Check In', name: 'Alfarah Person', block: 'AF1', room: 'AF1-1' });
  return d;
}

describe('Camps (PostgreSQL)', () => {
  let P, admin, afOp, gvView, nobody;
  const get = (cookie, p) => P.request('GET', p, { cookie });
  async function account(username, apps, camps) {
    const c = await P.request('POST', '/api/admin/users', { cookie: admin, body: { username, name: username.toUpperCase(), apps, camps } });
    assert.equal(c.status, 200, c.text);
    const first = await P.login(username, c.json.tempPassword);
    await P.request('POST', '/api/me/password', { cookie: first, body: { oldPassword: c.json.tempPassword, newPassword: `${username}-password` } });
    return P.login(username, `${username}-password`);
  }
  async function patch(cookie, path, ops) {
    const { rev } = (await get(cookie, path.replace('/patch', '/data'))).json;
    return P.request('POST', path, { cookie, body: { baseRev: rev, ops } });
  }

  before(async () => {
    await wipeDatabase(URL_);
    P = await startPortal(URL_);
    admin = await P.login('admin', ADMIN_PASSWORD);
    const r = await P.request('POST', '/api/apps/camp/patch', { cookie: admin, body: { baseRev: 0, ops: Patch.diff({}, twoCampDoc()) } });
    assert.equal(r.status, 200, r.text);
    afOp = await account('af.op', { camp: 'operator', costing: 'admin', dining: 'admin' }, ['alfarah']);
    gvView = await account('gv.view', { camp: 'viewer', costing: 'viewer' }, ['gv']);
    nobody = await account('no.camp', { camp: 'viewer', costing: 'viewer' }, []);
  });
  after(async () => { if (P) await P.close(); });

  it('the portal starts with Global Village and Alfarah Asab; each person sees their camps', async () => {
    assert.deepEqual((await get(admin, '/api/admin/camps')).json, [{ id: 'gv', name: GV }, { id: 'alfarah', name: AF }]);
    assert.deepEqual((await get(afOp, '/api/me')).json.camps, [{ id: 'alfarah', name: AF }]);
    assert.equal((await get(admin, '/api/me')).json.allCamps, true);
    assert.equal((await get(gvView, '/api/admin/camps')).status, 403, 'only portal admins manage camps');
  });

  it('Camp Management: an Alfarah person gets only Alfarah', async () => {
    const d = (await get(afOp, '/api/apps/camp/data')).json.doc;
    assert.deepEqual(d.campList, [AF]);
    assert.deepEqual(Object.keys(d.BLOCKS_META), ['AF1']);
    assert.deepEqual(Object.keys(d.campData).filter(k => k[0] !== '_'), ['AF1']);
    assert.deepEqual(d.historyLog.map(e => e.id), ['h3']);
    const v = (await get(gvView, '/api/apps/camp/data')).json.doc;
    assert.deepEqual(Object.keys(v.BLOCKS_META).sort(), ['A', 'B']);
    assert.equal((await get(nobody, '/api/apps/camp/data')).status, 403, 'no camp, no data');
  });

  it('Camp Management: changes only in their own camp; others never see them', async () => {
    let r = await patch(afOp, '/api/apps/camp/patch', [{ o: 's', p: ['campData', 'AF1', 'rooms', 'AF1-1', 'beds', 0, 'name'], v: 'Ali' }]);
    assert.equal(r.status, 200, r.text);
    r = await patch(afOp, '/api/apps/camp/patch', [{ o: 's', p: ['campData', 'A', 'rooms', 'A-1', 'beds', 0, 'name'], v: 'Intruder' }]);
    assert.equal(r.status, 403);
    assert.match(r.json.error, /another camp/);
    const feed = (await get(gvView, '/api/apps/camp/changes?since=1')).json.changes;
    assert.ok(feed.every(c => c.ops.length === 0), 'Global Village people never receive the Alfarah change');
    assert.equal(P.container.documents.get('camp').doc.campData.A.rooms['A-1'].beds[0].name, '');
  });

  it('Camp Management: camps cannot be renamed or removed from inside the app', async () => {
    const r = await patch(admin, '/api/apps/camp/patch', [{ o: 'pd', p: ['campList'], v: AF }]);
    assert.equal(r.status, 403);
    assert.match(r.json.error, /Users page/);
  });

  it('other apps: each camp has its own data; the first camp keeps today\'s data', async () => {
    let r = await P.request('POST', '/api/apps/costing/patch', { cookie: admin, body: { baseRev: 0, ops: Patch.diff({}, costingDoc()) } });
    assert.equal(r.status, 200, r.text);
    assert.equal((await get(afOp, '/api/apps/costing/data')).json.camp, 'alfarah', 'their only camp is chosen');
    assert.equal((await get(afOp, '/api/apps/costing/data?camp=alfarah')).json.doc, null, 'Alfarah starts empty');
    assert.equal((await get(afOp, '/api/apps/costing/data?camp=gv')).status, 403);
    const af = costingDoc(); af.settings.lowStock = 99;
    r = await P.request('POST', '/api/apps/costing/patch?camp=alfarah', { cookie: afOp, body: { baseRev: 0, ops: Patch.diff({}, af) } });
    assert.equal(r.status, 200, r.text);
    assert.equal(P.container.documents.get('costing~alfarah').doc.settings.lowStock, 99);
    assert.equal(P.container.documents.get('costing').doc.settings.lowStock, 10, 'Global Village untouched');
    assert.equal((await get(gvView, '/api/apps/costing/data')).json.doc.settings.lowStock, 10);
    assert.equal((await get(nobody, '/api/apps/costing/data')).status, 403);
  });

  it('dining: scans are per camp', async () => {
    const setup = { version: 1, nextBarcode: 1001, companies: [], settings: { entryRule: 'meal', lunchFrom: 11, dinnerFrom: 17, allowUnregistered: true },
      people: [{ id: 'p1', name: 'Same Card', company: '', room: '1', hall: 'Senior', barcode: 'MH00001', allowed: true }] };
    for (const [cookie, q] of [[admin, ''], [afOp, '?camp=alfarah']]) {
      const r = await P.request('POST', '/api/apps/dining/patch' + q, { cookie, body: { baseRev: 0, ops: Patch.diff({}, setup) } });
      assert.equal(r.status, 200, r.text);
    }
    const scan = (cookie, q) => P.request('POST', '/api/dining/scan' + q, { cookie, body: { hall: 'Senior', barcode: 'MH00001' } });
    assert.equal((await scan(admin, '?camp=gv')).json.result, 'allowed');
    assert.equal((await scan(afOp, '?camp=alfarah')).json.result, 'allowed', 'the same card number in another camp is another card');
    assert.equal((await scan(afOp, '?camp=alfarah')).json.code, 'already');
    assert.equal((await scan(afOp, '?camp=gv')).status, 403);
    const af = (await get(afOp, '/api/dining/today?camp=alfarah')).json.counts.total;
    const gv = (await get(admin, '/api/dining/today?camp=gv')).json.counts.total;
    assert.deepEqual([af, gv], [1, 1]);
  });

  it('a portal admin adds a camp: it appears everywhere, empty, and Camp Management lists it', async () => {
    const r = await P.request('POST', '/api/admin/camps', { cookie: admin, body: { name: 'DYCC' } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { id: 'dycc', name: 'DYCC' });
    assert.equal((await P.request('POST', '/api/admin/camps', { cookie: admin, body: { name: 'dycc' } })).status, 400, 'no duplicates');
    assert.ok(P.container.documents.get('camp').doc.campList.includes('DYCC'));
    assert.equal((await get(admin, '/api/apps/costing/data?camp=dycc')).json.doc, null);
    assert.equal((await get(afOp, '/api/apps/costing/data?camp=dycc')).status, 403, 'nobody gets a new camp automatically');
    // give it to the Alfarah person
    const u = await P.request('POST', '/api/admin/users/af.op', { cookie: admin, body: { camps: ['alfarah', 'dycc'] } });
    assert.equal(u.status, 200, u.text);
    const again = await P.login('af.op', 'af.op-password');
    assert.deepEqual((await get(again, '/api/me')).json.camps.map(c => c.id), ['alfarah', 'dycc']);
    assert.equal((await get(again, '/api/apps/costing/data?camp=dycc')).status, 200);
  });

  it('deleting a camp: refused while it has blocks or is the first camp; otherwise hidden, data kept, restorable', async () => {
    let r = await P.request('DELETE', '/api/admin/camps/gv', { cookie: admin });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /first camp/);
    r = await P.request('DELETE', '/api/admin/camps/alfarah', { cookie: admin });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /1 block in Camp Management \(AF1\)/);
    let c = await P.login('af.op', 'af.op-password');
    assert.equal((await P.request('DELETE', '/api/admin/camps/dycc', { cookie: c })).status, 403, 'only portal admins');
    // DYCC: give it some data first
    const d = costingDoc(); d.settings.lowStock = 7;
    assert.equal((await P.request('POST', '/api/apps/costing/patch?camp=dycc', { cookie: admin, body: { baseRev: 0, ops: Patch.diff({}, d) } })).status, 200);
    r = await P.request('DELETE', '/api/admin/camps/dycc', { cookie: admin });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual((await get(admin, '/api/admin/camps')).json.map(c => c.id), ['gv', 'alfarah']);
    assert.deepEqual((await get(admin, '/api/admin/camps/deleted')).json.map(c => [c.id, c.deletedBy]), [['dycc', 'admin']]);
    assert.ok(!P.container.documents.get('camp').doc.campList.includes('DYCC'), 'gone from Camp Management\'s camp switcher');
    c = await P.login('af.op', 'af.op-password');
    assert.deepEqual((await get(c, '/api/me')).json.camps.map(x => x.id), ['alfarah']);
    assert.equal((await get(c, '/api/apps/costing/data?camp=dycc')).status, 403);
    assert.equal(P.container.documents.get('costing~dycc').doc.settings.lowStock, 7, 'nothing erased');
    r = await P.request('POST', '/api/admin/camps', { cookie: admin, body: { name: 'DYCC' } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /deleted camp/);
    // restore: everything back as it was
    r = await P.request('POST', '/api/admin/camps/dycc/restore', { cookie: admin, body: {} });
    assert.equal(r.status, 200, r.text);
    assert.ok(P.container.documents.get('camp').doc.campList.includes('DYCC'));
    assert.deepEqual((await get(c, '/api/me')).json.camps.map(x => x.id), ['alfarah', 'dycc'], 'the same people have it again');
    assert.equal((await get(c, '/api/apps/costing/data?camp=dycc')).json.doc.settings.lowStock, 7);
    // a new camp never gets a deleted camp's id (and data)
    await P.request('DELETE', '/api/admin/camps/dycc', { cookie: admin });
    r = await P.request('POST', '/api/admin/camps', { cookie: admin, body: { name: 'DYCC New' } });
    assert.equal(r.json.id, 'dycc-new');
    await P.request('POST', '/api/admin/camps/dycc/restore', { cookie: admin, body: {} });
  });

  it('per-camp backups and imports on the admin page', async () => {
    const snap = await P.request('POST', '/api/admin/apps/costing/snapshots?camp=alfarah', { cookie: admin, body: { label: 'test' } });
    assert.equal(snap.status, 200, snap.text);
    const list = (await get(admin, '/api/admin/apps/costing/snapshots?camp=alfarah')).json;
    assert.ok(list.some(s => s.id === snap.json.id));
    const exp = await get(admin, '/api/admin/apps/costing/export?camp=alfarah');
    assert.equal(JSON.parse(exp.text).settings.lowStock, 99);
    assert.match(exp.headers.get('content-disposition'), /costing_alfarah_current/);
    assert.equal((await get(admin, '/api/admin/apps/costing/export?camp=nope')).status, 404);
  });

  it('everything survives a restart', async () => {
    await P.close();
    P = await startPortal(URL_);
    assert.equal(P.container.documents.get('costing~alfarah').doc.settings.lowStock, 99);
    assert.ok(P.container.documents.has('costing~dycc'));
    const c = await P.login('af.op', 'af.op-password');
    assert.deepEqual((await get(c, '/api/me')).json.camps.map(x => x.id), ['alfarah', 'dycc']);
  });
});
