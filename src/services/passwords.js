'use strict';
/**
 * Password hashing with scrypt (Node.js crypto) and a random salt per password.
 * Stored format: scrypt$N$r$p$<salt hex>$<hash hex>
 */
const crypto = require('crypto');

const PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 64;
const MIN_LENGTH = 8;
const MAX_LENGTH = 200;

function scrypt(password, salt, { N, r, p }) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, KEY_LENGTH, { N, r, p, maxmem: 128 * N * r * 2 }, (err, key) => err ? reject(err) : resolve(key)));
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scrypt(String(password), salt, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt}$${key.toString('hex')}`;
}

const DUMMY_HASH_PROMISE = hashPassword('dummy-password-for-timing');

/** Constant-time check. A missing hash still costs the same time (no user enumeration). */
async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    await verifyPassword(password, await DUMMY_HASH_PROMISE);
    return false;
  }
  const [, N, r, p, salt, hashHex] = parts;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(String(password || ''), salt, { N: Number(N), r: Number(r), p: Number(p) });
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/** @returns {string|null} what is wrong with a new password */
function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < MIN_LENGTH) return `Password must be at least ${MIN_LENGTH} characters.`;
  if (password.length > MAX_LENGTH) return 'Password is too long.';
  return null;
}

/** Temporary password that is easy to read out: no 0/O/1/l/I. Example: Kq7m-Tz3x-Pw9a */
function temporaryPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  while (out.length < 12) {
    const b = crypto.randomBytes(1)[0];
    if (b < 256 - (256 % chars.length)) out += chars[b % chars.length]; // no modulo bias
  }
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8)}`;
}

module.exports = { hashPassword, verifyPassword, passwordProblem, temporaryPassword, MIN_LENGTH };
