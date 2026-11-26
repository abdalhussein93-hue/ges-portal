/*
 * Connects Duty Board to the portal server.
 *
 * Duty Board already supports running as a desktop program: it loads and saves through
 * window.desktopStorage. This file provides that object, backed by the server, so the app's
 * own code is unchanged. Loaded in <head>, before the app's script.
 *
 * - LIVE mode: other people's changes are applied straight into the app's data (ROOT) and redrawn.
 * - Each person only receives the departments they were given (the server filters them).
 * - The department a person is looking at (activeDept) is personal: never sent to the server.
 * - Nothing is kept in this browser's storage (shared PCs).
 */
(function () {
  'use strict';
  var P = window.GVCPatch, Portal = window.GESPortal;
  var PERSONAL = 'activeDept';

  // never keep roster data in this browser (the app used to save a copy there)
  try { localStorage.removeItem('dutyCamp'); localStorage.removeItem('dutyBoard2'); } catch (e) { /* storage blocked */ }
  var origSetItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k, v) {
    if (this === window.localStorage && (k === 'dutyCamp' || k === 'dutyBoard2')) return;
    return origSetItem.apply(this, arguments);
  };

  /* global ROOT, S, activeDept, renderDeptPills, render */
  function shared() {
    var r = Object.assign({}, ROOT);
    delete r[PERSONAL];
    return r;
  }
  function userIsBusy() {
    if (document.querySelector('.scrim.on')) return true;
    var a = document.activeElement;
    return !!(a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName));
  }

  var engine = window.GESBridge.create('duty', {
    getLive: shared,
    applyLive: function (ops) { P.apply(ROOT, ops); },
    rerender: function () {
      if (!ROOT.depts.length) return;
      if (!ROOT.depts.some(function (d) { return d.id === ROOT[PERSONAL]; })) ROOT[PERSONAL] = ROOT.depts[0].id;
      S = activeDept();
      renderDeptPills();
      render();
    },
    isBusy: userIsBusy
  });

  // Only Admins add, delete or replace departments (the server enforces it as well).
  // The built page asks GESDuty.canManageDepts() before loading a backup file.
  var isAdmin = false;
  window.GESDuty = { canManageDepts: function () { return isAdmin; } };
  engine.ready.then(function (r) {
    isAdmin = r.role === 'admin';
    if (isAdmin) return;
    var css = document.createElement('style');
    css.textContent = '#deptAdd,#deptDelete{display:none!important}';
    (document.head || document.documentElement).appendChild(css);
  }, function () { });

  function download(name, content) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
    a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }

  window.desktopStorage = {
    isDesktop: true,
    loadData: function () {
      return engine.ready.then(function (r) {
        if (!r.doc) return { ok: true, data: null }; // empty server (Admin): the app starts with its sample department
        if (r.role !== 'admin' && (!r.doc.depts || !r.doc.depts.length)) {
          Portal.cover('No department has been given to you in Duty Board yet.<br>Ask a portal admin to tick your department on the Users page.<br><a href="/">Back to all apps</a>');
          return new Promise(function () { }); // stays on this message
        }
        return { ok: true, data: JSON.stringify(r.doc) };
      });
    },
    saveData: function () {
      engine.save(null); // LIVE mode reads the app's current data itself
      return Promise.resolve({ ok: true });
    },
    autoBackup: function () { return Promise.resolve({ ok: true }); }, // the server keeps backups
    exportBackup: function (json, name) {
      download(name || 'DutyBoard-Backup.json', json);
      return Promise.resolve({ ok: true, file: name });
    },
    getDataPath: function () { return Promise.resolve({ dataFile: 'Saved on the portal server', backupDir: 'Kept on the portal server' }); }
  };
})();
