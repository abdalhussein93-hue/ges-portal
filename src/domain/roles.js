'use strict';
/**
 * Roles inside each app. A user has one role per app (or none = no access).
 */
const ROLES = Object.freeze(['viewer', 'operator', 'admin']);
const RANK = Object.freeze({ viewer: 1, operator: 2, admin: 3 });
const LABELS = Object.freeze({ viewer: 'Viewer', operator: 'Operator', admin: 'Admin' });

function isRole(r) { return ROLES.includes(r); }

/** true if `role` is at least `needed` */
function atLeast(role, needed) {
  return (RANK[role] || 0) >= RANK[needed];
}

module.exports = { ROLES, RANK, LABELS, isRole, atLeast };
