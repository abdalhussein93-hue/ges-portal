'use strict';
/**
 * The portal's camps: list, add, delete, restore, and keeping Camp Management's own camp list the same.
 *
 * Deleting never erases anything: the camp disappears from every app and from everyone's access,
 * all its data stays in the database, and "Restore" brings it back as it was.
 */
const { UserError } = require('../domain/apps/common');
const Camps = require('../domain/camps');

class CampsService {
  /** @param {{db, documents, apps, live, audit, log?}} deps */
  constructor({ db, documents, apps, live, audit, log = console.log }) {
    this.db = db;
    this.documents = documents;
    this.apps = apps;
    this.live = live;
    this.audit = audit;
    this.log = log;
    this.all = [];   // every camp ever made: [{id, name, position, deletedAt, deletedBy}]
    this.camps = []; // the camps in use (not deleted)
  }

  /**
   * Loads the camps and the data of every camp. Call after documents.init().
   * Start-up never changes any app's data: a camp that is only in Camp Management is added to
   * the portal's list (that is not app data).
   */
  async init() {
    await this.reload();
    await this.syncCampManagement({ write: false });
    for (const camp of this.camps) await this.loadCampData(camp.id);
  }

  async reload() {
    const { rows } = await this.db.query('SELECT id, name, position, deleted_at, deleted_by FROM camps ORDER BY position, name');
    this.all = rows.map(r => ({ id: r.id, name: r.name, position: r.position, deletedAt: r.deleted_at, deletedBy: r.deleted_by }));
    this.camps = this.all.filter(c => !c.deletedAt);
  }

  list() { return this.camps.map(c => ({ id: c.id, name: c.name })); }
  deleted() { return this.all.filter(c => c.deletedAt).map(c => ({ id: c.id, name: c.name, deletedAt: c.deletedAt, deletedBy: c.deletedBy })); }
  get(id) { return this.camps.find(c => c.id === id) || null; }
  perCampApps() { return this.apps.list().filter(a => a.perCamp); }
  nextPosition() { return this.all.reduce((m, c) => Math.max(m, c.position), 0) + 1; }
  /** Ids are never reused, so a new camp can never see a deleted camp's data. */
  newId(name) { return Camps.newId(name, new Set(this.all.map(c => c.id))); }

  async loadCampData(campId) {
    if (campId === Camps.PRIMARY) return; // loaded with the apps
    for (const app of this.perCampApps()) {
      const key = Camps.docKey(app.id, campId);
      if (!this.documents.has(key)) await this.documents.load(key);
    }
  }

  /** Portal admin: adds a camp. Its data in every app starts empty. */
  async add(actor, name) {
    const problem = Camps.nameProblem(name);
    if (problem) throw new UserError(problem);
    name = String(name).trim();
    const same = this.all.find(c => c.name.toLowerCase() === name.toLowerCase());
    if (same && !same.deletedAt) throw new UserError('A camp with this name already exists.');
    if (same) throw new UserError(`"${same.name}" is a deleted camp. Use "Restore" in the list of deleted camps to bring it back with its data.`);
    const id = this.newId(name);
    await this.db.query('INSERT INTO camps (id, name, position) VALUES ($1, $2, $3)', [id, name, this.nextPosition()]);
    await this.reload();
    await this.loadCampData(id);
    await this.syncCampManagement({ username: actor.username, write: true });
    await this.audit.record({ username: actor.username, action: 'camp-add', details: { id, name } });
    return { id, name };
  }

  /** Camp Management blocks that belong to this camp. */
  campBlocks(name) {
    const doc = this.documents.get('camp').doc;
    const meta = doc && doc.BLOCKS_META && typeof doc.BLOCKS_META === 'object' ? doc.BLOCKS_META : {};
    return Object.keys(meta).filter(bk => ((meta[bk] && meta[bk].camp) || Camps.CAMP_APP_DEFAULT) === name);
  }

  /**
   * Portal admin: deletes a camp. Refused for the first camp (it holds the data from before camps)
   * and for a camp that still has blocks in Camp Management (they would fall into another camp).
   */
  async remove(actor, id) {
    const camp = this.get(id);
    if (!camp) throw new UserError('No such camp.', 404);
    if (id === Camps.PRIMARY) throw new UserError(`${camp.name} is the first camp: it holds the data from before camps, so it cannot be deleted.`);
    if (this.camps.length <= 1) throw new UserError('The last camp cannot be deleted.');
    const blocks = this.campBlocks(camp.name);
    if (blocks.length) {
      throw new UserError(`${camp.name} still has ${blocks.length} block${blocks.length > 1 ? 's' : ''} in Camp Management (${blocks.slice(0, 5).join(', ')}${blocks.length > 5 ? ', …' : ''}). ` +
        'Delete or move them to another camp in Camp Management first, so no rooms or residents end up in the wrong camp.');
    }
    await this.db.query('UPDATE camps SET deleted_at = now(), deleted_by = $2 WHERE id = $1', [id, actor.username]);
    await this.reload();
    // take it out of Camp Management's camp switcher (its old records stay in the data)
    const { rev, doc } = this.documents.get('camp');
    if (doc && Array.isArray(doc.campList) && doc.campList.includes(camp.name)) {
      const r = await this.documents.applyChange('camp', actor.username, rev, [{ o: 'pd', p: ['campList'], v: camp.name }]);
      this.live.broadcast('camp', 'change', { rev: r.rev, by: actor.username, clientId: '' });
    }
    await this.audit.record({ username: actor.username, action: 'camp-delete', details: { id, name: camp.name } });
    return { id, name: camp.name };
  }

  /** Portal admin: brings a deleted camp back, with all its data and everyone's access as before. */
  async restore(actor, id) {
    const camp = this.all.find(c => c.id === id && c.deletedAt);
    if (!camp) throw new UserError('No such deleted camp.', 404);
    await this.db.query('UPDATE camps SET deleted_at = NULL, deleted_by = NULL WHERE id = $1', [id]);
    await this.reload();
    await this.loadCampData(id);
    await this.syncCampManagement({ username: actor.username, write: true });
    await this.audit.record({ username: actor.username, action: 'camp-restore', details: { id, name: camp.name } });
    return { id, name: camp.name };
  }

  /**
   * Camp Management keeps its own list of camp names. A camp that is only in Camp Management is
   * added to the portal list; with `write`, portal camps missing from Camp Management are added there.
   */
  async syncCampManagement({ username = 'system', write = false } = {}) {
    const { rev, doc } = this.documents.get('camp');
    if (!doc) return;
    const inApp = Array.isArray(doc.campList) ? doc.campList.filter(n => typeof n === 'string') : [];
    for (const name of inApp) {
      if (this.all.some(c => c.name === name) || Camps.nameProblem(name)) continue;
      const id = this.newId(name);
      await this.db.query('INSERT INTO camps (id, name, position) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [id, name, this.nextPosition()]);
      this.log(`[camps] "${name}" was only in Camp Management: added to the portal's camps (${id}).`);
      await this.reload();
      await this.loadCampData(id);
    }
    const missing = this.camps.filter(c => !inApp.includes(c.name));
    if (!missing.length || !write) return;
    const ops = Array.isArray(doc.campList)
      ? missing.map((c, i) => ({ o: 'pi', p: ['campList'], v: c.name, at: inApp.length + i }))
      : [{ o: 's', p: ['campList'], v: this.camps.map(c => c.name) }];
    const r = await this.documents.applyChange('camp', username, rev, ops);
    this.live.broadcast('camp', 'change', { rev: r.rev, by: username, clientId: '' });
    this.log(`[camps] added to Camp Management's camp list: ${missing.map(c => c.name).join(', ')}`);
  }
}

module.exports = { CampsService };
