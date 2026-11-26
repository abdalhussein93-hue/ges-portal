'use strict';
/**
 * Daily Costing: confirming a day, change requests and Admin approval, end to end (PostgreSQL).
 * Changes are made the way the browser makes them: edit a copy of the data, send the difference.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Patch = require('../../src/domain/patch');
const { testDatabaseUrl, wipeDatabase, startPortal, ADMIN_PASSWORD } = require('./harness');
const { costingDoc } = require('../fixtures/data');

const URL_ = testDatabaseUrl();

describe('Daily Costing day confirmation (PostgreSQL)', () => {
  let P, admin, cook;
  const load = async c => (await P.request('GET', '/api/apps/costing/data', { cookie: c })).json;
  /** Like the browser: change a copy, send the difference. */
  async function edit(c, change) {
    const { rev, doc } = await load(c);
    const copy = Patch.clone(doc);
    change(copy);
    const r = await P.request('POST', '/api/apps/costing/patch', { cookie: c, body: { baseRev: rev, ops: Patch.diff(doc, copy) } });
    return r;
  }
  const server = () => P.container.documents.get('costing').doc;

  before(async () => {
    await wipeDatabase(URL_);
    P = await startPortal(URL_);
    admin = await P.login('admin', ADMIN_PASSWORD);
    const r = await P.request('POST', '/api/apps/costing/patch', { cookie: admin, body: { baseRev: 0, ops: Patch.diff({}, costingDoc()) } });
    assert.equal(r.status, 200, r.text);
    const c = await P.request('POST', '/api/admin/users', { cookie: admin, body: { username: 'cook', name: 'Cook One', apps: { costing: 'operator' } } });
    let ck = await P.login('cook', c.json.tempPassword);
    await P.request('POST', '/api/me/password', { cookie: ck, body: { oldPassword: c.json.tempPassword, newPassword: 'cook-pass-123' } });
    cook = await P.login('cook', 'cook-pass-123');
  });
  after(async () => { if (P) await P.close(); });

  it('older data gets the new sections without being changed', async () => {
    const d = (await load(cook)).doc;
    assert.deepEqual(d.dayLocks, {});
    assert.deepEqual(d.dayRequests, []);
    assert.equal('dayLocks' in server(), false);
  });

  it('the Operator enters a day and confirms it', async () => {
    let r = await edit(cook, d => { d.months['2026-11'].cons['5'] = { i0: { g_sen: 3 } }; d.months['2026-11'].received['5'] = { i0: 10 }; });
    assert.equal(r.status, 200, r.text);
    r = await edit(cook, d => { d.dayLocks['2026-11-05'] = { by: 'Cook One', byUser: 'cook', at: new Date().toISOString() }; });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.reload, false, 'no page reload after confirming');
    assert.equal(server().dayLocks['2026-11-05'].byUser, 'cook');
  });

  it('a confirmed day cannot be changed by the Operator, other days can', async () => {
    let r = await edit(cook, d => { d.months['2026-11'].cons['5'].i0.g_sen = 30; });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /confirmed/);
    r = await edit(cook, d => { delete d.months['2026-11'].received['5']; });
    assert.equal(r.status, 403);
    r = await edit(cook, d => { d.dayLocks = {}; });
    assert.equal(r.status, 403, 'cannot unlock');
    r = await edit(cook, d => { d.months['2026-11'].cons['6'] = { i0: { g_sen: 1 } }; });
    assert.equal(r.status, 200, r.text);
    assert.equal(server().months['2026-11'].cons['5'].i0.g_sen, 3);
    assert.equal(server().months['2026-11'].received['5'].i0, 10);
  });

  it('the Operator sends a change request; nothing changes until the Admin approves', async () => {
    const r = await edit(cook, d => {
      d.dayRequests.push({ id: 'req1', day: '2026-11-05', by: 'Cook One', byUser: 'cook', at: new Date().toISOString(), reason: 'typed 3 instead of 4',
        status: 'pending', seen: true, changes: [{ s: 'cons', i: 'i0', g: 'g_sen', from: 3, to: 4 }, { s: 'received', i: 'i0', from: 10, to: 12 }] });
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.reload, false, 'no page reload after sending');
    assert.equal(server().dayRequests[0].status, 'pending');
    assert.equal(server().months['2026-11'].cons['5'].i0.g_sen, 3);
    // the Operator cannot approve it
    const self = await edit(cook, d => { d.dayRequests[0].status = 'approved'; });
    assert.equal(self.status, 403);
  });

  it('the Admin approves: the figures are written into the day', async () => {
    const r = await edit(admin, d => {
      const m = d.months['2026-11'];
      m.cons['5'].i0.g_sen = 4; m.received['5'].i0 = 12;
      Object.assign(d.dayRequests[0], { status: 'approved', decidedAt: new Date().toISOString(), decidedBy: 'Portal Admin' });
    });
    assert.equal(r.status, 200, r.text);
    const s = server();
    assert.equal(s.months['2026-11'].cons['5'].i0.g_sen, 4);
    assert.equal(s.months['2026-11'].received['5'].i0, 12);
    assert.equal(s.dayRequests[0].status, 'approved');
    assert.ok(s.dayRequests[0].decidedBy);
    assert.ok(s.dayLocks['2026-11-05'], 'the day stays confirmed');
  });

  it('a request is decided only once', async () => {
    const r = await edit(admin, d => { d.dayRequests[0].status = 'rejected'; });
    assert.equal(r.status, 403);
    assert.equal(server().dayRequests[0].status, 'approved');
  });

  it('an approval applies the figures even if the browser did not', async () => {
    await edit(cook, d => {
      d.dayRequests.push({ id: 'req2', day: '2026-11-05', by: 'Cook One', byUser: 'cook', at: new Date().toISOString(), reason: 'one more',
        status: 'pending', seen: true, changes: [{ s: 'cons', i: 'i0', g: 'g_sen', from: 4, to: 0 }] });
    });
    const r = await edit(admin, d => { d.dayRequests.find(x => x.id === 'req2').status = 'approved'; });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.reload, true);
    assert.deepEqual(server().months['2026-11'].cons['5'], { i0: {} });
  });

  it('the Operator withdraws a request; the Admin unlocks a day', async () => {
    await edit(cook, d => {
      d.dayRequests.push({ id: 'req3', day: '2026-11-05', by: 'Cook One', byUser: 'cook', at: new Date().toISOString(), reason: 'x',
        status: 'pending', seen: true, changes: [{ s: 'received', i: 'i0', from: 12, to: 1 }] });
    });
    let r = await edit(cook, d => { Object.assign(d.dayRequests.find(x => x.id === 'req3'), { status: 'withdrawn', decidedAt: new Date().toISOString() }); });
    assert.equal(r.status, 200, r.text);
    r = await edit(admin, d => { delete d.dayLocks['2026-11-05']; });
    assert.equal(r.status, 200, r.text);
    r = await edit(cook, d => { d.months['2026-11'].received['5'].i0 = 13; });
    assert.equal(r.status, 200, 'an unlocked day is open again');
    assert.equal(server().months['2026-11'].received['5'].i0, 13);
  });

  it('the Costing page loads the day confirmation script', async () => {
    const page = await P.request('GET', '/costing/', { cookie: cook });
    assert.equal(page.status, 200);
    assert.match(page.text, /\/shared\/costing-days\.js/);
    const js = await P.request('GET', '/shared/costing-days.js', { cookie: cook });
    assert.equal(js.status, 200);
  });
});
