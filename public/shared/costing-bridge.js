/*
 * Connects the Daily Costing & Stock app to the portal server.
 *
 * The app already knows how to run as a desktop program: it calls window.desktopStorage to
 * load and save its data. This file provides that object, backed by the server, so the
 * app's own code is unchanged. Loaded in <head>, before the app's script.
 *
 * LIVE mode: changes by others are applied straight into the app's data (the global `db`)
 * and the current screen is redrawn.
 */
(function () {
  'use strict';
  var P = window.GVCPatch;

  function userIsBusy() {
    var modal = document.getElementById('modalBg');
    if (modal && modal.classList.contains('show')) return true;
    var a = document.activeElement;
    return !!(a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) && a.closest('#content'));
  }

  var engine = window.GESBridge.create('costing', {
    // `db` is the app's own data object (declared by the app's script; may be replaced by its Restore)
    getLive: function () { return db; },                      // eslint-disable-line no-undef
    applyLive: function (ops) { P.apply(db, ops); },           // eslint-disable-line no-undef
    rerender: function () { if (typeof render === 'function') render(); }, // eslint-disable-line no-undef
    isBusy: userIsBusy
  });

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
        return { ok: true, data: r.doc ? JSON.stringify(r.doc) : null }; // null: the app starts with its built-in catalogue
      });
    },
    saveData: function () {
      engine.save(null); // LIVE mode reads the app's current data itself
      return Promise.resolve({ ok: true });
    },
    autoBackup: function () { return Promise.resolve({ ok: true }); }, // the server keeps backups
    exportBackup: function (json, name) {
      download(name || 'Costing_Backup.json', json);
      return Promise.resolve({ ok: true, file: name });
    },
    getDataPath: function () { return Promise.resolve({ dataFile: 'Saved on the portal server', backupDir: 'Kept on the portal server' }); }
  };

  /** Used by the "Clear day" button (see tools/build-apps.js). */
  window.GESApp = { isAppAdmin: engine.isAppAdmin, verifyOwnPassword: engine.verifyOwnPassword, ready: engine.ready };
})();
