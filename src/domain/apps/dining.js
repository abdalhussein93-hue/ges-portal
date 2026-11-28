'use strict';
/**
 * Dining Halls Management: barcode / NFC cards, people, companies and gate scanning.
 *
 * The document holds the setup (see domain/dining.js); every scan is a row in dining_scans,
 * written by the server (services/dining.js), never by the browser.
 *   Admin     people, cards, companies, settings, reports, letting people in again
 *   Operator  security guard: scans at the gate (cannot change the setup)
 *   Viewer    reports only
 */
const { defineApp, UserError } = require('./common');
const { describePath } = require('../operations');
const Dining = require('../dining');

const ROOT_KEYS = new Set(['version', 'nextBarcode', 'people', 'companies', 'settings']);

function checkPermission(role, op) {
  if (role === 'admin') return null;
  if (role === 'operator') return `Only an Admin of Dining Halls can change people, cards, companies or settings (${describePath(op.p)}).`;
  return 'Your account can only view this app.';
}

/** The new app's own setup file, or a backup file of the old offline app. */
function importDocument(file) {
  if (file && typeof file === 'object' && Array.isArray(file.people) && file.settings && !file.entryLog) {
    const doc = {};
    for (const k of ROOT_KEYS) if (k in file) doc[k] = file[k];
    return doc;
  }
  const legacy = Dining.fromLegacyBackup(file);
  if (!legacy) throw new UserError('This is not a Dining Halls / Mess Hall backup file (it has no people and no scan log).');
  return legacy.doc;
}

module.exports = defineApp({
  id: 'dining',
  name: 'Dining Halls Management',
  description: 'Dining hall gates: barcode and NFC cards, scanning on phones, one meal per person, live counts and meal reports.',
  icon: 'ti-tools-kitchen-2',
  color: '#b45309',
  path: '/dining/',
  textMode: 'markup',
  isRootKey: k => ROOT_KEYS.has(k),
  checkPermission,
  importDocument,
  ROOT_KEYS,
});
