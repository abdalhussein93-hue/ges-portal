'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cleanValue, isSafeKey } = require('../../src/domain/text');
const { validateOp, cleanOps } = require('../../src/domain/operations');
const KV = require('../../src/domain/kv');
const apps = require('../../src/domain/apps');
const { atLeast } = require('../../src/domain/roles');

const camp = apps.get('camp');
const manpower = apps.get('manpower');
const costing = apps.get('costing');

test('strict cleaning neutralises everything that can break out of HTML or onclick handlers', () => {
  const r = cleanValue({ a: '<img src=x onerror=alert(1)>', b: "x');alert(1);//", c: '&#39;);x', d: 'say "hi" `x`', ok: 'AL-NASR 2' }, 'strict');
  assert.ok(r.changed);
  for (const v of Object.values(r.value)) assert.ok(!/[<>"']/.test(v), v);
  assert.equal(r.value.ok, 'AL-NASR 2');
  assert.ok(!r.value.c.includes('&#'));
});

test('strict cleaning never deletes text: characters are swapped for look-alikes', () => {
  const r = cleanValue({ a: "Cote d'Ivoire", b: 'PIPE 12" <A&B> `ok`', c: 'Tom &amp; Jerry' }, 'strict');
  assert.equal(r.value.a, 'Cote d’Ivoire');
  assert.equal(r.value.b, 'PIPE 12” ‹A&B› `ok`');
  assert.equal(r.value.c, 'Tom ＆amp; Jerry');
  for (const k of Object.keys(r.value)) assert.equal(r.value[k].length, { a: "Cote d'Ivoire", b: 'PIPE 12" <A&B> `ok`', c: 'Tom &amp; Jerry' }[k].length, 'same length: nothing removed');
});

test('markup cleaning keeps quotes and apostrophes, swaps < and >', () => {
  const r = cleanValue({ a: "O'Brien 12\" <b>", n: 5 }, 'markup');
  assert.equal(r.value.a, "O'Brien 12\" ‹b›");
  assert.equal(r.value.n, 5);
});

test('dangerous object keys are dropped', () => {
  const r = cleanValue(JSON.parse('{"__proto__": {"x": 1}, "ok": 1}'), 'strict');
  assert.deepEqual(Object.keys(r.value), ['ok']);
  assert.ok(r.changed);
  assert.equal(isSafeKey('constructor'), false);
});

test('operation shape validation', () => {
  assert.equal(validateOp({ o: 's', p: ['campData', 'A'], v: 1 }, camp), null);
  assert.match(validateOp({ o: 'x', p: ['campData'] }, camp), /unknown operation/);
  assert.match(validateOp({ o: 's', p: [] , v: 1 }, camp), /missing path/);
  assert.match(validateOp({ o: 's', p: ['nope'], v: 1 }, camp), /unknown section/);
  assert.match(validateOp({ o: 's', p: ['campData', '__proto__'], v: 1 }, camp), /invalid name/);
  assert.match(validateOp({ o: 's', p: ['campData', -1], v: 1 }, camp), /bad index/);
  assert.match(validateOp({ o: 's', p: ['campData'] }, camp), /missing value/);
  assert.equal(validateOp({ o: 's', p: ['keys', 'gesStaffV4', 'j', { id: 5 }, 'name'], v: 'x' }, manpower), null);
  assert.match(validateOp({ o: 's', p: ['campData'], v: 1 }, manpower), /unknown section/);
  assert.equal(validateOp({ o: 's', p: ['months', '2026-11'], v: {} }, costing), null);
});

test('cleanOps cleans values and reports it', () => {
  const r = cleanOps([{ o: 's', p: ['a'], v: '<x>' }, { o: 'ad', p: ['h'], id: 'z' }], 'strict');
  assert.equal(r.ops[0].v, '‹x›');
  assert.equal(r.ops[1].id, 'z');
  assert.ok(r.changed);
});

test('camp: operator may check in/out, edit room size, bathrooms, housekeeping', () => {
  const ok = [
    { o: 's', p: ['campData', 'A', 'rooms', 'A-1', 'beds', 0, 'name'], v: 'x' },
    { o: 'ai', p: ['historyLog'], v: { id: 'n' } },
    { o: 's', p: ['campData', 'A', 'rooms', 'A-1', 'L'], v: 4 },
    { o: 's', p: ['campData', '_bathrooms', 'A'], v: [] },
    { o: 's', p: ['campData', '_hkc', 'Global Village'], v: {} },
  ];
  for (const op of ok) assert.equal(camp.checkPermission('operator', op), null, JSON.stringify(op.p));
});

test('camp: operator may not change structure, lists, money or delete records', () => {
  const denied = [
    { o: 's', p: ['BLOCKS_META', 'Z'], v: {} },
    { o: 'pi', p: ['companies'], v: 'X' },
    { o: 's', p: ['campData', 'A', 'rooms', 'A-1', 'beds'], v: [] },
    { o: 's', p: ['campData', 'A', 'rooms', 'A-1', 'capacity'], v: 3 },
    { o: 'd', p: ['campData', 'A', 'rooms', 'A-1'] },
    { o: 'd', p: ['campData', 'A'] },
    { o: 'ad', p: ['historyLog'], id: 'h1' },
    { o: 's', p: ['campData', '_profit', 'x'], v: 1 },
    { o: 's', p: ['campList'], v: [] },
    { o: 's', p: ['appSeeds'], v: [] },
  ];
  for (const op of denied) assert.ok(camp.checkPermission('operator', op), JSON.stringify(op.p));
  assert.ok(camp.checkPermission('viewer', { o: 's', p: ['campData', 'A', 'rooms', 'A-1', 'beds', 0, 'name'], v: 'x' }));
  assert.equal(camp.checkPermission('admin', denied[0]), null);
});

test('camp: location profit is hidden from non-admins', () => {
  const doc = { campData: { A: {}, _profit: { x: 1 } } };
  assert.equal(camp.filterDoc(doc, 'operator').campData._profit, undefined);
  assert.ok(doc.campData._profit, 'the original is not modified');
  assert.ok(camp.filterDoc(doc, 'admin').campData._profit);
  assert.deepEqual(camp.filterOps([{ o: 's', p: ['campData', '_profit', 'a'], v: 1 }], 'viewer'), []);
});

test('camp: normalise gives every log record a unique id', () => {
  const doc = { historyLog: [{ id: 'a' }, { id: 'a' }, {}] };
  assert.deepEqual(camp.normalise(doc), ['historyLog']);
  assert.equal(new Set(doc.historyLog.map(e => e.id)).size, 3);
  assert.deepEqual(camp.normalise(doc), []);
});

test('manpower and costing: viewers read only, operators and admins edit', () => {
  for (const app of [manpower, costing]) {
    assert.ok(app.checkPermission('viewer', {}));
    assert.equal(app.checkPermission('operator', {}), null);
    assert.equal(app.checkPermission('admin', {}), null);
  }
});

test('imports accept the desktop files and reject others with a clear message', () => {
  assert.ok(camp.importDocument({ campData: {}, historyLog: [] }).campData);
  assert.throws(() => camp.importDocument({ foo: 1 }), /not the Camp Management/);
  const mp = manpower.importDocument({ app: 'GES Manpower System', data: { gesStaffV4: '[{"id":1}]', gesCampName: 'GES CAMP' } });
  assert.deepEqual(mp, { keys: { gesStaffV4: { j: [{ id: 1 }] }, gesCampName: { s: 'GES CAMP' } } });
  assert.throws(() => manpower.importDocument({ staff: [] }), /Restore it inside/);
  assert.ok(costing.importDocument({ items: [], groups: [], months: {} }));
  assert.throws(() => costing.importDocument({ items: [] }), /not a Daily Costing/);
});

test('kv: storage text <-> document round trip', () => {
  const mem = { a: '[1,2]', b: 'plain text', c: '30', d: 'true', e: '{"x":"y"}', f: '' };
  const doc = KV.toDoc(mem);
  assert.deepEqual(doc.keys.b, { s: 'plain text' });
  assert.deepEqual(doc.keys.c, { j: 30 });
  assert.deepEqual(KV.toMem(doc), mem);
});

test('roles order', () => {
  assert.ok(atLeast('admin', 'operator'));
  assert.ok(!atLeast('viewer', 'operator'));
  assert.ok(!atLeast(undefined, 'viewer'));
});
