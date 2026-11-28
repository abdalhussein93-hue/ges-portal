'use strict';
/**
 * The portal admin's summary on the home page: the main numbers of every app, per camp, plus what
 * is happening on the portal (who is online, failed sign-ins, blocked changes, latest activity).
 *
 * Read only: everything comes from the data already in memory, the dining scans table and the
 * activity log. Numbers are the same the apps show; nothing is estimated.
 */
const Camps = require('../domain/camps');
const Scope = require('../domain/camp-scope');
const Dining = require('../domain/dining');

const ATTENTION = { 'login-failed': 'failedLogins', 'login-disabled': 'failedLogins', 'change-denied': 'blockedChanges', 'change-conflict': 'conflicts' };
const RECENT = 12;

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Camp Management numbers for one camp (by name). */
function campNumbers(doc, name, day) {
  if (!doc) return null;
  const out = { blocks: 0, beds: 0, occupied: 0, reserved: 0, vacant: 0, checkIns: 0, checkOuts: 0, transfers: 0, pendingApprovals: 0 };
  const meta = isObj(doc.BLOCKS_META) ? doc.BLOCKS_META : {};
  const data = isObj(doc.campData) ? doc.campData : {};
  for (const bk of Object.keys(meta)) {
    if (Scope.blockCamp(doc, bk) !== name) continue;
    out.blocks++;
    const rooms = isObj(data[bk]) && isObj(data[bk].rooms) ? data[bk].rooms : {};
    for (const room of Object.values(rooms)) {
      for (const bed of (room && Array.isArray(room.beds) ? room.beds : [])) {
        const st = (bed && bed.status) || 'vacant';
        out.beds++;
        if (st === 'occupied') out.occupied++;
        else if (st === 'reserved') out.reserved++;
        else if (st === 'vacant') out.vacant++;
      }
    }
  }
  for (const e of Array.isArray(doc.historyLog) ? doc.historyLog : []) {
    if (!e || e.date !== day || Scope.recordCamp(doc, e) !== name) continue;
    if (e.action === 'Check In') out.checkIns++;
    else if (e.action === 'Check Out') out.checkOuts++;
    else if (e.action === 'Transfer') out.transfers++;
  }
  for (const r of Array.isArray(doc.approvals) ? doc.approvals : []) {
    if (r && r.status === 'pending' && Scope.requestCamps(doc, r).includes(name)) out.pendingApprovals++;
  }
  out.occupancy = out.beds ? Math.round(out.occupied / out.beds * 100) : 0;
  return out;
}

/** Manpower: staff by status (the app keeps its list under the key gesStaffV4). */
function manpowerNumbers(doc) {
  const k = doc && isObj(doc.keys) ? doc.keys.gesStaffV4 : null;
  const staff = k && Array.isArray(k.j) ? k.j : null;
  if (!staff) return null;
  const active = staff.filter(s => s && String(s.status || '').toLowerCase() === 'active').length;
  return { total: staff.length, active };
}

/** Daily Costing: today's entry, change requests waiting, last confirmed day. */
function costingNumbers(doc, day) {
  if (!doc) return null;
  const month = day.slice(0, 7), d = String(Number(day.slice(8)));
  const m = isObj(doc.months) ? doc.months[month] : null;
  const dayData = (section) => {
    const s = m && isObj(m[section]) ? m[section] : {};
    const k = Object.keys(s).find(x => String(Number(x)) === d);
    return k ? s[k] : null;
  };
  const filled = v => v !== null && v !== undefined && v !== '' && Number(v) !== 0;
  const cons = dayData('cons');
  const items = new Set();
  if (isObj(cons)) for (const [item, groups] of Object.entries(cons)) if (isObj(groups) && Object.values(groups).some(filled)) items.add(item);
  const recv = dayData('received');
  if (isObj(recv)) for (const [item, q] of Object.entries(recv)) if (filled(q)) items.add(item);
  const locks = isObj(doc.dayLocks) ? doc.dayLocks : {};
  const lockedDays = Object.keys(locks).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
  const today = locks[day];
  return {
    today: today ? 'confirmed' : items.size ? 'in progress' : 'not started',
    confirmedBy: today ? today.by || today.byUser || '' : '',
    itemsToday: items.size,
    pendingRequests: (Array.isArray(doc.dayRequests) ? doc.dayRequests : []).filter(r => r && r.status === 'pending').length,
    lastConfirmed: lockedDays.length ? lockedDays[lockedDays.length - 1] : null,
  };
}

/** Duty Board: departments and staff. */
function dutyNumbers(doc) {
  if (!doc || !Array.isArray(doc.depts)) return null;
  return { depts: doc.depts.length, staff: doc.depts.reduce((n, x) => n + (x && Array.isArray(x.staff) ? x.staff.length : 0), 0) };
}

class SummaryService {
  /** @param {{documents, camps, scans, users, audit, live, now?}} deps */
  constructor({ documents, camps, scans, users, audit, live, now = () => new Date() }) {
    Object.assign(this, { documents, camps, scans, users, audit, live, now });
  }

  doc(appId, campId) {
    const key = Camps.docKey(appId, campId);
    return this.documents.has(key) ? this.documents.get(key).doc : null;
  }

  async build() {
    const at = this.now();
    const { day, hour } = Dining.localParts(at);
    const campDoc = this.doc('camp', null);
    const camps = [];
    for (const c of this.camps.list()) {
      const diningDoc = this.doc('dining', c.id);
      const settings = Dining.settingsOf(diningDoc);
      camps.push({
        id: c.id, name: c.name,
        camp: campNumbers(campDoc, c.name, day),
        dining: diningDoc ? Object.assign({ meal: Dining.mealOf(hour, settings) }, await this.scans.dayCounts(c.id, day)) : null,
        costing: costingNumbers(this.doc('costing', c.id), day),
        manpower: manpowerNumbers(this.doc('manpower', c.id)),
        duty: dutyNumbers(this.doc('duty', c.id)),
      });
    }
    const users = await this.users.list();
    const online = this.live.onlineUsernames();
    const since = new Date(at.getTime() - 24 * 3600 * 1000);
    const counts = { failedLogins: 0, blockedChanges: 0, conflicts: 0, signIns: 0 };
    const recent = await this.audit.recent(500);
    for (const a of recent) {
      if (new Date(a.at) < since) continue;
      if (ATTENTION[a.action]) counts[ATTENTION[a.action]]++;
      if (a.action === 'login') counts.signIns++;
    }
    return {
      at: at.toISOString(), day,
      camps,
      portal: Object.assign({
        users: users.filter(u => !u.disabled).length,
        disabled: users.filter(u => u.disabled).length,
        tempPasswords: users.filter(u => u.mustChange && !u.disabled).length,
        online: users.filter(u => online.has(u.username)).map(u => u.name || u.username),
      }, counts),
      recent: recent.slice(0, RECENT).map(a => ({ at: a.at, username: a.username, appId: a.appId, action: a.action })),
    };
  }
}

module.exports = { SummaryService, campNumbers, costingNumbers, manpowerNumbers, dutyNumbers };
