/*
 * Camp Management - Operator -> Admin approval workflow and Movement Summary.
 *
 * Based on the version made for the single-file Camp app (CAMP_MANGMENT.html), adapted to the portal:
 *  - names come from the signed-in account (no name pop-up); the server also stamps them
 *  - an Operator's changes are compared with the data the server has confirmed (camp-sync.js keeps it),
 *    so changes made meanwhile by other people are never mistaken for the Operator's own
 *  - each Operator sees and clears only their own decision notifications
 *  - dashboard pending numbers count only the camp being viewed
 *  - "Deleted" in the Movement Summary = check in/out log records an Admin deleted
 *
 * Loaded after the app's own script and before camp-sync.js. The hooks inside the app's screens are
 * added by tools/build-apps.js.
 */
/* global campData, historyLog, BLOCKS_META, accessLevel, isAdmin, showPwModal, pwCallback, saveData,
   renderDashboard, renderHistory, renderSummary, renderBilling, renderVOReport, renderBlock, showPage,
   showBlockPage, updateNotifBadge, saveBtnHtml, today, XLSX, currentCamp, histCamp */

// ============================================================ state (saved with the camp data)
var approvalQueue = [];                 // saved as "approvals"
var approvalCfg = { enabled: true };    // saved as "approvalCfg"
var mvDeletedLog = [];                  // saved as "deletedLog"
var apFilter = 'pending';
var apPendIdx = {};
var apLastCaptured = 0;
var apLastUnseen = 0;
var mvLast = null;
var AP_FIELDS = [['status', 'Status'], ['name', 'Full Name'], ['badge', 'Badge'], ['company', 'Company'], ['position', 'Position'], ['nationality', 'Nationality'], ['mobile', 'Mobile'], ['food', 'Food Category'], ['checkin', 'Check-in Date'], ['checktime', 'Check-in Time'], ['checkout', 'Check-out Date'], ['contractEnd', 'Contract End'], ['notes', 'Notes']];
var MV_CATS = ['Management', 'Senior', 'Junior', 'Worker', 'Office'];
var MV_LBL = { in: 'Check In', out: 'Check Out', transfer: 'Transferred', tin: 'Transferred In', tout: 'Transferred Out', deleted: 'Deleted' };

// ============================================================ helpers
function apEnabled() { return !approvalCfg || approvalCfg.enabled !== false; }
function apQ() { if (!Array.isArray(approvalQueue)) approvalQueue = []; return approvalQueue; }
function apEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function apClone(o) { return JSON.parse(JSON.stringify(o == null ? {} : o)); }
function apStable(b) { const o = {}; Object.keys(b || {}).sort().forEach(k => { const v = b[k]; if (v === '' || v == null) return; o[k] = v; }); return JSON.stringify(o); }
function apSt(b) { return (b && b.status) || 'vacant'; }
function apFmt(iso) { if (!iso) return '—'; const d = new Date(iso); return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }
function apJustQueued() { return Date.now() - apLastCaptured < 2000; }
/** The signed-in account (from camp-sync.js). */
function apMe() { return (window.GESCamp && window.GESCamp.me()) || null; }
function apMyName() { const m = apMe(); return (m && (m.name || m.username)) || 'Operator'; }
function apMine(r) { const m = apMe(); return !!(m && r && r.byUser === m.username); }
/** A decision on one of my requests that I have not seen yet. */
function apUnseenMine(r) { return r.status !== 'pending' && r.status !== 'withdrawn' && !r.seen && apMine(r); }
/** Is this change in the camp being viewed? */
function apInCamp(c) { return !!(c && BLOCKS_META[c.bk]); }

// ============================================================ capture (called from saveData)
/** The baseline is the data the server has confirmed (see camp-sync.js); kept for older callers. */
function apTakeBaseline() { /* no snapshot needed in the portal */ }

/**
 * An Operator's bed changes become a request: the changes (before/after per bed) and the new log
 * entries are packed into a request and the beds are put back to the confirmed state.
 * @returns {boolean} true if a request was created
 */
function captureOperatorChanges() {
  if (accessLevel !== 'operator' || !apEnabled() || !window.GESCamp) return false;
  const base = window.GESCamp.base();
  if (!base || !base.campData) return false;
  const changes = [];
  Object.keys(campData).forEach(bk => {
    if (bk.charAt(0) === '_') return;
    const cur = campData[bk] && campData[bk].rooms, old = base.campData[bk] && base.campData[bk].rooms;
    if (!cur || !old) return;
    Object.keys(cur).forEach(rid => {
      const r = cur[rid], o = old[rid];
      if (!r || !o || !Array.isArray(r.beds) || !Array.isArray(o.beds) || r.beds.length !== o.beds.length) return;
      r.beds.forEach((b, bi) => {
        if (apStable(b) !== apStable(o.beds[bi])) changes.push({ type: 'bed', bk, rid, bi, before: apClone(o.beds[bi]), after: apClone(b) });
      });
    });
  });
  if (!changes.length) return false;
  // log entries this Operator created (not yet on the server) go into the request
  const known = new Set((base.historyLog || []).map(e => e && e.id));
  const hist = historyLog.filter(e => e && !known.has(e.id));
  historyLog = historyLog.filter(e => !e || known.has(e.id));
  changes.forEach(c => { campData[c.bk].rooms[c.rid].beds[c.bi] = apClone(c.before); });
  const req = {
    id: 'R' + Date.now().toString(36).toUpperCase().slice(-6) + Math.random().toString(36).slice(2, 4).toUpperCase(),
    ts: new Date().toISOString(), by: apMyName(), byUser: (apMe() || {}).username || '', status: 'pending', changes, hist, seen: true,
  };
  req.title = apTitle(req);
  req.impact = apImpact(changes);
  apQ().unshift(req);
  apLastCaptured = Date.now();
  apRebuildIndex();
  setTimeout(() => {
    apToast(`<b><i class="ti ti-send"></i> Sent to Admin for approval</b><br>${apEsc(req.title)} — dashboard numbers will update once the Admin approves.`, 'info', 5500, 'approvals');
    apRefreshUI();
  }, 0);
  return true;
}
/** Keeps all pending requests and the newest 300 decided ones (Admin only: Operators may not delete requests). */
function apTrim() {
  if (!isAdmin()) return;
  const q = apQ(); const pend = q.filter(r => r.status === 'pending');
  const done = q.filter(r => r.status !== 'pending').sort((a, b) => (b.ts || '').localeCompare(a.ts || '')).slice(0, 300);
  approvalQueue = [...pend, ...done].sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
}

// ============================================================ describing a request
function apKind(c) {
  const b = apSt(c.before), a = apSt(c.after);
  if (b === a) return 'Details Updated';
  if (a === 'occupied') return b === 'reserved' ? 'Check In (from reservation)' : 'Check In';
  if (b === 'occupied' && a === 'vacant') return 'Check Out';
  if (a === 'reserved') return 'Reservation';
  if (b === 'reserved' && a === 'vacant') return 'Reservation Cancelled';
  return 'Status Change';
}
function apTransferPair(req) {
  const ch = req.changes || [];
  const out = ch.find(c => apSt(c.before) === 'occupied' && apSt(c.after) === 'vacant');
  const inn = ch.find(c => apSt(c.after) === 'occupied' && apSt(c.before) !== 'occupied');
  if (ch.length === 2 && out && inn && (out.before.name || '') === (inn.after.name || '') && (out.before.badge || '') === (inn.after.badge || '')) return { out, inn };
  return null;
}
function apTitle(req) {
  if (apTransferPair(req)) return 'Transfer';
  const h = (req.hist || [])[0];
  if (h && h.name === 'Quick Entry') return 'Quick Entry';
  if (h && h.action) return h.action === 'Edit' ? 'Details Updated' : h.action;
  return [...new Set(req.changes.map(apKind))].join(' + ');
}
function apImpact(changes) {
  const d = { occupied: 0, reserved: 0, vacant: 0 };
  changes.forEach(c => { if (c.type !== 'bed') return; d[apSt(c.before)] = (d[apSt(c.before)] || 0) - 1; d[apSt(c.after)] = (d[apSt(c.after)] || 0) + 1; });
  return { occ: d.occupied || 0, res: d.reserved || 0, vac: d.vacant || 0 };
}
function apLoc(bk, rid, bi) { return `Block ${apEsc(bk)} · Room ${apEsc(rid)} · Bed ${bi + 1}`; }
function apWho(b) { const p = []; if (b.badge) p.push(b.badge); if (b.company) p.push(b.company); return `<b>${apEsc(b.name || '(no name)')}</b>${p.length ? ' <span style="color:var(--text3)">(' + apEsc(p.join(' · ')) + ')</span>' : ''}`; }
function apFieldDiffs(c) {
  return AP_FIELDS.filter(([k]) => k !== 'status' && (c.before[k] || '') !== (c.after[k] || '')).map(([k, l]) => ({ k, l, b: c.before[k] || '', a: c.after[k] || '' }));
}
function apLines(req) {
  const tp = apTransferPair(req);
  if (tp) {
    const note = (req.hist || []).map(h => h.notes || '').find(n => n) || '';
    const rem = note.split('. ').slice(1).join('. ').trim();
    return [`<b>Transfer</b> ${apWho(tp.out.before)} from <span class="ap-loc">${apLoc(tp.out.bk, tp.out.rid, tp.out.bi)}</span> to <span class="ap-loc">${apLoc(tp.inn.bk, tp.inn.rid, tp.inn.bi)}</span>` + (rem ? `<div class="ap-note">Reason: ${apEsc(rem)}</div>` : '')];
  }
  const lines = req.changes.slice(0, 6).map(c => {
    const k = apKind(c); const L = `<span class="ap-loc">${apLoc(c.bk, c.rid, c.bi)}</span>`;
    if (k.startsWith('Check In')) return `<b>${k}</b> ${apWho(c.after)} → ${L}`;
    if (k === 'Check Out') return `<b>Check Out</b> ${apWho(c.before)} from ${L}`;
    if (k === 'Reservation') return `<b>Reserve</b> ${L} for ${apWho(c.after)}`;
    if (k === 'Reservation Cancelled') return `<b>Cancel reservation</b> of ${apWho(c.before)} at ${L}`;
    const fd = apFieldDiffs(c);
    return `<b>Update details</b> of ${apWho(c.before)} at ${L}` + (fd.length ? `<div class="ap-note">${fd.slice(0, 5).map(f => `${f.l}: <s>${apEsc(f.b || '—')}</s> → <b>${apEsc(f.a || '—')}</b>`).join(' &nbsp;|&nbsp; ')}${fd.length > 5 ? ' …' : ''}</div>` : '');
  });
  if (req.changes.length > 6) lines.push(`<span style="color:var(--text3)">…and ${req.changes.length - 6} more bed(s)</span>`);
  return lines;
}
function apImpactHtml(im) {
  const chip = (lbl, v, col) => v ? `<span class="ap-imp" style="color:${col};border-color:${col}">${lbl} ${v > 0 ? '+' : '−'}${Math.abs(v)}</span>` : '';
  const s = chip('Occupied', im.occ, 'var(--red)') + chip('Vacant', im.vac, '#059669') + chip('Reserved', im.res, 'var(--orange)');
  return s || '<span class="ap-imp" style="color:var(--text3);border-color:var(--border)">No change to bed counts (details only)</span>';
}
function apDetailsHtml(req) {
  return req.changes.map(c => {
    const rows = AP_FIELDS.filter(([k]) => (c.before[k] || '') !== '' || (c.after[k] || '') !== '').map(([k, l]) => {
      const b = c.before[k] || '', a = c.after[k] || ''; const ch = b !== a;
      return `<tr class="${ch ? 'ap-ch' : ''}"><td>${l}</td><td>${apEsc(b || '—')}</td><td>${ch ? '<b>' + apEsc(a || '—') + '</b>' : apEsc(a || '—')}</td></tr>`;
    }).join('');
    return `<div class="ap-dt-title">${apLoc(c.bk, c.rid, c.bi)} — ${apKind(c)}</div>
    <table class="ap-dt"><thead><tr><th>Field</th><th>Before (approved)</th><th>Requested</th></tr></thead><tbody>${rows}</tbody></table>`;
  }).join('');
}

// ============================================================ pending index (bed markers) + screen hooks
function apRebuildIndex() {
  apPendIdx = {};
  apQ().forEach(r => { if (r.status !== 'pending') return; (r.changes || []).forEach(c => { if (c.type === 'bed') apPendIdx[c.bk + '|' + c.rid + '|' + c.bi] = r.id; }); });
}
function apBedCls(bk, rid, bi) { return apPendIdx && apPendIdx[bk + '|' + rid + '|' + bi] ? ' bed-pending' : ''; }
function apPendingList() { return apQ().filter(r => r.status === 'pending'); }
/** Pending requests that touch the camp being viewed. */
function apPendingHere() { return apPendingList().filter(r => (r.changes || []).some(apInCamp)); }
function apBreakdown(list) {
  const m = {}; (list || apPendingList()).forEach(r => { m[r.title] = (m[r.title] || 0) + 1; });
  return Object.entries(m).map(([k, v]) => `<b>${v}</b> ${apEsc(k)}`).join(' · ');
}
function apPendingImpact(bk) {
  const t = { occ: 0, res: 0, vac: 0 };
  apPendingList().forEach(r => {
    const ch = bk ? r.changes.filter(c => c.bk === bk) : r.changes.filter(apInCamp);
    const im = apImpact(ch); t.occ += im.occ; t.res += im.res; t.vac += im.vac;
  });
  return t;
}
function apDashBanner() {
  const p = apPendingHere();
  let h = '';
  if (p.length) {
    const im = apPendingImpact();
    h += `<div class="ap-banner">
      <div class="ap-banner-ico"><i class="ti ti-hourglass-high"></i></div>
      <div style="flex:1">
        <div style="font-weight:800;font-size:14px">${p.length} change request${p.length > 1 ? 's' : ''} waiting for Admin approval</div>
        <div style="font-size:12px;margin-top:3px">${apBreakdown(p)}</div>
        <div style="font-size:12px;margin-top:3px;opacity:.85">The numbers below show <b>approved data only</b>. Net effect if all are approved: ${apImpactHtml(im)}</div>
      </div>
      <button class="btn btn-sm" style="background:var(--purple);color:#fff" onclick="openApprovals()"><i class="ti ti-${isAdmin() ? 'checks' : 'eye'}"></i> ${isAdmin() ? 'Review now' : 'View requests'}</button>
    </div>`;
  }
  if (accessLevel === 'operator') {
    const un = apQ().filter(apUnseenMine);
    if (un.length) {
      const ap = un.filter(r => r.status === 'approved').length, rj = un.length - ap;
      h += `<div class="ap-banner" style="background:#ecfdf5;border-color:#6ee7b7;color:#065f46">
        <div class="ap-banner-ico" style="background:#d1fae5;color:#059669"><i class="ti ti-bell-ringing"></i></div>
        <div style="flex:1;font-size:13px"><b>The Admin answered ${un.length} of your request${un.length > 1 ? 's' : ''}:</b> ${ap ? `<span class="chip chip-green">${ap} approved</span> ` : ''}${rj ? `<span class="chip chip-red">${rj} rejected</span>` : ''}</div>
        <button class="btn btn-green btn-sm" onclick="openApprovals('decided')"><i class="ti ti-eye"></i> See details</button></div>`;
    }
  }
  return h;
}
function apPendSub(k) {
  if (!apPendingHere().length) return '';
  const v = apPendingImpact()[k]; if (!v) return '';
  return ` · <span style="color:var(--purple);font-weight:700" title="Waiting for Admin approval">${v > 0 ? '+' : '−'}${Math.abs(v)} pending</span>`;
}
function apBlockChip(bk) {
  const n = apPendingList().filter(r => r.changes.some(c => c.bk === bk)).length;
  return n ? `<div title="${n} change request(s) waiting for approval" style="font-size:10px;font-weight:700;color:var(--purple);background:var(--purple-bg);padding:2px 6px;border-radius:10px"><i class="ti ti-hourglass"></i> ${n}</div>` : '';
}
function apBlockNote(bk) {
  const reqs = apPendingList().filter(r => r.changes.some(c => c.bk === bk));
  if (!reqs.length) return '';
  return `<div class="ap-banner" style="padding:10px 14px"><div class="ap-banner-ico" style="width:30px;height:30px;font-size:16px"><i class="ti ti-hourglass"></i></div>
    <div style="flex:1;font-size:12.5px"><b>${reqs.length} pending change${reqs.length > 1 ? 's' : ''} in this block.</b> Beds with a <span style="outline:2px dashed var(--purple);padding:0 4px;border-radius:3px">dashed purple</span> outline are waiting for Admin approval — shown here as they are now (approved state).</div>
    <button class="btn btn-sm" style="background:var(--purple);color:#fff" onclick="openApprovals()">Open Approvals</button></div>`;
}
function apBedModalNote(bk, rid, bi) {
  const el = document.getElementById('bmApNote'); if (!el) return;
  let h = '';
  const rq = apPendIdx[bk + '|' + rid + '|' + bi];
  if (rq) h += `<div class="ap-mnote" style="background:#fef3c7;border-color:#fcd34d;color:#92400e"><i class="ti ti-alert-triangle"></i> This bed already has a pending request <b>#${apEsc(rq)}</b>. A new change will be sent as a separate request.</div>`;
  if (accessLevel === 'operator' && apEnabled()) h += `<div class="ap-mnote"><i class="ti ti-shield-check"></i> Operator mode: your change will be <b>sent to the Admin for approval</b> before it updates the camp numbers.</div>`;
  el.innerHTML = h;
}
function apSettingsCard() {
  const on = apEnabled();
  return `<div class="card" style="max-width:440px;margin-bottom:14px">
    <div style="font-size:14px;font-weight:700;margin-bottom:8px"><i class="ti ti-checklist" style="color:var(--purple)"></i> Operator Approval Workflow</div>
    <div style="font-size:12px;color:var(--text2);margin-bottom:12px">When ON, every Operator change to beds/residents (check in, check out, reserve, cancel reservation, edit, transfer, quick entry) is sent to the Admin as a summary and only applied after approval. Admin changes are applied directly. The server enforces this.</div>
    <label style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;cursor:pointer"><input type="checkbox" ${on ? 'checked' : ''} onchange="apToggleEnabled(this)"> Require Admin approval for Operator changes</label>
    <div style="font-size:11px;color:var(--text3);margin-top:6px">Admin only.</div>
  </div>`;
}
function apToggleEnabled(cb) {
  if (!isAdmin()) { cb.checked = apEnabled(); showPwModal('admin'); return; }
  approvalCfg = Object.assign({}, approvalCfg || {}, { enabled: cb.checked }); saveData();
  apToast(cb.checked ? 'Approval workflow is ON' : 'Approval workflow is OFF — operator changes now apply directly', 'info');
}

// ============================================================ unlock / lock (called by camp-sync.js)
function apOnLogin(level) {
  if (level === 'operator') {
    const ll = document.getElementById('lockLabel'); if (ll && apEnabled()) ll.textContent = 'Operator mode · changes need approval';
    const un = apQ().filter(apUnseenMine).length;
    apLastUnseen = un;
    if (un) apToast(`<b><i class="ti ti-bell-ringing"></i> The Admin answered ${un} of your request${un > 1 ? 's' : ''}</b><br>Click to see the decisions.`, 'ok', 7000, 'decided');
  } else if (level === 'admin') {
    const n = apPendingList().length;
    if (n) apToast(`<b><i class="ti ti-hourglass-high"></i> ${n} change request${n > 1 ? 's' : ''} waiting for your approval</b><br>Click to review.`, 'warn', 7000, 'approvals');
  }
  apRefreshUI();
  const a = document.querySelector('.page.active'); if (a) apRerender(a.id);
}

// ============================================================ badges / toasts
function apRefreshUI() {
  apRebuildIndex();
  const pend = apPendingList().length;
  const unseen = apQ().filter(apUnseenMine).length;
  let n = 0, col = 'var(--red)';
  if (accessLevel === 'operator') { n = unseen; col = 'var(--green)'; } else if (isAdmin()) n = pend;
  const b = document.getElementById('apBadge');
  if (b) { b.style.display = n ? 'flex' : 'none'; b.textContent = n; b.style.background = col; }
  const nb = document.getElementById('apNavBadge');
  if (nb) { nb.style.display = pend ? 'inline-block' : 'none'; nb.textContent = pend; }
  if (accessLevel === 'operator' && unseen > apLastUnseen) apToast('<b><i class="ti ti-bell-ringing"></i> New decision from the Admin</b><br>Click to see it.', 'ok', 6000, 'decided');
  apLastUnseen = accessLevel === 'operator' ? unseen : 0;
}
/**
 * Small notice in the corner. `open` = which Approvals tab a click opens ('approvals' | 'decided').
 * (The original ran code from a string, which the portal's security policy does not allow.)
 */
function apToast(html, kind, ms, open) {
  let box = document.getElementById('apToasts');
  if (!box) { box = document.createElement('div'); box.id = 'apToasts'; document.body.appendChild(box); }
  const t = document.createElement('div'); t.className = 'ap-toast ap-t-' + (kind || 'info'); t.innerHTML = html;
  if (open) { t.style.cursor = 'pointer'; t.onclick = () => { openApprovals(open === 'decided' ? 'decided' : undefined); t.remove(); }; }
  box.appendChild(t); setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 400); }, ms || 4500);
}
function apRerender(id) {
  if (id === 'page-dashboard') renderDashboard();
  else if (id === 'page-approvals') renderApprovals();
  else if (id === 'page-movement') mvRun();
  else if (id === 'page-history') renderHistory();
  else if (id === 'page-summary') renderSummary();
  else if (id === 'page-billing') renderBilling();
  else if (id === 'page-voReport') renderVOReport();
  else if (id && id.startsWith('page-block-')) renderBlock(id.replace('page-block-', ''));
}

// ============================================================ Approvals page
function openApprovals(f) {
  apFilter = f || 'pending';
  showPage('approvals', document.getElementById('navApprovals'));
}
function apSetFilter(f) { apFilter = f; renderApprovals(); }
function renderApprovals() {
  const q = apQ();
  // an Operator opening the page has read their own decisions
  const newIds = new Set();
  if (accessLevel === 'operator') {
    let ch = false; q.forEach(r => { if (apUnseenMine(r)) { newIds.add(r.id); r.seen = true; ch = true; } });
    if (ch) { saveData(); apRefreshUI(); }
  }
  const cnt = s => q.filter(r => r.status === s).length;
  const pend = cnt('pending'), appr = cnt('approved'), rej = cnt('rejected');
  const role = isAdmin() ? 'admin' : accessLevel === 'operator' ? 'operator' : 'none';
  const intro = role === 'admin' ? 'Review the changes Operators have submitted. <b>Approve</b> applies the change and updates the dashboard numbers immediately; <b>Reject</b> discards it and notifies the Operator.'
    : role === 'operator' ? 'Every change you make is sent here for the Admin to approve. You will get a notification when the Admin approves or rejects it.'
      : 'Only an Admin of Camp Management can approve or reject requests.';
  const h = `<div style="display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:14px">
    <div style="flex:1;min-width:260px"><div style="font-size:18px;font-weight:800;margin-bottom:4px">Change Approvals</div>
    <div style="font-size:12px;color:var(--text2);max-width:720px">${intro}</div></div>
    ${role === 'admin' && pend ? `<button class="btn btn-green" onclick="apApproveAll()"><i class="ti ti-checks"></i> Approve all (${pend})</button>` : ''}
  </div>
  <div class="stats-grid">
    <div class="stat-card" style="--c:var(--purple)"><div class="stat-icon" style="background:var(--purple-bg)"><i class="ti ti-hourglass-high" style="color:var(--purple)"></i></div><div class="stat-lbl">Waiting for approval</div><div class="stat-val" style="color:var(--purple)">${pend}</div><div class="stat-sub">${pend ? apBreakdown() : 'Nothing waiting'}</div></div>
    <div class="stat-card" style="--c:var(--green)"><div class="stat-icon" style="background:var(--green-bg)"><i class="ti ti-circle-check" style="color:var(--green)"></i></div><div class="stat-lbl">Approved</div><div class="stat-val" style="color:var(--green)">${appr}</div><div class="stat-sub">Applied to the camp data</div></div>
    <div class="stat-card" style="--c:var(--red)"><div class="stat-icon" style="background:var(--red-bg)"><i class="ti ti-circle-x" style="color:var(--red)"></i></div><div class="stat-lbl">Rejected</div><div class="stat-val" style="color:var(--red)">${rej}</div><div class="stat-sub">Discarded, operator notified</div></div>
    <div class="stat-card" style="--c:${apEnabled() ? 'var(--blue)' : 'var(--text3)'}"><div class="stat-icon" style="background:var(--blue-light)"><i class="ti ti-shield-check" style="color:var(--blue)"></i></div><div class="stat-lbl">Workflow</div><div class="stat-val" style="color:${apEnabled() ? 'var(--blue)' : 'var(--text3)'};font-size:20px">${apEnabled() ? 'ON' : 'OFF'}</div><div class="stat-sub">Change in Settings (Admin)</div></div>
  </div>
  <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px">
    <div class="tabs" style="margin-bottom:0">
      ${[['pending', 'Pending', pend], ['approved', 'Approved', appr], ['rejected', 'Rejected', rej], ['decided', 'Decided', appr + rej], ['all', 'All', q.length]].map(([k, l, c]) => `<div class="tab ${apFilter === k ? 'active' : ''}" onclick="apSetFilter('${k}')">${l} <span style="opacity:.7">(${c})</span></div>`).join('')}
    </div>
    <div class="search-bar" style="margin-bottom:0;flex:1;min-width:200px"><i class="ti ti-search"></i><input id="apSearch" placeholder="Search name, badge, room, operator, request #..." oninput="apRenderList()"></div>
  </div>
  <div id="apList"></div>`;
  document.getElementById('page-approvals').innerHTML = h;
  window.__apNewIds = newIds;
  apRenderList();
}
function apRenderList() {
  const el = document.getElementById('apList'); if (!el) return;
  const s = ((document.getElementById('apSearch') || {}).value || '').toLowerCase().trim();
  let list = apQ().filter(r => apFilter === 'all' ? true : apFilter === 'decided' ? (r.status === 'approved' || r.status === 'rejected') : r.status === apFilter);
  if (s) list = list.filter(r => JSON.stringify([r.id, r.by, r.title, r.note, r.changes.map(c => [c.bk, c.rid, c.before.name, c.before.badge, c.before.company, c.after.name, c.after.badge, c.after.company])]).toLowerCase().includes(s));
  if (!list.length) { el.innerHTML = `<div class="card" style="text-align:center;padding:36px;color:var(--text3)"><i class="ti ti-${apFilter === 'pending' ? 'mood-smile' : 'inbox'}" style="font-size:36px;display:block;margin-bottom:8px"></i>${apFilter === 'pending' ? 'No changes waiting for approval.' : 'Nothing here yet.'}</div>`; return; }
  el.innerHTML = list.map(apCardHtml).join('');
}
function apCardHtml(r) {
  const S = { pending: ['Waiting for approval', 'var(--purple)', 'var(--purple-bg)', 'hourglass-high'], approved: ['Approved', '#059669', 'var(--green-bg)', 'circle-check'], rejected: ['Rejected', 'var(--red)', 'var(--red-bg)', 'circle-x'], withdrawn: ['Withdrawn', '#6b7280', '#f3f4f6', 'arrow-back-up'] }[r.status] || ['?', '#666', '#eee', 'help'];
  const isNew = window.__apNewIds && window.__apNewIds.has(r.id);
  const first = r.changes[0] || {};
  const id = apEsc(r.id);
  let act = '';
  if (r.status === 'pending') {
    if (isAdmin()) act = `<button class="btn btn-green btn-sm" onclick="apApprove('${id}')"><i class="ti ti-check"></i> Approve</button>
      <button class="btn btn-red btn-sm" onclick="apReject('${id}')"><i class="ti ti-x"></i> Reject</button>`;
    else if (accessLevel === 'operator' && apMine(r)) act = `<button class="btn btn-ghost btn-sm" onclick="apWithdraw('${id}')"><i class="ti ti-arrow-back-up"></i> Withdraw</button>`;
  }
  if (first.bk && BLOCKS_META[first.bk]) act += `<button class="btn btn-ghost btn-sm" onclick="showBlockPage('${apEsc(first.bk)}')"><i class="ti ti-building-warehouse"></i> View block ${apEsc(first.bk)}</button>`;
  const decided = r.status === 'approved' || r.status === 'rejected' || r.status === 'withdrawn';
  return `<div class="ap-card" style="border-left-color:${S[1]}">
    <div class="ap-head">
      <div class="ap-ico" style="background:${S[2]};color:${S[1]}"><i class="ti ti-${S[3]}"></i></div>
      <div style="flex:1;min-width:0">
        <div class="ap-title">${apEsc(r.title)} <span class="ap-id">#${id}</span> ${isNew ? '<span class="chip chip-orange">NEW</span>' : ''}</div>
        <div class="ap-meta"><i class="ti ti-user"></i> Requested by <b>${apEsc(r.by)}</b> · <i class="ti ti-clock"></i> ${apFmt(r.ts)} · ${r.changes.length} bed${r.changes.length > 1 ? 's' : ''}</div>
      </div>
      <span class="ap-status" style="background:${S[2]};color:${S[1]}">${S[0]}</span>
    </div>
    <ul class="ap-lines">${apLines(r).map(l => `<li>${l}</li>`).join('')}</ul>
    <div class="ap-impact-row"><span style="font-size:11px;color:var(--text3);font-weight:600">${r.status === 'approved' ? 'Dashboard effect:' : r.status === 'pending' ? 'Dashboard effect if approved:' : 'Would have changed:'}</span> ${apImpactHtml(r.impact || apImpact(r.changes))}</div>
    ${decided ? `<div class="ap-decision" style="border-color:${S[1]};background:${S[2]}"><b style="color:${S[1]}">${S[0]}</b>${r.status !== 'withdrawn' ? ' by ' + apEsc(r.decidedBy || 'Admin') : ''} · ${apFmt(r.decidedAt)}${r.note ? `<div style="margin-top:4px">Note: ${apEsc(r.note)}</div>` : ''}${r.conflict ? '<div style="margin-top:4px;color:#92400e"><i class="ti ti-alert-triangle"></i> Applied over newer data (bed had changed since the request).</div>' : ''}</div>` : ''}
    <details class="ap-details"><summary>Show field-by-field details</summary>${apDetailsHtml(r)}</details>
    ${act ? `<div class="ap-actions">${act}</div>` : ''}
  </div>`;
}

// ============================================================ deciding
function apFind(id) { return apQ().find(r => r.id === id); }
function apConflicts(r) {
  return r.changes.filter(c => {
    const room = campData[c.bk] && campData[c.bk].rooms[c.rid];
    if (!room || !room.beds[c.bi]) return true;
    return apStable(room.beds[c.bi]) !== apStable(c.before);
  });
}
function apApplyReq(r, force) {
  const missing = r.changes.filter(c => !(campData[c.bk] && campData[c.bk].rooms[c.rid] && campData[c.bk].rooms[c.rid].beds[c.bi]));
  if (missing.length) { alert('Request #' + r.id + ' cannot be applied: ' + missing.map(c => c.rid + ' bed ' + (c.bi + 1)).join(', ') + ' no longer exists. Please reject it.'); return false; }
  const conf = apConflicts(r);
  if (conf.length && !force) {
    if (!confirm(`⚠ Request #${r.id}: ${conf.map(c => c.rid + ' Bed ' + (c.bi + 1)).join(', ')} changed after the Operator sent this request.\n\nApproving will overwrite the current data on ${conf.length > 1 ? 'these beds' : 'this bed'} with the requested values.\n\nApprove anyway?`)) return false;
  }
  const who = apMyName();
  r.changes.forEach(c => { campData[c.bk].rooms[c.rid].beds[c.bi] = apClone(c.after); });
  const nowIso = new Date().toISOString();
  (r.hist || []).slice().reverse().forEach(e => { const x = apClone(e); x.approvedBy = who; x.approvedAt = nowIso; x.requestId = r.id; x.requestedBy = r.by; historyLog.unshift(x); });
  r.status = 'approved'; r.decidedAt = nowIso; r.decidedBy = who; r.seen = false; r.conflict = conf.length > 0;
  return true;
}
function apApprove(id) {
  if (!isAdmin()) { pwCallback = () => apApprove(id); showPwModal('admin'); return; }
  const r = apFind(id); if (!r || r.status !== 'pending') return;
  if (!apApplyReq(r)) return;
  apTrim(); saveData(); updateNotifBadge(); apRefreshUI(); renderApprovals();
  apToast(`<b><i class="ti ti-circle-check"></i> Approved #${apEsc(id)}</b><br>${apEsc(r.title)} — dashboard updated.`, 'ok');
}
function apApproveAll() {
  if (!isAdmin()) { pwCallback = () => apApproveAll(); showPwModal('admin'); return; }
  const p = apPendingList().slice().reverse(); // oldest first
  if (!p.length) return;
  if (!confirm(`Approve all ${p.length} pending request(s)?\n\nThey will be applied oldest first and the dashboard will update.`)) return;
  let ok = 0, skip = 0;
  p.forEach(r => { if (apApplyReq(r)) ok++; else skip++; });
  apTrim(); saveData(); updateNotifBadge(); apRefreshUI(); renderApprovals();
  apToast(`<b><i class="ti ti-checks"></i> ${ok} approved</b>${skip ? ' · ' + skip + ' skipped' : ''}`, 'ok');
}
function apReject(id) {
  if (!isAdmin()) { pwCallback = () => apReject(id); showPwModal('admin'); return; }
  const r = apFind(id); if (!r || r.status !== 'pending') return;
  const note = prompt(`Reject request #${id} (${r.title})?\n\nReason for the Operator (optional):`, '');
  if (note === null) return;
  r.status = 'rejected'; r.decidedAt = new Date().toISOString(); r.decidedBy = apMyName(); r.note = note.trim(); r.seen = false;
  saveData(); apRefreshUI(); renderApprovals();
  apToast(`<b><i class="ti ti-circle-x"></i> Rejected #${apEsc(id)}</b><br>The Operator will be notified.`, 'err');
}
function apWithdraw(id) {
  const r = apFind(id); if (!r || r.status !== 'pending' || !apMine(r)) return;
  if (!confirm('Withdraw request #' + id + ' (' + r.title + ')? It will not be sent to the Admin.')) return;
  r.status = 'withdrawn'; r.decidedAt = new Date().toISOString(); r.seen = true;
  saveData(); apRefreshUI(); renderApprovals();
}

// ============================================================ MOVEMENT SUMMARY
/** Keeps a log record an Admin deletes (it counts as "Deleted"). */
function mvRecordDeletedLog(e) {
  if (!e) return;
  if (!Array.isArray(mvDeletedLog)) mvDeletedLog = [];
  mvDeletedLog.unshift(Object.assign({}, e, { deletedAt: new Date().toISOString(), deletedBy: apMyName() }));
}
function mvCo(e) { const c = (e.company || '').trim(); return c && c !== '—' ? c : '(No company)'; }
function mvCat(bk, rid, e) {
  if (e && e.category) return e.category;
  const r = campData[bk] && campData[bk].rooms && campData[bk].rooms[rid];
  return r ? r.category : 'Unknown';
}
function mvDate(e) { return e.date || (e.ts ? e.ts.slice(0, 10) : ''); }
/** Records in the camp being viewed (the log covers every camp). */
function mvHere(e) {
  if (typeof histCamp === 'function' && typeof currentCamp !== 'undefined') return histCamp(e) === currentCamp;
  return !!(BLOCKS_META[e.block] || BLOCKS_META[e.newBlock]);
}
function mvRecords(from, to, bkF) {
  const out = [];
  const inRange = d => (!from || d >= from) && (!to || d <= to);
  historyLog.forEach(e => {
    if (!e || !mvHere(e)) return;
    const d = mvDate(e); if (!inRange(d)) return;
    let kind = null;
    if (e.action === 'Check In') kind = 'in';
    else if (e.action === 'Check Out') kind = 'out';
    else if (e.action === 'Transfer') kind = 'transfer';
    if (!kind) return;
    if (bkF && e.block !== bkF && e.newBlock !== bkF) return;
    out.push({ kind, e, d, co: mvCo(e), cat: mvCat(e.block, e.room, e), toCat: kind === 'transfer' ? mvCat(e.newBlock, e.newRoom, null) : null, reason: '' });
  });
  // "Deleted" = log records an Admin deleted
  (mvDeletedLog || []).forEach(e => {
    if (!e || !mvHere(e)) return;
    const d = (e.deletedAt || '').slice(0, 10); if (!inRange(d)) return;
    if (bkF && e.block !== bkF) return;
    out.push({ kind: 'deleted', e, d, co: mvCo(e), cat: mvCat(e.block, e.room, e), reason: `Log record deleted by ${e.deletedBy || 'Admin'} (was: ${e.action || '?'} on ${e.date || '?'})` });
  });
  return out;
}
function mvCurrentOcc() {
  const co = {}, cat = {};
  Object.keys(BLOCKS_META).forEach(bk => {
    if (!campData[bk] || !campData[bk].rooms) return;
    Object.values(campData[bk].rooms).forEach(r => {
      (r.beds || []).forEach(b => { if (b.status !== 'occupied') return; const c = mvCo(b); co[c] = (co[c] || 0) + 1; cat[r.category] = (cat[r.category] || 0) + 1; });
    });
  });
  return { co, cat };
}
function renderMovement() {
  const t = today(); const f = t.slice(0, 8) + '01';
  const pend = apPendingHere().length;
  document.getElementById('page-movement').innerHTML = `
  <div style="font-size:18px;font-weight:800;margin-bottom:4px">Movement Summary</div>
  <div style="font-size:12px;color:var(--text2);margin-bottom:14px">Check In, Check Out, Transferred and Deleted — by company and by room category, for any date range.</div>
  ${saveBtnHtml()}
  <div class="card" style="margin-bottom:14px">
    <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
      <div class="form-row" style="margin-bottom:0"><label class="form-lbl">From</label><input type="date" id="mv_from" class="form-ctrl" value="${f}" onchange="mvRun()"></div>
      <div class="form-row" style="margin-bottom:0"><label class="form-lbl">To</label><input type="date" id="mv_to" class="form-ctrl" value="${t}" onchange="mvRun()"></div>
      <div class="form-row" style="margin-bottom:0"><label class="form-lbl">Block</label><select id="mv_bk" class="form-ctrl" onchange="mvRun()"><option value="">All Blocks</option>${Object.keys(BLOCKS_META).map(b => `<option value="${apEsc(b)}">${apEsc(BLOCKS_META[b].name)}</option>`).join('')}</select></div>
      <div style="display:flex;gap:4px;flex-wrap:wrap">
        ${[['Today', 0], ['7 days', 6], ['30 days', 29], ['This month', 'm'], ['All time', 'all']].map(([l, v]) => `<button class="btn btn-ghost btn-sm" onclick="mvQuick('${v}')">${l}</button>`).join('')}
      </div>
      <button class="btn btn-outline btn-sm" style="margin-left:auto" onclick="mvExport()"><i class="ti ti-download"></i> Export Excel</button>
    </div>
    ${pend ? `<div style="font-size:11.5px;color:var(--purple);margin-top:10px"><i class="ti ti-hourglass"></i> ${pend} operator request${pend > 1 ? 's are' : ' is'} still waiting for approval and ${pend > 1 ? 'are' : 'is'} not counted yet.</div>` : ''}
  </div>
  <div id="mvOut"></div>`;
  mvRun();
}
function mvQuick(v) {
  const t = today(); let f = '';
  if (v === 'all') f = ''; else if (v === 'm') f = t.slice(0, 8) + '01';
  else { const d = new Date(); d.setDate(d.getDate() - parseInt(v, 10)); f = d.toISOString().slice(0, 10); }
  document.getElementById('mv_from').value = f; document.getElementById('mv_to').value = v === 'all' ? '' : t; mvRun();
}
function mvRun() {
  const from = (document.getElementById('mv_from') || {}).value || '';
  const to = (document.getElementById('mv_to') || {}).value || '';
  const bkF = (document.getElementById('mv_bk') || {}).value || '';
  if (!document.getElementById('mvOut')) return;
  const recs = mvRecords(from, to, bkF);
  const cur = mvCurrentOcc();
  const co = {};
  recs.forEach(x => { const c = co[x.co] || (co[x.co] = { in: 0, out: 0, transfer: 0, deleted: 0 }); c[x.kind]++; });
  const cat = {}; const mk = k => cat[k] || (cat[k] = { in: 0, out: 0, tin: 0, tout: 0, deleted: 0 });
  recs.forEach(x => { if (x.kind === 'transfer') { mk(x.cat).tout++; mk(x.toCat).tin++; } else mk(x.cat)[x.kind]++; });
  mvLast = { from, to, bkF, recs, co, cat, cur };
  const T = { in: 0, out: 0, transfer: 0, deleted: 0 }; recs.forEach(x => T[x.kind]++);
  const num = (v, col, onclick) => v ? `<a class="mv-n" style="color:${col}" onclick="${onclick}">${v}</a>` : '<span style="color:var(--text3)">0</span>';
  const netH = n => `<b style="color:${n > 0 ? 'var(--green)' : n < 0 ? 'var(--red)' : 'var(--text3)'}">${n > 0 ? '+' : ''}${n}</b>`;
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/'/g, "\\'").replace(/"/g, '&quot;');
  const range = `${from || 'start'} → ${to || 'today'}${bkF ? ' · Block ' + bkF : ''}`;
  let h = `<div class="stats-grid">
    ${[['Check In', T.in, 'var(--green)', 'var(--green-bg)', 'login', 'in'], ['Check Out', T.out, 'var(--red)', 'var(--red-bg)', 'logout', 'out'], ['Transferred', T.transfer, 'var(--purple)', 'var(--purple-bg)', 'arrows-transfer-up', 'transfer'], ['Deleted', T.deleted, '#6b7280', '#f3f4f6', 'trash', 'deleted']]
      .map(([l, v, c, bg, ic, k]) => `<div class="stat-card" style="--c:${c};cursor:pointer" onclick="mvShow('all','','${k}')"><div class="stat-icon" style="background:${bg}"><i class="ti ti-${ic}" style="color:${c}"></i></div><div class="stat-lbl">${l}</div><div class="stat-val" style="color:${c}">${v}</div><div class="stat-sub">${apEsc(range)}</div></div>`).join('')}
  </div>`;
  const coRows = Object.entries(co).sort((a, b) => (b[1].in + b[1].out + b[1].transfer + b[1].deleted) - (a[1].in + a[1].out + a[1].transfer + a[1].deleted) || a[0].localeCompare(b[0]));
  h += `<div class="tbl-wrap"><div class="billing-tbl-head"><span class="tbl-title"><i class="ti ti-building"></i> 1. Movement by Company</span><span style="font-size:11px;color:#dbeafe;margin-left:auto">${apEsc(range)} · click any number to see the people</span></div>
  <table class="dtbl"><thead><tr><th>#</th><th>Company</th><th style="text-align:center">Check In</th><th style="text-align:center">Check Out</th><th style="text-align:center">Transferred</th><th style="text-align:center">Deleted</th><th style="text-align:center">Net change</th><th style="text-align:center">In camp now</th></tr></thead><tbody>`;
  if (!coRows.length) h += '<tr><td colspan="8" style="text-align:center;color:var(--text3);padding:22px">No movements in this period</td></tr>';
  const tc = { in: 0, out: 0, transfer: 0, deleted: 0 };
  coRows.forEach(([n, d], i) => {
    Object.keys(tc).forEach(k => { tc[k] += d[k]; }); const e = esc(n);
    h += `<tr><td style="color:var(--text3)">${i + 1}</td><td style="font-weight:700">${apEsc(n)}</td>
      <td style="text-align:center">${num(d.in, 'var(--green)', `mvShow('co','${e}','in')`)}</td>
      <td style="text-align:center">${num(d.out, 'var(--red)', `mvShow('co','${e}','out')`)}</td>
      <td style="text-align:center">${num(d.transfer, 'var(--purple)', `mvShow('co','${e}','transfer')`)}</td>
      <td style="text-align:center">${num(d.deleted, '#6b7280', `mvShow('co','${e}','deleted')`)}</td>
      <td style="text-align:center">${netH(d.in - d.out - d.deleted)}</td>
      <td style="text-align:center;color:var(--blue2);font-weight:600">${cur.co[n] || 0}</td></tr>`;
  });
  if (coRows.length) h += `<tr class="total-row"><td></td><td>TOTAL</td><td style="text-align:center;color:var(--green)">${tc.in}</td><td style="text-align:center;color:var(--red)">${tc.out}</td><td style="text-align:center;color:var(--purple)">${tc.transfer}</td><td style="text-align:center">${tc.deleted}</td><td style="text-align:center">${netH(tc.in - tc.out - tc.deleted)}</td><td style="text-align:center">${Object.values(cur.co).reduce((a, b) => a + b, 0)}</td></tr>`;
  h += '</tbody></table></div>';
  const catKeys = [...MV_CATS.filter(c => cat[c] || cur.cat[c]), ...Object.keys(cat).filter(c => !MV_CATS.includes(c))];
  h += `<div class="tbl-wrap"><div class="billing-tbl-head" style="background:#065f46"><span class="tbl-title"><i class="ti ti-category"></i> 2. Movement by Category (all companies combined)</span><span style="font-size:11px;color:#d1fae5;margin-left:auto">${apEsc(range)}</span></div>
  <table class="dtbl"><thead><tr><th>Category</th><th style="text-align:center">Check In</th><th style="text-align:center">Check Out</th><th style="text-align:center">Transferred In</th><th style="text-align:center">Transferred Out</th><th style="text-align:center">Deleted</th><th style="text-align:center">Net change</th><th style="text-align:center">Occupied now</th></tr></thead><tbody>`;
  const tt = { in: 0, out: 0, tin: 0, tout: 0, deleted: 0 };
  catKeys.forEach(c => {
    const d = cat[c] || { in: 0, out: 0, tin: 0, tout: 0, deleted: 0 }; Object.keys(tt).forEach(k => { tt[k] += d[k]; }); const e = esc(c);
    h += `<tr><td><span class="cat-pill pill-${apEsc(c)}">${apEsc(c)}</span></td>
      <td style="text-align:center">${num(d.in, 'var(--green)', `mvShow('cat','${e}','in')`)}</td>
      <td style="text-align:center">${num(d.out, 'var(--red)', `mvShow('cat','${e}','out')`)}</td>
      <td style="text-align:center">${num(d.tin, 'var(--purple)', `mvShow('cat','${e}','tin')`)}</td>
      <td style="text-align:center">${num(d.tout, 'var(--purple)', `mvShow('cat','${e}','tout')`)}</td>
      <td style="text-align:center">${num(d.deleted, '#6b7280', `mvShow('cat','${e}','deleted')`)}</td>
      <td style="text-align:center">${netH(d.in - d.out + d.tin - d.tout - d.deleted)}</td>
      <td style="text-align:center;color:var(--blue2);font-weight:600">${cur.cat[c] || 0}</td></tr>`;
  });
  h += `<tr class="total-row"><td>TOTAL</td><td style="text-align:center;color:var(--green)">${tt.in}</td><td style="text-align:center;color:var(--red)">${tt.out}</td><td style="text-align:center;color:var(--purple)">${tt.tin}</td><td style="text-align:center;color:var(--purple)">${tt.tout}</td><td style="text-align:center">${tt.deleted}</td><td style="text-align:center">${netH(tt.in - tt.out + tt.tin - tt.tout - tt.deleted)}</td><td style="text-align:center">${Object.values(cur.cat).reduce((a, b) => a + b, 0)}</td></tr>`;
  h += `</tbody></table></div>
  <div style="font-size:11px;color:var(--text3);margin:-10px 0 16px;line-height:1.6">
    <b>Deleted</b> = check in/out log records deleted by an Admin (kept so they can still be counted). &nbsp;
    <b>Net change</b> = Check In − Check Out − Deleted (category table also adds Transferred In − Transferred Out). &nbsp;
    Category is the room type (Management, Senior, Junior, Worker, Office) of the room the person moved into or out of.
  </div>
  <div id="mvDetail"></div>`;
  document.getElementById('mvOut').innerHTML = h;
}
function mvFilterRecs(scope, key, kind) {
  if (!mvLast) return [];
  return mvLast.recs.filter(x => {
    if (kind === 'tin') return x.kind === 'transfer' && (scope !== 'cat' || x.toCat === key);
    if (kind === 'tout') return x.kind === 'transfer' && (scope !== 'cat' || x.cat === key);
    if (x.kind !== kind) return false;
    if (scope === 'co') return x.co === key;
    if (scope === 'cat') return x.cat === key;
    return true;
  });
}
function mvShow(scope, key, kind) {
  const list = mvFilterRecs(scope, key, kind).sort((a, b) => (b.d + (b.e.time || '')).localeCompare(a.d + (a.e.time || '')));
  const E = s => apEsc(s);
  const el = document.getElementById('mvDetail'); if (!el) return;
  el.innerHTML = `<div class="tbl-wrap"><div class="tbl-head"><span class="tbl-title"><i class="ti ti-list-details" style="color:var(--blue)"></i> ${E(MV_LBL[kind])}${key ? ' — ' + E(key) : ''} <span class="chip chip-blue">${list.length}</span></span>
    <button class="btn btn-ghost btn-sm" style="margin-left:auto" onclick="document.getElementById('mvDetail').innerHTML=''"><i class="ti ti-x"></i> Close</button></div>
    <div style="max-height:460px;overflow:auto"><table class="dtbl"><thead><tr><th>Date</th><th>Name</th><th>Badge</th><th>Company</th><th>Category</th><th>Location</th><th>Notes</th></tr></thead><tbody>
    ${list.slice(0, 1000).map(x => {
      const e = x.e;
      const loc = x.kind === 'transfer' ? `${E(e.block)}·${E(e.room)} B${E(e.bed)} → ${E(e.newBlock)}·${E(e.newRoom)} B${E(e.newBed)}` : `${E(e.block)}·${E(e.room)}${e.bed && e.bed !== '—' ? ' B' + E(e.bed) : ''}`;
      return `<tr><td style="white-space:nowrap">${E(x.d)} ${E(e.time || '')}</td><td style="font-weight:600">${E(e.name || '—')}</td><td>${E(e.badge || '—')}</td><td>${E(x.co)}</td><td>${E(x.kind === 'transfer' ? x.cat + ' → ' + x.toCat : x.cat)}</td><td>${loc}</td><td style="color:var(--text2);font-size:11.5px">${E(x.reason || e.notes || '')}${e.approvedBy ? ' <span class="chip chip-green">approved</span>' : ''}</td></tr>`;
    }).join('') || '<tr><td colspan="7" style="text-align:center;color:var(--text3);padding:18px">None</td></tr>'}
    </tbody></table></div></div>`;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function mvExport() {
  if (!mvLast) mvRun(); const L = mvLast; if (!L) return;
  const wb = XLSX.utils.book_new();
  const range = `Period: ${L.from || 'start'} to ${L.to || 'today'}${L.bkF ? ' | Block ' + L.bkF : ''}`;
  const r1 = [['Movement by Company'], [range], [], ['Company', 'Check In', 'Check Out', 'Transferred', 'Deleted', 'Net change', 'In camp now']];
  Object.entries(L.co).sort((a, b) => a[0].localeCompare(b[0])).forEach(([n, d]) => r1.push([n, d.in, d.out, d.transfer, d.deleted, d.in - d.out - d.deleted, L.cur.co[n] || 0]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(r1), 'By Company');
  const r2 = [['Movement by Category'], [range], [], ['Category', 'Check In', 'Check Out', 'Transferred In', 'Transferred Out', 'Deleted', 'Net change', 'Occupied now']];
  Object.entries(L.cat).forEach(([c, d]) => r2.push([c, d.in, d.out, d.tin, d.tout, d.deleted, d.in - d.out + d.tin - d.tout - d.deleted, L.cur.cat[c] || 0]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(r2), 'By Category');
  const r3 = [['Date', 'Time', 'Movement', 'Name', 'Badge', 'Company', 'Category', 'Block', 'Room', 'Bed', 'To Block', 'To Room', 'To Bed', 'Notes']];
  L.recs.forEach(x => { const e = x.e; r3.push([x.d, e.time || '', MV_LBL[x.kind], e.name || '', e.badge || '', x.co, x.kind === 'transfer' ? x.cat + ' → ' + x.toCat : x.cat, e.block || '', e.room || '', e.bed || '', e.newBlock || '', e.newRoom || '', e.newBed || '', x.reason || e.notes || '']); });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(r3), 'All Movements');
  XLSX.writeFile(wb, 'Movement_Summary_' + today() + '.xlsx');
}

setInterval(function () { try { apRefreshUI(); } catch (e) { /* page not ready */ } }, 30000);
