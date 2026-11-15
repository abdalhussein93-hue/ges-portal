'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Patch = require('../../src/domain/patch');

const clone = v => JSON.parse(JSON.stringify(v));

function sample() {
  return {
    campData: {
      A: { rooms: { 'A-1': { capacity: 2, beds: [{ status: 'vacant', name: '' }, { status: 'occupied', name: 'Ali' }] }, 'A-2': { capacity: 1, beds: [{ status: 'vacant' }] } } },
      B: { rooms: { 'B-1': { capacity: 1, beds: [{ status: 'vacant' }] } } },
    },
    historyLog: [{ id: 'h3', action: 'Check In' }, { id: 'h2', action: 'Check Out' }, { id: 'h1', action: 'Check In' }],
    companies: ['ALPHA', 'BETA', 'GAMMA'],
  };
}

function roundtrip(a, b) {
  const ops = Patch.diff(a, b);
  const c = clone(a);
  Patch.apply(c, ops);
  assert.deepEqual(c, b);
  return ops;
}

test('no change produces no operations', () => {
  assert.deepEqual(Patch.diff(sample(), sample()), []);
});

test('one field change produces one small operation', () => {
  const b = sample();
  b.campData.A.rooms['A-1'].beds[0].name = 'New Person';
  const ops = roundtrip(sample(), b);
  assert.equal(ops.length, 1);
  assert.deepEqual(ops[0], { o: 's', p: ['campData', 'A', 'rooms', 'A-1', 'beds', 0, 'name'], v: 'New Person' });
});

test('records with ids are merged by id (insert / delete / edit)', () => {
  const b = sample();
  b.historyLog.unshift({ id: 'h4', action: 'Check In' });
  b.historyLog.splice(2, 1); // remove h2
  b.historyLog[1].action = 'Edited';
  const ops = roundtrip(sample(), b);
  assert.deepEqual(ops.map(o => o.o).sort(), ['ad', 'ai', 's']);
});

test('lists of names are merged as sets; sorting alone is not a change', () => {
  const b = sample();
  b.companies = ['GAMMA', 'BETA', 'ALPHA'];
  assert.deepEqual(Patch.diff(sample(), b), []);
  b.companies.push('DELTA');
  const ops = Patch.diff(sample(), b);
  assert.deepEqual(ops, [{ o: 'pi', p: ['companies'], v: 'DELTA', at: 3 }]);
});

test('arrays that change length (room capacity) are replaced whole', () => {
  const b = sample();
  b.campData.A.rooms['A-2'].beds.push({ status: 'vacant' });
  const ops = roundtrip(sample(), b);
  assert.equal(ops[0].o, 's');
  assert.deepEqual(ops[0].p, ['campData', 'A', 'rooms', 'A-2', 'beds']);
});

test('two people changing different records: both changes are kept', () => {
  const base = sample();
  const one = sample(); one.campData.A.rooms['A-1'].beds[0].name = 'One'; one.historyLog.unshift({ id: 'x1' });
  const two = sample(); two.campData.B.rooms['B-1'].beds[0].name = 'Two'; two.historyLog.unshift({ id: 'x2' });
  const server = clone(base);
  Patch.apply(server, Patch.diff(base, one));
  Patch.apply(server, Patch.diff(base, two));
  assert.equal(server.campData.A.rooms['A-1'].beds[0].name, 'One');
  assert.equal(server.campData.B.rooms['B-1'].beds[0].name, 'Two');
  assert.ok(server.historyLog.some(e => e.id === 'x1') && server.historyLog.some(e => e.id === 'x2'));
});

test('applying the same change twice changes nothing more', () => {
  const b = sample(); b.historyLog.unshift({ id: 'h9' }); b.companies.push('ZETA'); b.campData.A.rooms['A-1'].beds[0].name = 'Q';
  const ops = Patch.diff(sample(), b);
  const c = sample();
  Patch.apply(c, ops); Patch.apply(c, ops);
  assert.deepEqual(c, b);
});

test('a change to a deleted room is skipped and reported, never half re-created', () => {
  const doc = sample();
  delete doc.campData.A.rooms['A-1'];
  const conflicts = [];
  Patch.apply(doc, [{ o: 's', p: ['campData', 'A', 'rooms', 'A-1', 'beds', 0, 'name'], v: 'x' }], conflicts);
  assert.equal(doc.campData.A.rooms['A-1'], undefined);
  assert.equal(conflicts.length, 1);
});

test('a different record with an already used id is reported as a conflict', () => {
  const doc = sample();
  const conflicts = [];
  Patch.apply(doc, [{ o: 'ai', p: ['historyLog'], v: { id: 'h1', action: 'Different' }, at: 0, after: null }], conflicts);
  assert.equal(conflicts.length, 1);
  assert.equal(doc.historyLog.length, 3);
  const none = [];
  Patch.apply(doc, [{ o: 'ai', p: ['historyLog'], v: { id: 'h1', action: 'Check In' }, at: 0, after: null }], none);
  assert.equal(none.length, 0, 'an identical repeat is not a conflict');
});

test('values are copied, not shared', () => {
  const doc = { a: {} };
  const v = { x: 1 };
  Patch.apply(doc, [{ o: 's', p: ['a', 'b'], v }]);
  v.x = 2;
  assert.equal(doc.a.b.x, 1);
});
