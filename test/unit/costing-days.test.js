'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const apps = require('../../src/domain/apps');

const costing = apps.get('costing');
const oper = { username: 'cook', name: 'Cook One' };
const other = { username: 'cook2', name: 'Cook Two' };
const admin = { username: 'boss', name: 'Boss' };
const LOCK = { by: 'Cook One', byUser: 'cook', at: '2026-11-05T10:00:00.000Z' };

function doc() {
  return {
    items: [{ id: 'i0' }], groups: [{ id: 'g_sen' }],
    months: { '2026-11': { opening: {}, cons: { 5: { i0: { g_sen: 3 } }, 6: { i0: { g_sen: 1 } } }, received: { 5: { i0: 10 } }, manday: {} } },
    dayLocks: { '2026-11-05': LOCK },
    dayRequests: [{ id: 'r1', day: '2026-11-05', byUser: 'cook', by: 'Cook One', status: 'pending', changes: [{ s: 'cons', i: 'i0', g: 'g_sen', from: 3, to: 4 }] }],
  };
}
const check = (role, op, user = oper, d = doc()) => costing.checkPermission(role, op, { doc: d, user });

test('costing days: an Operator cannot change a confirmed day, in any way', () => {
  assert.match(check('operator', { o: 's', p: ['months', '2026-11', 'cons', '5', 'i0', 'g_sen'], v: 9 }), /Day 5\/11\/2026 is confirmed/);
  assert.match(check('operator', { o: 'd', p: ['months', '2026-11', 'received', '5', 'i0'] }), /confirmed/);
  assert.match(check('operator', { o: 's', p: ['months', '2026-11', 'cons', '05'], v: {} }), /confirmed/, 'padded day key');
  assert.match(check('operator', { o: 'd', p: ['months', '2026-11', 'cons'] }), /confirmed/, 'whole section');
  assert.match(check('operator', { o: 's', p: ['months', '2026-11'], v: { cons: {}, received: { 5: { i0: 10 } } } }), /confirmed/, 'whole month');
  assert.match(check('operator', { o: 's', p: ['months'], v: {} }), /confirmed/, 'all months');
});

test('costing days: other days and other figures stay open', () => {
  assert.equal(check('operator', { o: 's', p: ['months', '2026-11', 'cons', '6', 'i0', 'g_sen'], v: 2 }), null);
  assert.equal(check('operator', { o: 's', p: ['months', '2026-11', 'manday', '5'], v: { cc: 3 } }), null);
  assert.equal(check('operator', { o: 's', p: ['months', '2026-11', 'opening', 'i0'], v: 4 }), null);
  assert.equal(check('operator', { o: 's', p: ['items', { id: 'i0' }, 'desc'], v: 'X' }), null);
  // replacing a month without touching the confirmed day's figures
  const d = doc();
  const month = JSON.parse(JSON.stringify(d.months['2026-11']));
  month.cons['6'] = { i0: { g_sen: 7 } };
  assert.equal(check('operator', { o: 's', p: ['months', '2026-11'], v: month }), null);
  // nothing confirmed: everything open
  const open = doc(); open.dayLocks = {};
  assert.equal(check('operator', { o: 'd', p: ['months', '2026-11'] }, oper, open), null);
});

test('costing days: Operators confirm days but cannot unlock them; Admins can do both', () => {
  assert.equal(check('operator', { o: 's', p: ['dayLocks', '2026-11-06'], v: {} }), null);
  assert.match(check('operator', { o: 's', p: ['dayLocks', '2026-11-05'], v: {} }), /unlock or change/);
  assert.match(check('operator', { o: 'd', p: ['dayLocks', '2026-11-05'] }), /unlock or change/);
  assert.match(check('operator', { o: 's', p: ['dayLocks'], v: {} }), /unlock or change/);
  assert.match(check('operator', { o: 's', p: ['dayLocks', 'tomorrow'], v: {} }), /unlock or change/);
  assert.equal(check('operator', { o: 's', p: ['dayLocks'], v: { '2026-11-05': LOCK, '2026-11-06': {} } }), null);
  assert.equal(check('admin', { o: 'd', p: ['dayLocks', '2026-11-05'] }, admin), null);
  assert.equal(check('admin', { o: 's', p: ['months', '2026-11', 'cons', '5', 'i0', 'g_sen'], v: 9 }, admin), null);
  assert.match(check('viewer', { o: 's', p: ['dayLocks', '2026-11-06'], v: {} }), /only view/);
});

test('costing days: change requests', () => {
  const ok = { id: 'r2', day: '2026-11-05', changes: [{ s: 'cons', i: 'i0', g: 'g_sen', to: 5 }, { s: 'received', i: 'i0', to: 0 }] };
  assert.equal(check('operator', { o: 'ai', p: ['dayRequests'], v: ok }), null);
  assert.match(check('operator', { o: 'ai', p: ['dayRequests'], v: Object.assign({}, ok, { day: '2026-11-06' }) }), /not confirmed/);
  assert.match(check('operator', { o: 'ai', p: ['dayRequests'], v: Object.assign({}, ok, { changes: [] }) }), /no changes/);
  assert.match(check('operator', { o: 'ai', p: ['dayRequests'], v: Object.assign({}, ok, { changes: [{ s: 'cons', i: 'i0', to: 5 }] }) }), /invalid line/);
  assert.match(check('operator', { o: 'ai', p: ['dayRequests'], v: Object.assign({}, ok, { changes: [{ s: 'manday', i: 'i0', to: 5 }] }) }), /invalid line/);
  assert.match(check('operator', { o: 'ai', p: ['dayRequests'], v: Object.assign({}, ok, { changes: [{ s: 'received', i: 'i0', to: -1 }] }) }), /invalid quantity/);
  assert.match(check('operator', { o: 'ad', p: ['dayRequests'], id: 'r1' }), /replace or delete/);
  // own request: withdraw, mark as read; never approve
  const r1 = { id: 'r1' };
  assert.equal(check('operator', { o: 's', p: ['dayRequests', r1, 'status'], v: 'withdrawn' }), null);
  assert.equal(check('operator', { o: 's', p: ['dayRequests', r1, 'seen'], v: true }), null);
  assert.match(check('operator', { o: 's', p: ['dayRequests', r1, 'status'], v: 'approved' }), /approve or reject/);
  assert.match(check('operator', { o: 's', p: ['dayRequests', r1, 'changes'], v: [] }), /approve or reject/);
  assert.match(check('operator', { o: 's', p: ['dayRequests', r1, 'status'], v: 'withdrawn' }, other), /another person/);
  // Admin decides a request once, only while it waits
  assert.equal(check('admin', { o: 's', p: ['dayRequests', r1, 'status'], v: 'approved' }, admin), null);
  const decided = doc(); decided.dayRequests[0].status = 'withdrawn';
  assert.match(check('admin', { o: 's', p: ['dayRequests', r1, 'status'], v: 'approved' }, admin, decided), /already withdrawn or decided/);
});

test('costing days: the server writes who, when and the current figures', () => {
  const d = doc();
  const at = new Date().toISOString();
  let r = costing.prepareOps('operator', oper, [{ o: 's', p: ['dayLocks', '2026-11-06'], v: { by: 'Someone else', byUser: 'x', at } }], d);
  assert.deepEqual(r.ops[0].v, { by: 'Cook One', byUser: 'cook', at });
  assert.equal(r.changed, true);
  r = costing.prepareOps('operator', oper, [{ o: 's', p: ['dayLocks', '2026-11-06'], v: { by: 'Cook One', byUser: 'cook', at } }], d);
  assert.equal(r.changed, false, 'what a correct browser sends is kept as is');
  r = costing.prepareOps('operator', oper, [{ o: 's', p: ['dayLocks', '2026-11-06'], v: { by: 'Cook One', byUser: 'cook', at: '2020-01-01T00:00:00.000Z' } }], d);
  assert.notEqual(r.ops[0].v.at, '2020-01-01T00:00:00.000Z', 'a wrong clock is replaced');

  r = costing.prepareOps('operator', oper, [{ o: 'ai', p: ['dayRequests'], v: {
    id: 'r2', day: '2026-11-05', by: 'x', byUser: 'x', at, reason: 'typo', status: 'approved', decidedBy: 'x',
    changes: [{ s: 'cons', i: 'i0', g: 'g_sen', from: 99, to: 5 }, { s: 'received', i: 'i0', from: 0, to: 0 }],
  } }], d);
  assert.deepEqual(r.ops[0].v, {
    id: 'r2', day: '2026-11-05', by: 'Cook One', byUser: 'cook', at, reason: 'typo', status: 'pending', seen: true,
    changes: [{ s: 'cons', i: 'i0', g: 'g_sen', from: 3, to: 5 }, { s: 'received', i: 'i0', from: 10, to: 0 }],
  });
  assert.equal(r.changed, true);

  // data saved before this feature: the sections are created first
  const old = doc(); delete old.dayLocks; delete old.dayRequests;
  r = costing.prepareOps('operator', oper, [{ o: 's', p: ['dayLocks', '2026-11-06'], v: {} }], old);
  assert.deepEqual(r.ops[0], { o: 's', p: ['dayLocks'], v: {} });
  assert.deepEqual(costing.filterDoc(old).dayRequests, []);
  assert.deepEqual(costing.filterDoc(old).dayLocks, {});
});

test('costing days: an approved request always reaches the figures', () => {
  const d = doc();
  const decision = [{ o: 's', p: ['dayRequests', { id: 'r1' }, 'status'], v: 'approved' }, { o: 's', p: ['dayRequests', { id: 'r1' }, 'decidedBy'], v: 'Boss' }];
  // the browser did not apply the figures: the server adds them
  let r = costing.prepareOps('admin', admin, decision, d);
  assert.deepEqual(r.ops.filter(o => o.p[0] === 'months'), [{ o: 's', p: ['months', '2026-11', 'cons', '5', 'i0', 'g_sen'], v: 4 }]);
  assert.equal(r.changed, true);
  // the browser applied them (as it does): nothing extra, no reload
  r = costing.prepareOps('admin', admin, decision.concat({ o: 's', p: ['months', '2026-11', 'cons', '5', 'i0', 'g_sen'], v: 4 }), d);
  assert.equal(r.ops.filter(o => o.p[0] === 'months').length, 1);
  assert.equal(r.changed, false);
  // a rejected request changes nothing
  r = costing.prepareOps('admin', admin, [{ o: 's', p: ['dayRequests', { id: 'r1' }, 'status'], v: 'rejected' }], d);
  assert.equal(r.ops.filter(o => o.p[0] === 'months').length, 0);
});

test('costing days: approving writes cells like the app does', () => {
  const month = { cons: { 5: { i0: { g_sen: 3, g_jun: 1 } } }, received: {} };
  costing.applyChanges(month, { day: '2026-11-05', changes: [
    { s: 'cons', i: 'i0', g: 'g_sen', to: 0 }, { s: 'cons', i: 'i1', g: 'g_sen', to: 2 }, { s: 'received', i: 'i0', to: 6 }] });
  assert.deepEqual(month, { cons: { 5: { i0: { g_jun: 1 }, i1: { g_sen: 2 } } }, received: { 5: { i0: 6 } } });
  const empty = {};
  costing.applyChanges(empty, { day: '2026-11-09', changes: [{ s: 'received', i: 'i0', to: 1 }] });
  assert.deepEqual(empty, { received: { 9: { i0: 1 } } });
});
