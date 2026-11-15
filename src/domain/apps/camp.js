'use strict';
/**
 * Global Village Camp Management.
 * Document: {campData, companies, historyLog, nationalities, BLOCKS_META, foodCategories, campList, appSeeds}
 */
const { defineApp, UserError } = require('./common');
const { describePath } = require('../operations');

const ROOT_KEYS = Object.freeze(['campData', 'companies', 'historyLog', 'nationalities', 'BLOCKS_META', 'foodCategories', 'campList', 'appSeeds']);
const OPERATOR_CAMP_SECTIONS = new Set(['_bathrooms', '_hkc', '_housekeeping']);
const OPERATOR_ROOM_FIELDS = new Set(['L', 'W', 'size']);
const PROFIT = '_profit';

/**
 * Operators: check in/out, reservations, resident details, room sizes, bathrooms, housekeeping.
 * Everything that changes the camp's structure, lists, money or deletes records needs an admin.
 */
function checkPermission(role, op) {
  if (role === 'admin') return null;
  if (role !== 'operator') return 'Your account can only view this app.';
  const p = op.p;
  const deny = what => `An Operator account cannot ${what} (${describePath(p)}). Ask an Admin.`;
  switch (p[0]) {
    case 'historyLog':
      if (p.length === 1 && (op.o === 'ad' || op.o === 's')) return deny('delete check in/out log records');
      return null;
    case 'campData': {
      if (p.length === 1) return deny('replace all camp data');
      if (OPERATOR_CAMP_SECTIONS.has(p[1])) return null;
      if (p[1] === PROFIT) return deny('change profit figures');
      if (p.length === 2) return deny('add or delete blocks');
      if (p[2] !== 'rooms') return deny('change block settings');
      if (p.length <= 4) return deny('add or delete rooms');
      if (p[4] === 'beds') return p.length === 5 ? deny('change room capacity') : null;
      if (OPERATOR_ROOM_FIELDS.has(p[4]) && p.length === 5 && op.o === 's') return null;
      return deny('change room structure');
    }
    case 'companies': return deny('change the company list');
    case 'nationalities': return deny('change the nationality list');
    case 'foodCategories': return deny('change food categories');
    case 'BLOCKS_META': return deny('change blocks');
    case 'campList': return deny('add, rename or delete camps');
    default: return deny('change system setup');
  }
}

/** Location Profit (revenue, costs) is for admins only. */
function filterDoc(doc, role) {
  if (role === 'admin' || !doc || !doc.campData || !doc.campData[PROFIT]) return doc;
  const campData = Object.assign({}, doc.campData);
  delete campData[PROFIT];
  return Object.assign({}, doc, { campData });
}

function filterOps(ops, role) {
  if (role === 'admin') return ops;
  const out = [];
  for (const op of ops) {
    if (op.p[0] === 'campData' && op.p[1] === PROFIT) continue;
    if (op.p[0] === 'campData' && op.p.length === 1 && op.v && op.v[PROFIT]) {
      const v = Object.assign({}, op.v);
      delete v[PROFIT];
      out.push(Object.assign({}, op, { v }));
      continue;
    }
    out.push(op);
  }
  return out;
}

/**
 * Every check in/out record needs a unique id so changes merge record by record.
 * @returns {string[]} top-level sections that were changed
 */
function normalise(doc) {
  if (!Array.isArray(doc.historyLog)) return [];
  let changed = false;
  const seen = new Set();
  let n = 0;
  for (const e of doc.historyLog) {
    if (!e || typeof e !== 'object') continue;
    const bad = (typeof e.id !== 'string' && typeof e.id !== 'number') || seen.has(e.id);
    if (bad) {
      e.id = `srv${Date.now().toString(36)}_${(n++).toString(36)}`;
      changed = true;
    }
    seen.add(e.id);
  }
  return changed ? ['historyLog'] : [];
}

/** Accepts the desktop program's app_data.json. */
function importDocument(file) {
  if (!file || typeof file !== 'object' || !file.campData || typeof file.campData !== 'object') {
    throw new UserError('This is not the Camp Management app_data.json file (it has no campData).');
  }
  const doc = {};
  for (const k of ROOT_KEYS) if (k in file) doc[k] = file[k];
  return doc;
}

module.exports = defineApp({
  id: 'camp',
  name: 'Camp Management',
  description: 'Rooms and beds, check in / check out, occupancy, company billing, man-days and location profit.',
  icon: 'ti-building-community',
  color: '#1d4ed8',
  path: '/camp/',
  textMode: 'strict',
  seedFile: 'camp.json',
  isRootKey: k => ROOT_KEYS.includes(k),
  checkPermission,
  filterDoc,
  filterOps,
  normalise,
  importDocument,
  ROOT_KEYS,
});
