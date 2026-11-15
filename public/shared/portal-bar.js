/*
 * GES Operations Portal - the small bar shown in the bottom-right corner of every app:
 * live status, who is online, switching apps, account menu. Also notices and a covering
 * message for start-up problems.
 *
 *   GESPortal.mount({appId, me})
 *   GESPortal.setLive(true|false)        GESPortal.setOnline([{username, name}])
 *   GESPortal.notice(id, text, {kind, action: {label, run}})   GESPortal.clearNotice(id)
 *   GESPortal.toast(text)                GESPortal.cover(html|null)
 *   GESPortal.api(method, url, body)     fetch helper (signs in again on 401)
 */
(function () {
  'use strict';
  var ROLE_LABEL = { admin: 'Admin', operator: 'Operator', viewer: 'Viewer' };
  var state = { appId: null, me: null, apps: [], live: false, online: [] };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function el(tag, cls, html) { var x = document.createElement(tag); if (cls) x.className = cls; if (html != null) x.innerHTML = html; return x; }

  function goLogin() { location.href = '/login?next=' + encodeURIComponent(location.pathname); }

  /** fetch wrapper: JSON in/out, errors carry .status and .data */
  function api(method, url, body, options) {
    var opts = { method: method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    if (options && options.keepalive && opts.body && opts.body.length < 60000) opts.keepalive = true;
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (data) {
        if (r.status === 401) goLogin();
        if (r.status === 403 && data && data.mustChange) location.href = '/login?change=1';
        if (!r.ok) {
          var e = new Error((data && data.error) || ('Server error ' + r.status));
          e.status = r.status; e.data = data;
          throw e;
        }
        return data;
      });
    });
  }

  var CSS = [
    '.gesp{position:fixed;right:14px;bottom:14px;z-index:2147483000;font:13px/1.35 "Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif;color:#0f172a}',
    '.gesp *{box-sizing:border-box}',
    '.gesp-pill{display:flex;align-items:center;gap:8px;background:#0f172a;color:#fff;border-radius:999px;padding:6px 8px 6px 12px;box-shadow:0 8px 24px rgba(2,6,23,.3);cursor:pointer;user-select:none;border:0;font:inherit}',
    '.gesp-pill:focus-visible{outline:3px solid #60a5fa;outline-offset:2px}',
    '.gesp-app{font-weight:700;white-space:nowrap;max-width:180px;overflow:hidden;text-overflow:ellipsis}',
    '.gesp-dotapp{width:10px;height:10px;border-radius:3px;flex:none}',
    '.gesp-live{display:flex;align-items:center;gap:5px;background:rgba(255,255,255,.12);border-radius:999px;padding:3px 9px;font-size:11.5px;font-weight:600;white-space:nowrap}',
    '.gesp-dot{width:8px;height:8px;border-radius:50%;background:#ef4444}',
    '.gesp-live.on .gesp-dot{background:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.25)}',
    '.gesp-menu{position:absolute;right:0;bottom:calc(100% + 8px);width:290px;max-width:calc(100vw - 28px);background:#fff;border:1px solid #e2e8f0;border-radius:12px;box-shadow:0 18px 40px rgba(2,6,23,.25);padding:8px;display:none;max-height:calc(100vh - 90px);overflow:auto}',
    '.gesp.open .gesp-menu{display:block}',
    '.gesp-who{padding:8px 10px 10px;border-bottom:1px solid #e2e8f0;margin-bottom:6px}',
    '.gesp-who b{display:block;font-size:14px}',
    '.gesp-who span{color:#64748b;font-size:12px}',
    '.gesp-sec{font-size:10.5px;letter-spacing:.6px;text-transform:uppercase;color:#94a3b8;font-weight:700;padding:8px 10px 4px}',
    '.gesp-item{display:flex;align-items:center;gap:9px;width:100%;padding:8px 10px;border-radius:8px;text-decoration:none;color:#0f172a;background:none;border:0;font:inherit;cursor:pointer;text-align:left}',
    '.gesp-item:hover,.gesp-item:focus-visible{background:#f1f5f9;outline:none}',
    '.gesp-item.cur{background:#eff6ff}',
    '.gesp-item .gesp-role{margin-left:auto;font-size:11px;color:#64748b}',
    '.gesp-online{padding:8px 10px;font-size:12px;color:#475569;border-top:1px solid #e2e8f0;margin-top:6px}',
    '.gesp-notices{position:fixed;left:50%;top:10px;transform:translateX(-50%);z-index:2147483001;display:flex;flex-direction:column;gap:6px;align-items:center;pointer-events:none;width:max-content;max-width:calc(100vw - 24px);font:13px/1.35 "Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif}',
    '.gesp-notice{pointer-events:auto;display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:10px;box-shadow:0 8px 22px rgba(2,6,23,.18);background:#fffbeb;color:#92400e;border:1px solid #fcd34d}',
    '.gesp-notice.info{background:#eff6ff;color:#1e3a8a;border-color:#bfdbfe}',
    '.gesp-notice.error{background:#fef2f2;color:#991b1b;border-color:#fecaca}',
    '.gesp-notice button{border:0;border-radius:7px;padding:5px 10px;font:inherit;font-weight:700;cursor:pointer;background:#0f172a;color:#fff}',
    '.gesp-toast{position:fixed;right:14px;bottom:64px;z-index:2147483001;background:#0f172a;color:#fff;padding:9px 13px;border-radius:10px;font:12.5px "Segoe UI",system-ui,sans-serif;box-shadow:0 10px 28px rgba(2,6,23,.3);opacity:0;transform:translateY(6px);transition:all .25s;pointer-events:none;max-width:320px}',
    '.gesp-toast.show{opacity:1;transform:none}',
    '.gesp-cover{position:fixed;inset:0;z-index:2147483002;background:rgba(241,245,249,.96);display:flex;align-items:center;justify-content:center;padding:24px;font:15px/1.5 "Segoe UI",system-ui,sans-serif;color:#334155;text-align:center}',
    '.gesp-cover a,.gesp-cover button{display:inline-block;margin-top:14px;padding:9px 16px;border-radius:9px;background:#1d4ed8;color:#fff;text-decoration:none;border:0;font:inherit;font-weight:700;cursor:pointer}',
    '@media print{.gesp,.gesp-notices,.gesp-toast{display:none!important}}',
    '@media (max-width:640px){.gesp-app{max-width:90px}.gesp-live .gesp-txt{display:none}}'
  ].join('\n');

  var root, pill, menu, noticesBox, toastEl, toastTimer;

  function ensureStyles() {
    if (document.getElementById('gesp-css')) return;
    var s = el('style'); s.id = 'gesp-css'; s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  function currentApp() { return state.apps.find(function (a) { return a.id === state.appId; }) || null; }

  function renderPill() {
    if (!pill) return;
    var app = currentApp();
    pill.innerHTML = '<span class="gesp-dotapp" style="background:' + esc(app ? app.color : '#64748b') + '"></span>' +
      '<span class="gesp-app">' + esc(app ? app.name : 'GES Portal') + '</span>' +
      '<span class="gesp-live' + (state.live ? ' on' : '') + '"><span class="gesp-dot"></span><span class="gesp-txt">' +
      (state.live ? 'Live · ' + state.online.length : 'Offline') + '</span></span>';
    pill.title = state.live ? 'Connected. Online now: ' + state.online.map(function (u) { return u.name || u.username; }).join(', ')
      : 'Not connected to the server. Your changes are kept and saved when the connection is back.';
  }

  function renderMenu() {
    if (!menu || !state.me) return;
    var me = state.me, app = currentApp();
    var h = '<div class="gesp-who"><b>' + esc(me.name || me.username) + '</b><span>' + esc(me.username) +
      (app && me.apps[app.id] ? ' · ' + ROLE_LABEL[me.apps[app.id]] + ' in ' + esc(app.name) : '') + '</span></div>';
    h += '<div class="gesp-sec">Apps</div><a class="gesp-item" href="/">⌂ All apps</a>';
    state.apps.forEach(function (a) {
      if (!me.apps[a.id]) return;
      h += '<a class="gesp-item' + (a.id === state.appId ? ' cur' : '') + '" href="' + esc(a.path) + '">' +
        '<span class="gesp-dotapp" style="background:' + esc(a.color) + '"></span>' + esc(a.name) +
        '<span class="gesp-role">' + ROLE_LABEL[me.apps[a.id]] + '</span></a>';
    });
    h += '<div class="gesp-sec">Account</div>';
    if (me.isAdmin) h += '<a class="gesp-item" href="/admin">⚙ Users, backups &amp; activity</a>';
    h += '<a class="gesp-item" href="/login?change=1&amp;self=1">🔑 Change my password</a>' +
      '<button class="gesp-item" type="button" data-gesp="logout">⎋ Sign out</button>';
    h += '<div class="gesp-online"><b>Online in this app (' + state.online.length + '):</b><br>' +
      (state.online.map(function (u) { return esc(u.name || u.username); }).join(', ') || '—') + '</div>';
    menu.innerHTML = h;
  }

  function mount(options) {
    state.appId = options.appId || null;
    state.me = options.me;
    ensureStyles();
    if (!root) {
      root = el('div', 'gesp');
      pill = el('button', 'gesp-pill'); pill.type = 'button'; pill.setAttribute('aria-haspopup', 'true');
      menu = el('div', 'gesp-menu'); menu.setAttribute('role', 'menu');
      root.appendChild(menu); root.appendChild(pill);
      document.body.appendChild(root);
      pill.addEventListener('click', function (e) { e.stopPropagation(); root.classList.toggle('open'); renderMenu(); });
      document.addEventListener('click', function (e) { if (!root.contains(e.target)) root.classList.remove('open'); });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') root.classList.remove('open'); });
      menu.addEventListener('click', function (e) {
        var b = e.target.closest('[data-gesp="logout"]');
        if (b) signOut();
      });
    }
    renderPill();
    return api('GET', '/api/apps').then(function (apps) { state.apps = apps; renderPill(); renderMenu(); }).catch(function () { });
  }

  /** Set by the sync layer so signing out waits for pending saves. */
  var beforeLeave = function () { return Promise.resolve(); };
  function onBeforeLeave(fn) { beforeLeave = fn; }
  function signOut() {
    beforeLeave().catch(function () { }).then(function () { return api('POST', '/api/logout', {}).catch(function () { }); })
      .then(function () { location.href = '/login'; });
  }

  function setLive(on) { state.live = !!on; renderPill(); }
  function setOnline(list) { state.online = list || []; renderPill(); if (root && root.classList.contains('open')) renderMenu(); }

  function notice(id, text, opts) {
    opts = opts || {};
    if (!noticesBox) { noticesBox = el('div', 'gesp-notices'); document.body.appendChild(noticesBox); }
    var n = document.getElementById('gesp-n-' + id);
    if (!n) { n = el('div'); n.id = 'gesp-n-' + id; noticesBox.appendChild(n); }
    n.className = 'gesp-notice ' + (opts.kind || 'warn');
    n.setAttribute('role', 'status');
    n.innerHTML = '<span>' + esc(text) + '</span>';
    if (opts.action) {
      var b = el('button', null, esc(opts.action.label)); b.type = 'button';
      b.addEventListener('click', opts.action.run);
      n.appendChild(b);
    }
  }
  function clearNotice(id) { var n = document.getElementById('gesp-n-' + id); if (n) n.remove(); }

  function toast(text) {
    ensureStyles();
    if (!toastEl) { toastEl = el('div', 'gesp-toast'); toastEl.setAttribute('role', 'status'); document.body.appendChild(toastEl); }
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 3500);
  }

  function cover(html) {
    ensureStyles();
    var c = document.getElementById('gesp-cover');
    if (!html) { if (c) c.remove(); return; }
    if (!c) { c = el('div', 'gesp-cover'); c.id = 'gesp-cover'; (document.body || document.documentElement).appendChild(c); }
    c.innerHTML = '<div>' + html + '</div>';
  }

  function displayName(username) {
    var o = state.online.find(function (u) { return u.username === username; });
    return (o && o.name) || username;
  }

  window.GESPortal = {
    mount: mount, setLive: setLive, setOnline: setOnline, notice: notice, clearNotice: clearNotice,
    toast: toast, cover: cover, api: api, esc: esc, displayName: displayName, onBeforeLeave: onBeforeLeave,
    goLogin: goLogin, ROLE_LABEL: ROLE_LABEL
  };
})();
