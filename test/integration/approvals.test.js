'use strict';
/**
 * Camp: Operator -> Admin approval workflow, end to end on PostgreSQL.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Patch = require('../../src/domain/patch');
const { testDatabaseUrl, wipeDatabase, startPortal, ADMIN_PASSWORD } = require('./harness');
const { campDoc } = require('../fixtures/data');

const URL_ = testDatabaseUrl();
const bedPath = (rid, bi, f) => ['campData', 'A', 'rooms', rid, 'beds', bi, f];

describe('Camp approval workflow (PostgreSQL)', () => {
  let P, admin, op1, op2, rev;

  async function data(cookie) { return (await P.request('GET', '/api/apps/camp/data', { cookie })).json; }
  async function patch(cookie, ops) {
    const r = await P.request('POST', '/api/apps/camp/patch', { cookie, body: { baseRev: rev, ops } });
    if (r.json && r.json.rev) rev = r.json.rev;
    return r;
  }
  async function operator(username) {
    const c = await P.request('POST', '/api/admin/users', { cookie: admin, body: { username, name: username.toUpperCase(), apps: { camp: 'operator' } } });
    let cookie = await P.login(username, c.json.tempPassword);
    await P.request('POST', '/api/me/password', { cookie, body: { oldPassword: c.json.tempPassword, newPassword: `${username}-password` } });
    cookie = await P.login(username, `${username}-password`);
    return cookie;
  }

  before(async () => {
    await wipeDatabase(URL_);
    P = await startPortal(URL_);
    admin = await P.login('admin', ADMIN_PASSWORD);
    // live data saved before this feature: no approvals list, no approvalCfg (= approval ON)
    const doc = campDoc();
    delete doc.approvalCfg;
    const r = await P.request('POST', '/api/apps/camp/patch', { cookie: admin, body: { baseRev: 0, ops: Patch.diff({}, doc) } });
    rev = r.json.rev;
    op1 = await operator('op.one');
    op2 = await operator('op.two');
  });
  after(async () => { if (P) await P.close(); });

  it('approval is on by default: an Operator cannot change a bed directly', async () => {
    const r = await patch(op1, [{ o: 's', p: bedPath('A-1', 0, 'name'), v: 'Direct' }]);
    assert.equal(r.status, 403);
    assert.match(r.json.error, /Admin approval is switched on/);
  });

  let reqId;
  it('an Operator sends a request; the server stamps their real account and creates the list', async () => {
    reqId = 'RTEST1';
    const req = {
      id: reqId, ts: new Date().toISOString(), by: 'Pretend Admin', byUser: 'admin', status: 'approved', seen: true, title: 'Check In',
      changes: [{ type: 'bed', bk: 'A', rid: 'A-1', bi: 0, before: { status: 'vacant', name: '' }, after: { status: 'occupied', name: 'New Person', company: 'ALPHA CO' } }],
      hist: [{ id: 'h-new', action: 'Check In', name: 'New Person', block: 'A', room: 'A-1', date: '2026-11-25' }],
    };
    const r = await patch(op1, [{ o: 'ai', p: ['approvals'], v: req, at: 0, after: null }]);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.reload, true, 'the browser reloads because the server corrected the name/status');
    const saved = (await data(admin)).doc.approvals.find(x => x.id === reqId);
    assert.deepEqual([saved.by, saved.byUser, saved.status], ['OP.ONE', 'op.one', 'pending']);
    const bed = (await data(admin)).doc.campData.A.rooms['A-1'].beds[0];
    assert.equal(bed.name, '', 'nothing changed in the camp yet');
  });

  it("another Operator cannot withdraw or touch someone else's request; the owner can mark it read", async () => {
    let r = await patch(op2, [{ o: 's', p: ['approvals', { id: reqId }, 'status'], v: 'withdrawn' }]);
    assert.equal(r.status, 403);
    r = await patch(op1, [{ o: 's', p: ['approvals', { id: reqId }, 'status'], v: 'approved' }]);
    assert.equal(r.status, 403, 'an Operator cannot approve');
  });

  it('the Admin approves: beds, log and request change together, stamped with the Admin', async () => {
    const d = await data(admin);
    const req = d.doc.approvals.find(x => x.id === reqId);
    const now = new Date().toISOString();
    const ops = [
      ...Object.entries(req.changes[0].after).map(([k, v]) => ({ o: 's', p: bedPath('A-1', 0, k), v })),
      { o: 'ai', p: ['historyLog'], v: Object.assign({}, req.hist[0], { approvedBy: 'Administrator', requestId: reqId }), at: 0, after: null },
      { o: 's', p: ['approvals', { id: reqId }, 'status'], v: 'approved' },
      { o: 's', p: ['approvals', { id: reqId }, 'decidedAt'], v: now },
      { o: 's', p: ['approvals', { id: reqId }, 'decidedBy'], v: 'Someone' },
      { o: 's', p: ['approvals', { id: reqId }, 'seen'], v: false },
    ];
    const r = await patch(admin, ops);
    assert.equal(r.status, 200, r.text);
    const after = (await data(admin)).doc;
    assert.equal(after.campData.A.rooms['A-1'].beds[0].name, 'New Person');
    assert.ok(after.historyLog.some(e => e.id === 'h-new' && e.requestId === reqId));
    const decided = after.approvals.find(x => x.id === reqId);
    assert.equal(decided.status, 'approved');
    assert.equal(decided.decidedBy, 'Administrator', 'the server wrote the real Admin name');
  });

  it('the owner marks the decision as read; others cannot', async () => {
    assert.equal((await patch(op2, [{ o: 's', p: ['approvals', { id: reqId }, 'seen'], v: true }])).status, 403);
    assert.equal((await patch(op1, [{ o: 's', p: ['approvals', { id: reqId }, 'seen'], v: true }])).status, 200);
  });

  it('only an Admin can switch approval off; then Operators change beds directly again', async () => {
    assert.equal((await patch(op1, [{ o: 's', p: ['approvalCfg'], v: { enabled: false } }])).status, 403);
    assert.equal((await patch(admin, [{ o: 's', p: ['approvalCfg'], v: { enabled: false } }])).status, 200);
    const r = await patch(op1, [{ o: 's', p: bedPath('A-2', 0, 'notes'), v: 'direct ok' }]);
    assert.equal(r.status, 200, r.text);
  });

  it('automatic approval: the change applies at once and is recorded as approved, with no page reload', async () => {
    const now = new Date().toISOString();
    // exactly what the browser sends (camp-approvals.js apRecordAutomatic)
    const hist = { id: 'h-auto', action: 'Check In', name: 'Auto Person', block: 'A', room: 'A-1', date: '2026-11-27', approvedBy: 'Automatic approval', approvedAt: now, requestId: 'RAUTO1', requestedBy: 'OP.ONE' };
    const req = {
      id: 'RAUTO1', ts: now, by: 'OP.ONE', byUser: 'op.one', status: 'approved', auto: true, decidedBy: 'Automatic approval', decidedAt: now, seen: true,
      changes: [{ type: 'bed', bk: 'A', rid: 'A-1', bi: 0, before: { status: 'vacant' }, after: { status: 'occupied', name: 'Auto Person' } }],
      hist: [hist], title: 'Check In', impact: { occ: 1, res: 0, vac: -1 },
    };
    const r = await patch(op1, [
      { o: 's', p: bedPath('A-1', 0, 'status'), v: 'occupied' },
      { o: 's', p: bedPath('A-1', 0, 'name'), v: 'Auto Person' },
      { o: 'ai', p: ['historyLog'], v: hist, at: 0, after: null },
      { o: 'ai', p: ['approvals'], v: req, at: 0, after: null },
    ]);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.reload, false, 'the server writes the same stamps as the browser');
    const d = (await data(admin)).doc;
    assert.equal(d.campData.A.rooms['A-1'].beds[0].name, 'Auto Person');
    const saved = d.approvals.find(x => x.id === 'RAUTO1');
    assert.deepEqual([saved.status, saved.auto, saved.decidedBy, saved.byUser], ['approved', true, 'Automatic approval', 'op.one']);
    assert.ok(d.historyLog.some(e => e.id === 'h-auto' && e.approvedBy === 'Automatic approval'));
  });

  it('automatic approval: the record is always in the real account and cannot claim an Admin decision', async () => {
    const r = await patch(op2, [{ o: 'ai', p: ['approvals'], v: {
      id: 'RAUTO2', ts: new Date().toISOString(), by: 'Portal Admin', byUser: 'admin', status: 'rejected', decidedBy: 'Portal Admin', decidedAt: '2001-01-01T00:00:00.000Z', note: 'x', seen: false,
      changes: [{ type: 'bed', bk: 'A', rid: 'A-2', bi: 0, before: {}, after: {} }], hist: [],
    }, at: 0, after: null }]);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.reload, true);
    const saved = (await data(admin)).doc.approvals.find(x => x.id === 'RAUTO2');
    assert.deepEqual([saved.by, saved.byUser, saved.status, saved.decidedBy, saved.auto, saved.seen, saved.note],
      ['OP.TWO', 'op.two', 'approved', 'Automatic approval', true, true, undefined]);
    assert.ok(Math.abs(Date.parse(saved.decidedAt) - Date.now()) < 60000, 'an old decision time is replaced by the server time');
  });

  it('back to Admin approval: Operator records wait again and cannot be sent as automatic', async () => {
    assert.equal((await patch(admin, [{ o: 's', p: ['approvalCfg'], v: { enabled: true } }])).status, 200);
    assert.equal((await patch(op1, [{ o: 's', p: bedPath('A-2', 0, 'name'), v: 'Direct' }])).status, 403);
    const r = await patch(op1, [{ o: 'ai', p: ['approvals'], v: {
      id: 'RAUTO3', ts: new Date().toISOString(), by: 'OP.ONE', byUser: 'op.one', status: 'approved', auto: true, decidedBy: 'Automatic approval', decidedAt: new Date().toISOString(), seen: true, changes: [], hist: [],
    }, at: 0, after: null }]);
    assert.equal(r.status, 200, r.text);
    const saved = (await data(admin)).doc.approvals.find(x => x.id === 'RAUTO3');
    assert.deepEqual([saved.status, saved.auto, saved.decidedBy], ['pending', undefined, undefined]);
  });

  it('a log record an Admin deletes is kept in the deleted list (counted as Deleted)', async () => {
    const d = (await data(admin)).doc;
    const victim = d.historyLog.find(e => e.id === 'h1');
    const r = await patch(admin, [{ o: 'ad', p: ['historyLog'], id: 'h1' }, { o: 'ai', p: ['deletedLog'], v: Object.assign({}, victim, { deletedAt: new Date().toISOString() }), at: 0, after: null }]);
    assert.equal(r.status, 200, r.text);
    const after = (await data(admin)).doc;
    assert.ok(!after.historyLog.some(e => e.id === 'h1'));
    assert.equal(after.deletedLog[0].id, 'h1');
    assert.equal((await patch(op1, [{ o: 'ai', p: ['deletedLog'], v: { id: 'fake' }, at: 0, after: null }])).status, 403);
  });

  it('everything survives a restart', async () => {
    const beforeDoc = P.container.documents.get('camp');
    await P.close();
    P = await startPortal(URL_);
    const now = P.container.documents.get('camp');
    assert.equal(now.rev, beforeDoc.rev);
    assert.deepEqual(now.doc.approvals, beforeDoc.doc.approvals);
    assert.deepEqual(now.doc.deletedLog, beforeDoc.doc.deletedLog);
  });
});
