'use strict';
/**
 * All settings come from environment variables (see .env.example).
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function bool(v) { return /^(1|true|yes|on)$/i.test(String(v || '')); }
function num(v, d) { const n = Number(v); return Number.isFinite(n) && v !== '' && v != null ? n : d; }

function loadConfig(env = process.env) {
  return {
    root: ROOT,
    publicDir: path.join(ROOT, 'public'),
    seedDir: env.SEED_DIR ? path.resolve(env.SEED_DIR) : path.join(ROOT, 'seed'),
    port: num(env.PORT, 8080),
    host: env.HOST || '0.0.0.0',
    databaseUrl: env.DATABASE_URL || '',
    databasePoolSize: num(env.DATABASE_POOL_SIZE, 10),
    trustProxy: bool(env.TRUST_PROXY),
    session: {
      idleHours: num(env.SESSION_IDLE_HOURS, 12),
      maxDays: num(env.SESSION_MAX_DAYS, 14),
    },
    documents: {
      snapshotDays: num(env.SNAPSHOT_DAYS, 60),   // daily copies kept in the database
      checkpointEvery: num(env.CHECKPOINT_EVERY, 50), // write a full copy after this many changes
    },
    admin: {
      username: (env.ADMIN_USERNAME || 'admin').toLowerCase(),
      password: env.ADMIN_PASSWORD || '',
      mustChange: env.ADMIN_MUST_CHANGE === undefined ? !env.ADMIN_PASSWORD : bool(env.ADMIN_MUST_CHANGE),
    },
    maxUploadBytes: num(env.MAX_UPLOAD_MB, 80) * 1024 * 1024,
    // temporary emergency admin (src/emergency-admin.js); EMERGENCY_ADMIN=off turns it off
    emergencyAdmin: !/^(0|false|no|off)$/i.test(String(env.EMERGENCY_ADMIN || '')),
    // how long a new server waits for the previous one to stop (deploys)
    lockWaitSeconds: num(env.LOCK_WAIT_SECONDS, 600),
  };
}

module.exports = { loadConfig, ROOT };
