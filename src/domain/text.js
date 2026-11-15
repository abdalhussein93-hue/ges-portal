'use strict';
/**
 * Cleaning of text saved by users, so that one user cannot plant code that runs in
 * another user's browser (the original apps build their screens from text without
 * escaping it everywhere).
 *
 * Nothing is deleted: dangerous characters are swapped for look-alikes, so the text keeps
 * its meaning ("12" pipe" stays readable as 12” pipe).
 *
 *   'strict' - for apps that put text inside value="..." attributes and onclick="f('...')"
 *              handlers (Camp):  < > " ' and entity-like &  ->  ‹ › ” ’ ＆
 *   'markup' - for apps that escape attributes themselves (Manpower, Costing):  < >  ->  ‹ ›
 * Invisible control characters (not tab / new line) are removed.
 */

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;
const LOOK_ALIKE = { '<': '‹', '>': '›', '"': '”', "'": '’' };

const CLEANERS = {
  strict: s => s
    .replace(/[<>"']/g, c => LOOK_ALIKE[c])
    .replace(/&(?=#|[a-zA-Z][a-zA-Z0-9]*;)/g, '＆')
    .replace(CONTROL_CHARS, ''),
  markup: s => s.replace(/[<>]/g, c => LOOK_ALIKE[c]).replace(CONTROL_CHARS, ''),
};

function cleanerFor(mode) {
  const fn = CLEANERS[mode];
  if (!fn) throw new Error(`Unknown text cleaning mode: ${mode}`);
  return fn;
}

/** True if `key` is safe to use as an object key / path segment. */
function isSafeKey(key, mode = 'strict') {
  return typeof key === 'string' && key.length <= 200 && !FORBIDDEN_KEYS.has(key) && cleanerFor(mode)(key) === key;
}

/**
 * Returns a cleaned deep copy of `value` and whether anything had to change.
 * @returns {{value: any, changed: boolean}}
 */
function cleanValue(value, mode = 'strict') {
  const clean = cleanerFor(mode);
  let changed = false;
  const walk = v => {
    if (typeof v === 'string') { const c = clean(v); if (c !== v) changed = true; return c; }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v)) {
        if (FORBIDDEN_KEYS.has(k)) { changed = true; continue; }
        const nk = isSafeKey(k, mode) ? k : clean(k).slice(0, 200);
        if (nk !== k) changed = true;
        if (!nk || FORBIDDEN_KEYS.has(nk)) continue;
        out[nk] = walk(v[k]);
      }
      return out;
    }
    if (typeof v === 'number' && !Number.isFinite(v)) { changed = true; return null; }
    return v;
  };
  return { value: walk(value), changed };
}

module.exports = { cleanValue, isSafeKey, FORBIDDEN_KEYS };
