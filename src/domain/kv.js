/*
 * Key/value storage <-> document.
 *
 * The Manpower app keeps its data as text values under keys (browser "localStorage" style),
 * e.g. gesStaffV4 = "[{...},{...}]". To merge changes record by record, each value that is
 * JSON is stored parsed:   {keys: {gesStaffV4: {j: [...]}, gesCampName: {s: "GES CAMP"}}}
 *
 * Shared by the server (Node.js) and the browser (served as /shared/kv.js).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GVCKV = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  function toDoc(mem) {
    const keys = {};
    for (const k of Object.keys(mem || {})) {
      const s = String(mem[k]);
      let j, ok = false;
      if (/^[\[{"]|^-?\d|^(true|false|null)$/.test(s.trim())) { try { j = JSON.parse(s); ok = true; } catch (e) { } }
      keys[k] = ok ? { j: j } : { s: s };
    }
    return { keys: keys };
  }
  function toMem(doc) {
    const mem = {};
    const keys = (doc && doc.keys) || {};
    for (const k of Object.keys(keys)) {
      const e = keys[k] || {};
      mem[k] = ('j' in e) ? JSON.stringify(e.j) : String(e.s == null ? '' : e.s);
    }
    return mem;
  }
  return { toDoc: toDoc, toMem: toMem };
});
