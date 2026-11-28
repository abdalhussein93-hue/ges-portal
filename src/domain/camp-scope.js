'use strict';
/**
 * Camp Management: limiting a person to their camps.
 *
 * Camp Management keeps every camp in one set of data. What belongs to a camp:
 *   campList                       the camp names
 *   BLOCKS_META[bk].camp           the camp of block bk (no camp written = the first camp, "Global Village")
 *   campData[bk]                   the rooms and beds of block bk
 *   campData._bathrooms[bk]        bathrooms of block bk
 *   campData._hkc[camp name]       housekeeping of a camp; campData._housekeeping = old housekeeping of the first camp
 *   campData._profit[camp name]    location profit of a camp
 *   historyLog / deletedLog        record.camp, else the camp of record.block, else the first camp
 *   approvals                      the camp of the blocks in the request's changes
 * Shared by all camps: companies, nationalities, food categories, settings.
 *
 * A person who may use all camps (portal admin) is never limited here.
 */
const { CAMP_APP_DEFAULT } = require('./camps');

const LOGS = new Set(['historyLog', 'deletedLog']);
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The camp of block `bk`: from the data, else from this save's ops (a block being created),
 * else null (unknown block).
 */
function blockCamp(doc, bk, ops) {
  const meta = doc && isObj(doc.BLOCKS_META) ? doc.BLOCKS_META[bk] : undefined;
  if (isObj(meta)) return meta.camp || CAMP_APP_DEFAULT;
  for (const op of ops || []) {
    if (op.o !== 's' || op.p[0] !== 'BLOCKS_META' || op.p[1] !== bk) continue;
    if (op.p.length === 2 && isObj(op.v)) return op.v.camp || CAMP_APP_DEFAULT;
    if (op.p.length === 3 && op.p[2] === 'camp' && typeof op.v === 'string') return op.v;
  }
  return null;
}

/** The camp of a check in/out log record (same rule as the app's histCamp). */
function recordCamp(doc, e) {
  if (!isObj(e)) return CAMP_APP_DEFAULT;
  return e.camp || (e.block !== undefined && blockCamp(doc, e.block)) || CAMP_APP_DEFAULT;
}

/** The camps an approval request is about. */
function requestCamps(doc, r) {
  const changes = isObj(r) && Array.isArray(r.changes) ? r.changes : [];
  return changes.map(c => (isObj(c) && blockCamp(doc, c.bk)) || CAMP_APP_DEFAULT);
}

const findById = (list, seg) => (Array.isArray(list) && isObj(seg) ? list.find(x => isObj(x) && x.id === seg.id) : undefined);

/** Each person's copy: only the camps in `allowed` (a Set of camp names). */
function filterDoc(doc, allowed) {
  if (!doc) return doc;
  const ok = name => allowed.has(name);
  const out = Object.assign({}, doc);
  if (Array.isArray(doc.campList)) out.campList = doc.campList.filter(ok);
  if (isObj(doc.BLOCKS_META)) {
    out.BLOCKS_META = {};
    for (const [bk, m] of Object.entries(doc.BLOCKS_META)) if (ok(blockCamp(doc, bk))) out.BLOCKS_META[bk] = m;
  }
  if (isObj(doc.campData)) out.campData = filterCampData(doc, doc.campData, ok);
  for (const k of LOGS) if (Array.isArray(doc[k])) out[k] = doc[k].filter(e => ok(recordCamp(doc, e)));
  if (Array.isArray(doc.approvals)) out.approvals = doc.approvals.filter(r => requestCamps(doc, r).every(ok));
  return out;
}

function filterCampData(doc, campData, ok) {
  const out = {};
  for (const [k, v] of Object.entries(campData)) {
    if (k === '_bathrooms' && isObj(v)) out[k] = pick(v, bk => ok(blockCamp(doc, bk) || CAMP_APP_DEFAULT));
    else if ((k === '_hkc' || k === '_profit') && isObj(v)) out[k] = pick(v, ok);
    else if (k === '_housekeeping') { if (ok(CAMP_APP_DEFAULT)) out[k] = v; }
    else if (k.charAt(0) === '_') out[k] = v;
    else if (ok(blockCamp(doc, k) || CAMP_APP_DEFAULT)) out[k] = v;
  }
  return out;
}

function pick(obj, keep) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (keep(k)) out[k] = v;
  return out;
}

/**
 * Others' changes, as a person limited to `allowed` may receive them. `doc` is the data after the
 * changes. A change to something this person cannot see is left out; a change to a block that no
 * longer exists (a delete) is passed on (it reveals only the block's id).
 */
function filterOps(ops, allowed, doc) {
  const ok = name => allowed.has(name);
  const visible = bk => { const c = blockCamp(doc, bk); return c === null || ok(c); };
  const out = [];
  for (const op of ops) {
    const p = op.p;
    const root = p[0];
    if (root === 'campList') {
      if (op.o === 's') out.push(Object.assign({}, op, { v: Array.isArray(op.v) ? op.v.filter(ok) : op.v }));
      else if ((op.o !== 'pi' && op.o !== 'pd') || ok(op.v)) out.push(op);
    } else if (root === 'BLOCKS_META') {
      if (p.length === 1) out.push(Object.assign({}, op, { v: isObj(op.v) ? pick(op.v, bk => ok((isObj(op.v[bk]) && op.v[bk].camp) || CAMP_APP_DEFAULT)) : op.v }));
      else if (visible(p[1])) out.push(op);
    } else if (root === 'campData') {
      if (p.length === 1) out.push(Object.assign({}, op, { v: isObj(op.v) ? filterCampData(doc, op.v, ok) : op.v }));
      else if (p[1] === '_bathrooms') { if (p.length === 2 ? true : visible(p[2])) out.push(p.length === 2 && isObj(op.v) ? Object.assign({}, op, { v: pick(op.v, visible) }) : op); }
      else if (p[1] === '_hkc' || p[1] === '_profit') { if (p.length === 2) out.push(Object.assign({}, op, { v: isObj(op.v) ? pick(op.v, ok) : op.v })); else if (ok(p[2])) out.push(op); }
      else if (p[1] === '_housekeeping') { if (ok(CAMP_APP_DEFAULT)) out.push(op); }
      else if (String(p[1]).charAt(0) === '_') out.push(op);
      else if (visible(p[1])) out.push(op);
    } else if (LOGS.has(root)) {
      if (p.length === 1 && op.o === 's') out.push(Object.assign({}, op, { v: Array.isArray(op.v) ? op.v.filter(e => ok(recordCamp(doc, e))) : op.v }));
      else if (p.length === 1 && op.o === 'ai') { if (ok(recordCamp(doc, op.v))) out.push(op); }
      else if (p.length === 1) out.push(op); // a removal: reveals only the record's id
      else { const e = findById(doc[root], p[1]); if (!e || ok(recordCamp(doc, e))) out.push(op); }
    } else if (root === 'approvals') {
      if (p.length === 1 && op.o === 's') out.push(Object.assign({}, op, { v: Array.isArray(op.v) ? op.v.filter(r => requestCamps(doc, r).every(ok)) : op.v }));
      else if (p.length === 1 && op.o === 'ai') { if (requestCamps(doc, op.v).every(ok)) out.push(op); }
      else if (p.length === 1) out.push(op);
      else { const r = findById(doc.approvals, p[1]); if (!r || requestCamps(doc, r).every(ok)) out.push(op); }
    } else {
      out.push(op);
    }
  }
  return out;
}

/**
 * Can a person limited to `allowed` make this change? Checked against the data before the save
 * (`doc`) and the other ops of the same save (a block created in the same save).
 * @returns {string|null} why not
 */
function checkOp(op, allowed, doc, ops) {
  const p = op.p;
  const root = p[0];
  const ok = name => allowed.has(name);
  const other = what => `You can only change your own camp${allowed.size > 1 ? 's' : ''} (${[...allowed].join(', ')}): ${what} belongs to another camp.`;
  const whole = what => `${what} covers every camp: only a portal admin can replace it.`;
  const blockOk = bk => {
    const c = blockCamp(doc, bk, ops);
    return c === null ? ok(CAMP_APP_DEFAULT) : ok(c);
  };
  if (root === 'campList') return 'Camps are added on the portal\'s Users page by a portal admin.';
  if (root === 'BLOCKS_META') {
    if (p.length === 1) return whole('The block list');
    const current = blockCamp(doc, p[1]);
    if (current !== null && !ok(current)) return other(`block ${p[1]}`);
    if (op.o === 's' && p.length === 2 && isObj(op.v) && !ok(op.v.camp || CAMP_APP_DEFAULT)) return other('the camp chosen for this block');
    if (op.o === 's' && p.length === 3 && p[2] === 'camp' && !ok(op.v)) return other('the camp chosen for this block');
    if (current === null && !blockOk(p[1])) return other(`block ${p[1]}`);
    return null;
  }
  if (root === 'campData') {
    if (p.length === 1) return whole('Camp data');
    const k = p[1];
    if (k === '_bathrooms') {
      if (p.length === 2) return whole('The bathroom list');
      return blockOk(p[2]) ? null : other(`block ${p[2]}`);
    }
    if (k === '_hkc' || k === '_profit') {
      if (p.length === 2) return whole(k === '_hkc' ? 'Housekeeping' : 'Location profit');
      return ok(p[2]) ? null : other(`"${p[2]}"`);
    }
    if (k === '_housekeeping') return ok(CAMP_APP_DEFAULT) ? null : other('this housekeeping list');
    if (String(k).charAt(0) === '_') return null;
    return blockOk(k) ? null : other(`block ${k}`);
  }
  if (LOGS.has(root)) {
    if (p.length === 1 && op.o === 's') return whole('The check in/out log');
    if (p.length === 1 && op.o === 'ai') return ok(recordCamp(doc, op.v)) || ok(recordCampAfter(op.v, ops)) ? null : other('this record');
    const e = p.length === 1 ? findById(doc && doc[root], { id: op.id }) : findById(doc && doc[root], p[1]);
    return !e || ok(recordCamp(doc, e)) ? null : other('this record');
  }
  if (root === 'approvals') {
    if (p.length === 1 && op.o === 's') return whole('The approval list');
    if (p.length === 1 && op.o === 'ai') return requestCamps(doc, op.v).every(ok) ? null : other('this request');
    const r = p.length === 1 ? findById(doc && doc.approvals, { id: op.id }) : findById(doc && doc.approvals, p[1]);
    return !r || requestCamps(doc, r).every(ok) ? null : other('this request');
  }
  return null;
}

/** A new record in a block created in the same save. */
function recordCampAfter(e, ops) {
  if (!isObj(e) || e.camp || e.block === undefined) return null;
  return blockCamp(null, e.block, ops);
}

module.exports = { blockCamp, recordCamp, requestCamps, filterDoc, filterOps, checkOp };
