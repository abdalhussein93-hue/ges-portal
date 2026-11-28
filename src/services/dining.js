'use strict';
/**
 * Dining Halls Management - the gate decision, counts, reports and imports.
 *
 * Every scan is decided here on the server (never on the phone), so all gates see the same
 * entries: a person refused at one gate is refused at every gate. The database's unique index
 * refuses a second entry even if two gates scan the same card at the same moment.
 */
const { UserError } = require('../domain/apps/common');
const { cleanValue } = require('../domain/text');
const Dining = require('../domain/dining');

const APP_ID = 'dining';
const MAX_LIST = 200;
const MAX_REPORT_DAYS = 400;

function personView(p) {
  return p ? { id: String(p.id), name: p.name || '', company: p.company || '', room: p.room || '', hall: p.hall || '', barcode: p.barcode || '', allowed: p.allowed !== false } : null;
}

function hallLabel(id) {
  const h = Dining.HALLS.find(x => x.id === id);
  return h ? h.label : id;
}

function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

class DiningService {
  /** @param {{scans, documents, live, audit, now?: () => Date}} deps */
  constructor({ scans, documents, live, audit, now = () => new Date() }) {
    this.scans = scans;
    this.documents = documents;
    this.live = live;
    this.audit = audit;
    this.now = now;
  }

  setup() {
    const { doc } = this.documents.get(APP_ID);
    if (!doc) throw new UserError('Dining Halls has not been set up yet. An Admin of this app must open it first.', 409);
    return doc;
  }

  /** Today in camp time, the current meal and the settings. */
  clock() {
    const doc = this.documents.get(APP_ID).doc;
    const settings = Dining.settingsOf(doc);
    const at = this.now();
    const { day, hour } = Dining.localParts(at);
    const meal = Dining.mealOf(hour, settings);
    return { at, day, meal, slot: Dining.slotOf(meal, settings), settings };
  }

  /**
   * One scan at a gate.
   * @param {{hall: string, barcode: string, decision?: 'allow'|'deny'}} input
   *   decision: the guard's answer for a card that belongs to nobody
   * @returns {Promise<object>} {result: 'allowed'|'denied'|'unregistered', code, title, reason, person, previousAt, counts}
   */
  async scan(user, role, input) {
    const hall = String((input && input.hall) || '');
    if (!Dining.HALL_IDS.has(hall)) throw new UserError('Choose the dining hall first.');
    const barcode = Dining.normBarcode(input && input.barcode);
    if (!barcode) throw new UserError('This is not a valid barcode.');
    const decision = input && input.decision;
    if (decision !== undefined && decision !== 'allow' && decision !== 'deny') throw new UserError('Bad request.');

    const doc = this.setup();
    const { at, day, meal, slot, settings } = this.clock();
    const person = Dining.findPerson(doc, barcode);
    const base = {
      at, day, meal, slot, hall, barcode, personId: person ? String(person.id) : null,
      name: person ? person.name || '' : '', company: person ? person.company || '' : '', room: person ? person.room || '' : '',
      scannedBy: user.username, scannedByName: user.name || user.username, source: 'scan',
    };
    const entryKey = { day, hall, barcode, slot: settings.entryRule === 'day' ? null : slot };
    const deny = (code, title, reason, previousAt) => this.record(base, { status: 'denied', reason }, { code, title, reason, person, previousAt });
    const allow = async (code, title, reason) => {
      const row = await this.scans.insert(Object.assign({}, base, { status: 'allowed', reason }));
      if (row) return this.answer(row, { code, title, reason, person }, day);
      const first = await this.scans.findEntry(entryKey); // another gate let this card in a moment ago
      return deny('already', 'ALREADY ENTERED', this.alreadyText(meal, settings), first && first.at);
    };

    if (!person) {
      if (!decision) return { result: 'unregistered', barcode, hall, meal, canAllow: settings.allowUnregistered || role === 'admin' };
      if (decision === 'deny') return deny('manual-deny', 'DENIED', 'Card not registered - denied by security');
      if (!settings.allowUnregistered && role !== 'admin') {
        throw new UserError('Letting in cards that are not registered is switched off. Ask an Admin.', 403);
      }
      const first = await this.scans.findEntry(entryKey);
      if (first) return deny('already', 'ALREADY ENTERED', this.alreadyText(meal, settings) + ' (card not registered)', first.at);
      return allow('manual-allow', 'MANUALLY ALLOWED', 'Card not registered - allowed by security');
    }
    if (person.allowed === false) return deny('blocked', 'ACCESS DENIED', 'Blocked by the Admin');
    if (person.hall !== hall) return deny('wrong-hall', 'WRONG DINING HALL', `Belongs to ${hallLabel(person.hall)}`);
    const first = await this.scans.findEntry(entryKey);
    if (first) return deny('already', 'ALREADY ENTERED', this.alreadyText(meal, settings), first.at);
    return allow('ok', 'ACCESS GRANTED', `Welcome to ${hallLabel(hall)}`);
  }

  alreadyText(meal, settings) {
    return settings.entryRule === 'day' ? 'Already entered today' : `Already entered for ${meal.toLowerCase()} today`;
  }

  async record(base, extra, view) {
    const row = await this.scans.insert(Object.assign({}, base, extra));
    return this.answer(row, view, base.day);
  }

  async answer(row, view, day) {
    const counts = await this.scans.dayCounts(day);
    this.live.broadcast(APP_ID, 'scan', { hall: row.hall, status: row.status, by: row.scannedBy });
    return {
      result: row.status, code: view.code, title: view.title, reason: view.reason, at: row.at, id: row.id,
      hall: row.hall, meal: row.meal, barcode: row.barcode, person: personView(view.person),
      previousAt: view.previousAt || null, counts,
    };
  }

  /** Numbers for today (camp time). */
  async today() {
    const { day, meal, settings } = this.clock();
    const counts = await this.scans.dayCounts(day);
    return { day, meal, entryRule: settings.entryRule, counts };
  }

  /** Scan records, newest first. */
  async list(query) {
    const f = this.filter(query, false);
    const limit = Math.min(Math.max(Number(query.get('limit')) || 100, 1), MAX_LIST);
    const beforeId = Number(query.get('beforeId'));
    if (Number.isInteger(beforeId) && beforeId > 0) f.beforeId = beforeId;
    return this.scans.list(f, limit);
  }

  /** Filters from the URL, checked. */
  filter(query, needRange) {
    const f = {};
    const from = query.get('from'), to = query.get('to');
    if (from || to || needRange) {
      if (!Dining.isDay(from) || !Dining.isDay(to) || from > to) throw new UserError('Choose a valid date range.');
      f.from = from; f.to = to;
    }
    const hall = query.get('hall');
    if (hall) { if (!Dining.HALL_IDS.has(hall)) throw new UserError('Unknown dining hall.'); f.hall = hall; }
    const status = query.get('status');
    if (status) { if (status !== 'allowed' && status !== 'denied') throw new UserError('Bad status.'); f.status = status; }
    const q = String(query.get('q') || '').trim().slice(0, 60);
    if (q) f.q = q;
    return f;
  }

  /** Meals per day / meal / hall and per company, for a date range. */
  async report(query) {
    const { from, to } = this.filter(query, true);
    if (daysBetween(from, to) > MAX_REPORT_DAYS) throw new UserError(`Choose at most ${MAX_REPORT_DAYS} days.`);
    const r = await this.scans.report(from, to);
    return { from, to, halls: Dining.HALLS, meals: Dining.MEALS, daily: r.daily, byCompany: r.byCompany, firstDay: await this.scans.firstDay() };
  }

  /** Writes every scan in the range as CSV (Excel opens it). */
  async exportCsv(query, write) {
    const f = this.filter(query, true);
    const cell = v => {
      let s = String(v == null ? '' : v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // never a formula in Excel
      return '"' + s.replace(/"/g, '""') + '"';
    };
    await write('﻿' + ['Date', 'Time', 'Meal', 'Dining hall', 'Status', 'Name', 'Company', 'Room', 'Barcode', 'Reason', 'Scanned by', 'Source'].join(',') + '\r\n');
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: Dining.TIME_ZONE, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    await this.scans.each(f, rows => write(rows.map(r => [
      r.day, time.format(new Date(r.at)), r.meal, hallLabel(r.hall), r.status, r.name, r.company, r.room, r.barcode,
      r.reason + (r.released ? ' (let in again by Admin)' : ''), r.scannedByName || r.scannedBy, r.source,
    ].map(cell).join(',')).join('\r\n') + '\r\n'));
  }

  /** Admin: lets people in again today (one hall or all). */
  async release(user, hall, ip) {
    if (hall && !Dining.HALL_IDS.has(hall)) throw new UserError('Unknown dining hall.');
    const { day } = this.clock();
    const n = await this.scans.release({ day, hall: hall || null, username: user.username });
    await this.audit.record({ username: user.username, appId: APP_ID, action: 'dining-release', details: { day, hall: hall || 'all', entries: n }, ip });
    this.live.broadcast(APP_ID, 'scan', { hall: hall || '', status: 'released', by: user.username });
    return { day, released: n };
  }

  /**
   * Admin: brings in backup files of the old offline app. Scan records from every file are merged
   * (a record already imported is skipped). `setupFrom` = index of the file whose people, cards and
   * companies replace the current setup (-1 = keep the current setup).
   */
  async importBackups(user, files, setupFrom, ip) {
    if (!Array.isArray(files) || !files.length || files.length > 50) throw new UserError('Choose 1 to 50 backup files.');
    const settings = Dining.settingsOf(this.documents.get(APP_ID).doc);
    const parsed = files.map((f, i) => {
      const r = Dining.fromLegacyBackup(f && f.content, settings);
      if (!r) throw new UserError(`"${String((f && f.name) || `file ${i + 1}`).slice(0, 80)}" is not a Mess Hall backup file.`);
      return r;
    });
    let setupRev = null;
    if (Number.isInteger(setupFrom) && setupFrom >= 0) {
      if (!parsed[setupFrom]) throw new UserError('Choose which file the people and cards come from.');
      const current = this.documents.get(APP_ID).doc;
      const doc = cleanValue(parsed[setupFrom].doc, 'markup').value;
      if (current && current.settings) doc.settings = current.settings; // keep the settings already chosen
      setupRev = await this.documents.replace(APP_ID, user.username, doc, `old app backup ${String(files[setupFrom].name || '').slice(0, 80)}`);
      this.live.broadcast(APP_ID, 'change', { rev: setupRev, by: user.username, clientId: '' });
    }
    const all = parsed.flatMap(p => p.scans.map(s => Object.assign({}, s, cleanValue({ name: s.name, company: s.company, reason: s.reason, scannedByName: s.scannedByName }, 'markup').value)));
    const added = await this.scans.insertImported(all);
    await this.audit.record({ username: user.username, appId: APP_ID, action: 'dining-import', details: { files: files.length, records: all.length, added, setupRev }, ip });
    if (added) this.live.broadcast(APP_ID, 'scan', { hall: '', status: 'imported', by: user.username });
    return { files: files.length, records: all.length, added, skipped: all.length - added, people: setupRev ? parsed[setupFrom].doc.people.length : null, setupRev };
  }
}

module.exports = { DiningService, APP_ID };
