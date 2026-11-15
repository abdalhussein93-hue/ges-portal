'use strict';
/** Serves files from disk with ETags, gzip and an in-memory cache (refreshed when a file changes). */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { acceptsGzip } = require('./response');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
};

class StaticFiles {
  constructor() { this.cache = new Map(); }

  load(file) {
    let stat;
    try { stat = fs.statSync(file); } catch (e) { return null; }
    if (!stat.isFile()) return null;
    const hit = this.cache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit;
    const buf = fs.readFileSync(file);
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const compressible = /text|javascript|json|svg|x-icon/.test(type) && buf.length > 1024;
    const entry = {
      buf, type, mtimeMs: stat.mtimeMs, size: stat.size,
      gz: compressible ? zlib.gzipSync(buf, { level: 9 }) : null,
      etag: `"${crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20)}"`,
    };
    this.cache.set(file, entry);
    return entry;
  }

  /** @returns {boolean} false if the file does not exist */
  serve(req, res, file, cacheControl = 'no-cache') {
    const entry = this.load(file);
    if (!entry) return false;
    const headers = { 'Content-Type': entry.type, ETag: entry.etag, 'Cache-Control': cacheControl, Vary: 'Accept-Encoding' };
    if (req.headers['if-none-match'] === entry.etag) { res.writeHead(304, headers); res.end(); return true; }
    let body = entry.buf;
    if (entry.gz && acceptsGzip(req)) { body = entry.gz; headers['Content-Encoding'] = 'gzip'; }
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }
}

/** Joins a URL path under `base`; returns null if it would escape `base`. */
function safeJoin(base, urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch (e) { return null; }
  if (decoded.includes('\0')) return null;
  const full = path.normalize(path.join(base, decoded));
  return full === base || full.startsWith(base + path.sep) ? full : null;
}

module.exports = { StaticFiles, safeJoin };
