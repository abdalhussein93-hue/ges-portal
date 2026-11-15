'use strict';
/**
 * Checks and cleans the change operations ("ops") a browser sends.
 * See patch.js for the operation format.
 */
const { cleanValue, isSafeKey } = require('./text');

const OP_TYPES = new Set(['s', 'd', 'ai', 'ad', 'pi', 'pd']);
const MAX_PATH_DEPTH = 12;

/**
 * @returns {string|null} why the operation is malformed, or null if it is fine
 */
function validateOp(op, app) {
  if (!op || typeof op !== 'object' || Array.isArray(op)) return 'bad operation';
  if (!OP_TYPES.has(op.o)) return 'unknown operation type';
  if (!Array.isArray(op.p) || op.p.length === 0) return 'missing path';
  if (op.p.length > MAX_PATH_DEPTH) return 'path too deep';
  for (const seg of op.p) {
    if (typeof seg === 'string') {
      if (!isSafeKey(seg, app.textMode)) return `invalid name in path: ${String(seg).slice(0, 40)}`;
    } else if (typeof seg === 'number') {
      if (!Number.isInteger(seg) || seg < 0) return 'bad index in path';
    } else if (seg && typeof seg === 'object') {
      if (typeof seg.id !== 'string' && typeof seg.id !== 'number') return 'bad record id in path';
    } else {
      return 'bad path';
    }
  }
  if (typeof op.p[0] !== 'string' || !app.isRootKey(op.p[0])) return `unknown section: ${String(op.p[0]).slice(0, 40)}`;
  if ((op.o === 's' || op.o === 'ai' || op.o === 'pi' || op.o === 'pd') && !('v' in op)) return 'missing value';
  if (op.o === 'ad' && typeof op.id !== 'string' && typeof op.id !== 'number') return 'missing record id';
  return null;
}

/**
 * Returns copies of the ops with their values cleaned, and whether anything changed.
 * @returns {{ops: object[], changed: boolean}}
 */
function cleanOps(ops, textMode) {
  let changed = false;
  const out = ops.map(op => {
    const copy = { o: op.o, p: op.p };
    for (const k of ['v', 'id', 'at', 'after']) if (k in op) copy[k] = op[k];
    if ('v' in op) {
      const r = cleanValue(op.v, textMode);
      copy.v = r.value;
      if (r.changed) changed = true;
    }
    return copy;
  });
  return { ops: out, changed };
}

/** Human readable path, e.g. "campData > A > rooms > A-1" */
function describePath(path) {
  return path.map(s => (s && typeof s === 'object') ? `#${s.id}` : String(s)).join(' > ');
}

module.exports = { validateOp, cleanOps, describePath };
