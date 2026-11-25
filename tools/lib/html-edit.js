'use strict';
/**
 * Exact, checked edits to an app's index.html. Every edit must match exactly once;
 * otherwise the build stops, so a changed desktop program never produces a broken web app.
 */

class HtmlEditor {
  constructor(html, appName) { this.html = html; this.appName = appName; }

  fail(label, detail) { throw new Error(`[${this.appName}] build edit "${label}" failed: ${detail}`); }

  /** Replaces the one occurrence of `find`. */
  replaceOnce(label, find, replacement) {
    const count = this.html.split(find).length - 1;
    if (count !== 1) this.fail(label, `expected 1 match, found ${count}`);
    this.html = this.html.replace(find, () => replacement);
    return this;
  }

  /** Replaces every occurrence of `find`, which must occur exactly `count` times. */
  replaceCount(label, find, replacement, count) {
    const found = this.html.split(find).length - 1;
    if (found !== count) this.fail(label, `expected ${count} matches, found ${found}`);
    this.html = this.html.split(find).join(replacement);
    return this;
  }

  /**
   * Inserts `insert` between `before` and `after` (which must appear together `count` times).
   */
  insertBetween(label, before, after, insert, count = 1) {
    return this.replaceCount(label, before + after, before + insert + after, count);
  }

  /** Inserts `snippet` right before the first occurrence of `marker`. */
  insertBefore(label, marker, snippet, { last = false } = {}) {
    const i = last ? this.html.lastIndexOf(marker) : this.html.indexOf(marker);
    if (i < 0) this.fail(label, `marker ${marker} not found`);
    this.html = this.html.slice(0, i) + snippet + this.html.slice(i);
    return this;
  }

  /**
   * Finds `<prefix><JSON literal>` (e.g. "var INIT_STAFF = [...]"), returns the parsed value
   * and replaces only the literal with `replacement` (the prefix is kept).
   */
  extractLiteral(label, prefix, replacement) {
    // only occurrences directly followed by a [ or { literal count
    const hits = [];
    for (let i = this.html.indexOf(prefix); i >= 0; i = this.html.indexOf(prefix, i + 1)) {
      const next = this.html[i + prefix.length];
      if (next === '[' || next === '{') hits.push(i);
    }
    if (hits.length !== 1) this.fail(label, `"${prefix.trim()}" followed by data must appear exactly once (found ${hits.length})`);
    const start = hits[0];
    const from = start + prefix.length;
    const end = findLiteralEnd(this.html, from);
    if (end < 0) this.fail(label, 'could not find the end of the data');
    let value;
    try { value = JSON.parse(this.html.slice(from, end)); } catch (e) { this.fail(label, `data is not valid JSON (${e.message})`); }
    this.html = this.html.slice(0, from) + replacement + this.html.slice(end); // the prefix stays
    return value;
  }

  mustNotContain(label, text) {
    if (this.html.includes(text)) this.fail(label, `"${text.slice(0, 30)}" is still in the page`);
    return this;
  }
}

/** Index just after the [...] or {...} literal starting at `from` (string-aware). */
function findLiteralEnd(text, from) {
  const open = text[from];
  if (open !== '[' && open !== '{') return -1;
  let depth = 0, inString = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

module.exports = { HtmlEditor, findLiteralEnd };
