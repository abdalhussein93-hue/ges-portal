'use strict';
/**
 * Global Village Camp Management.
 * Document: {campData, companies, historyLog, nationalities, BLOCKS_META, foodCategories, campList, appSeeds,
 *            approvals, approvalCfg, deletedLog}
 *   approvals   Operator change requests waiting for / decided by an Admin
 *   approvalCfg {enabled}: when on (the default), Operators cannot change beds directly;
 *               off = automatic approval (changes apply at once and are recorded as approved)
 *   deletedLog  check in/out log records an Admin deleted (counted as "Deleted" in the Movement Summary)
 */
const { defineApp, UserError } = require('./common');
const { describePath } = require('../operations');

const ROOT_KEYS = Object.freeze(['campData', 'companies', 'historyLog', 'nationalities', 'BLOCKS_META', 'foodCategories',
  'campList', 'appSeeds', 'approvals', 'approvalCfg', 'deletedLog']);
const OPERATOR_CAMP_SECTIONS = new Set(['_bathrooms', '_hkc', '_housekeeping']);
const OPERATOR_ROOM_FIELDS = new Set(['L', 'W', 'size']);
const PROFIT = '_profit';
const DECIDED = new Set(['approved', 'rejected']);
/** Name written on requests approved automatically (the browser writes the same, so no reload). */
const AUTO_APPROVER = 'Automatic approval';
const CLOCK_SKEW_MS = 10 * 60 * 1000;

/**
 * Admin approval of Operator bed changes is on unless an Admin switched it off.
 * Switched off = automatic approval: Operator changes apply at once and are recorded as approved.
 */
function approvalOn(doc) {
  return !(doc && doc.approvalCfg && doc.approvalCfg.enabled === false);
}

/** The browser's time if it is a real time close to now, otherwise the server's. */
function nearNow(iso, now) {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isFinite(t) && Math.abs(t - now) <= CLOCK_SKEW_MS ? iso : new Date(now).toISOString();
}

function findRequest(doc, seg) {
  const list = doc && Array.isArray(doc.approvals) ? doc.approvals : [];
  return seg && typeof seg === 'object' ? list.find(r => r && r.id === seg.id) || null : null;
}

/** What an Operator may do with approval requests: send new ones, withdraw / mark as read their own. */
function operatorApprovalRule(op, ctx, deny) {
  const p = op.p;
  if (p.length === 1) return op.o === 'ai' ? null : deny('replace or delete approval requests');
  const req = findRequest(ctx.doc, p[1]);
  if (!req) return deny('change this approval request');
  const own = !!ctx.user && req.byUser === ctx.user.username;
  if (!own) return deny("change another person's approval request");
  if (p.length !== 3 || op.o !== 's') return deny('change approval requests');
  if (p[2] === 'seen' && op.v === true) return null;
  if (req.status === 'pending' && ((p[2] === 'status' && op.v === 'withdrawn') || p[2] === 'decidedAt')) return null;
  return deny('approve or reject requests');
}

/**
 * Operators: check in/out, reservations, resident details, room sizes, bathrooms, housekeeping.
 * While approval is on, bed changes go through approval requests instead.
 * Everything that changes the camp's structure, lists, money or deletes records needs an admin.
 * @param {{doc?: object, user?: object}} [ctx]  current data and the signed-in user
 */
function checkPermission(role, op, ctx = {}) {
  if (role === 'admin') return null;
  if (role !== 'operator') return 'Your account can only view this app.';
  const p = op.p;
  const deny = what => `An Operator account cannot ${what} (${describePath(p)}). Ask an Admin.`;
  switch (p[0]) {
    case 'historyLog':
      if (p.length === 1 && (op.o === 'ad' || op.o === 's')) return deny('delete check in/out log records');
      return null;
    case 'approvals': return operatorApprovalRule(op, ctx, deny);
    case 'approvalCfg': return deny('switch the approval workflow on or off');
    case 'deletedLog': return deny('change the deleted-records list');
    case 'campData': {
      if (p.length === 1) return deny('replace all camp data');
      if (OPERATOR_CAMP_SECTIONS.has(p[1])) return null;
      if (p[1] === PROFIT) return deny('change profit figures');
      if (p.length === 2) return deny('add or delete blocks');
      if (p[2] !== 'rooms') return deny('change block settings');
      if (p.length <= 4) return deny('add or delete rooms');
      if (p[4] === 'beds') {
        if (p.length === 5) return deny('change room capacity');
        if (approvalOn(ctx.doc)) return 'Admin approval is switched on: this bed change must be sent as a request and approved by an Admin. Please reload the page and try again.';
        return null;
      }
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

/**
 * Compares room numbers the way people read them: B1-9 before B1-10, B2-1 after B1-14.
 * Digit runs compare as numbers, everything else as case-insensitive text.
 */
function naturalCompare(a, b) {
  const x = String(a).toLowerCase().match(/\d+|\D+/g) || [];
  const y = String(b).toLowerCase().match(/\d+|\D+/g) || [];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    const nx = /^\d/.test(x[i]), ny = /^\d/.test(y[i]);
    if (nx && ny) {
      const d = Number(x[i]) - Number(y[i]);
      if (d) return d;
      continue;
    }
    return x[i] < y[i] ? -1 : 1;
  }
  return x.length - y.length || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * The app shows rooms in the order their keys come in. PostgreSQL (jsonb) keeps object keys
 * shortest first, which puts B1-10 after B9-9, so the rooms are put back in room-number order
 * before they are sent. Copies only: the stored data is not changed.
 */
function orderRooms(campData) {
  const out = {};
  for (const [bk, block] of Object.entries(campData)) {
    const rooms = block && typeof block === 'object' && block.rooms;
    if (!rooms || typeof rooms !== 'object' || Array.isArray(rooms)) { out[bk] = block; continue; }
    const sorted = {};
    for (const rid of Object.keys(rooms).sort(naturalCompare)) sorted[rid] = rooms[rid];
    out[bk] = Object.assign({}, block, { rooms: sorted });
  }
  return out;
}

/** Rooms in room-number order; Location Profit (revenue, costs) is for admins only. */
function filterDoc(doc, role) {
  if (!doc || !doc.campData || typeof doc.campData !== 'object') return doc;
  const campData = orderRooms(doc.campData);
  if (role !== 'admin') delete campData[PROFIT];
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

/**
 * An Operator's request as the server records it: always in their real name. With Admin approval
 * it waits ("pending"); with automatic approval it is recorded as approved by "Automatic approval"
 * (the bed changes themselves are sent in the same save, as an Admin's would be).
 */
function stampOperatorRequest(sent, user, who, auto, now) {
  const v = Object.assign({}, sent, { by: who, byUser: user.username, seen: true });
  for (const k of ['decidedAt', 'decidedBy', 'note', 'conflict', 'auto']) delete v[k];
  if (!auto) return Object.assign(v, { status: 'pending' });
  return Object.assign(v, { status: 'approved', auto: true, decidedBy: AUTO_APPROVER, decidedAt: nearNow(sent.decidedAt, now) });
}

/** Same content, whatever the key order. */
function sameRecord(a, b) {
  const keys = o => Object.keys(o).sort();
  return JSON.stringify(keys(a)) === JSON.stringify(keys(b)) && keys(a).every(k => JSON.stringify(a[k]) === JSON.stringify(b[k]));
}

/**
 * Writes the real account onto approval requests and decisions, so nobody can send or decide
 * a request in someone else's name.
 * @returns {{ops: object[], changed: boolean}} changed: the browser's copy now differs (it reloads)
 */
function prepareOps(role, user, ops, doc) {
  const who = (user && (user.name || user.username)) || 'unknown';
  const auto = !approvalOn(doc);
  const now = Date.now();
  let changed = false;
  const out = [];
  const stamps = [];
  // data saved before this feature has no approvals / deletedLog list yet: create it first
  for (const key of ['approvals', 'deletedLog']) {
    const adds = ops.some(op => op.p[0] === key && op.p.length === 1 && (op.o === 'ai' || op.o === 'pi'));
    if (adds && !(doc && Array.isArray(doc[key]))) out.push({ o: 's', p: [key], v: [] });
  }
  for (const op of ops) {
    if (role === 'operator' && op.o === 'ai' && op.p.length === 1 && op.p[0] === 'approvals' && op.v && typeof op.v === 'object') {
      const v = stampOperatorRequest(op.v, user, who, auto, now);
      if (!sameRecord(v, op.v)) changed = true;
      out.push(Object.assign({}, op, { v }));
      continue;
    }
    out.push(op);
    if (role === 'admin' && op.o === 's' && op.p[0] === 'approvals' && op.p.length === 3 && op.p[2] === 'status' && DECIDED.has(op.v)) {
      const path = [op.p[0], op.p[1], 'decidedBy'];
      const sent = ops.find(o => o.o === 's' && o.p.length === 3 && o.p[0] === 'approvals' && o.p[2] === 'decidedBy' && JSON.stringify(o.p[1]) === JSON.stringify(op.p[1]));
      if (!sent || sent.v !== who) changed = true;
      stamps.push({ o: 's', p: path, v: who });
    }
  }
  return { ops: out.concat(stamps), changed };
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
  prepareOps,
  filterDoc,
  filterOps,
  normalise,
  importDocument,
  ROOT_KEYS,
  approvalOn,
  naturalCompare,
  AUTO_APPROVER,
});
