'use strict';
/**
 * Sign-in, sessions and password changes.
 */
const crypto = require('crypto');
const { hashPassword, verifyPassword, passwordProblem } = require('./passwords');
const { LoginLimiter } = require('./login-limiter');
const { UserError } = require('../domain/apps/common');

const TOUCH_EVERY_MS = 60 * 1000;

function sha256(text) { return crypto.createHash('sha256').update(text).digest('hex'); }

class AuthService {
  /**
   * @param {{users, sessions, audit, config, limiter?: LoginLimiter}} deps
   */
  constructor({ users, sessions, audit, config, limiter }) {
    this.users = users;
    this.sessions = sessions;
    this.audit = audit;
    this.idleMs = config.session.idleHours * 3600 * 1000;
    this.maxMs = config.session.maxDays * 86400 * 1000;
    this.limiter = limiter || new LoginLimiter();
  }

  /**
   * @returns {Promise<{token: string, user: object}>}
   * @throws {UserError} 401 wrong credentials, 403 disabled, 429 locked
   */
  async login(usernameInput, password, { ip, userAgent }) {
    const username = String(usernameInput || '').trim().toLowerCase();
    if (this.limiter.ipBlocked(ip)) throw new UserError('Too many failed sign-ins from this network. Try again in 15 minutes.', 429);
    const lockedMs = this.limiter.accountLockedFor(username);
    if (lockedMs) throw new UserError(`This account is locked for ${Math.ceil(lockedMs / 60000)} minutes after failed sign-ins.`, 429);

    const user = username ? await this.users.find(username) : null;
    const ok = await verifyPassword(password, user && user.passwordHash);
    if (!user || !ok) {
      this.limiter.failure(username, ip);
      await this.audit.record({ username: username || null, action: 'login-failed', ip });
      throw new UserError('Wrong username or password.', 401);
    }
    if (user.disabled) {
      await this.audit.record({ username, action: 'login-disabled', ip });
      throw new UserError('This account is disabled. Ask an admin.', 403);
    }
    this.limiter.success(username);
    const token = crypto.randomBytes(32).toString('base64url');
    await this.sessions.create({ tokenHash: sha256(token), username, ip, userAgent: String(userAgent || '').slice(0, 200) });
    await this.users.touchLogin(username);
    await this.audit.record({ username, action: 'login', ip });
    return { token, user };
  }

  /** @returns {Promise<{user: object, session: object}|null>} */
  async authenticate(token) {
    if (!token || typeof token !== 'string' || token.length > 100) return null;
    const tokenHash = sha256(token);
    const session = await this.sessions.find(tokenHash);
    if (!session) return null;
    const now = Date.now();
    const user = await this.users.find(session.username);
    const expired = now - session.lastSeenAt.getTime() > this.idleMs || now - session.createdAt.getTime() > this.maxMs;
    if (!user || user.disabled || expired) {
      await this.sessions.remove(tokenHash);
      return null;
    }
    if (now - session.lastSeenAt.getTime() > TOUCH_EVERY_MS) await this.sessions.touch(tokenHash);
    return { user, session };
  }

  async logout(token, username) {
    if (!token) return;
    await this.sessions.remove(sha256(token));
    if (username) await this.audit.record({ username, action: 'logout' });
  }

  /** Changes the user's own password and signs out their other browsers. */
  async changePassword(user, currentTokenHash, oldPassword, newPassword, ip) {
    if (!(await verifyPassword(oldPassword, user.passwordHash))) {
      this.limiter.failure(user.username, ip);
      throw new UserError('Current password is wrong.');
    }
    const problem = passwordProblem(newPassword);
    if (problem) throw new UserError(problem);
    if (newPassword === oldPassword) throw new UserError('Choose a different password.');
    await this.users.setPassword(user.username, await hashPassword(newPassword), false);
    await this.sessions.removeAllFor(user.username, currentTokenHash);
    await this.audit.record({ username: user.username, action: 'change-password', ip });
  }

  /** Re-check of the user's own password (the Unlock button inside the Camp app). */
  async verifyOwnPassword(user, password, ip) {
    if (this.limiter.accountLockedFor(user.username) || this.limiter.ipBlocked(ip)) {
      throw new UserError('Too many wrong passwords. Wait 15 minutes.', 429);
    }
    const ok = await verifyPassword(password, user.passwordHash);
    if (ok) this.limiter.success(user.username); else this.limiter.failure(user.username, ip);
    return ok;
  }

  async cleanup() {
    this.limiter.sweep();
    return this.sessions.removeExpired(this.idleMs / 3600000, this.maxMs / 86400000);
  }
}

module.exports = { AuthService, sha256 };
