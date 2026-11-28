'use strict';
/**
 * The portal's camps: list, add, and keeping Camp Management's own camp list the same.
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
    this.camps = []; // [{id, name, position}]
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
    const { rows } = await this.db.query('SELECT id, name, position FROM camps ORDER BY position, name');
    this.camps = rows.map(r => ({ id: r.id, name: r.name, position: r.position }));
  }

  list() { return this.camps.map(c => ({ id: c.id, name: c.name })); }
  get(id) { return this.camps.find(c => c.id === id) || null; }
  perCampApps() { return this.apps.list().filter(a => a.perCamp); }

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
    if (this.camps.some(c => c.name.toLowerCase() === name.toLowerCase())) throw new UserError('A camp with this name already exists.');
    const id = Camps.newId(name, new Set(this.camps.map(c => c.id)));
    const position = this.camps.reduce((m, c) => Math.max(m, c.position), 0) + 1;
    await this.db.query('INSERT INTO camps (id, name, position) VALUES ($1, $2, $3)', [id, name, position]);
    await this.reload();
    await this.loadCampData(id);
    await this.syncCampManagement({ username: actor.username, write: true });
    await this.audit.record({ username: actor.username, action: 'camp-add', details: { id, name } });
    return { id, name };
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
      if (this.camps.some(c => c.name === name) || Camps.nameProblem(name)) continue;
      const id = Camps.newId(name, new Set(this.camps.map(c => c.id)));
      const position = this.camps.reduce((m, c) => Math.max(m, c.position), 0) + 1;
      await this.db.query('INSERT INTO camps (id, name, position) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [id, name, position]);
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
