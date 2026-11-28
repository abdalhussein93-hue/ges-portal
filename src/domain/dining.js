'use strict';
/**
 * Dining Halls Management - rules shared by the app definition, the scan service and the import.
 *
 * Setup document (saved like the other apps' data, changed only by Admins):
 *   { version, nextBarcode, people: [{id, name, company, room, hall, barcode, allowed}], companies: [..],
 *     settings: {entryRule, lunchFrom, dinnerFrom, allowUnregistered} }
 *   Card barcodes are MH00001 ... MH(nextBarcode - 1); a card belongs to the person who has its barcode.
 * Scans are not in the document: each one is a row in the dining_scans table.
 */

const TIME_ZONE = 'Asia/Dubai';
const HALLS = Object.freeze([
  { id: 'Senior', label: 'Senior Mess' },
  { id: 'Junior', label: 'Junior Mess' },
  { id: 'Worker1', label: 'Worker 1' },
  { id: 'Worker2', label: 'Worker 2' },
  { id: 'Worker3', label: 'Worker 3' },
  { id: 'Worker4', label: 'Worker 4' },
  { id: 'Worker5', label: 'Worker 5' },
]);
const HALL_IDS = new Set(HALLS.map(h => h.id));
const MEALS = Object.freeze(['Breakfast', 'Lunch', 'Dinner']);
const DEFAULT_SETTINGS = Object.freeze({ entryRule: 'meal', lunchFrom: 11, dinnerFrom: 17, allowUnregistered: true });
const FIRST_POOL = 1000; // the old app started with 1000 cards
const MAX_BARCODE = 64;

const PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
});

/** Calendar day (YYYY-MM-DD) and hour (0-23) in camp time. */
function localParts(date) {
  const p = {};
  for (const x of PARTS.formatToParts(date)) p[x.type] = x.value;
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}

function isDay(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}

/** The settings with defaults filled in and anything invalid replaced. */
function settingsOf(doc) {
  const s = Object.assign({}, DEFAULT_SETTINGS, (doc && doc.settings) || {});
  const out = Object.assign({}, DEFAULT_SETTINGS);
  if (s.entryRule === 'day' || s.entryRule === 'meal') out.entryRule = s.entryRule;
  const lunch = Number(s.lunchFrom), dinner = Number(s.dinnerFrom);
  if (Number.isInteger(lunch) && Number.isInteger(dinner) && lunch >= 1 && lunch < dinner && dinner <= 23) {
    out.lunchFrom = lunch; out.dinnerFrom = dinner;
  }
  out.allowUnregistered = s.allowUnregistered !== false;
  return out;
}

/** Breakfast until lunch time, Lunch until dinner time, then Dinner. */
function mealOf(hour, settings) {
  if (hour < settings.lunchFrom) return 'Breakfast';
  if (hour < settings.dinnerFrom) return 'Lunch';
  return 'Dinner';
}

/** One entry per meal, or one per day. */
function slotOf(meal, settings) {
  return settings.entryRule === 'day' ? 'Day' : meal;
}

/** Barcode as stored and compared: no spaces, upper case. '' if it cannot be a barcode. */
function normBarcode(value) {
  const s = String(value == null ? '' : value).replace(/\s+/g, '').toUpperCase();
  if (!s || s.length > MAX_BARCODE || /[\u0000-\u001f<>"'`\\]/.test(s)) return '';
  return s;
}

function poolCode(n) { return 'MH' + String(n).padStart(5, '0'); }
function poolNumber(code) {
  const m = /^MH(\d{1,9})$/.exec(normBarcode(code));
  return m ? Number(m[1]) : 0;
}

const INDEX = new WeakMap(); // people array -> Map(barcode -> person)
/** The person holding this card, or null. */
function findPerson(doc, code) {
  const people = doc && Array.isArray(doc.people) ? doc.people : [];
  let map = INDEX.get(people);
  if (!map) {
    map = new Map();
    for (const p of people) {
      const b = p && normBarcode(p.barcode);
      if (b && !map.has(b)) map.set(b, p);
    }
    INDEX.set(people, map);
  }
  return map.get(code) || null;
}

/** The old app called the first worker hall "Worker". */
function legacyHall(name) {
  const s = String(name == null ? '' : name).trim();
  return s === 'Worker' ? 'Worker1' : s;
}

function text(v, max = 200) { return String(v == null ? '' : v).trim().slice(0, max); }

/**
 * Reads a backup file of the old offline app (mess_backup_YYYY-MM-DD.json):
 *   {barcodePool, people, companies, entryLog, entries}
 * @returns {{doc: object, scans: object[]}} the setup document and the scan records
 *   (rows ready for dining_scans; legacyKey matches the old app's own duplicate check)
 */
function fromLegacyBackup(file, settings = DEFAULT_SETTINGS) {
  if (!file || typeof file !== 'object' || (!Array.isArray(file.people) && !Array.isArray(file.entryLog))) {
    return null;
  }
  const people = [];
  const seenIds = new Set(), seenCards = new Set();
  for (const p of Array.isArray(file.people) ? file.people : []) {
    if (!p || typeof p !== 'object') continue;
    const barcode = normBarcode(p.barcode);
    let id = text(p.id, 40);
    if (!barcode || seenCards.has(barcode)) continue;
    if (!id || seenIds.has(id)) id = `p${people.length + 1}_${barcode}`;
    seenIds.add(id); seenCards.add(barcode);
    people.push({ id, name: text(p.name), company: text(p.company), room: text(p.room, 40), hall: legacyHall(p.category || p.hall), barcode, allowed: p.allowed !== false });
  }
  let top = FIRST_POOL;
  for (const b of Array.isArray(file.barcodePool) ? file.barcodePool : []) top = Math.max(top, poolNumber(b && b.barcode));
  for (const p of people) top = Math.max(top, poolNumber(p.barcode));
  const companies = [...new Set((Array.isArray(file.companies) ? file.companies : []).map(c => text(c)).filter(Boolean))].sort();

  const scans = [];
  for (const e of Array.isArray(file.entryLog) ? file.entryLog : []) {
    if (!e || typeof e !== 'object') continue;
    const time = Number(e.time);
    const barcode = normBarcode(e.barcode);
    if (!Number.isFinite(time) || time <= 0 || !barcode || (e.status !== 'allowed' && e.status !== 'denied')) continue;
    const at = new Date(time);
    const { day, hour } = localParts(at);
    const meal = mealOf(hour, settings);
    const name = text(e.name);
    scans.push({
      at, day, meal, slot: meal, hall: legacyHall(e.mess), barcode, personId: null,
      name: name === 'Unknown' ? '' : name, company: text(e.company), room: '',
      status: e.status, reason: text(e.note), scannedBy: '', scannedByName: text(e.scannedBy, 80),
      legacyKey: `${e.barcode}_${e.time}_${e.mess}_${e.status}`.slice(0, 300),
    });
  }
  const doc = { version: 1, nextBarcode: top + 1, people, companies, settings: Object.assign({}, DEFAULT_SETTINGS) };
  return { doc, scans };
}

module.exports = {
  TIME_ZONE, HALLS, HALL_IDS, MEALS, DEFAULT_SETTINGS, FIRST_POOL,
  localParts, isDay, settingsOf, mealOf, slotOf, normBarcode, poolCode, poolNumber, findPerson, legacyHall, fromLegacyBackup,
};
