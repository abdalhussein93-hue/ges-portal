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

/** Leaving the company (the Manpower app's MV_STATS). */
const MOVEMENTS = new Set(['Resigned', 'Terminated', 'Transferred', 'Other Location', 'Visa Issue']);

/**
 * Manpower, counted exactly like the app's own "Main List" (updateStats / countsInMain):
 * departments switched off in its settings are not counted; people leaving count until their
 * notice ends (inMainList); people on leave today are left out unless the setting says otherwise.
 * `today` is the app's day (UTC date, as the app uses).
 */
function manpowerNumbers(doc, today) {
  const keys = doc && isObj(doc.keys) ? doc.keys : null;
  const staff = keys && keys.gesStaffV4 && Array.isArray(keys.gesStaffV4.j) ? keys.gesStaffV4.j : null;
  if (!staff) return null;
  const settings = keys.gesSettings && isObj(keys.gesSettings.j) ? keys.gesSettings.j : {};
  const deptOn = keys.gesDeptCount && isObj(keys.gesDeptCount.j) ? keys.gesDeptCount.j : {};
  const out = { total: staff.length, mainList: 0, onLeave: 0, leaving: 0 };
  for (const s of staff) {
    if (!isObj(s) || deptOn[s.dept] === false) continue;
    const moving = !!(s.movementType && MOVEMENTS.has(s.movementType));
    if (moving) out.leaving++;
    if (moving && s.inMainList === false) continue;
    const onLeave = !!(s.onVacation && s.vacationStart && s.vacationStart <= today);
    if (onLeave) out.onLeave++;
    if (!onLeave || settings.countVac === true) out.mainList++;
  }
  return out;
}

/**
 * Camp Management blocks whose camp is not one of the camps in use (deleted or unknown):
 * nobody can see them in the app. [{name, blocks, beds, occupied}]
 */
function hiddenBlocks(doc, activeNames) {
  if (!doc || !isObj(doc.BLOCKS_META)) return [];
  const active = new Set(activeNames);
  const by = new Map();
  for (const bk of Object.keys(doc.BLOCKS_META)) {
    const name = Scope.blockCamp(doc, bk);
    if (active.has(name)) continue;
    const g = by.get(name) || { name, blocks: 0, beds: 0, occupied: 0 };
    g.blocks++;
    const rooms = isObj(doc.campData) && isObj(doc.campData[bk]) && isObj(doc.campData[bk].rooms) ? Object.values(doc.campData[bk].rooms) : [];
    for (const r of rooms) for (const b of (r && Array.isArray(r.beds) ? r.beds : [])) { g.beds++; if (b && b.status === 'occupied') g.occupied++; }
    by.set(name, g);
  }
  return [...by.values()];
}

/** Items with figures entered on a day (consumption or received). */
function itemsEntered(doc, day) {
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
  return items.size;
}

function previousDay(day) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Daily Costing: today's and yesterday's entry, change requests waiting, last confirmed day. */
function costingNumbers(doc, day) {
  if (!doc) return null;
  const locks = isObj(doc.dayLocks) ? doc.dayLocks : {};
  const lockedDays = Object.keys(locks).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
  const status = (dd, n) => (locks[dd] ? 'confirmed' : n ? 'in progress' : 'not started');
  const itemsToday = itemsEntered(doc, day);
  const yesterday = previousDay(day);
  const itemsYesterday = itemsEntered(doc, yesterday);
  const today = locks[day];
  return {
    today: status(day, itemsToday),
    yesterday: status(yesterday, itemsYesterday),
    confirmedBy: today ? today.by || today.byUser || '' : '',
    itemsToday,
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
        manpower: manpowerNumbers(this.doc('manpower', c.id), at.toISOString().slice(0, 10)),
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
    const deleted = new Map(this.camps.deleted().map(c => [c.name, c.id]));
    const hidden = hiddenBlocks(campDoc, this.camps.list().map(c => c.name))
      .map(h => Object.assign(h, { deletedCampId: deleted.get(h.name) || null }));
    return {
      at: at.toISOString(), day,
      camps,
      hiddenBlocks: hidden,
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

module.exports = { SummaryService, campNumbers, costingNumbers, manpowerNumbers, dutyNumbers, hiddenBlocks };
