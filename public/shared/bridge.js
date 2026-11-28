/*
 * GES Operations Portal - sync engine for apps that save their whole data in one go
 * (Manpower, Costing). Each app has a small adapter (manpower-bridge.js, costing-bridge.js).
 *
 *   var engine = GESBridge.create(appId, {
 *     getLive:     function () { return liveDataObject; },   // LIVE mode: others' changes are applied in place
 *     applyLive:   function (ops) { ... },                    //   (Costing)
 *     rerender:    function () { ... },
 *     isBusy:      function () { return true while the user is typing / a form is open; },
 *     events:      { name: function (data) { ... } }          // optional: other live events of this app
 *   });
 *   // without getLive/applyLive the app runs in RELOAD mode: when others change data the page
 *   // reloads as soon as the user pauses (Manpower - its screens keep their own copies of the data).
 *
 *   engine.ready  -> Promise {me, role, doc, seed}
 *   engine.save(docOrNull)   queue a save (docOrNull: the app's full data now; LIVE mode reads getLive())
 *   engine.flush()           Promise resolved when nothing is waiting to be saved
 *
 * Safety rules:
 *   - changes are computed against `known` = the data as this page last loaded/saved it,
 *     so a page that has not yet seen someone else's change never undoes it
 *   - one request at a time; failed saves are retried, never dropped
 */
(function () {
  'use strict';
  var P = window.GVCPatch, Portal = window.GESPortal;
  var RETRY_MS = 5000, IDLE_RELOAD_MS = 8000, CATCH_UP_EVERY_MS = 60000;

  function create(appId, adapter) {
    adapter = adapter || {};
    var live = typeof adapter.getLive === 'function' && typeof adapter.applyLive === 'function';
    var s = {
      me: null, role: null, rev: 0, known: null,
      clientId: Math.random().toString(36).slice(2) + Date.now().toString(36),
      pendingDoc: null, pendingWanted: false, busy: false, retryTimer: null,
      stale: false, lastInput: Date.now(), reloading: false, connected: false
    };
    var engine = { state: s, live: live };

    // ---------------------------------------------------------- start-up
    var resolveReady, rejectReady;
    engine.ready = new Promise(function (res, rej) { resolveReady = res; rejectReady = rej; });

    function boot() {
      Portal.api('GET', '/api/me').then(function (me) {
        s.me = me;
        s.role = me.apps[appId] || null;
        if (!s.role) { location.href = '/?denied=' + encodeURIComponent(appId); throw null; }
        return Portal.api('GET', '/api/apps/' + appId + '/data');
      }).then(function (d) {
        s.rev = d.rev;
        if (d.doc) { s.known = P.clone(d.doc); return { doc: d.doc, seed: null }; }
        if (s.role !== 'admin') {
          Portal.cover('This app has not been set up yet.<br>An Admin of this app must open it first.<br><a href="/">Back to all apps</a>');
          throw null;
        }
        s.known = {};
        return Portal.api('GET', '/api/apps/' + appId + '/seed').then(function (seed) { return { doc: null, seed: seed }; }, function () { return { doc: null, seed: null }; });
      }).then(function (r) {
        resolveReady({ me: s.me, role: s.role, doc: r.doc, seed: r.seed });
      }).catch(function (e) {
        if (e === null) return;
        if (e && e.status === 401) return;
        Portal.cover('Cannot reach the server.<br><small>' + Portal.esc(e && e.message) + '</small><br><button onclick="location.reload()">Try again</button>');
        rejectReady(e);
      });
    }

    function afterReady() {
      Portal.mount({ appId: appId, me: s.me });
      Portal.onBeforeLeave(engine.flush);
      // shown on the portal bar, not over the page (a banner there hid the data behind it)
      if (s.role === 'viewer') Portal.setViewOnly(true);
      connect();
      setInterval(catchUp, CATCH_UP_EVERY_MS);
      ['keydown', 'pointerdown', 'input', 'wheel'].forEach(function (ev) {
        document.addEventListener(ev, function () { s.lastInput = Date.now(); }, true);
      });
      window.addEventListener('beforeunload', function (e) {
        if (s.pendingWanted || s.busy) { engine.save(null, { keepalive: true }); e.preventDefault(); e.returnValue = ''; }
      });
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden' && s.pendingWanted) engine.save(null, { keepalive: true });
        if (document.visibilityState === 'visible') catchUp();
      });
    }

    // ---------------------------------------------------------- saving
    engine.save = function (doc, opts) {
      if (s.role === 'viewer' || !s.known) return;
      if (!live && doc) s.pendingDoc = doc; // save(null) = "send whatever is waiting"
      if (!live && !s.pendingDoc) return;
      s.pendingWanted = true;
      s.keepalive = !!(opts && opts.keepalive);
      run();
    };

    function current() {
      return live ? P.clone(adapter.getLive()) : s.pendingDoc;
    }

    function run() {
      if (s.busy || !s.pendingWanted) return;
      s.busy = true;
      s.pendingWanted = false;
      var doc = current();
      s.pendingDoc = null;
      var ops = doc ? P.diff(s.known, doc) : [];
      if (!ops.length) { done(); return; }
      Portal.api('POST', '/api/apps/' + appId + '/patch', { baseRev: s.rev, ops: ops, clientId: s.clientId }, { keepalive: s.keepalive })
        .then(function (r) {
          setConnected(true);
          if (r.reload) {
            if (r.conflicts) alert('Someone else changed or deleted the same record at the same moment, so part of your last change could not be saved.\n\nThe page will now reload with the latest data. Please check your last change.');
            return reloadPage('The data was updated on the server.');
          }
          var others = r.missed || [];
          if (live && others.length) {
            others.forEach(function (c) { adapter.applyLive(c.ops); P.apply(s.known, c.ops); });
            adapter.applyLive(ops); // ours were applied last on the server, so ours win here too
          }
          P.apply(s.known, ops);
          s.rev = r.rev;
          if (others.length) { if (live) rerender(); else markStale(others); showUpdatedBy(others); }
          done();
        })
        .catch(function (e) {
          if (e && e.status === 401) { s.busy = false; return; }
          if (e && e.data && e.data.denied) {
            alert('This change was NOT saved.\n\n' + e.message + '\n\nThe page will reload with the latest saved data.');
            return reloadPage('');
          }
          if (e && (e.status === 400 || e.status === 409 || e.status === 413)) {
            alert('This change was NOT saved: ' + e.message);
            s.busy = false;
            return;
          }
          // network or server problem: keep the change and try again
          setConnected(false);
          if (!live) s.pendingDoc = s.pendingDoc || doc;
          s.pendingWanted = true;
          s.busy = false;
          clearTimeout(s.retryTimer);
          s.retryTimer = setTimeout(run, RETRY_MS);
        });
    }

    function done() {
      s.busy = false;
      if (s.pendingWanted) run();
      else { flushWaiters(); if (s.stale) maybeReload(); }
    }

    var waiters = [];
    function flushWaiters() { var w = waiters; waiters = []; w.forEach(function (f) { f(); }); }
    engine.flush = function () {
      if (!s.busy && !s.pendingWanted) return Promise.resolve();
      return new Promise(function (res) { waiters.push(res); });
    };

    // ---------------------------------------------------------- others' changes
    function catchUp() {
      if (!s.known || s.busy || s.reloading) return;
      if (s.pendingWanted) { run(); return; }
      if (!live) { if (s.stale) maybeReload(); return; }
      s.busy = true;
      Portal.api('GET', '/api/apps/' + appId + '/changes?since=' + s.rev).then(function (r) {
        if (r.reload) return reloadPage('The data was replaced on the server.');
        if (r.changes.length) {
          r.changes.forEach(function (c) { adapter.applyLive(c.ops); P.apply(s.known, c.ops); });
          s.rev = r.rev;
          rerender();
          showUpdatedBy(r.changes);
        }
        setConnected(true);
      }).catch(function (e) { if (!e || !e.status) setConnected(false); })
        .then(function () { s.busy = false; if (s.pendingWanted) run(); });
    }

    var renderTimer = null;
    function rerender() {
      clearTimeout(renderTimer);
      (function attempt() {
        if (adapter.isBusy && adapter.isBusy()) { renderTimer = setTimeout(attempt, 2000); return; }
        try { if (adapter.rerender) adapter.rerender(); } catch (e) { console.error(e); }
      })();
    }

    function showUpdatedBy(changes) {
      var who = {};
      changes.forEach(function (c) { if (c.by && c.by !== s.me.username) who[Portal.displayName(c.by)] = 1; });
      var names = Object.keys(who);
      if (names.length) Portal.toast('↻ Updated by ' + names.join(', '));
    }

    // RELOAD mode: show the newest data by reloading the page once the user pauses
    function markStale(changes) {
      s.stale = true;
      var names = {};
      (changes || []).forEach(function (c) { if (c.by) names[Portal.displayName(c.by)] = 1; });
      var by = Object.keys(names).join(', ');
      Portal.notice('stale', (by ? 'Updated by ' + by + '. ' : 'New changes are available. ') + 'The page refreshes when you pause.', {
        kind: 'info', action: { label: 'Refresh now', run: function () { reloadPage(''); } }
      });
      setTimeout(maybeReload, IDLE_RELOAD_MS + 200);
    }
    function maybeReload() {
      if (!s.stale || s.reloading) return;
      var idle = Date.now() - s.lastInput >= IDLE_RELOAD_MS;
      var busyUi = adapter.isBusy && adapter.isBusy();
      if (idle && !busyUi && !s.busy && !s.pendingWanted) { reloadPage(''); return; }
      setTimeout(maybeReload, 2000);
    }
    function reloadPage(message) {
      if (s.reloading) return;
      s.reloading = true;
      if (message) Portal.notice('reload', message + ' Reloading...', { kind: 'info' });
      engine.flush().then(function () { location.reload(); });
      if (!s.busy && !s.pendingWanted) location.reload();
    }

    // ---------------------------------------------------------- live connection
    function setConnected(on) { s.connected = on; Portal.setLive(on); }
    function connect() {
      var es = new EventSource('/api/apps/' + appId + '/events');
      es.addEventListener('hello', function (e) {
        setConnected(true);
        var d = JSON.parse(e.data);
        if (d.rev !== s.rev) { if (live) catchUp(); else if (d.rev > s.rev) markStale([]); }
        if (s.pendingWanted) run();
      });
      es.addEventListener('change', function (e) {
        var d = JSON.parse(e.data);
        if (d.clientId === s.clientId || d.rev <= s.rev) return;
        if (live) catchUp(); else markStale([{ by: d.by }]);
      });
      es.addEventListener('file', function (e) {
        var d = JSON.parse(e.data);
        if (d.by !== s.me.username) markStale([{ by: d.by }]);
      });
      es.addEventListener('presence', function (e) { Portal.setOnline(JSON.parse(e.data)); });
      // app-specific live events (e.g. Dining Halls: a gate scanned a card)
      Object.keys(adapter.events || {}).forEach(function (name) {
        es.addEventListener(name, function (e) { try { adapter.events[name](JSON.parse(e.data)); } catch (err) { console.error(err); } });
      });
      es.addEventListener('logout', function () {
        es.close();
        alert('Your account was changed by an admin. Please sign in again.');
        Portal.goLogin();
      });
      es.onerror = function () {
        setConnected(false);
        if (es.readyState === 2) setTimeout(function () {
          Portal.api('GET', '/api/me').then(connect, function (err) { if (!err.status || err.status >= 500) setTimeout(connect, RETRY_MS); });
        }, 3000);
      };
    }

    // ---------------------------------------------------------- account helpers for the app
    engine.isAppAdmin = function () { return s.role === 'admin'; };
    engine.verifyOwnPassword = function (password) {
      return Portal.api('POST', '/api/me/verify-password', { password: String(password || '') })
        .then(function (r) { return !!r.ok; }, function (e) { alert(e.message); return false; });
    };

    engine.ready.then(function () {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', afterReady);
      else afterReady();
    }, function () { });
    boot();
    return engine;
  }

  window.GESBridge = { create: create };
})();
