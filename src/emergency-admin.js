'use strict';
/**
 * TEMPORARY EMERGENCY ADMIN - remove this once the admin can sign in normally.
 *
 * On every start the server makes sure this account exists, is enabled, is a portal admin
 * (Admin in every app) and has this password. Anyone who can read this repository knows
 * this password, so:
 *   - keep the GitHub repository private;
 *   - after signing in, set the Railway variable EMERGENCY_ADMIN=off (or delete this file and its
 *     use in src/server.js) and then change the admin password on the portal.
 * While it is on, every restart resets this account's password to the one below.
 */
module.exports = Object.freeze({
  username: 'admin',
  password: 'admin@123',
});
