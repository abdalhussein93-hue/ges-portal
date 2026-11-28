'use strict';
/**
 * Dining Halls Management end to end on PostgreSQL: gate scans decided by the server,
 * one meal per person, permissions, reports, exports, letting in again and old backups.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Patch = require('../../src/domain/patch');
const { testDatabaseUrl, wipeDatabase, startPortal, ADMIN_PASSWORD } = require('./harness');

const URL_ = testDatabaseUrl();
// camp time is UTC+4: 08:00 in camp = 04:00Z
const at = (day, hhmm) => new Date(`${day}T${hhmm}:00+04:00`);

function setupDoc() {
  return {
    version: 1, nextBarcode: 1001, companies: ['ACME', 'BETA'],
    settings: { entryRule: 'meal', lunchFrom: 11, dinnerFrom: 17, allowUnregistered: true },
    people: [
      { id: 'p1', name: 'Ali Senior', company: 'ACME', room: 'S-1', hall: 'Senior', barcode: 'MH00001', allowed: true },
      { id: 'p2', name: 'Bob Worker', company: 'BETA', room: 'W-2', hall: 'Worker1', barcode: 'MH00002', allowed: true },
      { id: 'p3', name: 'Carl Blocked', company: 'BETA', room: 'W-3', hall: 'Worker1', barcode: 'MH00003', allowed: false },
    ],
  };
}

describe('Dining Halls Management (PostgreSQL)', () => {
  let P, admin, guard, guard2, viewer;
  const setClock = d => { P.container.dining.now = () => d; };
  const scan = (cookie, hall, barcode, decision) => P.request('POST', '/api/dining/scan', { cookie, body: { hall, barcode, decision } });

  async function account(username, roleName) {
    const c = await P.request('POST', '/api/admin/users', { cookie: admin, body: { username, name: username.toUpperCase(), apps: { dining: roleName } } });
    const first = await P.login(username, c.json.tempPassword);
    await P.request('POST', '/api/me/password', { cookie: first, body: { oldPassword: c.json.tempPassword, newPassword: `${username}-password` } });
    return P.login(username, `${username}-password`);
  }

  before(async () => {
    await wipeDatabase(URL_);
    P = await startPortal(URL_);
    admin = await P.login('admin', ADMIN_PASSWORD);
    guard = await account('gate.one', 'operator');
    guard2 = await account('gate.two', 'operator');
    viewer = await account('boss', 'viewer');
  });
  after(async () => { if (P) await P.close(); });

  it('before the Admin sets it up, scanning is refused with a clear message', async () => {
    const r = await scan(guard, 'Senior', 'MH00001');
    assert.equal(r.status, 409);
    assert.match(r.json.error, /not been set up/);
  });

  it('the Admin sets up people and cards; a guard cannot change them', async () => {
    let r = await P.request('POST', '/api/apps/dining/patch', { cookie: admin, body: { baseRev: 0, ops: Patch.diff({}, setupDoc()) } });
    assert.equal(r.status, 200, r.text);
    r = await P.request('POST', '/api/apps/dining/patch', { cookie: guard, body: { baseRev: r.json.rev, ops: [{ o: 's', p: ['people', { id: 'p3' }, 'allowed'], v: true }] } });
    assert.equal(r.status, 403);
    assert.equal((await P.request('GET', '/dining/', { cookie: guard })).status, 200, 'the page is served');
  });

  it('a person gets in once per meal; a second scan is refused at every gate', async () => {
    setClock(at('2026-11-27', '08:00'));
    let r = await scan(guard, 'Senior', ' mh00001 ');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.result, 'allowed');
    assert.equal(r.json.meal, 'Breakfast');
    assert.equal(r.json.person.name, 'Ali Senior');
    assert.deepEqual(r.json.counts.byHall, { Senior: 1 });
    r = await scan(guard2, 'Senior', 'MH00001');
    assert.equal(r.json.result, 'denied');
    assert.equal(r.json.code, 'already');
    assert.ok(r.json.previousAt, 'says when they entered');
    setClock(at('2026-11-27', '12:30'));
    r = await scan(guard2, 'Senior', 'MH00001');
    assert.equal(r.json.result, 'allowed', 'lunch is a new meal');
  });

  it('wrong dining hall and blocked people are refused', async () => {
    let r = await scan(guard, 'Junior', 'MH00002');
    assert.equal(r.json.code, 'wrong-hall');
    assert.match(r.json.reason, /Worker 1/);
    r = await scan(guard, 'Worker1', 'MH00003');
    assert.equal(r.json.code, 'blocked');
  });

  it('two gates scanning the same card at the same moment let it in only once', async () => {
    setClock(at('2026-11-27', '18:00'));
    const both = await Promise.all([scan(guard, 'Worker1', 'MH00002'), scan(guard2, 'Worker1', 'MH00002'), scan(guard, 'Worker1', 'MH00002')]);
    const results = both.map(r => r.json.result).sort();
    assert.deepEqual(results, ['allowed', 'denied', 'denied']);
  });

  it('a card nobody holds: the guard decides, and it is still one entry per meal', async () => {
    let r = await scan(guard, 'Junior', 'MH00500');
    assert.equal(r.json.result, 'unregistered');
    assert.equal(r.json.canAllow, true);
    const before = (await P.request('GET', '/api/dining/scans?from=2026-11-27&to=2026-11-27&q=MH00500', { cookie: viewer })).json.rows.length;
    assert.equal(before, 0, 'nothing is recorded until the guard decides');
    r = await scan(guard, 'Junior', 'MH00500', 'allow');
    assert.equal(r.json.code, 'manual-allow');
    r = await scan(guard2, 'Junior', 'MH00500', 'allow');
    assert.equal(r.json.code, 'already');
    r = await scan(guard2, 'Junior', 'MH00777', 'deny');
    assert.equal(r.json.code, 'manual-deny');
    const rows = (await P.request('GET', '/api/dining/scans?from=2026-11-27&to=2026-11-27&q=MH00777', { cookie: viewer })).json.rows;
    assert.deepEqual(rows.map(x => [x.status, x.scannedBy]), [['denied', 'gate.two']]);
  });

  it('viewers cannot scan; guards cannot let people in again; bad input is refused', async () => {
    assert.equal((await scan(viewer, 'Senior', 'MH00001')).status, 403);
    assert.equal((await P.request('POST', '/api/dining/release', { cookie: guard, body: {} })).status, 403);
    assert.equal((await scan(guard, 'Kitchen', 'MH00001')).status, 400);
    assert.equal((await scan(guard, 'Senior', '')).status, 400);
    assert.equal((await scan(guard, 'Senior', 'MH00500', 'maybe')).status, 400);
  });

  it('the Admin lets people in again: the earlier meal stays counted', async () => {
    let r = await scan(guard, 'Worker1', 'MH00002');
    assert.equal(r.json.code, 'already');
    r = await P.request('POST', '/api/dining/release', { cookie: admin, body: { hall: 'Worker1' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.released, 1);
    r = await scan(guard, 'Worker1', 'MH00002');
    assert.equal(r.json.result, 'allowed');
    assert.equal(r.json.counts.byHall.Worker1, 2);
  });

  it('switching off unregistered cards and to one entry per day is enforced by the server', async () => {
    const { rev } = (await P.request('GET', '/api/apps/dining/data', { cookie: admin })).json;
    const r = await P.request('POST', '/api/apps/dining/patch', { cookie: admin, body: { baseRev: rev, ops: [{ o: 's', p: ['settings'], v: { entryRule: 'day', lunchFrom: 11, dinnerFrom: 17, allowUnregistered: false } }] } });
    assert.equal(r.status, 200, r.text);
    assert.equal((await scan(guard, 'Junior', 'MH00900', 'allow')).status, 403);
    assert.equal((await scan(admin, 'Junior', 'MH00900', 'allow')).json.result, 'allowed', 'an Admin still can');
    setClock(at('2026-11-28', '08:00'));
    assert.equal((await scan(guard, 'Senior', 'MH00001')).json.result, 'allowed');
    setClock(at('2026-11-28', '13:00'));
    assert.equal((await scan(guard, 'Senior', 'MH00001')).json.code, 'already', 'once per day');
  });

  it('today, records, report and the CSV export add up', async () => {
    setClock(at('2026-11-27', '20:00'));
    const t = (await P.request('GET', '/api/dining/today', { cookie: viewer })).json;
    assert.equal(t.day, '2026-11-27');
    assert.deepEqual(t.counts.byHall, { Senior: 2, Worker1: 2, Junior: 2 });
    const rep = (await P.request('GET', '/api/dining/report?from=2026-11-27&to=2026-11-28', { cookie: viewer })).json;
    const meals = rep.daily.reduce((a, x) => a + x.n, 0);
    assert.equal(meals, 7);
    assert.ok(rep.daily.some(x => x.day === '2026-11-27' && x.meal === 'Lunch' && x.hall === 'Senior' && x.n === 1));
    assert.ok(rep.byCompany.some(x => x.company === 'BETA' && x.hall === 'Worker1' && x.n === 2));
    const page1 = (await P.request('GET', '/api/dining/scans?from=2026-11-27&to=2026-11-28&limit=3', { cookie: viewer })).json;
    assert.equal(page1.rows.length, 3); assert.equal(page1.more, true);
    const page2 = (await P.request('GET', `/api/dining/scans?from=2026-11-27&to=2026-11-28&limit=200&beforeId=${page1.rows[2].id}`, { cookie: viewer })).json;
    assert.ok(page2.rows.every(r => r.id < page1.rows[2].id));
    const csv = await P.request('GET', '/api/dining/scans.csv?from=2026-11-27&to=2026-11-28', { cookie: viewer });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-disposition'), /dining_scans_2026-11-27_to_2026-11-28\.csv/);
    const lines = csv.text.trim().split('\r\n');
    assert.equal(lines.length, 1 + page1.rows.length + page2.rows.length);
    assert.match(lines[0], /Date,Time,Meal/);
    assert.equal((await P.request('GET', '/api/dining/report?from=2026-11-28&to=2026-11-27', { cookie: viewer })).status, 400);
  });

  it("the old app's backups are brought in once; the setup can be taken from one of them", async () => {
    const t1 = Date.parse('2026-10-01T05:00:00Z'), t2 = Date.parse('2026-10-01T09:00:00Z');
    const phone1 = { version: 1, barcodePool: [], companies: ['GAMMA'],
      people: [{ id: 11, name: 'Old Worker', company: 'GAMMA', room: 'X-1', category: 'Worker', barcode: 'MH00010', allowed: true }],
      entryLog: [{ barcode: 'MH00010', name: 'Old Worker', company: 'GAMMA', mess: 'Worker', status: 'allowed', note: 'Allowed', time: t1, scannedBy: 'Security 1' }] };
    const phone2 = { version: 1, people: [], companies: [],
      entryLog: [phone1.entryLog[0], { barcode: 'MH00010', name: 'Old Worker', company: 'GAMMA', mess: 'Worker', status: 'allowed', note: 'Allowed', time: t2, scannedBy: 'Security 2' }] };
    assert.equal((await P.request('POST', '/api/dining/import', { cookie: guard, body: { files: [{ name: 'a.json', content: phone1 }] } })).status, 403);
    let r = await P.request('POST', '/api/dining/import', { cookie: admin, body: { files: [{ name: 'phone1.json', content: phone1 }, { name: 'phone2.json', content: phone2 }], setupFrom: -1 } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.json.records, r.json.added, r.json.skipped], [3, 2, 1], 'the same record on two phones is added once');
    r = await P.request('POST', '/api/dining/import', { cookie: admin, body: { files: [{ name: 'phone2.json', content: phone2 }] } });
    assert.equal(r.json.added, 0, 'importing again adds nothing');
    r = await P.request('POST', '/api/dining/import', { cookie: admin, body: { files: [{ name: 'phone1.json', content: phone1 }], setupFrom: 0 } });
    assert.equal(r.json.people, 1);
    const doc = P.container.documents.get('dining').doc;
    assert.deepEqual(doc.people.map(p => [p.name, p.hall]), [['Old Worker', 'Worker1']]);
    assert.equal(doc.settings.entryRule, 'day', 'the settings already chosen are kept');
    const old = (await P.request('GET', '/api/dining/scans?from=2026-10-01&to=2026-10-01', { cookie: admin })).json.rows;
    assert.deepEqual(old.map(x => x.source), ['import', 'import']);
    assert.equal((await P.request('POST', '/api/dining/import', { cookie: admin, body: { files: [{ name: 'x.json', content: { foo: 1 } }] } })).status, 400);
    // imported records never stop anybody from coming in now
    setClock(at('2026-10-01', '09:30'));
    assert.equal((await scan(guard, 'Worker1', 'MH00010')).json.result, 'allowed');
  });

  it('the scans are kept after a restart', async () => {
    const before = (await P.request('GET', '/api/dining/scans?from=2026-10-01&to=2026-11-30&limit=200', { cookie: admin })).json.rows.length;
    await P.close();
    P = await startPortal(URL_);
    const cookie = await P.login('admin', ADMIN_PASSWORD);
    const now = (await P.request('GET', '/api/dining/scans?from=2026-10-01&to=2026-11-30&limit=200', { cookie })).json.rows.length;
    assert.equal(now, before);
  });
});
