'use strict';
/** The apps available in the portal, in the order shown on the home page. */
const APPS = [require('./camp'), require('./manpower'), require('./costing'), require('./duty')];
const BY_ID = new Map(APPS.map(a => [a.id, a]));

module.exports = {
  list: () => APPS,
  get: id => BY_ID.get(id) || null,
  ids: () => APPS.map(a => a.id),
};
