'use strict';
/**
 * Keeps each app's data and saves every change to PostgreSQL.
 *
 * How data is kept safe:
 *  - Every change is written to app_changes inside a transaction BEFORE the browser is told "saved".
 *    The data in memory is only replaced after the transaction has committed.
 *  - app_changes is never trimmed: checkpoint (app_documents) + later changes = current data.
 *  - Before the first change of each day a full copy is stored in app_snapshots ('daily').
 *  - Before an import replaces everything, a full copy is stored ('pre-import').
 *  - Changes to one app are applied one at a time (no lost updates between two saves).
 */
const Patch = require('../domain/patch');
const { UserError } = require('../domain/apps/common');

const MAX_CATCH_UP = 2000; // more missed changes than this: the browser reloads everything

function utcDay(date) { return new Date(date).toISOString().slice(0, 10); }

class DocumentService {
  /** @param {{db, documents, apps, config, log?}} deps */
  constructor({ db, documents, apps, config, log = console.log }) {
    this.db = db;
    this.repo = documents;
    this.apps = apps;
    this.checkpointEvery = config.documents.checkpointEvery;
    this.snapshotDays = config.documents.snapshotDays;
    this.log = log;
    this.state = new Map(); // appId -> {doc, rev, sinceCheckpoint, lastDailyDay, queue}
  }

  /** Loads every app: last checkpoint + all later changes. */
  async init() {
    for (const app of this.apps.list()) await this.load(app.id);
  }

  async load(appId) {
    const checkpoint = await this.repo.getCheckpoint(appId);
    let doc = checkpoint ? checkpoint.doc : null;
    let rev = checkpoint ? checkpoint.rev : 0;
    let replayed = 0;
    for (;;) {
      const batch = await this.repo.changesAfter(appId, rev, 1000);
      if (!batch.length) break;
      for (const change of batch) {
        if (change.rev !== rev + 1) throw new Error(`[${appId}] change history has a gap after revision ${rev}`);
        if (change.kind === 'replace') doc = change.ops;
        else { if (!doc) doc = {}; Patch.apply(doc, change.ops); }
        rev = change.rev;
        replayed++;
      }
    }
    const lastDaily = await this.repo.lastDailySnapshotAt(appId);
    const previous = this.state.get(appId);
    this.state.set(appId, {
      doc, rev, sinceCheckpoint: replayed,
      lastDailyDay: lastDaily ? utcDay(lastDaily) : null,
      queue: previous ? previous.queue : Promise.resolve(),
    });
    this.log(`[data] ${appId}: revision ${rev}${doc ? '' : ' (empty)'}${replayed ? `, ${replayed} changes after the last checkpoint` : ''}`);
  }

  get(appId) {
    const st = this.mustState(appId);
    return { rev: st.rev, doc: st.doc };
  }

  mustState(appId) {
    const st = this.state.get(appId);
    if (!st) throw new Error(`Unknown app: ${appId}`);
    return st;
  }

  /** Runs `fn` after every earlier write to the same app has finished. */
  exclusive(appId, fn) {
    const st = this.mustState(appId);
    const run = st.queue.then(fn, fn);
    st.queue = run.catch(() => { });
    return run;
  }

  /**
   * Saves a change made by a user.
   * `ops` must already be validated, permission-checked and cleaned.
   * @returns {Promise<{rev: number, missed: object[]|null, normalised: boolean, conflicts: object[]}>}
   *   missed: changes by others between baseRev and this one (null = too many, browser must reload)
   */
  applyChange(appId, username, baseRev, ops) {
    const app = this.apps.get(appId);
    return this.exclusive(appId, async () => {
      const st = this.mustState(appId);
      const now = new Date();
      const newRev = st.rev + 1;
      const takeDaily = !!st.doc && st.lastDailyDay !== utcDay(now);

      // work on a copy: memory is only replaced after the database has committed
      const working = st.doc ? structuredClone(st.doc) : {};
      const conflicts = [];
      Patch.apply(working, ops, conflicts);
      const normalisedKeys = app.normalise(working);
      const storedOps = normalisedKeys.length
        ? ops.concat(normalisedKeys.map(k => ({ o: 's', p: [k], v: working[k] })))
        : ops;
      const checkpointNow = st.sinceCheckpoint + 1 >= this.checkpointEvery;

      let missed = [];
      await this.db.transaction(async client => {
        if (takeDaily) {
          await this.repo.insertSnapshot(client, { appId, rev: st.rev, kind: 'daily', label: 'Start of day', doc: st.doc });
        }
        if (baseRev < st.rev) {
          missed = st.rev - baseRev > MAX_CATCH_UP || baseRev < 0 ? null
            : await this.repo.changesAfter(appId, baseRev, MAX_CATCH_UP, client);
          if (missed && missed.some(c => c.kind === 'replace')) missed = null;
        }
        await this.repo.insertChange(client, { appId, rev: newRev, kind: 'patch', username, ops: storedOps });
        if (checkpointNow) await this.repo.saveCheckpoint(client, appId, newRev, working);
      });

      st.doc = working;
      st.rev = newRev;
      st.sinceCheckpoint = checkpointNow ? 0 : st.sinceCheckpoint + 1;
      if (takeDaily) st.lastDailyDay = utcDay(now);
      return { rev: newRev, missed, normalised: normalisedKeys.length > 0, conflicts };
    });
  }

  /**
   * Changes after `sinceRev`, or null when the browser should reload everything
   * (too many, an import happened, or the revision is unknown).
   */
  async changesSince(appId, sinceRev) {
    const st = this.mustState(appId);
    if (!Number.isInteger(sinceRev) || sinceRev < 0 || sinceRev > st.rev) return null;
    if (sinceRev === st.rev) return [];
    if (st.rev - sinceRev > MAX_CATCH_UP) return null;
    const list = await this.repo.changesAfter(appId, sinceRev, MAX_CATCH_UP);
    if (list.some(c => c.kind === 'replace')) return null;
    return list.filter(c => c.rev <= st.rev);
  }

  /**
   * Replaces all data of an app (import). The old data is kept as a 'pre-import' snapshot.
   * `doc` must already be cleaned.
   */
  replace(appId, username, doc, note) {
    if (!doc || typeof doc !== 'object') throw new UserError('Nothing to import.');
    return this.exclusive(appId, async () => {
      const st = this.mustState(appId);
      const newRev = st.rev + 1;
      await this.db.transaction(async client => {
        if (st.doc) {
          await this.repo.insertSnapshot(client, { appId, rev: st.rev, kind: 'pre-import', label: `Before import: ${note}`.slice(0, 200), createdBy: username, doc: st.doc });
        }
        await this.repo.insertChange(client, { appId, rev: newRev, kind: 'replace', username, ops: doc });
        await this.repo.saveCheckpoint(client, appId, newRev, doc);
      });
      st.doc = doc;
      st.rev = newRev;
      st.sinceCheckpoint = 0;
      return newRev;
    });
  }

  /** Stores a full copy now ("Back up now" on the admin page). */
  snapshotNow(appId, username, label) {
    return this.exclusive(appId, async () => {
      const st = this.mustState(appId);
      if (!st.doc) throw new UserError('This app has no data yet.');
      return this.db.transaction(client =>
        this.repo.insertSnapshot(client, { appId, rev: st.rev, kind: 'manual', label: String(label || 'Manual backup').slice(0, 200), createdBy: username, doc: st.doc }));
    });
  }

  /** Writes a checkpoint for every app that has changes since the last one (used at shutdown). */
  async checkpointAll() {
    for (const [appId, st] of this.state) {
      if (!st.doc || !st.sinceCheckpoint) continue;
      await this.exclusive(appId, async () => {
        await this.db.transaction(client => this.repo.saveCheckpoint(client, appId, st.rev, st.doc));
        st.sinceCheckpoint = 0;
      });
    }
  }

  /** Daily housekeeping: remove daily snapshots older than the retention period. */
  async pruneSnapshots() {
    let removed = 0;
    for (const app of this.apps.list()) removed += await this.repo.pruneDailySnapshots(app.id, this.snapshotDays);
    return removed;
  }
}

module.exports = { DocumentService };
