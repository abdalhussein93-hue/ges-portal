'use strict';
/**
 * Daily Costing & Stock.
 * Document: the app's own data object {v, items, categories, groups, costCenters, targets,
 * settings, months, priceChanges}.
 */
const { defineApp, UserError } = require('./common');

const ROOT_KEY = /^[A-Za-z][A-Za-z0-9_]{0,60}$/;

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
  importDocument,
});
