'use strict';
/**
 * Camp rooms keep their room-number order after the data has been stored in PostgreSQL
 * and read back (jsonb keeps object keys shortest first: B1-10 would come after B9-9).
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Patch = require('../../src/domain/patch');
const { testDatabaseUrl, wipeDatabase, startPortal, ADMIN_PASSWORD } = require('./harness');

const URL_ = testDatabaseUrl();

/** Block B: 10 buildings of 14 rooms, B1-1 ... B10-14, in room-number order. */
function blockB() {
  const rooms = {};
  for (let b = 1; b <= 10; b++) {
    for (let r = 1; r <= 14; r++) {
      const id = `B${b}-${r}`;
      rooms[id] = { number: id, category: 'Standard', capacity: 2, beds: [{ status: 'vacant' }, { status: 'vacant' }] };
    }
  }
  return { rooms };
}

describe('Camp room order (PostgreSQL)', () => {
  let P;
  const expected = Object.keys(blockB().rooms);

  before(async () => {
    await wipeDatabase(URL_);
    P = await startPortal(URL_);
    const admin = await P.login('admin', ADMIN_PASSWORD);
    const doc = { campData: { B: blockB() }, BLOCKS_META: { B: { name: 'B Block' } } };
    const r = await P.request('POST', '/api/apps/camp/patch', { cookie: admin, body: { baseRev: 0, ops: Patch.diff({}, doc) } });
    assert.equal(r.status, 200, r.text);
    // read everything back from the database, as after a restart or deploy
    await P.close();
    P = await startPortal(URL_);
  });
  after(async () => { if (P) await P.close(); });

  it('B1-10 to B1-14 come right after B1-9, for every building', async () => {
    const admin = await P.login('admin', ADMIN_PASSWORD);
    const r = await P.request('GET', '/api/apps/camp/data', { cookie: admin });
    assert.equal(r.status, 200);
    const got = Object.keys(r.json.doc.campData.B.rooms);
    assert.equal(got.length, 140);
    assert.deepEqual(got, expected);
    assert.deepEqual(got.slice(8, 15), ['B1-9', 'B1-10', 'B1-11', 'B1-12', 'B1-13', 'B1-14', 'B2-1']);
  });
});
