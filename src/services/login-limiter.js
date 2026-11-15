'use strict';
/**
 * Slows down password guessing:
 *   - an account is locked for 15 minutes after 5 wrong passwords
 *   - a network address is blocked for 15 minutes after 20 wrong passwords
 */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_ACCOUNT = 5;
const MAX_PER_IP = 20;

class LoginLimiter {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.byAccount = new Map(); // username -> {count, lockedUntil}
    this.byIp = new Map();      // ip -> {count, since}
  }

  /** @returns {number} milliseconds the account is still locked (0 = not locked) */
  accountLockedFor(username) {
    const r = this.byAccount.get(username);
    if (!r || !r.lockedUntil) return 0;
    const left = r.lockedUntil - this.now();
    if (left > 0) return left;
    this.byAccount.delete(username);
    return 0;
  }

  ipBlocked(ip) {
    const r = this.byIp.get(ip);
    if (!r) return false;
    if (this.now() - r.since > WINDOW_MS) { this.byIp.delete(ip); return false; }
    return r.count >= MAX_PER_IP;
  }

  failure(username, ip) {
    const ipRec = this.byIp.get(ip) || { count: 0, since: this.now() };
    ipRec.count += 1;
    this.byIp.set(ip, ipRec);
    if (!username) return;
    const acc = this.byAccount.get(username) || { count: 0, lockedUntil: 0 };
    acc.count += 1;
    if (acc.count >= MAX_PER_ACCOUNT) { acc.lockedUntil = this.now() + WINDOW_MS; acc.count = 0; }
    this.byAccount.set(username, acc);
  }

  success(username) {
    this.byAccount.delete(username);
  }

  /** Drops old entries so memory stays small. */
  sweep() {
    const now = this.now();
    for (const [k, r] of this.byIp) if (now - r.since > WINDOW_MS) this.byIp.delete(k);
    for (const [k, r] of this.byAccount) if (!r.lockedUntil || r.lockedUntil < now) this.byAccount.delete(k);
  }
}

module.exports = { LoginLimiter };
