'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Dining = require('../../src/domain/dining');
const apps = require('../../src/domain/apps');

const dining = apps.get('dining');

test('dining: days and meals are in camp time (UAE, UTC+4)', () => {
  assert.deepEqual(Dining.localParts(new Date('2026-11-27T19:59:00Z')), { day: '2026-11-27', hour: 23 });
  assert.deepEqual(Dining.localParts(new Date('2026-11-27T20:00:00Z')), { day: '2026-11-28', hour: 0 });
  const s = Dining.settingsOf({});
  assert.equal(Dining.mealOf(10, s), 'Breakfast');
  assert.equal(Dining.mealOf(11, s), 'Lunch');
  assert.equal(Dining.mealOf(16, s), 'Lunch');
  assert.equal(Dining.mealOf(17, s), 'Dinner');
  assert.equal(Dining.slotOf('Lunch', s), 'Lunch');
  assert.equal(Dining.slotOf('Lunch', Dining.settingsOf({ settings: { entryRule: 'day' } })), 'Day');
});

test('dining: settings are checked; anything invalid falls back to the defaults', () => {
  assert.deepEqual(Dining.settingsOf({ settings: { entryRule: 'x', lunchFrom: 18, dinnerFrom: 12, allowUnregistered: 'no' } }),
    { entryRule: 'meal', lunchFrom: 11, dinnerFrom: 17, allowUnregistered: true });
  assert.deepEqual(Dining.settingsOf({ settings: { entryRule: 'day', lunchFrom: 12, dinnerFrom: 18, allowUnregistered: false } }),
    { entryRule: 'day', lunchFrom: 12, dinnerFrom: 18, allowUnregistered: false });
});

test('dining: barcodes are compared without spaces and case; junk is refused', () => {
  assert.equal(Dining.normBarcode(' mh00012 '), 'MH00012');
  assert.equal(Dining.normBarcode(''), '');
  assert.equal(Dining.normBarcode('<script>'), '');
  assert.equal(Dining.normBarcode('x'.repeat(65)), '');
  assert.equal(Dining.poolCode(7), 'MH00007');
  assert.equal(Dining.poolNumber('MH01234'), 1234);
  const doc = { people: [{ id: 'a', barcode: 'MH00001' }, { id: 'b', barcode: 'mh00002' }] };
  assert.equal(Dining.findPerson(doc, 'MH00002').id, 'b');
  assert.equal(Dining.findPerson(doc, 'MH00009'), null);
});

test('dining: an NFC tag finds the person it is linked to, whatever separators the phone uses', () => {
  assert.equal(Dining.normNfc('04:a2:3b:91'), '04A23B91');
  assert.equal(Dining.normNfc('04-A2 3B'), '04A23B');
  assert.equal(Dining.normNfc('x!'), '');
  const doc = { people: [{ id: 'a', barcode: 'MH00001', nfc: '04A23B91' }, { id: 'b', barcode: 'MH00002' }] };
  assert.equal(Dining.findPerson(doc, '04:A2:3B:91').id, 'a');
  assert.equal(Dining.findPerson(doc, 'MH00001').id, 'a');
  assert.equal(Dining.findPerson(doc, '04A23B92'), null);
  const r = Dining.fromLegacyBackup({ people: [{ id: 1, name: 'A', category: 'Senior', barcode: 'MH00001', nfc: '04:a2' }], entryLog: [] });
  assert.equal(r.doc.people[0].nfc, '04A2', 'a backup of this app keeps the tags');
});

test('dining: an old app backup becomes the setup and scan records, nothing lost', () => {
  const t = Date.parse('2026-11-20T04:30:00Z'); // 08:30 in camp
  const r = Dining.fromLegacyBackup({
    version: 1,
    barcodePool: [{ barcode: 'MH00001', assigned: true, personId: 1 }, { barcode: 'MH01200', assigned: false, personId: null }],
    people: [
      { id: 1, name: 'Ali', company: 'ACME', room: 'B-1', category: 'Worker', barcode: 'MH00001', allowed: true },
      { id: 2, name: 'Duplicate card', category: 'Senior', barcode: 'MH00001', allowed: true },
      { id: 3, name: 'Blocked', category: 'Junior', barcode: 'MH00003', allowed: false },
    ],
    companies: ['ACME', 'ACME', 'Beta'],
    entryLog: [
      { id: t, barcode: 'MH00001', name: 'Ali', company: 'ACME', mess: 'Worker', status: 'allowed', note: 'Allowed', time: t, scannedBy: 'Security 1' },
      { id: t + 1, barcode: 'X9', name: 'Unknown', company: '', mess: 'Senior', status: 'denied', note: 'Manually denied', time: t + 1, scannedBy: 'Security 2' },
      { barcode: 'MH00001', status: 'weird', time: t },
    ],
  });
  assert.equal(r.doc.nextBarcode, 1201);
  assert.deepEqual(r.doc.people.map(p => [p.id, p.hall, p.allowed]), [['1', 'Worker1', true], ['3', 'Junior', false]]);
  assert.deepEqual(r.doc.companies, ['ACME', 'Beta']);
  assert.equal(r.scans.length, 2);
  assert.deepEqual([r.scans[0].day, r.scans[0].meal, r.scans[0].hall, r.scans[0].scannedByName], ['2026-11-20', 'Breakfast', 'Worker1', 'Security 1']);
  assert.equal(r.scans[0].legacyKey, `MH00001_${t}_Worker_allowed`, 'same duplicate check as the old app');
  assert.equal(r.scans[1].name, '', '"Unknown" is not a name');
  assert.equal(Dining.fromLegacyBackup({ hello: 1 }), null);
});

test('dining: only Admins change the setup; guards and viewers cannot', () => {
  const op = { o: 's', p: ['people', { id: 'a' }, 'allowed'], v: true };
  assert.equal(dining.checkPermission('admin', op), null);
  assert.match(dining.checkPermission('operator', op), /Only an Admin/);
  assert.match(dining.checkPermission('viewer', op), /only view/);
  assert.equal(dining.isRootKey('people'), true);
  assert.equal(dining.isRootKey('scans'), false, 'scans are never part of the document');
  assert.throws(() => dining.importDocument({ foo: 1 }), /not a Dining Halls/);
  assert.equal(dining.importDocument({ people: [], entryLog: [] }).nextBarcode, 1001);
});
