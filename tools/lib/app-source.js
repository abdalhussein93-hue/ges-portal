'use strict';
/**
 * Reads the files of a desktop (Electron) program: either its app.asar archive or an
 * unpacked resources/app folder. Returns Map<relative path with '/', Buffer>.
 */
const fs = require('fs');
const path = require('path');

process.noAsar = true; // when run with Electron's Node: treat .asar as a plain file

function readAsar(file) {
  const buf = fs.readFileSync(file);
  const headerSize = buf.readUInt32LE(4);
  const jsonLength = buf.readUInt32LE(12);
  const header = JSON.parse(buf.subarray(16, 16 + jsonLength).toString('utf-8'));
  const base = 8 + headerSize;
  const files = new Map();
  (function walk(node, prefix) {
    for (const [name, entry] of Object.entries(node.files || {})) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (entry.files) walk(entry, rel);
      else if (!entry.unpacked && entry.offset !== undefined) {
        const start = base + Number(entry.offset);
        files.set(rel, buf.subarray(start, start + entry.size));
      }
    }
  })(header, '');
  return files;
}

/** Only the files the web version needs (a portable folder also holds a 180 MB program). */
const NEEDED = rel => rel === 'index.html' || rel === 'icon.ico' || rel.startsWith('vendor/');

function readFolder(dir) {
  const files = new Map();
  (function walk(d, prefix) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (ent.name === 'node_modules') continue;
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) { if (!prefix || rel.startsWith('vendor')) walk(full, rel); }
      else if (NEEDED(rel)) files.set(rel, fs.readFileSync(full));
    }
  })(dir, '');
  return files;
}

function readAppSource(location) {
  if (!fs.existsSync(location)) throw new Error(`Not found: ${location}`);
  return fs.statSync(location).isDirectory() ? readFolder(location) : readAsar(location);
}

module.exports = { readAppSource };
