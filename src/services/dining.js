'use strict';
/**
 * Dining Halls Management - the gate decision, counts, reports and imports.
 *
 * Every scan is decided here on the server (never on the phone), so all gates see the same
 * entries: a person refused at one gate is refused at every gate. The database's unique index
 * refuses a second entry even if two gates scan the same card at the same moment.
 *
 * Every camp has its own Dining Halls: its own setup (people, cards, settings) and its own scans.
 * Each method takes the camp id first.
 */
const { UserError } = require('../domain/apps/common');
const { cleanValue } = require('../domain/text');
const Dining = require('../domain/dining');
const Camps = require('../domain/camps');

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

  key(campId) { return Camps.docKey(APP_ID, campId); }

  setup(campId) {
    const { doc } = this.documents.get(this.key(campId));
    if (!doc) throw new UserError('Dining Halls has not been set up yet. An Admin of this app must open it first.', 409);
    return doc;
  }

  /** Today in camp time, the current meal and the settings. */
  clock(campId) {
    const doc = this.documents.get(this.key(campId)).doc;
    const settings = Dining.settingsOf(doc);
    const at = this.now();
    const { day, hour } = Dining.localParts(at);
    const meal = Dining.mealOf(hour, settings);
    return { at, day, meal, slot: Dining.slotOf(meal, settings), settings };
  }

  /**
   * One scan at a gate.
   * @param {{hall: string, barcode: string, method?: 'code'|'nfc', decision?: 'allow'|'deny'}} input
   *   barcode: what was read - a card barcode, or an NFC tag id (or the card barcode written on the tag)
   *   decision: the guard's answer for a card that belongs to nobody
   * @returns {Promise<object>} {result: 'allowed'|'denied'|'unregistered', code, title, reason, person, previousAt, counts}
   */
  async scan(campId, user, role, input) {
    const hall = String((input && input.hall) || '');
    if (!Dining.HALL_IDS.has(hall)) throw new UserError('Choose the dining hall first.');
    const read = Dining.normBarcode(input && input.barcode);
    if (!read) throw new UserError('This is not a valid barcode.');
    const method = input && input.method === 'nfc' ? 'nfc' : 'code';
    const decision = input && input.decision;
    if (decision !== undefined && decision !== 'allow' && decision !== 'deny') throw new UserError('Bad request.');

    const doc = this.setup(campId);
    const { at, day, meal, slot, settings } = this.clock(campId);
    const person = Dining.findPerson(doc, read);
    // one person = one card: an NFC tag counts as the card it is linked to
    const barcode = person ? Dining.normBarcode(person.barcode) || read : read;
    const base = {
      campId, at, day, meal, slot, hall, barcode, method, personId: person ? String(person.id) : null,
      name: person ? person.name || '' : '', company: person ? person.company || '' : '', room: person ? person.room || '' : '',
      scannedBy: user.username, scannedByName: user.name || user.username, source: 'scan',
    };
    const entryKey = { campId, day, hall, barcode, slot: settings.entryRule === 'day' ? null : slot };
    const deny = (code, title, reason, previousAt) => this.record(base, { status: 'denied', reason }, { code, title, reason, person, previousAt });
    const allow = async (code, title, reason) => {
      const row = await this.scans.insert(Object.assign({}, base, { status: 'allowed', reason }));
      if (row) return this.answer(campId, row, { code, title, reason, person }, day);
      const first = await this.scans.findEntry(entryKey); // another gate let this card in a moment ago
      return deny('already', 'ALREADY ENTERED', this.alreadyText(meal, settings), first && first.at);
    };

    if (!person) {
      if (!decision) return { result: 'unregistered', barcode, hall, meal, method, canAllow: settings.allowUnregistered || role === 'admin' };
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
    return this.answer(base.campId, row, view, base.day);
  }

  async answer(campId, row, view, day) {
    const counts = await this.scans.dayCounts(campId, day);
    this.live.broadcast(this.key(campId), 'scan', { hall: row.hall, status: row.status, by: row.scannedBy });
    return {
      result: row.status, code: view.code, title: view.title, reason: view.reason, at: row.at, id: row.id,
      hall: row.hall, meal: row.meal, barcode: row.barcode, method: row.method, person: personView(view.person),
      previousAt: view.previousAt || null, counts,
    };
  }

  /** Numbers for today (camp time). */
  async today(campId) {
    const { day, meal, settings } = this.clock(campId);
    const counts = await this.scans.dayCounts(campId, day);
    return { day, meal, entryRule: settings.entryRule, counts };
  }

  /** Scan records, newest first. */
  async list(campId, query) {
    const f = Object.assign(this.filter(query, false), { campId });
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
  async report(campId, query) {
    const { from, to } = this.filter(query, true);
    if (daysBetween(from, to) > MAX_REPORT_DAYS) throw new UserError(`Choose at most ${MAX_REPORT_DAYS} days.`);
    const r = await this.scans.report(campId, from, to);
    return { from, to, halls: Dining.HALLS, meals: Dining.MEALS, daily: r.daily, byCompany: r.byCompany, firstDay: await this.scans.firstDay(campId) };
  }

  /** Writes every scan in the range as CSV (Excel opens it). */
  async exportCsv(campId, query, write) {
    const f = Object.assign(this.filter(query, true), { campId });
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
  async release(campId, user, hall, ip) {
    if (hall && !Dining.HALL_IDS.has(hall)) throw new UserError('Unknown dining hall.');
    const { day } = this.clock(campId);
    const n = await this.scans.release({ campId, day, hall: hall || null, username: user.username });
    await this.audit.record({ username: user.username, appId: this.key(campId), action: 'dining-release', details: { day, hall: hall || 'all', entries: n }, ip });
    this.live.broadcast(this.key(campId), 'scan', { hall: hall || '', status: 'released', by: user.username });
    return { day, released: n };
  }

  /**
   * Admin: brings in backup files of the old offline app. Scan records from every file are merged
   * (a record already imported is skipped). `setupFrom` = index of the file whose people, cards and
   * companies replace the current setup (-1 = keep the current setup).
   */
  async importBackups(campId, user, files, setupFrom, ip) {
    if (!Array.isArray(files) || !files.length || files.length > 50) throw new UserError('Choose 1 to 50 backup files.');
    const key = this.key(campId);
    const settings = Dining.settingsOf(this.documents.get(key).doc);
    const parsed = files.map((f, i) => {
      const r = Dining.fromLegacyBackup(f && f.content, settings);
      if (!r) throw new UserError(`"${String((f && f.name) || `file ${i + 1}`).slice(0, 80)}" is not a Mess Hall backup file.`);
      return r;
    });
    let setupRev = null;
    if (Number.isInteger(setupFrom) && setupFrom >= 0) {
      if (!parsed[setupFrom]) throw new UserError('Choose which file the people and cards come from.');
      const current = this.documents.get(key).doc;
      const doc = cleanValue(parsed[setupFrom].doc, 'markup').value;
      if (current && current.settings) doc.settings = current.settings; // keep the settings already chosen
      setupRev = await this.documents.replace(key, user.username, doc, `backup file ${String(files[setupFrom].name || '').slice(0, 80)}`);
      this.live.broadcast(key, 'change', { rev: setupRev, by: user.username, clientId: '' });
    }
    const byKey = new Map(); // the same record in two files counts once
    for (const p of parsed) {
      for (const s of p.scans) {
        if (!byKey.has(s.legacyKey)) byKey.set(s.legacyKey, Object.assign({}, s, cleanValue({ name: s.name, company: s.company, reason: s.reason, scannedByName: s.scannedByName }, 'markup').value));
      }
    }
    const records = parsed.reduce((n, p) => n + p.scans.length, 0);
    const added = await this.scans.insertImported(campId, [...byKey.values()]);
    await this.audit.record({ username: user.username, appId: key, action: 'dining-import', details: { files: files.length, records, added, setupRev }, ip });
    if (added) this.live.broadcast(key, 'scan', { hall: '', status: 'imported', by: user.username });
    return { files: files.length, records, added, skipped: records - added, people: setupRev ? parsed[setupFrom].doc.people.length : null, setupRev };
  }

  /**
   * Admin: a full backup file - people, cards, companies, settings and the scan records of the chosen
   * dates (all dates when none are given). Same layout as the old Mess Hall app's backup, so it can
   * be brought back in here ("Bring in backups": nothing is counted twice) or opened by the old app.
   * Written in pieces, so a year of scans never has to fit in memory.
   */
  async backup(campId, campName, query, write) {
    const f = { campId };
    if (query.get('from') || query.get('to')) Object.assign(f, this.filter(query, true));
    const doc = this.setup(campId);
    const settings = Dining.settingsOf(doc);
    const next = Math.max(Number(doc.nextBarcode) || 0, Dining.FIRST_POOL + 1);
    const people = (doc.people || []).map(p => Object.assign({}, p, { category: p.hall }));
    const owner = new Map(people.map(p => [Dining.normBarcode(p.barcode), p.id]));
    const pool = [];
    for (let i = 1; i < next; i++) {
      const code = Dining.poolCode(i);
      pool.push({ barcode: code, assigned: owner.has(code), personId: owner.has(code) ? owner.get(code) : null });
    }
    const head = {
      version: 1, app: 'Dining Halls Management', camp: campName, date: this.now().toISOString(),
      range: f.from ? { from: f.from, to: f.to } : 'all', settings, nextBarcode: next,
      companies: doc.companies || [], people, barcodePool: pool, entries: {},
    };
    let s = JSON.stringify(head);
    await write(s.slice(0, -1) + ',"entryLog":[');
    let first = true;
    await this.scans.each(f, rows => {
      const part = rows.map(r => JSON.stringify({
        id: r.id, time: Date.parse(r.at), barcode: r.barcode, name: r.name || 'Unknown', company: r.company, room: r.room,
        mess: r.hall, meal: r.meal, status: r.status, note: r.reason, scannedBy: r.scannedByName || r.scannedBy,
        method: r.method, source: r.source, released: r.released,
      })).join(',');
      s = (first ? '' : ',') + part;
      first = false;
      return write(s);
    });
    await write(']}');
  }
}

module.exports = { DiningService, APP_ID };
