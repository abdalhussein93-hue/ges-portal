/*
 * Daily Costing: confirming a day's entry, and change requests for confirmed days.
 *
 *  - An Operator (or Admin) clicks "Confirm day" when the day's entry is finished.
 *  - A confirmed day is locked for Operators. To change it they click "Request a change",
 *    edit the figures in a draft (nothing is saved), and send it to the Admin with a reason.
 *  - An Admin approves (the figures are written into the day) or rejects each request, can
 *    still edit a confirmed day directly, and can unlock it.
 * The server enforces all of this (src/domain/apps/costing.js); this file is the screen part.
 * Loaded in <head> after costing-bridge.js; it wraps a few of the app's own functions once the
 * app's script has run.
 */
(function () {
  'use strict';
  /* global db, state, render, save, showModal, closeModal, toast, esc, item, priceFor, dayKey, monthLabel, ensureMonth */
  var me = null, role = null;
  var ORIG = {};
  var draft = null;          // {mk, day, cons:{item:{group:qty}}, received:{item:qty}} while requesting a change
  var lastStatus = null;     // request id -> status, to tell people about news

  function pad(d) { return String(d).padStart(2, '0'); }
  function keyOf(mk, day) { return mk + '-' + pad(day); }
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function locks() { return db && isObj(db.dayLocks) ? db.dayLocks : {}; }
  function requests() { return db && Array.isArray(db.dayRequests) ? db.dayRequests : []; }
  function lockOf(mk, day) { return locks()[keyOf(mk, day)] || null; }
  function isAdmin() { return role === 'admin'; }
  function canEdit() { return role === 'admin' || role === 'operator'; }
  function who() { return me ? (me.name || me.username) : ''; }
  function inDraft(mk, day) { return !!draft && draft.mk === mk && String(draft.day) === String(day); }
  function dayIn(section, dd) {
    if (!isObj(section)) return undefined;
    for (var k in section) if (Object.prototype.hasOwnProperty.call(section, k) && pad(k) === dd) return section[k];
    return undefined;
  }
  function dayKeyIn(section, dd) {
    if (isObj(section)) for (var k in section) if (Object.prototype.hasOwnProperty.call(section, k) && pad(k) === dd) return k;
    return String(Number(dd));
  }
  function niceDay(key) {
    var p = key.split('-');
    return 'Day ' + Number(p[2]) + ', ' + monthLabel(p[0] + '-' + p[1]);
  }
  function when(iso) {
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function qty(n) { return (Math.round(Number(n) * 1000) / 1000).toLocaleString('en-US'); }
  function money2(n) { return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function uid() { return 'dr' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  /* ------------------------------------------------------------------ the request draft */
  function startDraft() {
    var m = (db.months || {})[state.month] || {};
    var dd = pad(state.day);
    var cons = clone(dayIn(m.cons, dd)) || {}, received = clone(dayIn(m.received, dd)) || {};
    // base: the figures when the draft started; only cells the Operator changes from these are sent
    draft = { mk: state.month, day: String(state.day), cons: cons, received: received, base: { cons: clone(cons), received: clone(received) } };
    ORIG.drawDaily();
    afterDraw();
    toast('Change request: edit the figures, then send it to the Admin', 'ok');
  }
  function dropDraft(say) {
    if (!draft) return;
    draft = null;
    if (say) toast('Unsent change request discarded', 'warn');
  }

  /**
   * The cells the Operator changed in the draft, in the format the server checks.
   * "from" is the figure saved now (it may have changed since the draft started, e.g. an Admin
   * approved another request); cells the Operator did not touch are never sent.
   */
  function draftChanges() {
    var m = (db.months || {})[draft.mk] || {};
    var dd = pad(draft.day);
    var out = [];
    var keys = function (a, b) { var k = {}; Object.keys(a || {}).concat(Object.keys(b || {})).forEach(function (x) { k[x] = 1; }); return Object.keys(k); };
    keys(draft.base.cons, draft.cons).forEach(function (i) {
      var a = isObj(draft.base.cons[i]) ? draft.base.cons[i] : {}, b = isObj(draft.cons[i]) ? draft.cons[i] : {};
      keys(a, b).forEach(function (g) {
        var to = Number(b[g]) || 0;
        if ((Number(a[g]) || 0) === to) return;
        var c = { s: 'cons', i: i, g: g, from: 0, to: to };
        c.from = currentValue(m, c, dd);
        if (c.from !== to) out.push(c);
      });
    });
    keys(draft.base.received, draft.received).forEach(function (i) {
      var to = Number(draft.received[i]) || 0;
      if ((Number(draft.base.received[i]) || 0) === to) return;
      var c = { s: 'received', i: i, from: 0, to: to };
      c.from = currentValue(m, c, dd);
      if (c.from !== to) out.push(c);
    });
    return out;
  }

  /** Writes requested cells into a month, exactly like the server does (src/domain/apps/costing.js). */
  function applyChanges(month, req) {
    var dd = req.day.slice(8);
    req.changes.forEach(function (c) {
      if (!isObj(month[c.s])) month[c.s] = {};
      var sec = month[c.s];
      var key = dayKeyIn(sec, dd);
      if (c.s === 'received') {
        if (c.to) { if (!isObj(sec[key])) sec[key] = {}; sec[key][c.i] = c.to; }
        else if (isObj(sec[key])) delete sec[key][c.i];
      } else if (c.to) {
        if (!isObj(sec[key])) sec[key] = {};
        if (!isObj(sec[key][c.i])) sec[key][c.i] = {};
        sec[key][c.i][c.g] = c.to;
      } else if (isObj(sec[key]) && isObj(sec[key][c.i])) delete sec[key][c.i][c.g];
    });
  }

  /* ------------------------------------------------------------------ change list (table) */
  function groupName(id) {
    var g = (db.groups || []).find(function (x) { return x.id === id; });
    return g ? g.name : id;
  }
  function changesTable(req, liveFrom) {
    var m = (db.months || {})[req.day.slice(0, 7)] || {};
    var dd = req.day.slice(8);
    var total = 0;
    var rows = req.changes.map(function (c) {
      var it = item(c.i);
      var price = it ? priceFor(it, req.day) : 0;
      var nowVal = liveFrom ? currentValue(m, c, dd) : c.from;
      var changedSince = liveFrom && nowVal !== c.from;
      if (c.s === 'cons') total += (c.to - c.from) * price;
      return '<tr><td>' + esc(it ? it.desc : c.i) + (it && it.ref ? ' <span class="dr-ref">' + esc(it.ref) + '</span>' : '') + '</td>' +
        '<td>' + (c.s === 'received' ? '<span class="dr-recv">Received</span>' : esc(groupName(c.g))) + '</td>' +
        '<td class="t-r">' + qty(c.from) + (changedSince ? ' <span class="dr-warn" title="Now ' + qty(nowVal) + '">⚠ now ' + qty(nowVal) + '</span>' : '') + '</td>' +
        '<td class="t-r"><b>' + qty(c.to) + '</b></td>' +
        '<td class="t-r ' + (c.to > c.from ? 'dr-up' : 'dr-down') + '">' + (c.to > c.from ? '+' : '') + qty(c.to - c.from) + '</td></tr>';
    }).join('');
    return '<table class="mini dr-table"><thead><tr><th>Item</th><th>Group</th><th class="t-r">Was</th><th class="t-r">New</th><th class="t-r">Diff</th></tr></thead><tbody>' + rows + '</tbody>' +
      '<tfoot><tr class="tot"><td colspan="4" class="t-r">Consumption cost impact</td><td class="t-r"><b>' + (total > 0 ? '+' : '') + money2(total) + '</b></td></tr></tfoot></table>';
  }
  function currentValue(month, c, dd) {
    var day = dayIn(month[c.s], dd);
    var row = isObj(day) ? day[c.i] : undefined;
    if (c.s === 'received') return Number(row) || 0;
    return (isObj(row) && Number(row[c.g])) || 0;
  }

  /* ------------------------------------------------------------------ actions */
  function confirmDay() {
    var mk = state.month, day = state.day;
    var m = (db.months || {})[mk] || {};
    var dd = pad(day);
    var cons = dayIn(m.cons, dd) || {}, recv = dayIn(m.received, dd) || {};
    var lines = 0, cost = 0;
    Object.keys(cons).forEach(function (i) {
      var it = item(i);
      Object.keys(cons[i] || {}).forEach(function (g) { var q = Number(cons[i][g]) || 0; if (q) { lines++; if (it) cost += q * priceFor(it, dayKey(mk, day)); } });
    });
    var recvLines = Object.keys(recv).filter(function (i) { return Number(recv[i]); }).length;
    showModal('<h3>Confirm ' + esc(niceDay(keyOf(mk, day))) + '?</h3>' +
      '<div class="msub">Confirm when the entry for this day is complete and correct.</div>' +
      '<div class="body"><div class="dr-sum"><div><b>' + lines + '</b><span>consumption entries</span></div><div><b>' + money2(cost) + '</b><span>consumption cost</span></div><div><b>' + recvLines + '</b><span>items received</span></div></div>' +
      (lines || recvLines ? '' : '<p class="dr-note warn">⚠ Nothing is recorded for this day.</p>') +
      '<p class="dr-note">After confirming, ' + (isAdmin() ? 'Operators can no longer change this day. Changes they need are sent to an Admin for approval.' : 'you can no longer change this day yourself. If something needs correcting, use <b>Request a change</b> and an Admin will approve it.') + '</p></div>' +
      '<div class="actions"><button class="btn ghost" id="drCancel">Cancel</button><button class="btn primary" id="drDoConfirm">✔ Confirm day</button></div>');
    document.getElementById('drCancel').onclick = closeModal;
    document.getElementById('drDoConfirm').onclick = function () {
      if (lockOf(mk, day)) { closeModal(); return; }
      if (!isObj(db.dayLocks)) db.dayLocks = {};
      db.dayLocks[keyOf(mk, day)] = { by: who(), byUser: me.username, at: new Date().toISOString() };
      save(); closeModal(); render();
      toast(niceDay(keyOf(mk, day)) + ' confirmed', 'ok');
    };
  }

  function unlockDay() {
    var key = keyOf(state.month, state.day);
    showModal('<h3>Unlock ' + esc(niceDay(key)) + '?</h3>' +
      '<div class="msub">Operators will be able to change this day again and confirm it once more.</div>' +
      '<div class="actions"><button class="btn ghost" id="drCancel">Cancel</button><button class="btn danger" id="drDoUnlock">🔓 Unlock day</button></div>');
    document.getElementById('drCancel').onclick = closeModal;
    document.getElementById('drDoUnlock').onclick = function () {
      delete db.dayLocks[key];
      save(); closeModal(); render();
      toast(niceDay(key) + ' unlocked', 'ok');
    };
  }

  function sendDraft() {
    var changes = draftChanges();
    if (!changes.length) { toast('You have not changed anything yet', 'warn'); return; }
    var key = keyOf(draft.mk, draft.day);
    var preview = { day: key, changes: changes };
    showModal('<h3>Send change request — ' + esc(niceDay(key)) + '</h3>' +
      '<div class="msub">An Admin will approve or reject it. Nothing changes until then.</div>' +
      '<div class="body" style="max-height:46vh;overflow:auto">' + changesTable(preview, false) + '</div>' +
      '<div class="body"><label class="dr-label" for="drReason">Reason for the change <span>(required)</span></label>' +
      '<textarea id="drReason" class="dr-text" rows="3" maxlength="1000" placeholder="e.g. Wrong quantity typed for Senior breakfast"></textarea></div>' +
      '<div class="actions"><button class="btn ghost" id="drCancel">Back</button><button class="btn primary" id="drDoSend">Send to Admin</button></div>');
    document.getElementById('drCancel').onclick = closeModal;
    document.getElementById('drReason').focus();
    document.getElementById('drDoSend').onclick = function () {
      var reason = document.getElementById('drReason').value.trim();
      if (!reason) { toast('Please write the reason for the change', 'warn'); document.getElementById('drReason').focus(); return; }
      if (!isObj(db.dayLocks) || !lockOf(draft.mk, draft.day)) { toast('This day is no longer confirmed: change it directly', 'warn'); closeModal(); dropDraft(false); render(); return; }
      if (!Array.isArray(db.dayRequests)) db.dayRequests = [];
      db.dayRequests.push({
        id: uid(), day: key, by: who(), byUser: me.username, at: new Date().toISOString(),
        reason: reason, status: 'pending', seen: true, changes: draftChanges()
      });
      draft = null;
      save(); closeModal(); render();
      toast('Change request sent to the Admin', 'ok');
    };
  }

  function decide(req, approve) {
    if (approve) {
      var m = (db.months || {})[req.day.slice(0, 7)] || {};
      var dd = req.day.slice(8);
      var moved = req.changes.filter(function (c) { return currentValue(m, c, dd) !== c.from; }).length;
      if (moved && !confirm(moved + ' of these figures changed after the request was sent (marked ⚠).\n\nApprove anyway? The requested "New" figures will be written into the day.')) return;
      applyChanges(ensureMonth(req.day.slice(0, 7)), req);
      req.status = 'approved';
      req.decidedAt = new Date().toISOString();
      req.decidedBy = who();
      save(); render(); openPanel();
      toast('Approved — ' + niceDay(req.day) + ' updated', 'ok');
      return;
    }
    showModal('<h3>Reject change request</h3><div class="msub">' + esc(req.by) + ' — ' + esc(niceDay(req.day)) + '</div>' +
      '<div class="body"><label class="dr-label" for="drNote">Reason <span>(shown to ' + esc(req.by) + ')</span></label>' +
      '<textarea id="drNote" class="dr-text" rows="3" maxlength="1000"></textarea></div>' +
      '<div class="actions"><button class="btn ghost" id="drCancel">Back</button><button class="btn danger" id="drDoReject">Reject</button></div>');
    document.getElementById('drCancel').onclick = openPanel;
    document.getElementById('drDoReject').onclick = function () {
      req.status = 'rejected';
      req.note = document.getElementById('drNote').value.trim().slice(0, 1000);
      req.decidedAt = new Date().toISOString();
      req.decidedBy = who();
      save(); render(); openPanel();
      toast('Request rejected', 'ok');
    };
  }

  function withdraw(req) {
    if (!confirm('Withdraw this change request?')) return;
    req.status = 'withdrawn';
    req.decidedAt = new Date().toISOString();
    save(); render(); openPanel();
  }

  /* ------------------------------------------------------------------ requests panel */
  var STATUS = { pending: ['⏳ Waiting for Admin', 'p'], approved: ['✔ Approved', 'a'], rejected: ['✖ Rejected', 'r'], withdrawn: ['Withdrawn', 'w'] };
  function visible() {
    var list = requests().slice().reverse();
    return isAdmin() ? list : list.filter(function (r) { return me && r.byUser === me.username; });
  }
  function openPanel(onlyDay) {
    var list = visible().filter(function (r) { return !onlyDay || r.day === onlyDay; });
    var pending = list.filter(function (r) { return r.status === 'pending'; });
    var done = list.filter(function (r) { return r.status !== 'pending'; }).slice(0, 30);
    function card(r) {
      var st = STATUS[r.status] || [r.status, 'w'];
      var mine = me && r.byUser === me.username;
      return '<div class="dr-card" data-id="' + esc(r.id) + '"><div class="dr-head"><b>' + esc(niceDay(r.day)) + '</b>' +
        '<span class="dr-st dr-' + st[1] + '">' + st[0] + '</span><span class="dr-meta">' + esc(r.by) + ' · ' + esc(when(r.at)) + '</span></div>' +
        '<div class="dr-reason">“' + esc(r.reason || '') + '”</div>' +
        changesTable(r, r.status === 'pending') +
        (r.status !== 'pending' && r.decidedBy ? '<div class="dr-meta">' + (r.status === 'withdrawn' ? 'Withdrawn' : 'Decided by ' + esc(r.decidedBy)) + ' · ' + esc(when(r.decidedAt)) + (r.note ? ' — “' + esc(r.note) + '”' : '') + '</div>' : '') +
        (r.status === 'pending' && isAdmin() ? '<div class="dr-btns"><button class="btn danger sm" data-act="reject">✖ Reject</button><button class="btn primary sm" data-act="approve">✔ Approve</button></div>' : '') +
        (r.status === 'pending' && !isAdmin() && mine ? '<div class="dr-btns"><button class="btn ghost sm" data-act="withdraw">Withdraw</button></div>' : '') +
        '</div>';
    }
    showModal('<h3>' + (isAdmin() ? 'Day change requests' : 'My change requests') + (onlyDay ? ' — ' + esc(niceDay(onlyDay)) : '') + '</h3>' +
      '<div class="msub">' + (isAdmin() ? 'Operators ask to change days that were already confirmed. Approving writes the new figures into the day.' : 'Changes you asked for on confirmed days, and the Admin’s answer.') + '</div>' +
      '<div class="body dr-list">' +
      (pending.length ? '<div class="dr-sec">Waiting (' + pending.length + ')</div>' + pending.map(card).join('') : '<p class="dr-empty">No requests waiting.</p>') +
      (done.length ? '<div class="dr-sec">Decided</div>' + done.map(card).join('') : '') +
      '</div><div class="actions"><button class="btn primary" id="drClose">Close</button></div>');
    document.getElementById('drClose').onclick = closeModal;
    document.querySelectorAll('.dr-card [data-act]').forEach(function (b) {
      b.onclick = function () {
        var id = b.closest('.dr-card').getAttribute('data-id');
        var r = requests().find(function (x) { return x.id === id; });
        if (!r || r.status !== 'pending') { toast('This request was already decided', 'warn'); openPanel(onlyDay); return; }
        var act = b.getAttribute('data-act');
        if (act === 'withdraw') withdraw(r); else decide(r, act === 'approve');
      };
    });
    // the Operator has now seen the answers to their requests
    if (!isAdmin() && canEdit()) {
      var unseen = requests().filter(function (r) { return me && r.byUser === me.username && r.status !== 'pending' && r.seen !== true; });
      if (unseen.length) { unseen.forEach(function (r) { r.seen = true; }); save(); updateBadge(); }
    }
  }

  /* ------------------------------------------------------------------ screen */
  function afterDraw() {
    if (state.view !== 'daily') return;
    var card = document.querySelector('#content .tablecard');
    if (!card) return;
    var bar = document.getElementById('drBar');
    if (!bar) { bar = document.createElement('div'); bar.id = 'drBar'; card.parentNode.insertBefore(bar, card); }
    var key = keyOf(state.month, state.day);
    var lock = lockOf(state.month, state.day);
    var waiting = requests().filter(function (r) { return r.day === key && r.status === 'pending' && (isAdmin() || (me && r.byUser === me.username)); }).length;
    var waitHtml = waiting ? '<button class="dr-chip dr-p" id="drWaiting">⏳ ' + waiting + ' change request' + (waiting > 1 ? 's' : '') + ' waiting</button>' : '';
    var locked = !!lock && !isAdmin() && !inDraft(state.month, state.day);
    if (inDraft(state.month, state.day)) {
      var n = draftChanges().length;
      bar.className = 'dr-bar dr-draft';
      bar.innerHTML = '<span class="dr-ic">✏️</span><div class="dr-txt"><b>Change request for ' + esc(niceDay(key)) + '</b><span>Edit the figures below. Nothing is saved until an Admin approves. ' + n + ' figure' + (n !== 1 ? 's' : '') + ' changed.</span></div>' +
        '<button class="btn ghost sm" id="drCancelDraft">Cancel</button><button class="btn primary sm" id="drSend"' + (n ? '' : ' disabled') + '>Send to Admin…</button>';
      document.getElementById('drCancelDraft').onclick = function () { dropDraft(false); ORIG.drawDaily(); afterDraw(); };
      document.getElementById('drSend').onclick = sendDraft;
    } else if (lock) {
      bar.className = 'dr-bar dr-locked';
      bar.innerHTML = '<span class="dr-ic">🔒</span><div class="dr-txt"><b>' + esc(niceDay(key)) + ' is confirmed</b><span>by ' + esc(lock.by || '') + ' · ' + esc(when(lock.at)) +
        (isAdmin() ? ' — as Admin, your changes here are saved directly.' : role === 'operator' ? ' — to correct something, request a change.' : '') + '</span></div>' + waitHtml +
        (role === 'operator' ? '<button class="btn primary sm" id="drRequest">✏️ Request a change</button>' : '') +
        (isAdmin() ? '<button class="btn ghost sm" id="drUnlock">🔓 Unlock day</button>' : '');
      var rq = document.getElementById('drRequest'); if (rq) rq.onclick = startDraft;
      var ul = document.getElementById('drUnlock'); if (ul) ul.onclick = unlockDay;
    } else {
      bar.className = 'dr-bar dr-open';
      bar.innerHTML = '<span class="dr-ic">📝</span><div class="dr-txt"><b>' + esc(niceDay(key)) + ' — not confirmed yet</b><span>' +
        (canEdit() ? 'When the entry for this day is finished, confirm it.' : 'Entry still in progress.') + '</span></div>' + waitHtml +
        (canEdit() ? '<button class="btn primary sm" id="drConfirm">✔ Confirm day</button>' : '');
      var cf = document.getElementById('drConfirm'); if (cf) cf.onclick = confirmDay;
    }
    var w = document.getElementById('drWaiting'); if (w) w.onclick = function () { openPanel(key); };
    // a confirmed day is read-only for Operators (outside a change request)
    document.querySelectorAll('#dTable input').forEach(function (inp) {
      inp.disabled = locked;
      inp.classList.toggle('dr-ro', locked);
    });
    var clear = document.getElementById('clearDay');
    if (clear && locked) clear.style.display = 'none';
  }

  /** Marks confirmed days in the day picker. */
  function markDayOptions() {
    var pick = document.getElementById('dayPick');
    if (!pick) return;
    Array.prototype.forEach.call(pick.options, function (o) {
      if (lockOf(state.month, o.value)) o.textContent = 'Day ' + o.value + '  ✔ confirmed';
    });
  }

  function ensureNav() {
    if (document.getElementById('drNav')) return;
    var nav = document.getElementById('nav');
    if (!nav) return;
    var a = document.createElement('a');
    a.id = 'drNav';
    a.innerHTML = '<span class="ic">📝</span> Change requests <span class="nav-badge hide" id="drBadge">0</span>';
    a.onclick = function () {
      document.getElementById('side').classList.remove('open');
      document.getElementById('scrim').classList.remove('show');
      openPanel();
    };
    var daily = nav.querySelector('a[data-view="daily"]');
    if (daily && daily.nextSibling) nav.insertBefore(a, daily.nextSibling); else nav.appendChild(a);
  }
  function updateBadge() {
    ensureNav();
    var b = document.getElementById('drBadge');
    if (!b) return;
    var n = isAdmin()
      ? requests().filter(function (r) { return r.status === 'pending'; }).length
      : requests().filter(function (r) { return me && r.byUser === me.username && (r.status === 'pending' || (r.status !== 'withdrawn' && r.seen !== true)); }).length;
    b.textContent = n;
    b.classList.toggle('hide', !n);
  }
  /** Tells people about new requests (Admin) and answers to their own (Operator). */
  function noticeChanges() {
    var now = {};
    requests().forEach(function (r) { now[r.id] = r.status; });
    if (lastStatus) {
      requests().forEach(function (r) {
        var before = lastStatus[r.id];
        if (isAdmin() && !before && r.status === 'pending' && me && r.byUser !== me.username) toast('New change request from ' + r.by + ' — ' + niceDay(r.day));
        if (!isAdmin() && me && r.byUser === me.username && before === 'pending' && (r.status === 'approved' || r.status === 'rejected')) {
          toast('Your change request for ' + niceDay(r.day) + ' was ' + r.status, r.status === 'approved' ? 'ok' : 'warn');
        }
      });
    }
    lastStatus = now;
  }

  function addStyles() {
    var css = document.createElement('style');
    css.textContent = [
      '.dr-bar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;border-radius:12px;padding:10px 14px;margin:0 0 12px;border:1px solid var(--line);background:var(--card);box-shadow:var(--shadow)}',
      '.dr-bar .dr-ic{font-size:20px}',
      '.dr-bar .dr-txt{flex:1;min-width:200px;display:flex;flex-direction:column}',
      '.dr-bar .dr-txt span{color:var(--muted);font-size:12.5px}',
      '.dr-open{border-color:#f3d7b5;background:var(--accent-soft)}',
      '.dr-locked{border-color:#b9dccb;background:var(--good-soft)}',
      '.dr-draft{border-color:#9dbfe3;background:var(--blue-soft)}',
      '.dr-chip{border-radius:999px;padding:5px 11px;font-size:12px;font-weight:700}',
      '.dr-p{background:#fff3cd;color:#8a5a00}.dr-a{background:var(--good-soft);color:var(--good)}.dr-r{background:var(--warn-soft);color:var(--warn)}.dr-w{background:#eef0f3;color:var(--muted)}',
      'input.dr-ro{background:#f3f2ee!important;color:var(--muted)!important;cursor:not-allowed}',
      '.dr-sum{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:6px 0 10px}',
      '.dr-sum div{background:var(--paper);border:1px solid var(--line);border-radius:10px;padding:10px;text-align:center}',
      '.dr-sum b{display:block;font-size:18px}.dr-sum span{font-size:11.5px;color:var(--muted)}',
      '.dr-note{font-size:13px;color:var(--muted);margin-top:6px}.dr-note.warn{color:var(--warn)}',
      '.dr-label{display:block;font-weight:600;font-size:13px;margin:8px 0 6px}.dr-label span{color:var(--muted);font-weight:400}',
      '.dr-text{width:100%;border:1px solid var(--line);border-radius:10px;padding:9px 10px;font:inherit;resize:vertical}',
      '.dr-list{max-height:62vh;overflow:auto}',
      '.dr-sec{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);font-weight:700;margin:6px 0}',
      '.dr-card{border:1px solid var(--line);border-radius:12px;padding:12px;margin-bottom:10px;background:var(--card)}',
      '.dr-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px}',
      '.dr-st{border-radius:999px;padding:2px 9px;font-size:11.5px;font-weight:700}',
      '.dr-meta{color:var(--muted);font-size:12px}',
      '.dr-reason{font-style:italic;margin:2px 0 8px}',
      '.dr-btns{display:flex;justify-content:flex-end;gap:8px;margin-top:8px}',
      '.dr-table{width:100%}.dr-ref{color:var(--muted);font-size:11px}.dr-recv{color:var(--blue);font-weight:600}',
      '.dr-up{color:var(--warn)}.dr-down{color:var(--good)}.dr-warn{color:var(--warn);font-size:11px}',
      '.dr-empty{color:var(--muted)}',
      '#drNav{cursor:pointer}'
    ].join('\n');
    document.head.appendChild(css);
  }

  /* ------------------------------------------------------------------ install */
  function install() {
    ['dayCons', 'setDayCons', 'dayRecv', 'setDayRecv', 'drawDaily', 'viewDaily', 'render'].forEach(function (n) {
      if (typeof window[n] !== 'function') throw new Error('Daily Costing changed: ' + n + ' is missing');
      ORIG[n] = window[n];
    });
    // while a change request is being written, the day's figures are read from / written to the draft
    window.dayCons = function (mk, day, itemId, grpId) {
      if (inDraft(mk, day)) return ((draft.cons[itemId] || {})[grpId]) || 0;
      return ORIG.dayCons.apply(this, arguments);
    };
    window.setDayCons = function (mk, day, itemId, grpId, val) {
      if (!inDraft(mk, day)) return ORIG.setDayCons.apply(this, arguments);
      if (!isObj(draft.cons[itemId])) draft.cons[itemId] = {};
      if (val) draft.cons[itemId][grpId] = val; else delete draft.cons[itemId][grpId];
      setTimeout(afterDraw, 0);
    };
    window.dayRecv = function (mk, day, itemId) {
      if (inDraft(mk, day)) return draft.received[itemId] || 0;
      return ORIG.dayRecv.apply(this, arguments);
    };
    window.setDayRecv = function (mk, day, itemId, val) {
      if (!inDraft(mk, day)) return ORIG.setDayRecv.apply(this, arguments);
      if (val) draft.received[itemId] = val; else delete draft.received[itemId];
      setTimeout(afterDraw, 0);
    };
    window.drawDaily = function () { ORIG.drawDaily.apply(this, arguments); afterDraw(); };
    window.viewDaily = function () {
      if (draft && (draft.mk !== state.month || String(draft.day) !== String(state.day))) dropDraft(true);
      ORIG.viewDaily.apply(this, arguments);
      markDayOptions();
    };
    window.render = function () {
      if (draft && state.view !== 'daily') dropDraft(true);
      // the Admin unlocked the day, or approved meanwhile: the draft is no longer needed
      if (draft && !lockOf(draft.mk, draft.day)) dropDraft(true);
      ORIG.render.apply(this, arguments);
      updateBadge();
      noticeChanges();
    };
  }

  window.GESApp.ready.then(function (r) {
    me = r.me; role = r.role;
  });
  document.addEventListener('DOMContentLoaded', function () {
    try { install(); addStyles(); }
    catch (e) { console.error(e); window.GESPortal && window.GESPortal.notice('drfail', 'Day confirmation could not start: ' + e.message, { kind: 'error' }); }
  });
})();
