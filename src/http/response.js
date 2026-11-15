'use strict';
/** Writing responses (gzip for larger bodies, no caching of data). */
const zlib = require('zlib');

const GZIP_MIN_BYTES = 1024;

function acceptsGzip(req) { return /\bgzip\b/.test(req.headers['accept-encoding'] || ''); }

function send(req, res, status, body, type = 'text/plain; charset=utf-8', extraHeaders = {}) {
  const headers = Object.assign({ 'Content-Type': type, 'Cache-Control': 'no-store' }, extraHeaders);
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  const compressible = /^(text\/|application\/(json|javascript))/.test(type);
  if (compressible && buf.length > GZIP_MIN_BYTES && acceptsGzip(req)) {
    buf = zlib.gzipSync(buf, { level: 6 });
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
  }
  headers['Content-Length'] = buf.length;
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : buf);
}

function json(req, res, status, data) {
  send(req, res, status, JSON.stringify(data), 'application/json; charset=utf-8');
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

module.exports = { send, json, redirect, acceptsGzip };
