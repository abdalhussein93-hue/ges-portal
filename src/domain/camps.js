'use strict';
/**
 * Camps - one list for the whole portal.
 *
 *   Camp Management   all camps in one set of data; each person receives only their camps' part
 *   other apps        a separate set of data per camp ("perCamp" apps), stored under docKey(app, camp)
 *
 * The first camp ('gv', Global Village) keeps the data that existed before camps: its documents
 * are stored under the plain app id ('manpower'); every other camp under 'manpower~<camp id>'.
 */

const PRIMARY = 'gv';
/** Camp Management's name for blocks and records that have no camp written on them. */
const CAMP_APP_DEFAULT = 'Global Village';
const SEP = '~';
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

function docKey(appId, campId) {
  return !campId || campId === PRIMARY ? appId : `${appId}${SEP}${campId}`;
}

function parseKey(key) {
  const i = String(key).indexOf(SEP);
  return i < 0 ? { appId: key, campId: PRIMARY } : { appId: key.slice(0, i), campId: key.slice(i + 1) };
}

/** A new camp's id from its name: "Alfarah Asab" -> "alfarah-asab" (unique among `taken`). */
function newId(name, taken) {
  const base = String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'camp';
  let id = ID.test(base) ? base : `camp-${base}`.slice(0, 30);
  for (let n = 2; taken.has(id); n++) id = `${base.slice(0, 26)}-${n}`;
  return id;
}

/** A camp name people can type: 1-60 characters, nothing that could break a page. */
function nameProblem(name) {
  const s = String(name == null ? '' : name).trim();
  if (!s) return 'Enter the camp name.';
  if (s.length > 60) return 'A camp name can be at most 60 characters.';
  if (/[<>"'`\\\u0000-\u001f]/.test(s)) return 'A camp name cannot contain < > " \' ` or \\.';
  return null;
}

/**
 * Which camps a person may use.
 * @param {object} user  {isAdmin, camps: [ids]}
 * @param {{id, name}[]} camps  the portal's camps
 * @returns {{all: boolean, ids: string[], names: string[], list: {id, name}[]}}
 */
function accessFor(user, camps) {
  const all = !!(user && user.isAdmin);
  const own = new Set(user && Array.isArray(user.camps) ? user.camps : []);
  const list = camps.filter(c => all || own.has(c.id));
  return { all, ids: list.map(c => c.id), names: list.map(c => c.name), list: list.map(c => ({ id: c.id, name: c.name })) };
}

module.exports = { PRIMARY, CAMP_APP_DEFAULT, ID, docKey, parseKey, newId, nameProblem, accessFor };
