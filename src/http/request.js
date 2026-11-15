'use strict';
/** Reading requests: cookies, client address, HTTPS detection, bodies with size limits. */
const { UserError } = require('../domain/apps/common');

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    try { out[name] = decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { /* malformed cookie ignored */ }
  }
  return out;
}

function isHttps(req, trustProxy) {
  if (req.socket.encrypted) return true;
  return trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function clientIp(req, trustProxy) {
  if (trustProxy && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

/** Reads the body into a Buffer; rejects with 413 above `limit` bytes. */
function readBuffer(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) { req.resume(); reject(new UserError('The upload is too large.', 413)); return; }
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(new UserError('The upload is too large.', 413)); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw new UserError('Expected JSON.', 415);
  const buf = await readBuffer(req, limit);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf-8')); } catch (e) { throw new UserError('Invalid JSON.', 400); }
}

module.exports = { parseCookies, isHttps, clientIp, readBuffer, readJson };
