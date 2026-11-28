'use strict';
/**
 * Migration 007 on the situation found on live: "Alfarah Asab" (from migration 005) and
 * "AL FARAH" (the real Camp Management camp) both in the camp list.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { testDatabaseUrl, wipeDatabase, startPortal } = require('./harness');

const URL_ = testDatabaseUrl();
const SQL = fs.readFileSync(path.join(__dirname, '../../src/db/migrations/007_al_farah.sql'), 'utf-8');

describe('Migration 007: keep AL FARAH (PostgreSQL)', () => {
  let P, pool;
  const q = (text, params) => pool.query(text, params);
  const campsOf = async u => (await q('SELECT camps FROM users WHERE username = $1', [u])).rows[0].camps;

  before(async () => {
    await wipeDatabase(URL_);
    P = await startPortal(URL_); // every migration, as a new installation: 007 does nothing there
    pool = new Pool({ connectionString: URL_, max: 1 });
  });
  after(async () => { if (pool) await pool.end(); if (P) await P.close(); });

  it('does nothing on a new installation', async () => {
    const { rows } = await q('SELECT id, deleted_at FROM camps ORDER BY position');
    assert.deepEqual(rows.map(r => [r.id, r.deleted_at]), [['gv', null], ['alfarah', null]]);
  });

  it('on live data: people with Alfarah Asab get AL FARAH, and Alfarah Asab is hidden (not erased)', async () => {
    await q("INSERT INTO camps (id, name, position) VALUES ('al-farah', 'AL FARAH', 3)");
    const mk = (u, camps) => q("INSERT INTO users (username, password_hash, camps) VALUES ($1, 'x', $2)", [u, JSON.stringify(camps)]);
    await mk('both', ['gv', 'alfarah']);
    await mk('gv.only', ['gv']);
    await mk('already', ['alfarah', 'al-farah']);
    await q(SQL);
    assert.deepEqual(await campsOf('both'), ['gv', 'alfarah', 'al-farah']);
    assert.deepEqual(await campsOf('gv.only'), ['gv']);
    assert.deepEqual(await campsOf('already'), ['alfarah', 'al-farah']);
    const { rows } = await q("SELECT id, deleted_at IS NOT NULL AS deleted, deleted_by FROM camps ORDER BY position");
    assert.deepEqual(rows.map(r => [r.id, r.deleted]), [['gv', false], ['alfarah', true], ['al-farah', false]]);
    assert.match(rows[1].deleted_by, /duplicate of AL FARAH/);
    // running it again changes nothing
    await q(SQL);
    assert.deepEqual(await campsOf('both'), ['gv', 'alfarah', 'al-farah']);
  });
});
