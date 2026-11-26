'use strict';
/**
 * Daily Costing & Stock.
 * Document: the app's own data object {v, items, categories, groups, costCenters, targets,
 * settings, months, priceChanges} plus the portal's day confirmation sections:
 *   dayLocks     {"YYYY-MM-DD": {by, byUser, at}}  days whose entry was confirmed
 *   dayRequests  [{id, day, by, byUser, at, reason, status, changes:[{s, i, g?, from, to}], ...}]
 *                changes to a confirmed day sent by an Operator; an Admin approves or rejects them
 *
 * A day's entry is months[YYYY-MM].cons[d][itemId][groupId] (consumption) and
 * months[YYYY-MM].received[d][itemId] (goods received); d is the day number ("5", sometimes "05").
 * Once a day is confirmed, an Operator can no longer change those two sections of that day.
 */
const { defineApp, editorsMayChangeAll, UserError } = require('./common');
const P = require('../patch');

const ROOT_KEY = /^[A-Za-z][A-Za-z0-9_]{0,60}$/;
const DAY_KEY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const SECTIONS = Object.freeze(['cons', 'received']);
const DECIDED = new Set(['approved', 'rejected']);
const ID = /^[A-Za-z0-9_.:-]{1,64}$/;            // request ids
const KEY = /^[^\u0000-\u001f]{1,100}$/;          // item / group ids, as the app made them
const MAX_CHANGES = 3000;
const MAX_QTY = 1e9;
const CLOCK_SKEW_MS = 10 * 60 * 1000;

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const pad = d => String(d).padStart(2, '0');

/** Same value, whatever the key order, and empty objects count as missing. */
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (!isObj(v)) return v;
  const out = {};
  for (const k of Object.keys(v).sort()) {
    const c = canon(v[k]);
    if (c !== undefined && !(isObj(c) && !Object.keys(c).length)) out[k] = c;
  }
  return out;
}
const same = (a, b) => JSON.stringify(canon(a) ?? null) === JSON.stringify(canon(b) ?? null);

function locks(doc) { return doc && isObj(doc.dayLocks) ? doc.dayLocks : {}; }
function requests(doc) { return doc && Array.isArray(doc.dayRequests) ? doc.dayRequests : []; }
function isLocked(doc, mk, d) { return hasOwn(locks(doc), `${mk}-${pad(d)}`); }
function findRequest(doc, seg) { return isObj(seg) ? requests(doc).find(r => r && r.id === seg.id) || null : null; }

/** The key a day uses inside a month section ("5" or "05"); a new day uses "5", like the app. */
function dayKeyIn(section, dd) {
  if (isObj(section)) for (const k of Object.keys(section)) if (pad(k) === dd) return k;
  return String(Number(dd));
}
function dayIn(section, dd) {
  if (!isObj(section)) return undefined;
  for (const k of Object.keys(section)) if (pad(k) === dd) return section[k];
  return undefined;
}

/** The current value of one changed cell. */
function cellValue(month, c, dd) {
  const day = dayIn(month && month[c.s], dd);
  const row = isObj(day) ? day[c.i] : undefined;
  if (c.s === 'received') return Number(row) || 0;
  return (isObj(row) && Number(row[c.g])) || 0;
}

/** Writes the requested cells into a month object, the way the app's own setDayCons / setDayRecv do. */
function applyChanges(month, req) {
  const dd = req.day.slice(8);
  for (const c of req.changes) {
    if (!isObj(month[c.s])) month[c.s] = {};
    const sec = month[c.s];
    const key = dayKeyIn(sec, dd);
    if (c.s === 'received') {
      if (c.to) { if (!isObj(sec[key])) sec[key] = {}; sec[key][c.i] = c.to; }
      else if (isObj(sec[key])) delete sec[key][c.i];
    } else if (c.to) {
      if (!isObj(sec[key])) sec[key] = {};
      if (!isObj(sec[key][c.i])) sec[key][c.i] = {};
      sec[key][c.i][c.g] = c.to;
    } else if (isObj(sec[key]) && isObj(sec[key][c.i])) delete sec[key][c.i][c.g];
  }
  return month;
}

/** True if this change alters the consumption / received figures of a confirmed day. */
function changesConfirmedDay(doc, op) {
  const p = op.p;
  if (p[0] !== 'months') return false;
  const keys = Object.keys(locks(doc));
  if (!keys.length) return false;
  if (p.length >= 4) return SECTIONS.includes(p[2]) && isLocked(doc, p[1], p[3]);
  if (p.length === 3 && !SECTIONS.includes(p[2])) return false;
  if (op.o !== 's' && op.o !== 'd') return true;
  // a whole month (or section) is replaced or deleted: compare every confirmed day it covers
  let old = doc.months;
  for (const seg of p.slice(1)) old = isObj(old) ? old[seg] : undefined;
  const now = op.o === 's' ? op.v : undefined;
  const sectionOf = (v, mk, sec) => {
    if (p.length === 1) return isObj(v) && isObj(v[mk]) ? v[mk][sec] : undefined;
    if (p.length === 2) return isObj(v) ? v[sec] : undefined;
    return v;
  };
  return keys.some(key => {
    const mk = key.slice(0, 7), dd = key.slice(8);
    if (p.length >= 2 && p[1] !== mk) return false;
    return SECTIONS.some(sec => (p.length < 3 || p[2] === sec) &&
      !same(dayIn(sectionOf(old, mk, sec), dd), dayIn(sectionOf(now, mk, sec), dd)));
  });
}

function dayLabel(key) {
  const [y, m, d] = key.split('-');
  return `${Number(d)}/${Number(m)}/${y}`;
}

/** Operators confirm days; only an Admin can unlock one. */
function lockRule(op, doc, deny) {
  const p = op.p;
  const current = locks(doc);
  if (op.o === 's' && p.length === 2 && DAY_KEY.test(p[1]) && !hasOwn(current, p[1])) return null;
  if (op.o === 's' && p.length === 1 && isObj(op.v) &&
    Object.keys(op.v).every(k => DAY_KEY.test(k)) && Object.keys(current).every(k => hasOwn(op.v, k) && same(current[k], op.v[k]))) return null;
  return deny('unlock or change a confirmed day');
}

/** Checks a change request an Operator sends; the error message is shown to them. */
function requestProblem(v, doc) {
  if (!isObj(v) || typeof v.id !== 'string' || !ID.test(v.id)) return 'This change request is not valid.';
  if (typeof v.day !== 'string' || !DAY_KEY.test(v.day)) return 'This change request has no valid day.';
  if (!hasOwn(locks(doc), v.day)) return `Day ${dayLabel(v.day)} is not confirmed: change it directly. Please reload the page.`;
  if (!Array.isArray(v.changes) || !v.changes.length) return 'This change request has no changes.';
  if (v.changes.length > MAX_CHANGES) return 'This change request has too many changes.';
  for (const c of v.changes) {
    if (!isObj(c) || !SECTIONS.includes(c.s) || typeof c.i !== 'string' || !KEY.test(c.i)) return 'This change request contains an invalid line.';
    if (c.s === 'cons' && (typeof c.g !== 'string' || !KEY.test(c.g))) return 'This change request contains an invalid line.';
    if (typeof c.to !== 'number' || !Number.isFinite(c.to) || c.to < 0 || c.to > MAX_QTY) return 'This change request contains an invalid quantity.';
  }
  return null;
}

/** What an Operator may do with change requests: send new ones, withdraw / mark as read their own. */
function requestRule(op, ctx, deny) {
  const p = op.p;
  if (p.length === 1) return op.o === 'ai' ? requestProblem(op.v, ctx.doc) : deny('replace or delete change requests');
  const req = findRequest(ctx.doc, p[1]);
  if (!req) return deny('change this change request');
  if (!ctx.user || req.byUser !== ctx.user.username) return deny("change another person's change request");
  if (p.length !== 3 || op.o !== 's') return deny('change change requests');
  if (p[2] === 'seen' && op.v === true) return null;
  if (req.status === 'pending' && ((p[2] === 'status' && op.v === 'withdrawn') || p[2] === 'decidedAt')) return null;
  return deny('approve or reject change requests');
}

/**
 * Viewers read only. Operators change everything in the app, except the figures of a confirmed
 * day: those go through a change request an Admin approves.
 * @param {{doc?: object, user?: object}} [ctx]
 */
function checkPermission(role, op, ctx = {}) {
  const p = op.p;
  if (role === 'admin') {
    // a request can be decided once, and only while it is waiting
    if (p[0] === 'dayRequests' && p.length === 3 && p[2] === 'status' && DECIDED.has(op.v)) {
      const req = findRequest(ctx.doc, p[1]);
      if (!req || req.status !== 'pending') return 'This change request was already withdrawn or decided. The page will reload.';
    }
    return null;
  }
  const notEditor = editorsMayChangeAll(role);
  if (notEditor) return notEditor;
  const deny = what => `An Operator account cannot ${what}. Ask an Admin.`;
  switch (p[0]) {
    case 'dayLocks': return lockRule(op, ctx.doc, deny);
    case 'dayRequests': return requestRule(op, ctx, deny);
    case 'months': {
      if (!changesConfirmedDay(ctx.doc, op)) return null;
      const day = p.length >= 4 ? ` ${dayLabel(`${p[1]}-${pad(p[3])}`)}` : '';
      return `Day${day} is confirmed. To change it, use "Request a change" so an Admin can approve it.`;
    }
    default: return null;
  }
}

/** Everyone receives the two sections, even before the first day is confirmed. */
function filterDoc(doc) {
  if (!doc || (isObj(doc.dayLocks) && Array.isArray(doc.dayRequests))) return doc;
  return Object.assign({}, doc, {
    dayLocks: isObj(doc.dayLocks) ? doc.dayLocks : {},
    dayRequests: Array.isArray(doc.dayRequests) ? doc.dayRequests : [],
  });
}

/** A browser's own time is kept when it is plausible, so its copy stays the same as the server's. */
function stampTime(at, now) {
  const t = typeof at === 'string' ? Date.parse(at) : NaN;
  return Number.isFinite(t) && Math.abs(t - now) <= CLOCK_SKEW_MS ? at : new Date(now).toISOString();
}

/**
 * Writes the real account and time onto confirmations, requests and decisions, records the
 * current figures in each request ("from"), and makes sure an approved request is applied.
 * @returns {{ops: object[], changed: boolean}} changed: the browser's copy now differs (it reloads)
 */
function prepareOps(role, user, ops, doc) {
  const who = (user && (user.name || user.username)) || 'unknown';
  const username = user && user.username;
  const now = Date.now();
  let changed = false;
  const out = [];
  const after = [];
  const swap = (op, v) => { if (!same(v, op.v)) changed = true; out.push(Object.assign({}, op, { v })); };
  const lockStamp = v => ({ by: who, byUser: username, at: stampTime(isObj(v) && v.at, now) });

  // data saved before this feature has no dayLocks / dayRequests yet: create them first
  if (!isObj(doc && doc.dayLocks) && ops.some(op => op.p[0] === 'dayLocks' && op.p.length > 1)) out.push({ o: 's', p: ['dayLocks'], v: {} });
  if (!Array.isArray(doc && doc.dayRequests) && ops.some(op => op.p[0] === 'dayRequests' && op.o === 'ai')) out.push({ o: 's', p: ['dayRequests'], v: [] });

  for (const op of ops) {
    const p = op.p;
    if (p[0] === 'dayLocks' && op.o === 's' && p.length === 2) { swap(op, lockStamp(op.v)); continue; }
    if (p[0] === 'dayLocks' && op.o === 's' && p.length === 1 && isObj(op.v)) {
      const v = {};
      for (const k of Object.keys(op.v)) v[k] = hasOwn(locks(doc), k) ? locks(doc)[k] : lockStamp(op.v[k]);
      swap(op, v);
      continue;
    }
    if (p[0] === 'dayRequests' && op.o === 'ai' && p.length === 1 && isObj(op.v) && role === 'operator') { // checked by requestProblem
      const month = doc && isObj(doc.months) ? doc.months[op.v.day.slice(0, 7)] : undefined;
      const dd = op.v.day.slice(8);
      const v = {
        id: op.v.id, day: op.v.day, by: who, byUser: username, at: stampTime(op.v.at, now),
        reason: typeof op.v.reason === 'string' ? op.v.reason.slice(0, 1000) : '',
        status: 'pending', seen: true,
        changes: op.v.changes.map(c => Object.assign({ s: c.s, i: c.i }, c.s === 'cons' ? { g: c.g } : {},
          { from: cellValue(month, c, dd), to: c.to })),
      };
      swap(op, v);
      continue;
    }
    out.push(op);
    if (role === 'admin' && p[0] === 'dayRequests' && p.length === 3 && op.o === 's' && p[2] === 'status' && DECIDED.has(op.v)) {
      const sent = ops.find(o => o.o === 's' && o.p.length === 3 && o.p[0] === 'dayRequests' && o.p[2] === 'decidedBy' && same(o.p[1], p[1]));
      if (!sent || sent.v !== who) changed = true;
      after.push({ o: 's', p: [p[0], p[1], 'decidedBy'], v: who });
      const req = findRequest(doc, p[1]);
      if (op.v === 'approved' && req) after.push(...approvalOps(req, doc, ops));
    }
  }
  const applyOps = after.filter(o => o.p[0] === 'months');
  if (applyOps.length) changed = true;
  return { ops: out.concat(after), changed };
}

/**
 * The approved figures must end up in the month, whatever the Admin's browser sent with the
 * decision. Returns only what is still missing (usually nothing: the browser applies them too).
 */
function approvalOps(req, doc, sentOps) {
  const mk = req.day.slice(0, 7);
  const scratch = { months: {} };
  if (doc && isObj(doc.months) && isObj(doc.months[mk])) scratch.months[mk] = P.clone(doc.months[mk]);
  P.apply(scratch, sentOps.filter(o => o.p[0] === 'months' && (o.p.length === 1 || o.p[1] === mk)));
  const month = isObj(scratch.months) ? scratch.months[mk] : undefined;
  if (!isObj(month)) return [{ o: 's', p: ['months', mk], v: applyChanges({ opening: {}, received: {}, cons: {}, manday: {} }, req) }];
  const wanted = applyChanges(P.clone(month), req);
  return P.diff(month, wanted).map(o => Object.assign({}, o, { p: ['months', mk].concat(o.p) }));
}

/** Accepts the desktop program's app_data.json or a backup made with "Export JSON" (same format). */
function importDocument(file) {
  if (!file || typeof file !== 'object' || !Array.isArray(file.items) || !Array.isArray(file.groups)) {
    throw new UserError('This is not a Daily Costing data or backup file (it has no items / groups).');
  }
  const bad = Object.keys(file).find(k => !ROOT_KEY.test(k));
  if (bad) throw new UserError(`This file contains an unexpected section: ${bad.slice(0, 40)}`);
  return file;
}

module.exports = defineApp({
  id: 'costing',
  name: 'Daily Costing & Stock',
  description: 'Kitchen stock, daily consumption, monthly prices, man-days, budget per cost centre and alerts.',
  icon: 'ti-tools-kitchen-2',
  color: '#d97706',
  path: '/costing/',
  textMode: 'markup',
  isRootKey: k => ROOT_KEY.test(k),
  checkPermission,
  prepareOps,
  filterDoc,
  importDocument,
  applyChanges,
});
