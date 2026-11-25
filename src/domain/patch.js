/*
 * Global Village Camp Management - change tracking ("patches").
 *
 * Shared by the server (Node.js) and the browser (served as /patch.js).
 *
 * diff(a, b)      -> list of small operations that turn document a into b
 * apply(doc, ops) -> applies those operations IN PLACE (keeps object identity,
 *                    so screens that hold references keep working)
 *
 * Operations:
 *   {o:'s',  p:path, v}        set value at path
 *   {o:'d',  p:path}           delete key at path
 *   {o:'ai', p:path, v, at, after}  insert element into an "id array" (array of objects with .id)
 *   {o:'ad', p:path, id}       remove element with this id from an "id array"
 *   {o:'pi', p:path, v, at}    insert a primitive into a list of unique primitives (e.g. companies)
 *   {o:'pd', p:path, v}        remove a primitive from such a list
 * A path is a list of segments: string = object key, number = array index,
 * {id:x} = the element of an id array whose .id === x.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GVCPatch = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function isPrim(v) { return v === null || (typeof v !== 'object' && typeof v !== 'function'); }
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  function idArray(arr) {
    if (!arr.length) return false;
    const seen = new Set();
    for (const e of arr) {
      if (!isObj(e) || (typeof e.id !== 'string' && typeof e.id !== 'number')) return false;
      if (seen.has(e.id)) return false;
      seen.add(e.id);
    }
    return true;
  }
  function uniquePrimArray(arr) {
    const seen = new Set();
    for (const e of arr) { if (!isPrim(e) || seen.has(e)) return false; seen.add(e); }
    return true;
  }

  function diff(a, b, path, ops) {
    path = path || []; ops = ops || [];
    if (a === b) return ops;
    if (isObj(a) && isObj(b)) {
      for (const k of Object.keys(b)) {
        if (!hasOwn(a, k)) ops.push({ o: 's', p: path.concat(k), v: clone(b[k]) });
        else diff(a[k], b[k], path.concat(k), ops);
      }
      for (const k of Object.keys(a)) if (!hasOwn(b, k)) ops.push({ o: 'd', p: path.concat(k) });
      return ops;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      // arrays of records with an id (e.g. the check in/out log): merge by id
      if ((idArray(a) || !a.length) && (idArray(b) || !b.length) && (a.length || b.length)) {
        const am = new Map(a.map(e => [e.id, e]));
        const bm = new Map(b.map(e => [e.id, e]));
        for (const e of a) if (!bm.has(e.id)) ops.push({ o: 'ad', p: path, id: e.id });
        b.forEach((e, i) => {
          if (!am.has(e.id)) ops.push({ o: 'ai', p: path, v: clone(e), at: i, after: i > 0 ? b[i - 1].id : null });
          else diff(am.get(e.id), e, path.concat({ id: e.id }), ops);
        });
        return ops;
      }
      // lists of unique names (companies, nationalities, ...): merge as a set
      if (uniquePrimArray(a) && uniquePrimArray(b)) {
        const as = new Set(a), bs = new Set(b);
        for (const v of a) if (!bs.has(v)) ops.push({ o: 'pd', p: path, v });
        b.forEach((v, i) => { if (!as.has(v)) ops.push({ o: 'pi', p: path, v, at: i }); });
        return ops;
      }
      // same length (e.g. the beds of a room): compare position by position
      if (a.length === b.length) {
        for (let i = 0; i < a.length; i++) diff(a[i], b[i], path.concat(i), ops);
        return ops;
      }
      ops.push({ o: 's', p: path, v: clone(b) });
      return ops;
    }
    if (isPrim(a) && isPrim(b) && a === b) return ops;
    if (typeof a === 'number' && typeof b === 'number' && isNaN(a) && isNaN(b)) return ops;
    ops.push({ o: 's', p: path, v: clone(b) });
    return ops;
  }

  // get child by one path segment
  function child(container, seg) {
    if (container === null || typeof container !== 'object') return undefined;
    if (isObj(seg)) return Array.isArray(container) ? container.find(e => isObj(e) && e.id === seg.id) : undefined;
    if (typeof seg === 'number') return Array.isArray(container) ? container[seg] : undefined;
    return isObj(container) && hasOwn(container, seg) ? container[seg] : undefined;
  }

  function resolve(rootObj, path, create) {
    let cur = rootObj;
    for (const seg of path) {
      let nxt = child(cur, seg);
      if (nxt === undefined && create && typeof seg === 'string' && isObj(cur)) { nxt = {}; cur[seg] = nxt; }
      if (nxt === undefined || nxt === null || typeof nxt !== 'object') return undefined;
      cur = nxt;
    }
    return cur;
  }

  // Applies ops in place. Returns how many were applied (ops whose target no longer exists are skipped).
  // If `conflicts` (an array) is given, changes that were lost because someone else changed or
  // deleted the same record meanwhile are listed in it.
  function apply(doc, ops, conflicts) {
    let applied = 0;
    const lost = op => { if (conflicts) conflicts.push(op); };
    for (const op of ops) {
      const p = op.p || [];
      if (op.o === 's' || op.o === 'd') {
        if (!p.length) continue; // whole-document replace is not used
        // Never re-create missing parents: if someone else deleted the room/block meanwhile,
        // their delete wins and this change is skipped (a half-built room would break the screens).
        const parent = resolve(doc, p.slice(0, -1), false);
        const last = p[p.length - 1];
        if (!parent) { if (op.o === 's') lost(op); continue; }
        if (op.o === 's') {
          if (isObj(last)) {
            if (!Array.isArray(parent)) { lost(op); continue; }
            const i = parent.findIndex(e => isObj(e) && e.id === last.id);
            if (i < 0) { lost(op); continue; }
            parent[i] = clone(op.v);
          } else if (typeof last === 'number') {
            if (!Array.isArray(parent) || last < 0 || last >= parent.length) { lost(op); continue; }
            parent[last] = clone(op.v);
          } else {
            if (!isObj(parent)) continue;
            parent[last] = clone(op.v);
          }
        } else {
          if (isObj(parent) && typeof last === 'string' && hasOwn(parent, last)) delete parent[last];
          else continue;
        }
        applied++;
        continue;
      }
      const arr = resolve(doc, p, false);
      if (!Array.isArray(arr)) { if (op.o === 'ai' || op.o === 'pi') lost(op); continue; }
      if (op.o === 'ai') {
        if (!isObj(op.v)) continue;
        const existing = arr.find(e => isObj(e) && e.id === op.v.id);
        if (existing) {
          // same record already there (harmless repeat) - or a DIFFERENT record that got the same id
          if (JSON.stringify(existing) !== JSON.stringify(op.v)) lost(op);
          continue;
        }
        let idx;
        if (op.after === null || op.after === undefined) idx = 0;
        else {
          const j = arr.findIndex(e => isObj(e) && e.id === op.after);
          idx = j >= 0 ? j + 1 : Math.min(op.at || 0, arr.length);
        }
        arr.splice(idx, 0, clone(op.v));
        applied++;
      } else if (op.o === 'ad') {
        const i = arr.findIndex(e => isObj(e) && e.id === op.id);
        if (i >= 0) { arr.splice(i, 1); applied++; }
      } else if (op.o === 'pi') {
        if (arr.includes(op.v)) continue;
        arr.splice(Math.min(op.at || 0, arr.length), 0, op.v);
        applied++;
      } else if (op.o === 'pd') {
        const i = arr.indexOf(op.v);
        if (i >= 0) { arr.splice(i, 1); applied++; }
      }
    }
    return applied;
  }

  return { diff: function (a, b) { return diff(a, b, [], []); }, apply, clone };
});
