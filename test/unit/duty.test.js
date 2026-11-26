'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const apps = require('../../src/domain/apps');

const duty = apps.get('duty');
const head = { username: 'kitchen.head', scopes: { duty: { depts: ['K'] } } };
const doc = () => ({
  version: 3, camp: 'Camp Roster', activeDept: 'S',
  depts: [{ id: 'K', name: 'Kitchen', staff: [{ id: 's1', name: 'A', duties: [] }] }, { id: 'S', name: 'Service', staff: [] }],
});

test('duty: a department head only receives their own departments; the current department is personal', () => {
  const out = duty.filterDoc(doc(), 'operator', head);
  assert.deepEqual(out.depts.map(d => d.id), ['K']);
  assert.equal(out.activeDept, undefined);
  const all = duty.filterDoc(doc(), 'admin', { username: 'admin' });
  assert.deepEqual(all.depts.map(d => d.id), ['K', 'S']);
  assert.equal(all.activeDept, undefined);
  assert.deepEqual(duty.filterDoc(doc(), 'viewer', { username: 'x' }).depts, [], 'no departments given = sees none');
});

test('duty: a department head changes only inside their departments', () => {
  const P = (op) => duty.checkPermission('operator', op, { user: head });
  assert.equal(P({ o: 's', p: ['depts', { id: 'K' }, 'staff', { id: 's1' }, 'name'], v: 'B' }), null);
  assert.equal(P({ o: 'ai', p: ['depts', { id: 'K' }, 'staff'], v: { id: 's2' } }), null);
  assert.match(P({ o: 's', p: ['depts', { id: 'S' }, 'name'], v: 'x' }), /not been given/);
  assert.match(P({ o: 'ai', p: ['depts'], v: { id: 'N' } }), /add, delete/);
  assert.match(P({ o: 'ad', p: ['depts'], id: 'K' }), /add, delete/);
  assert.match(P({ o: 's', p: ['camp'], v: 'x' }), /camp name/);
  assert.match(P({ o: 's', p: ['depts', { id: 'K' }, 'id'], v: 'Z' }), /department id/);
  assert.ok(duty.checkPermission('viewer', { o: 's', p: ['depts', { id: 'K' }, 'name'], v: 'x' }, { user: head }));
  assert.equal(duty.checkPermission('admin', { o: 'ad', p: ['depts'], id: 'S' }, { user: { username: 'admin' } }), null);
});

test('duty: live changes to other departments are not sent to a department head', () => {
  const ops = [
    { o: 's', p: ['depts', { id: 'S' }, 'name'], v: 'Secret' },
    { o: 's', p: ['depts', { id: 'K' }, 'name'], v: 'Kitchen 2' },
    { o: 'ai', p: ['depts'], v: { id: 'S2', name: 'New' } },
    { o: 'ad', p: ['depts'], id: 'K' },
    { o: 's', p: ['depts'], v: [{ id: 'K' }, { id: 'S' }] },
    { o: 's', p: ['activeDept'], v: 'S' },
  ];
  const out = duty.filterOps(ops, 'operator', head);
  assert.deepEqual(out, [
    { o: 's', p: ['depts', { id: 'K' }, 'name'], v: 'Kitchen 2' },
    { o: 'ad', p: ['depts'], id: 'K' },
    { o: 's', p: ['depts'], v: [{ id: 'K' }] },
  ]);
});

test('duty: the current department is never stored from a browser', () => {
  const r = duty.prepareOps('admin', { username: 'admin' }, [{ o: 's', p: ['activeDept'], v: 'S' }, { o: 's', p: ['camp'], v: 'X' }]);
  assert.deepEqual(r.ops, [{ o: 's', p: ['camp'], v: 'X' }]);
});

test('duty: imports accept the desktop file and reject others', () => {
  const d = duty.importDocument(doc());
  assert.equal(d.activeDept, undefined);
  assert.equal(d.depts.length, 2);
  assert.throws(() => duty.importDocument({ staff: [] }), /not a Duty Board/);
  assert.throws(() => duty.importDocument({ depts: [{ id: 'A' }, { id: 'A' }] }), /same id/);
});

test('duty: home page shows what a person can open', () => {
  assert.equal(duty.scopeLabel(doc(), 'operator', head), 'Kitchen');
  assert.equal(duty.scopeLabel(doc(), 'admin', {}), 'All departments');
  assert.equal(duty.scopeLabel(doc(), 'viewer', { username: 'x' }), 'No department assigned yet');
});
