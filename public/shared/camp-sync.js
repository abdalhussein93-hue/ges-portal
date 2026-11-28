/*
 * Connects the Global Village Camp Management app to the portal server.
 *
 * Loaded after the camp app's own script (see tools/build-apps.js). It replaces the app's
 * local saving with the server:
 *   - loads the data from the server at start-up (the app's start-up waits for it)
 *   - saves only what changed; the server merges changes from several people
 *   - applies other people's changes in place and redraws the page
 *   - Unlock / admin checks use the signed-in user's own account and their role in this app
 */
(function () {
  'use strict';
  var P = window.GVCPatch, Portal = window.GESPortal;
  var APP = 'camp';
  var DOC_KEYS = ['campData', 'companies', 'historyLog', 'nationalities', 'BLOCKS_META', 'foodCategories', 'campList', 'appSeeds',
    'approvals', 'approvalCfg', 'deletedLog'];
  var RETRY_MS = 10000, CATCH_UP_EVERY_MS = 60000;

  // The app never declares historyLog (it becomes a global on first assignment); create it.
  if (!('historyLog' in window)) window.historyLog = [];

  var S = {
    me: null, role: null, rev: 0, base: null, doc: null, seed: null, ready: false,
    clientId: Math.random().toString(36).slice(2) + Date.now().toString(36),
    editSeq: 0, saveQueued: false, pullQueued: false, retryTimer: null, keepalive: false
  };

  // one thing at a time: saves and catch-ups never overlap
  var lock = Promise.resolve();
  function exclusive(fn) { var p = lock.then(fn, fn); lock = p.catch(function () { }); return p; }

  // ------------------------------------------------------------------ the app's data
  /* global campData, companies, historyLog, nationalities, BLOCKS_META_ALL, foodCategories, campList, appSeeds,
     unsaved, accessLevel, pwCallback, setSaveBar, refreshData, buildCampSwitcher, buildNav, updateNotifBadge,
     closePwModal, canEdit, renderProfit, isAdmin,
     approvalQueue, approvalCfg, mvDeletedLog, captureOperatorChanges, apOnLogin, apRefreshUI, renderApprovals, mvRun */
  function snapshot() {
    return {
      campData: campData, companies: companies, historyLog: historyLog, nationalities: nationalities,
      BLOCKS_META: BLOCKS_META_ALL, foodCategories: foodCategories, campList: campList, appSeeds: appSeeds,
      approvals: approvalQueue, approvalCfg: approvalCfg, deletedLog: mvDeletedLog
    };
  }
  function setTop(k, v) {
    switch (k) {
      case 'campData': campData = v; break;
      case 'companies': companies = v; break;
      case 'historyLog': historyLog = v; break;
      case 'nationalities': nationalities = v; break;
      case 'BLOCKS_META': BLOCKS_META_ALL = v; break;
      case 'foodCategories': foodCategories = v; break;
      case 'campList': campList = v; break;
      case 'appSeeds': appSeeds = v; break;
      case 'approvals': approvalQueue = v; break;
      case 'approvalCfg': approvalCfg = v; break;
      case 'deletedLog': mvDeletedLog = v; break;
    }
  }
  /** Applies changes to the data the screens use, in place (open forms keep working). */
  function applyLive(ops) {
    var root = snapshot(), before = {};
    DOC_KEYS.forEach(function (k) { before[k] = root[k]; });
    P.apply(root, ops);
    DOC_KEYS.forEach(function (k) { if (root[k] !== before[k]) setTop(k, root[k]); });
  }
  function applyDoc(doc) {
    campData = doc.campData || {};
    if (doc.companies) companies = doc.companies;
    historyLog = doc.historyLog || [];
    if (doc.nationalities) nationalities = doc.nationalities;
    if (doc.foodCategories) foodCategories = doc.foodCategories;
    if (doc.BLOCKS_META) BLOCKS_META_ALL = doc.BLOCKS_META;
    if (doc.campList) campList = doc.campList;
    if (doc.appSeeds) appSeeds = doc.appSeeds;
    approvalQueue = Array.isArray(doc.approvals) ? doc.approvals : [];
    approvalCfg = doc.approvalCfg || { enabled: true };
    mvDeletedLog = Array.isArray(doc.deletedLog) ? doc.deletedLog : [];
  }
  /**
   * Every block in the block list must have its data ({rooms: {}}); the app's screens crash
   * otherwise. Adds missing ones to `target` and returns their codes.
   */
  function missingBlocks(target, meta) {
    var added = [];
    Object.keys(meta || {}).forEach(function (bk) {
      if (!target[bk] || typeof target[bk] !== 'object' || !target[bk].rooms) { target[bk] = { rooms: {} }; added.push(bk); }
    });
    return added;
  }

  function loadDoc(doc) {
    applyDoc(P.clone(doc));
    S.base = P.clone(doc);
    var fixed = missingBlocks(campData, BLOCKS_META_ALL);
    if (fixed.length) {
      console.warn('[camp] blocks without data were given empty room lists:', fixed.join(', '));
      // Admins save the repair; for other roles it stays on this screen only (they may not change blocks).
      if (S.role !== 'admin' && S.base.campData) missingBlocks(S.base.campData, BLOCKS_META_ALL);
    }
    // Sections the server does not have yet: an admin's browser uploads them; other roles keep
    // the app's built-in defaults locally and never try to save them.
    if (S.role !== 'admin') {
      var snap = snapshot();
      DOC_KEYS.forEach(function (k) { if (!(k in S.base)) S.base[k] = P.clone(snap[k]); });
    }
  }
  function reloadAll() {
    return Portal.api('GET', '/api/apps/' + APP + '/data').then(function (d) {
      S.rev = d.rev;
      if (d.doc) loadDoc(d.doc);
      unsaved = false;
      rerender(null, true);
    });
  }

  // ------------------------------------------------------------------ saving
  function doSave() {
    if (!S.ready) return Promise.resolve();
    if (S.role === 'viewer') { unsaved = false; bar('view'); return Promise.resolve(); }
    var cur;
    try { cur = P.clone(snapshot()); } catch (e) { console.error(e); return Promise.resolve(); }
    var ops = P.diff(S.base, cur);
    if (!ops.length) { unsaved = false; bar('ok'); return Promise.resolve(); }
    var seq = S.editSeq;
    bar('saving');
    return Portal.api('POST', '/api/apps/' + APP + '/patch', { baseRev: S.rev, ops: ops, clientId: S.clientId }, { keepalive: S.keepalive })
      .then(function (r) {
        Portal.setLive(true);
        if (r.reload) {
          if (r.conflicts) alert('Someone else changed or deleted the same record at the same moment, so part of your last change could not be saved.\n\nThe page now shows the latest data. Please check your last change.');
          return reloadAll().then(function () { bar('ok'); });
        }
        var others = r.missed || [];
        if (others.length) {
          others.forEach(function (c) { applyLive(c.ops); P.apply(S.base, c.ops); });
          applyLive(ops); // the server applied ours last, so ours win here too
        }
        P.apply(S.base, ops);
        S.rev = r.rev;
        if (S.editSeq === seq) unsaved = false;
        bar(unsaved ? 'warn' : 'ok');
        if (others.length) { rerender(keysOf(others)); toastChanges(others); }
        if (unsaved) saveData();
      })
      .catch(function (e) {
        if (e && e.status === 401) return;
        if (e && e.data && e.data.denied) {
          alert('⚠ This change was NOT saved.\n\n' + e.message + '\n\nThe page will now show the latest saved data.');
          unsaved = false;
          return reloadAll().catch(function () { });
        }
        if (e && (e.status === 400 || e.status === 409 || e.status === 413)) { alert('⚠ Not saved: ' + e.message); bar('err'); return; }
        // network or server problem: keep the changes and try again
        unsaved = true; bar('err'); Portal.setLive(false);
        clearTimeout(S.retryTimer);
        S.retryTimer = setTimeout(saveData, RETRY_MS);
      });
  }
  function saveData(opts) {
    S.keepalive = !!(opts && opts.keepalive);
    if (S.saveQueued) return;
    S.saveQueued = true;
    exclusive(function () { S.saveQueued = false; return doSave(); });
  }
  function whenSaved() { return exclusive(function () { }); }

  // ------------------------------------------------------------------ receiving changes
  function doPull() {
    if (!S.ready) return Promise.resolve();
    if (unsaved) return doSave(); // saving also brings in everyone else's changes
    return Portal.api('GET', '/api/apps/' + APP + '/changes?since=' + S.rev).then(function (r) {
      if (r.reload) return reloadAll();
      if (!r.changes.length) return;
      r.changes.forEach(function (c) { applyLive(c.ops); P.apply(S.base, c.ops); });
      S.rev = r.rev;
      rerender(keysOf(r.changes));
      toastChanges(r.changes);
    }).catch(function (e) { if (!e || !e.status) Portal.setLive(false); });
  }
  function pull() {
    if (S.pullQueued) return;
    S.pullQueued = true;
    exclusive(function () { S.pullQueued = false; return doPull(); });
  }
  function keysOf(changes) {
    var k = {};
    changes.forEach(function (c) { (c.ops || []).forEach(function (o) { if (o.p) k[o.p[0]] = 1; }); });
    return k;
  }
  function toastChanges(changes) {
    var who = {};
    changes.forEach(function (c) { if (c.by && c.by !== S.me.username) who[Portal.displayName(c.by)] = 1; });
    var names = Object.keys(who);
    if (names.length) Portal.toast('↻ Updated by ' + names.join(', '));
  }

  // redraw the current page (waits while someone is typing or has a form open)
  var renderTimer = null;
  function busy() {
    if (document.querySelector('.modal-overlay:not(.hidden)')) return true;
    var a = document.querySelector('.page.active'), ae = document.activeElement;
    return !!(a && ae && a.contains(ae) && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName));
  }
  function rerender(keys, structure) {
    try {
      if (structure || (keys && (keys.BLOCKS_META || keys.campList))) { buildCampSwitcher(); buildNav(); }
      if (structure && typeof checkBackupReminder === 'function') checkBackupReminder(); // eslint-disable-line no-undef
    } catch (e) { console.error(e); }
    clearTimeout(renderTimer);
    (function attempt() {
      if (busy()) { renderTimer = setTimeout(attempt, 3000); return; }
      try {
        refreshData(true);
        if (typeof updateNotifBadge === 'function') updateNotifBadge();
        if (typeof apRefreshUI === 'function') apRefreshUI();
        var a = document.querySelector('.page.active');
        if (a && a.id === 'page-approvals' && typeof renderApprovals === 'function') renderApprovals();
        if (a && a.id === 'page-movement' && typeof mvRun === 'function') mvRun();
      } catch (e) { console.error(e); }
    })();
  }

  // ------------------------------------------------------------------ live connection
  function connect() {
    var es = new EventSource('/api/apps/' + APP + '/events');
    es.addEventListener('hello', function (e) {
      Portal.setLive(true);
      if (JSON.parse(e.data).rev !== S.rev) pull();
      if (unsaved) saveData();
    });
    es.addEventListener('change', function (e) {
      var d = JSON.parse(e.data);
      if (d.clientId !== S.clientId && d.rev > S.rev) pull();
    });
    es.addEventListener('presence', function (e) { Portal.setOnline(JSON.parse(e.data)); });
    es.addEventListener('logout', function () {
      es.close();
      alert('Your account was changed by an admin. Please sign in again.');
      Portal.goLogin();
    });
    es.onerror = function () {
      Portal.setLive(false);
      if (es.readyState === 2) setTimeout(function () {
        Portal.api('GET', '/api/me').then(connect, function (err) { if (!err.status || err.status >= 500) setTimeout(connect, 5000); });
      }, 3000);
    };
  }

  // ------------------------------------------------------------------ save bar + access
  function bar(state) {
    var b = document.getElementById('saveBar'); if (!b) return;
    if (state === 'saving') { b.className = 'save-bar warn'; b.textContent = '⟳ Saving…'; return; }
    if (state === 'view') { b.className = 'save-bar ok'; b.textContent = '👁 View only'; return; }
    if (state === 'err') { b.className = 'save-bar err'; b.textContent = '❌ Not saved – retrying…'; return; }
    setSaveBar(state);
  }
  function roleLevel(role) { return role === 'admin' ? 'admin' : role === 'operator' ? 'operator' : 'none'; }
  function setAccess(level) {
    accessLevel = level;
    // approval workflow: notifications on unlock / lock (once the data is loaded)
    if (S.ready && typeof apOnLogin === 'function') setTimeout(function () { try { apOnLogin(level); } catch (e) { console.error(e); } }, 0);
    var lb = document.getElementById('lockBtn'), ls = document.getElementById('lockStatus'), ll = document.getElementById('lockLabel');
    if (!lb) return;
    if (level === 'admin') {
      lb.innerHTML = '<i class="ti ti-lock-open"></i> Admin';
      lb.style.cssText = 'background:#fee2e2;color:var(--red);border:1.5px solid #fca5a5';
      if (ls) ls.style.display = 'block'; if (ll) ll.textContent = 'Admin mode';
    } else if (level === 'operator') {
      lb.innerHTML = '<i class="ti ti-lock-open"></i> Operator';
      lb.style.cssText = 'background:var(--green-bg);color:var(--green);border:1.5px solid #6ee7b7';
      if (ls) ls.style.display = 'block'; if (ll) ll.textContent = 'Operator mode';
    } else {
      lb.innerHTML = S.role === 'viewer' ? '<i class="ti ti-eye"></i> View only' : '<i class="ti ti-lock"></i> Unlock';
      lb.style.cssText = 'background:var(--blue-light);color:var(--blue);border:1.5px solid var(--border2)';
      if (ls) ls.style.display = 'none';
    }
  }
  function needAccountMsg(level) {
    return 'This needs the ' + (level === 'admin' ? 'Admin' : 'Operator or Admin') + ' role in Camp Management.\n\nYou are signed in as "' +
      S.me.username + '" (' + Portal.ROLE_LABEL[S.role] + '). Ask a portal admin to change your role, or sign in with another account.';
  }

  // ------------------------------------------------------------------ replace the app's functions
  function install() {
    // For the approval workflow: the signed-in account and the data the server has confirmed
    window.GESCamp = { me: function () { return S.me; }, base: function () { return S.base; } };

    window.saveData = function () {
      // an Operator's bed changes become an approval request (beds go back to the confirmed state)
      if (typeof captureOperatorChanges === 'function') {
        try { captureOperatorChanges(); } catch (e) { console.error('Approval capture failed:', e); }
      }
      saveData();
    };

    // Camps are the portal's: added on the Users page by a portal admin (the server enforces it)
    ['addCamp', 'renameCamp', 'deleteCamp'].forEach(function (fn) {
      if (typeof window[fn] !== 'function') return;
      window[fn] = function () {
        if (typeof buildCampSwitcher === 'function') buildCampSwitcher();
        alert('Camps are added on the portal\'s "Users, backups & activity" page by a portal admin, so every app has the same camps.' +
          (S.me && S.me.isAdmin ? '\n\nOpen it from the portal home page (⚙ Users, backups & activity).' : '\n\nAsk a portal admin.'));
      };
    });

    // Restoring a backup replaces data: Admins only (the server enforces it as well)
    ['restoreBackup', 'importCamp'].forEach(function (fn) {
      var orig = window[fn];
      if (typeof orig !== 'function') return;
      window[fn] = function (inp) {
        if (!isAdmin()) {
          if (inp && 'value' in inp) inp.value = '';
          alert('Only an Admin of Camp Management can restore a backup.');
          return;
        }
        return orig.apply(this, arguments);
      };
    });

    var origMarkUnsaved = window.markUnsaved, autoTimer = null;
    window.markUnsaved = function () {
      S.editSeq++;
      origMarkUnsaved();
      clearTimeout(autoTimer); autoTimer = setTimeout(saveData, 1500);
    };

    window.initData = function () {
      if (S.doc) loadDoc(S.doc);
      else { // empty server (admin only)
        if (S.seed && S.seed.campData) {
          // start from the data that was built into the desktop program
          campData = P.clone(S.seed.campData);
          historyLog = S.seed.historyLog || [];
        } else {
          // no starting data on this server: every block exists, with no rooms yet
          campData = {};
          historyLog = [];
        }
        missingBlocks(campData, BLOCKS_META_ALL);
        S.base = {};
      }
      S.doc = null;
      S.ready = true;
      bar(S.role === 'viewer' ? 'view' : 'ok');
    };

    var origRefresh = window.refreshData;
    window.refreshData = function (auto) {
      if (auto !== true) pull();
      return origRefresh.apply(this, arguments);
    };

    var origAddHist = window.addHistEntry;
    window.addHistEntry = function (e) {
      if (e && typeof e === 'object' && !e.by) e.by = S.me.username;
      return origAddHist.apply(this, arguments);
    };

    var origShowPw = window.showPwModal;
    window.showPwModal = function (level) {
      level = level || 'operator';
      var want = level === 'admin' ? 3 : 2, have = { admin: 3, operator: 2, viewer: 1 }[S.role] || 0;
      if (have < want) { pwCallback = null; alert(needAccountMsg(level)); return; }
      origShowPw(level);
      var sub = document.getElementById('pwModalSub');
      if (sub) sub.textContent = 'Enter YOUR password to unlock (signed in as ' + S.me.username + ').';
    };

    window.checkPw = function () {
      var inp = document.getElementById('pwInput'), err = document.getElementById('pwErr');
      var val = inp.value, level = inp.dataset.level || 'operator';
      if (!val) return;
      err.style.display = 'none';
      Portal.api('POST', '/api/me/verify-password', { password: val }).then(function (r) {
        if (!r.ok) { err.textContent = 'Incorrect password. Try again.'; err.style.display = 'block'; inp.select(); return; }
        var lvl = roleLevel(S.role);
        var cb = pwCallback;
        closePwModal();
        setAccess(lvl);
        if (level === 'admin' && lvl !== 'admin') { alert(needAccountMsg('admin')); return; }
        if (cb) cb();
      }).catch(function (e) { err.textContent = e.message; err.style.display = 'block'; });
    };

    window.toggleLock = function () {
      if (canEdit()) {
        setAccess('none');
        var pp = document.getElementById('page-profit');
        if (pp && pp.classList.contains('active')) renderProfit();
      } else if (S.role === 'viewer') {
        alert('Your role in Camp Management is View only. Ask a portal admin if you need to make changes.');
      } else {
        window.showPwModal(S.role === 'admin' ? 'admin' : 'operator');
      }
    };

    // Settings: the two shared-password boxes become "Your account"
    var origSettings = window.renderSettings;
    window.renderSettings = function () {
      origSettings.apply(this, arguments);
      var a = document.getElementById('s_old'), o = document.getElementById('o_old');
      var ca = a && a.closest('.card'), co = o && o.closest('.card');
      if (co) co.remove();
      if (!ca) return;
      var esc = Portal.esc;
      ca.innerHTML = '<div style="font-size:14px;font-weight:700;margin-bottom:10px"><i class="ti ti-user-circle" style="color:var(--blue)"></i> Your account</div>' +
        '<div style="font-size:13px;margin-bottom:12px">Signed in as <b>' + esc(S.me.name || S.me.username) + '</b> (' + esc(S.me.username) + ') · <b>' + Portal.ROLE_LABEL[S.role] + '</b> in Camp Management</div>' +
        '<div style="font-size:12px;color:var(--text2);margin-bottom:12px">Passwords are personal. Portal admins manage accounts and roles on the Users page.</div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap"><a class="btn btn-blue btn-sm" href="/login?change=1&self=1"><i class="ti ti-key"></i> Change my password</a>' +
        (S.me.isAdmin ? '<a class="btn btn-amber btn-sm" href="/admin"><i class="ti ti-users"></i> Users, backups &amp; activity</a>' : '') + '</div>';
    };
    window.changeAdminPw = window.changeOperPw = function () { location.href = '/login?change=1&self=1'; };
  }

  // ------------------------------------------------------------------ start
  /**
   * Camp has no data and the server has no starting data: let the admin import the desktop
   * data (recommended) or start with an empty camp. Resolves when "empty camp" is chosen.
   */
  function chooseFirstSetup() {
    Portal.cover('<div style="max-width:520px;text-align:left">' +
      '<h2 style="margin:0 0 8px;font-size:20px;color:#0f172a">Camp Management has no data yet</h2>' +
      '<p style="margin:0 0 6px">Recommended: import the data from the desktop program first. On the office PC, take ' +
      '<b>%APPDATA%\\global-village-camp-management\\app_data.json</b> and upload it on the admin page under <b>Backups &amp; import</b>.</p>' +
      '<p style="margin:0 0 4px;font-size:13px;color:#64748b">Or start with an empty camp (all blocks, no rooms) and add rooms yourself. ' +
      'An import later replaces it; the empty camp is kept as a backup.</p>' +
      '<a href="/admin">Import desktop data</a> &nbsp; ' +
      '<button type="button" id="gvcStartEmpty" style="background:#fff;color:#1d4ed8;border:1.5px solid #1d4ed8">Start an empty camp</button>' +
      '</div>');
    return new Promise(function (resolve) {
      document.getElementById('gvcStartEmpty').addEventListener('click', function () {
        Portal.cover('Setting up an empty camp…');
        resolve();
      });
    });
  }

  function boot() {
    Portal.cover('Connecting to the server…');
    Portal.api('GET', '/api/me').then(function (me) {
      S.me = me;
      S.role = me.apps[APP] || null;
      if (!S.role) { location.href = '/?denied=' + APP; throw null; }
      return Portal.api('GET', '/api/apps/' + APP + '/data');
    }).then(function (d) {
      S.rev = d.rev; S.doc = d.doc;
      if (!d.doc) {
        if (S.role !== 'admin') { Portal.cover('Camp Management has not been set up yet.<br>An Admin of this app must open it first.<br><a href="/">Back to all apps</a>'); throw null; }
        return Portal.api('GET', '/api/apps/' + APP + '/seed').then(function (seed) { S.seed = seed; }, function () {
          S.seed = null;
          return chooseFirstSetup();
        });
      }
    }).then(function () {
      install();
      setAccess(roleLevel(S.role));
      return window.__gvcStart();
    }).then(function () {
      if (S.base && !Object.keys(S.base).length) saveData(); // first setup: upload the starting data
      if (typeof apOnLogin === 'function') { try { apOnLogin(roleLevel(S.role)); } catch (e) { console.error(e); } }
      Portal.mount({ appId: APP, me: S.me });
      Portal.onBeforeLeave(whenSaved);
      connect();
      setInterval(pull, CATCH_UP_EVERY_MS);
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden' && unsaved) saveData({ keepalive: true });
        else if (document.visibilityState === 'visible') pull();
      });
      Portal.cover(null);
    }).catch(function (e) {
      if (e === null || (e && e.status === 401)) return;
      if (e && e.status === 403) { Portal.cover(Portal.esc(e.message) + '<br><a href="/">Back to all apps</a>'); return; }
      console.error(e);
      Portal.cover('Cannot reach the server.<br><small>' + Portal.esc(e && e.message) + '</small><br><button onclick="location.reload()">Try again</button>');
    });
  }
  boot();
})();
