'use strict';
/**
 * Duty Board (duty roster per department).
 * Document: {version, camp, depts: [{id, name, config, tasks, staff}]}
 *
 * Access per department:
 *   Admin            all departments; may add, delete and replace departments and change the camp name
 *   Operator/Viewer  only the departments listed for them (user.scopes.duty.depts);
 *                    Operators edit inside those departments, Viewers only look
 * "activeDept" (the department a person is looking at) is personal and never shared.
 */
const { defineApp, UserError } = require('./common');
const { describePath } = require('../operations');

const ROOT_KEYS = new Set(['version', 'camp', 'activeDept', 'depts']);
const PERSONAL = 'activeDept';

/** Departments this user may see (null = all). */
function allowedDepts(role, user) {
  if (role === 'admin') return null;
  const s = user && user.scopes && user.scopes.duty;
  return new Set(s && Array.isArray(s.depts) ? s.depts : []);
}

function checkPermission(role, op, ctx = {}) {
  if (role === 'admin') return null;
  if (role !== 'operator') return 'Your account can only view this app.';
  const p = op.p;
  const deny = what => `A department account cannot ${what} (${describePath(p)}). Ask an Admin.`;
  if (p[0] === PERSONAL) return null; // dropped by prepareOps
  if (p[0] !== 'depts') return deny('change the camp name or settings');
  if (p.length === 1) return deny('add, delete or replace departments');
  const id = p[1] && typeof p[1] === 'object' ? p[1].id : undefined;
  if (id === undefined || !allowedDepts(role, ctx.user).has(id)) return deny('change a department you have not been given');
  if (p.length === 2) return deny('replace a whole department');
  if (p[2] === 'id') return deny('change a department id');
  return null;
}

/** The department a person is looking at is personal: never stored from a browser. */
function prepareOps(role, user, ops) {
  const out = ops.filter(op => op.p[0] !== PERSONAL);
  return { ops: out, changed: false };
}

function filterDoc(doc, role, user) {
  if (!doc) return doc;
  const out = Object.assign({}, doc);
  delete out[PERSONAL];
  const allowed = allowedDepts(role, user);
  if (allowed && Array.isArray(doc.depts)) out.depts = doc.depts.filter(d => d && allowed.has(d.id));
  return out;
}

function filterOps(ops, role, user) {
  const allowed = allowedDepts(role, user);
  const out = [];
  for (const op of ops) {
    const p = op.p;
    if (p[0] === PERSONAL) continue;
    if (!allowed || p[0] !== 'depts') { out.push(op); continue; }
    if (p.length === 1) {
      if (op.o === 's') out.push(Object.assign({}, op, { v: (Array.isArray(op.v) ? op.v : []).filter(d => d && allowed.has(d.id)) }));
      else if (op.o === 'ai' && op.v && allowed.has(op.v.id)) out.push(op);
      else if (op.o === 'ad' && allowed.has(op.id)) out.push(op);
      continue;
    }
    const id = p[1] && typeof p[1] === 'object' ? p[1].id : undefined;
    if (allowed.has(id)) out.push(op);
  }
  return out;
}

/** "Kitchen, Service" - what a person can open, for the portal home page. */
function scopeLabel(doc, role, user) {
  if (role === 'admin') return 'All departments';
  const allowed = allowedDepts(role, user);
  const names = ((doc && doc.depts) || []).filter(d => d && allowed.has(d.id)).map(d => d.name);
  return names.length ? names.join(', ') : 'No department assigned yet';
}

/** Accepts the desktop program's app_data.json or a "Download backup" file (same format). */
function importDocument(file) {
  if (!file || typeof file !== 'object' || !Array.isArray(file.depts)) {
    throw new UserError('This is not a Duty Board data or backup file (it has no departments).');
  }
  const ids = new Set();
  for (const d of file.depts) {
    if (!d || typeof d !== 'object' || typeof d.id !== 'string' || !d.id) throw new UserError('A department in this file has no id.');
    if (ids.has(d.id)) throw new UserError(`Two departments in this file have the same id (${d.id}).`);
    ids.add(d.id);
  }
  const doc = { version: file.version || 3, camp: file.camp || 'Camp Roster', depts: file.depts };
  return doc;
}

module.exports = defineApp({
  id: 'duty',
  name: 'Duty Board',
  description: 'Duty roster per department: who works where and when, tasks, days off, coverage and print-outs.',
  icon: 'ti-calendar-time',
  color: '#7c3aed',
  path: '/duty/',
  textMode: 'markup',
  scoped: true, // access can be limited to some departments per person
  isRootKey: k => ROOT_KEYS.has(k),
  checkPermission,
  prepareOps,
  filterDoc,
  filterOps,
  scopeLabel,
  importDocument,
  allowedDepts,
});
