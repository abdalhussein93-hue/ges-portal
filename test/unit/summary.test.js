'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../src/services/summary');

const GV = 'Global Village', AF = 'AL FARAH';

test('summary: Camp Management numbers per camp (beds, today\'s movements, approvals)', () => {
  const doc = {
    BLOCKS_META: { A: { name: 'A' }, F: { name: 'F', camp: AF } },
    campData: {
      A: { rooms: { a1: { beds: [{ status: 'occupied' }, { status: 'vacant' }] }, a2: { beds: [{ status: 'reserved' }, {}] } } },
      F: { rooms: { f1: { beds: [{ status: 'occupied' }] } } },
    },
    historyLog: [
      { action: 'Check In', block: 'A', date: '2026-11-28' }, { action: 'Check Out', block: 'A', date: '2026-11-28' },
      { action: 'Check In', block: 'A', date: '2026-11-27' }, { action: 'Check In', block: 'F', date: '2026-11-28' },
      { action: 'Transfer', camp: AF, date: '2026-11-28' },
    ],
    approvals: [{ status: 'pending', changes: [{ bk: 'A' }] }, { status: 'approved', changes: [{ bk: 'A' }] }, { status: 'pending', changes: [{ bk: 'F' }] }],
  };
  assert.deepEqual(S.campNumbers(doc, GV, '2026-11-28'),
    { blocks: 1, beds: 4, occupied: 1, reserved: 1, vacant: 2, checkIns: 1, checkOuts: 1, transfers: 0, pendingApprovals: 1, occupancy: 25 });
  const af = S.campNumbers(doc, AF, '2026-11-28');
  assert.deepEqual([af.beds, af.occupied, af.checkIns, af.transfers, af.pendingApprovals, af.occupancy], [1, 1, 1, 1, 1, 100]);
  assert.equal(S.campNumbers(null, GV, '2026-11-28'), null);
});

test('summary: Daily Costing today - not started, in progress, confirmed', () => {
  const doc = { months: { '2026-11': { cons: {}, received: {} } }, dayLocks: { '2026-11-20': { by: 'Cook' } }, dayRequests: [{ status: 'pending' }, { status: 'approved' }] };
  let r = S.costingNumbers(doc, '2026-11-28');
  assert.deepEqual([r.today, r.itemsToday, r.pendingRequests, r.lastConfirmed], ['not started', 0, 1, '2026-11-20']);
  doc.months['2026-11'].cons['28'] = { i1: { g: 2 }, i2: { g: 0 } };
  doc.months['2026-11'].received['28'] = { i3: 5 };
  r = S.costingNumbers(doc, '2026-11-28');
  assert.deepEqual([r.today, r.itemsToday], ['in progress', 2]);
  doc.dayLocks['2026-11-28'] = { by: 'Head Cook' };
  r = S.costingNumbers(doc, '2026-11-28');
  assert.deepEqual([r.today, r.confirmedBy], ['confirmed', 'Head Cook']);
  doc.months['2026-11'].cons = { '05': { i1: { g: 1 } } };
  assert.equal(S.costingNumbers(doc, '2026-11-05').itemsToday, 1, 'day keys may be padded');
});

test('summary: Manpower and Duty Board', () => {
  assert.deepEqual(S.manpowerNumbers({ keys: { gesStaffV4: { j: [{ status: 'Active' }, { status: 'Resigned' }, { status: 'active' }] } } }), { total: 3, active: 2 });
  assert.equal(S.manpowerNumbers({ keys: {} }), null);
  assert.deepEqual(S.dutyNumbers({ depts: [{ staff: [1, 2] }, { staff: [3] }, {}] }), { depts: 3, staff: 3 });
  assert.equal(S.dutyNumbers(null), null);
});
