'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Camps = require('../../src/domain/camps');
const Scope = require('../../src/domain/camp-scope');
const apps = require('../../src/domain/apps');

const camp = apps.get('camp');
const GV = 'Global Village', AF = 'Alfarah Asab';

function doc() {
  return {
    campList: [GV, AF],
    BLOCKS_META: { A: { name: 'A' }, AF1: { name: 'AF1', camp: AF } },
    campData: {
      A: { rooms: { 'A-1': { beds: [{ status: 'vacant' }] } } },
      AF1: { rooms: { 'AF1-1': { beds: [{ status: 'vacant' }] } } },
      ORPHAN: { rooms: {} },
      _bathrooms: { A: [1], AF1: [2] },
      _hkc: { [GV]: { staff: [1] }, [AF]: { staff: [2] } },
      _housekeeping: { old: true },
      _profit: { [GV]: { x: 1 }, [AF]: { x: 2 } },
    },
    historyLog: [{ id: 'h1', block: 'A' }, { id: 'h2', block: 'AF1' }, { id: 'h3', camp: AF }, { id: 'h4' }],
    deletedLog: [{ id: 'd1', block: 'AF1' }],
    approvals: [{ id: 'r1', changes: [{ bk: 'A' }] }, { id: 'r2', changes: [{ bk: 'AF1' }] }],
    companies: ['ACME'],
  };
}
const alfarahOnly = { username: 'af', isAdmin: false, campAccess: { all: false, ids: ['alfarah'], names: [AF] } };
const portalAdmin = { username: 'boss', isAdmin: true, campAccess: { all: true, ids: ['gv', 'alfarah'], names: [GV, AF] } };

test('camps: data keys keep the first camp where the data always was', () => {
  assert.equal(Camps.docKey('costing', 'gv'), 'costing');
  assert.equal(Camps.docKey('costing', 'alfarah'), 'costing~alfarah');
  assert.deepEqual(Camps.parseKey('costing~alfarah'), { appId: 'costing', campId: 'alfarah' });
  assert.deepEqual(Camps.parseKey('costing'), { appId: 'costing', campId: 'gv' });
  assert.equal(Camps.newId('Alfarah Asab', new Set()), 'alfarah-asab');
  assert.equal(Camps.newId('DYCC', new Set(['dycc'])), 'dycc-2');
  assert.match(Camps.nameProblem('<b>'), /cannot contain/);
  assert.equal(Camps.nameProblem('New Camp 2'), null);
  const list = [{ id: 'gv', name: GV }, { id: 'alfarah', name: AF }];
  assert.deepEqual(Camps.accessFor({ isAdmin: false, camps: ['alfarah', 'gone'] }, list).names, [AF]);
  assert.equal(Camps.accessFor({ isAdmin: true, camps: [] }, list).ids.length, 2, 'portal admins: every camp');
});

test('camps: Camp Management sends a person only their camps', () => {
  const out = camp.filterDoc(doc(), 'admin', alfarahOnly);
  assert.deepEqual(out.campList, [AF]);
  assert.deepEqual(Object.keys(out.BLOCKS_META), ['AF1']);
  assert.deepEqual(Object.keys(out.campData).sort(), ['AF1', '_bathrooms', '_hkc', '_profit']);
  assert.deepEqual(Object.keys(out.campData._bathrooms), ['AF1']);
  assert.deepEqual(Object.keys(out.campData._hkc), [AF]);
  assert.deepEqual(Object.keys(out.campData._profit), [AF]);
  assert.deepEqual(out.historyLog.map(e => e.id), ['h2', 'h3']);
  assert.deepEqual(out.deletedLog.map(e => e.id), ['d1']);
  assert.deepEqual(out.approvals.map(r => r.id), ['r2']);
  assert.deepEqual(out.companies, ['ACME'], 'shared lists stay');
  const all = camp.filterDoc(doc(), 'admin', portalAdmin);
  assert.equal(Object.keys(all.BLOCKS_META).length, 2);
  assert.equal(all.historyLog.length, 4);
  // a portal camp missing from the app's own list is still offered in the camp switcher
  const old = Object.assign(doc(), { campList: [GV] });
  assert.deepEqual(camp.filterDoc(old, 'admin', portalAdmin).campList, [GV, AF]);
  assert.deepEqual(camp.filterDoc(old, 'admin', alfarahOnly).campList, [AF]);
  assert.deepEqual(old.campList, [GV], 'the stored data is not changed');
});

test('camps: a person can only change their own camps in Camp Management', () => {
  const d = doc();
  const check = (op, ops) => camp.checkPermission('admin', op, { doc: d, user: alfarahOnly, ops: ops || [op], campNames: [GV, AF] });
  assert.equal(check({ o: 's', p: ['campData', 'AF1', 'rooms', 'AF1-1', 'beds', 0, 'status'], v: 'occupied' }), null);
  assert.match(check({ o: 's', p: ['campData', 'A', 'rooms', 'A-1', 'beds', 0, 'status'], v: 'occupied' }), /another camp/);
  assert.match(check({ o: 'd', p: ['campData', 'ORPHAN'] }), /another camp/, 'a block with no camp is the first camp');
  assert.match(check({ o: 's', p: ['BLOCKS_META', 'AF1', 'camp'], v: GV }), /another camp/, 'cannot move a block to another camp');
  assert.match(check({ o: 's', p: ['campData'], v: {} }), /every camp/);
  assert.match(check({ o: 's', p: ['historyLog'], v: [] }), /every camp/);
  assert.equal(check({ o: 'ai', p: ['historyLog'], v: { id: 'n1', block: 'AF1' }, at: 0, after: null }), null);
  assert.match(check({ o: 'ai', p: ['historyLog'], v: { id: 'n2', block: 'A' }, at: 0, after: null }), /another camp/);
  assert.match(check({ o: 'ad', p: ['historyLog'], id: 'h1' }), /another camp/);
  assert.match(check({ o: 's', p: ['campData', '_hkc', GV, 'staff'], v: [] }), /another camp/);
  assert.equal(check({ o: 's', p: ['campData', '_hkc', AF, 'staff'], v: [] }), null);
  // a new block in their camp, created in the same save
  const create = [{ o: 's', p: ['BLOCKS_META', 'AF2'], v: { name: 'AF2', camp: AF } }, { o: 's', p: ['campData', 'AF2'], v: { rooms: {} } }];
  assert.equal(check(create[0], create), null);
  assert.equal(check(create[1], create), null);
  const wrong = [{ o: 's', p: ['BLOCKS_META', 'GV9'], v: { name: 'GV9' } }, { o: 's', p: ['campData', 'GV9'], v: { rooms: {} } }];
  assert.match(check(wrong[0], wrong), /another camp/);
  assert.match(check(wrong[1], wrong), /another camp/);
});

test('camps: the camp list is the portal\'s - an app can only add a camp the portal has', () => {
  const d = doc();
  const ctx = user => ({ doc: d, user, campNames: [GV, AF, 'DYCC'] });
  assert.equal(camp.checkPermission('admin', { o: 'pi', p: ['campList'], v: 'DYCC', at: 2 }, ctx(portalAdmin)), null);
  assert.match(camp.checkPermission('admin', { o: 'pi', p: ['campList'], v: 'Made Up', at: 2 }, ctx(portalAdmin)), /Users page/);
  assert.match(camp.checkPermission('admin', { o: 'pd', p: ['campList'], v: AF }, ctx(portalAdmin)), /Users page/, 'no removing');
  assert.match(camp.checkPermission('admin', { o: 's', p: ['campList'], v: [GV, 'Renamed'] }, ctx(portalAdmin)), /Users page/, 'no renaming');
  assert.match(camp.checkPermission('operator', { o: 'pi', p: ['campList'], v: 'DYCC', at: 2 }, ctx(portalAdmin)), /Admin/);
});

test('camps: others\' changes reach a person only for their camps', () => {
  const d = doc();
  const ops = [
    { o: 's', p: ['campData', 'A', 'rooms', 'A-1', 'beds', 0, 'status'], v: 'occupied' },
    { o: 's', p: ['campData', 'AF1', 'rooms', 'AF1-1', 'beds', 0, 'status'], v: 'occupied' },
    { o: 'ai', p: ['historyLog'], v: { id: 'x1', block: 'A' }, at: 0, after: null },
    { o: 'ai', p: ['historyLog'], v: { id: 'x2', block: 'AF1' }, at: 0, after: null },
    { o: 's', p: ['campData', '_hkc', GV], v: {} },
    { o: 'pi', p: ['companies'], v: 'NEW CO', at: 1 },
    { o: 's', p: ['BLOCKS_META'], v: { A: { name: 'A' }, AF1: { name: 'AF1', camp: AF } } },
  ];
  const out = camp.filterOps(ops, 'admin', alfarahOnly, d);
  assert.deepEqual(out.map(o => o.p.slice(0, 2).join('/') + (o.v && o.v.id ? ':' + o.v.id : '')),
    ['campData/AF1', 'historyLog:x2', 'companies', 'BLOCKS_META']);
  assert.deepEqual(Object.keys(out[3].v), ['AF1'], 'a whole block list is cut down too');
  assert.equal(camp.filterOps(ops, 'admin', portalAdmin, d).length, ops.length);
});

test('camps: blocks, records and requests know their camp', () => {
  const d = doc();
  assert.equal(Scope.blockCamp(d, 'A'), GV);
  assert.equal(Scope.blockCamp(d, 'AF1'), AF);
  assert.equal(Scope.blockCamp(d, 'NOPE'), null);
  assert.equal(Scope.recordCamp(d, { block: 'AF1' }), AF);
  assert.equal(Scope.recordCamp(d, { camp: AF, block: 'A' }), AF, 'a record\'s own camp wins');
  assert.equal(Scope.recordCamp(d, { block: 'deleted-block' }), GV);
  assert.deepEqual(Scope.requestCamps(d, { changes: [{ bk: 'A' }, { bk: 'AF1' }] }), [GV, AF]);
});
