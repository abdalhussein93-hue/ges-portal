/*
 * Connects the GES Manpower app to the portal server.
 *
 * The app already supports running as a desktop program: when window.desktopStorage exists,
 * its own storage layer keeps all its data (gesStaffV4, gesSettings, ...) in memory and calls
 * desktopStorage.saveData(...) after every change. This file provides that object, backed by
 * the server, so the app's own code is unchanged. Loaded in <head>, before the app's scripts.
 *
 * RELOAD mode: the app keeps copies of its data in many variables, so other people's changes
 * are shown by reloading the page as soon as the user pauses (see bridge.js).
 *
 * The timesheet workbook (.xlsx) is stored on the server instead of in this browser, so
 * everyone works with the same file.
 */
(function () {
  'use strict';
  var KV = window.GVCKV;

  function userIsBusy() {
    var a = document.activeElement;
    if (a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) return true;
    // the app's dialogs (.modal-overlay.open) and timesheet pop-up menus (.ts-pop.open)
    return !!document.querySelector('.modal-overlay.open, .ts-pop.open');
  }

  var engine = window.GESBridge.create('manpower', { isBusy: userIsBusy });

  var domReady = new Promise(function (res) {
    if (document.readyState !== 'loading') res(); else document.addEventListener('DOMContentLoaded', res);
  });

  // ---- timesheet workbook on the server (replaces the app's browser storage for it) ----
  function installWorkbookStorage() {
    window.tsDbPut = function (rec) {
      var url = '/api/apps/manpower/files/workbook?fileName=' + encodeURIComponent(rec.name || '') + '&saved=' + encodeURIComponent(rec.saved || '');
      return fetch(url, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }, body: rec.data })
        .then(function (r) {
          if (r.ok) return;
          return r.json().catch(function () { return {}; }).then(function (d) { throw new Error(d.error || ('Upload failed (' + r.status + ')')); });
        });
    };
    window.tsDbGet = function () {
      return fetch('/api/apps/manpower/files/workbook', { credentials: 'same-origin' }).then(function (r) {
        if (r.status === 404) return null;
        if (!r.ok) throw new Error('Could not load the timesheet file (' + r.status + ')');
        return r.arrayBuffer().then(function (buf) {
          return {
            name: decodeURIComponent(r.headers.get('X-File-Name') || 'timesheet.xlsx'),
            saved: decodeURIComponent(r.headers.get('X-File-Saved') || ''),
            data: buf
          };
        });
      });
    };
  }

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
      return Promise.all([engine.ready, domReady]).then(function (all) {
        var r = all[0];
        installWorkbookStorage();
        if (!r.doc) {
          // empty server (admin only): the app starts from the built-in staff list
          var seed = r.seed || {};
          window.__gvcInitStaff = window.INIT_STAFF = seed.INIT_STAFF || [];
          window.__gvcVacDue = window.VAC_DUE = seed.VAC_DUE || {};
          return { ok: true, data: JSON.stringify({ data: {} }) };
        }
        return { ok: true, data: JSON.stringify({ data: KV.toMem(r.doc) }) };
      });
    },
    saveData: function (snapshot) {
      try {
        var o = JSON.parse(snapshot);
        engine.save(KV.toDoc((o && o.data) || {}));
      } catch (e) {
        console.error('Could not read the app data to save it', e);
        return Promise.resolve({ ok: false, error: e.message });
      }
      return Promise.resolve({ ok: true });
    },
    autoBackup: function () { return Promise.resolve({ ok: true }); }, // the server keeps backups
    exportBackup: function (json, name) {
      download(name || 'Manpower_Backup.json', json);
      return Promise.resolve({ ok: true, file: name });
    },
    getDataPath: function () { return Promise.resolve({ dataFile: 'Saved on the portal server', backupDir: 'Kept on the portal server' }); }
  };

  window.GESApp = { isAppAdmin: engine.isAppAdmin, verifyOwnPassword: engine.verifyOwnPassword };
})();
