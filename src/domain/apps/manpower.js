'use strict';
/**
 * GES Manpower System.
 * The app stores text values under keys (gesStaffV4, gesSettings, ...).
 * Document: {keys: {<key>: {j: <parsed JSON>} | {s: <plain text>}}}  - see kv.js
 */
const { defineApp, UserError } = require('./common');
const KV = require('../kv');

const KEY_NAME = /^[A-Za-z0-9_.-]{1,100}$/;

/** Accepts the desktop program's app_data.json: {app, saved, data: {key: text}} */
function importDocument(file) {
  if (file && typeof file === 'object' && file.data && typeof file.data === 'object' && !Array.isArray(file.data)) {
    const keys = Object.keys(file.data);
    if (!keys.length) throw new UserError('This Manpower data file is empty.');
    const bad = keys.find(k => !KEY_NAME.test(k));
    if (bad) throw new UserError(`This file contains an unexpected entry: ${bad.slice(0, 40)}`);
    return KV.toDoc(file.data);
  }
  if (file && Array.isArray(file.staff)) {
    throw new UserError('This is a Manpower backup file. Restore it inside the Manpower app (Settings > Restore) instead.');
  }
  throw new UserError('This is not the GES Manpower app_data.json file.');
}

module.exports = defineApp({
  id: 'manpower',
  perCamp: true, // a separate set of data per camp (see domain/camps.js)
  name: 'GES Manpower',
  description: 'Staff list, transfers and resignations, vacation plan, monthly timesheet and salary.',
  icon: 'ti-users-group',
  color: '#059669',
  path: '/manpower/',
  textMode: 'markup',
  seedFile: 'manpower.json',
  files: {
    workbook: { maxBytes: 40 * 1024 * 1024, writeRole: 'operator', label: 'Timesheet workbook (.xlsx)' },
  },
  isRootKey: k => k === 'keys',
  importDocument,
});
