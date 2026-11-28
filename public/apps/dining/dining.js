/*
 * Dining Halls Management - the page.
 *
 * The setup (people, cards, companies, settings) is shared through the portal's sync engine
 * (bridge.js, LIVE mode) and only Admins change it. Every scan is sent to the server, which
 * decides and records it (/api/dining/scan): without a connection, scanning stops.
 */
(function () {
  'use strict';
  var P = window.GVCPatch, Portal = window.GESPortal;

  var TZ = 'Asia/Dubai';
  var HALLS = [
    { id: 'Senior', label: 'Senior Mess', short: 'Senior', sub: 'Officers', color: '#1a3a8f' },
    { id: 'Junior', label: 'Junior Mess', short: 'Junior', sub: 'Enlisted', color: '#8f6a00' },
    { id: 'Worker1', label: 'Worker 1', short: 'W1', sub: 'Mess hall', color: '#1a7a4a' },
    { id: 'Worker2', label: 'Worker 2', short: 'W2', sub: 'Mess hall', color: '#00695c' },
    { id: 'Worker3', label: 'Worker 3', short: 'W3', sub: 'Mess hall', color: '#558b2f' },
    { id: 'Worker4', label: 'Worker 4', short: 'W4', sub: 'Mess hall', color: '#283593' },
    { id: 'Worker5', label: 'Worker 5', short: 'W5', sub: 'Mess hall', color: '#ad1457' }
  ];
  var MEALS = ['Breakfast', 'Lunch', 'Dinner'];
  var DEFAULTS = { entryRule: 'meal', lunchFrom: 11, dinnerFrom: 17, allowUnregistered: true };
  var POOL_START = 1000;
  var LIST_PAGE = 100, CARDS_SHOWN = 100, PRINT_MAX = 3000;
  var RESULT_MS = 4000, SAME_CODE_MS = 4000, RETRY_MS = 5000;

  var D = null;          // the shared setup document (kept up to date by the sync engine)
  var me = null, role = null;
  var S = {
    hall: readLocal('dining.hall') || 'Senior',
    mode: 'manual', online: true, busy: false, pending: null,
    lastCode: '', lastCodeAt: 0, resultTimer: null, panel: null,
    recBefore: null, cardsFilter: 'all', importFiles: []
  };

  // ------------------------------------------------------------------ small helpers
  function $(id) { return document.getElementById(id); }
  function esc(s) { return Portal.esc(s); }
  function readLocal(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function writeLocal(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } }
  function hallOf(id) { return HALLS.find(function (h) { return h.id === id; }) || { id: id, label: id || '—', short: id || '—', color: '#6b7280' }; }
  function badge(id) { var h = hallOf(id); return '<span class="badge" style="--hc:' + h.color + '">' + esc(h.short) + '</span>'; }
  function isAdmin() { return role === 'admin'; }
  function canScan() { return role === 'admin' || role === 'operator'; }
  function settings() { return Object.assign({}, DEFAULTS, (D && D.settings) || {}); }
  function people() { return (D && Array.isArray(D.people)) ? D.people : []; }
  function companies() { return (D && Array.isArray(D.companies)) ? D.companies : []; }
  function norm(code) { return String(code == null ? '' : code).replace(/\s+/g, '').toUpperCase(); }
  function poolCode(n) { return 'MH' + String(n).padStart(5, '0'); }
  /** Dining Halls API, for this page's camp. */
  function api(method, path, body) { return Portal.api(method, Portal.withCamp(path), body); }
  function debounce(fn, ms) { var t; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; }

  var fmtTime = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  var fmtDay = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  var fmtLong = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: 'short' });
  function today() { return fmtDay.format(new Date()); }
  function timeOf(iso) { return iso ? fmtTime.format(new Date(iso)) : ''; }
  function dayLabel(day) { return fmtLong.format(new Date(day + 'T00:00:00Z')); }
  function addDays(day, n) { var d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

  var toastTimer;
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2800);
  }

  function download(name, text, type) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: type || 'text/csv;charset=utf-8' }));
    a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
  function csvCell(v) {
    var s = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function csv(rows) { return '﻿' + rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n'; }

  // ------------------------------------------------------------------ sounds (same as the old app)
  var audio = null;
  function ctx() { try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); return audio; } catch (e) { return null; } }
  function beepOk() {
    var c = ctx(); if (!c) return;
    [0, 0.15].forEach(function (d, i) {
      var o = c.createOscillator(), g = c.createGain(); o.connect(g); g.connect(c.destination);
      o.type = 'sine'; o.frequency.setValueAtTime(i ? 1100 : 880, c.currentTime + d);
      g.gain.setValueAtTime(0.4, c.currentTime + d); g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + d + 0.25);
      o.start(c.currentTime + d); o.stop(c.currentTime + d + 0.25);
    });
  }
  function beepNo() {
    var c = ctx(); if (!c) return;
    [0, 0.25, 0.5].forEach(function (d) {
      var o = c.createOscillator(), g = c.createGain();
      o.connect(g); g.connect(c.destination); o.type = 'sawtooth';
      o.frequency.setValueAtTime(180, c.currentTime + d); o.frequency.linearRampToValueAtTime(120, c.currentTime + d + 0.2);
      g.gain.setValueAtTime(0.7, c.currentTime + d); g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + d + 0.22);
      o.start(c.currentTime + d); o.stop(c.currentTime + d + 0.22);
    });
  }
  function vibrate(p) { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) { /* not supported */ } }

  // ------------------------------------------------------------------ connection to the server
  var engine = window.GESBridge.create('dining', {
    getLive: function () { return D || {}; },
    applyLive: function (ops) { if (!D) D = {}; P.apply(D, ops); },
    rerender: function () { if (S.panel) renderPanel(S.panel); },
    isBusy: function () { return $('dlg-person').open; },
    events: { scan: debounce(onScanElsewhere, 1200) }
  });

  function save() { engine.save(null); }

  engine.ready.then(function (r) {
    me = r.me; role = r.role; D = r.doc || null;
    if (!D) { if (isAdmin()) $('setup').hidden = false; return; }
    start();
  }, function () { });

  $('setup-btn').onclick = function () {
    D = { version: 1, nextBarcode: POOL_START + 1, people: [], companies: [], settings: Object.assign({}, DEFAULTS) };
    save();
    $('setup').hidden = true;
    start();
    showPanel('settings');
    toast('Dining Halls is ready: 1000 cards');
  };

  function start() {
    $('app').hidden = false;
    var camp = Portal.camp();
    $('who').textContent = (camp ? camp.name + ' · ' : '') + (me.name || me.username) + ' · ' + Portal.ROLE_LABEL[role];
    $('bk-all').href = Portal.withCamp('/api/dining/backup');
    document.querySelectorAll('.admin-only').forEach(function (el) { if (!isAdmin()) el.hidden = true; });
    document.querySelectorAll('.admin-op').forEach(function (el) { if (!canScan()) el.hidden = true; });
    if (!HALLS.some(function (h) { return h.id === S.hall; })) S.hall = 'Senior';
    fillHallSelect($('rec-hall'), 'All dining halls');
    fillHallSelect($('cards-hall'), 'All dining halls');
    fillHallSelect($('rel-hall'), 'All dining halls');
    fillHallSelect($('pf-hall'));
    renderHallButtons();
    tickClock(); setInterval(tickClock, 30000);
    $('rec-from').value = $('rec-to').value = today();
    setRange('month', true);
    document.querySelectorAll('#tabs button').forEach(function (b) { b.onclick = function () { showPanel(b.dataset.panel); }; });
    showPanel(canScan() ? 'scan' : 'reports');
    refreshToday();
    setInterval(function () { if (S.panel === 'scan') refreshToday(); }, 60000);
    window.addEventListener('offline', function () { setOnline(false); });
    window.addEventListener('online', function () { refreshToday(); });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') { if (S.panel === 'scan') { refreshToday(); keepAwake(); if (S.mode === 'nfc') startNfc(); } }
      else { stopCamera(); stopNfc(); }
    });
  }

  function tickClock() {
    var now = new Date();
    $('clock').textContent = dayLabel(today()) + ' · ' + fmtTime.format(now);
  }

  function fillHallSelect(sel, allLabel) {
    sel.innerHTML = (allLabel ? '<option value="">' + esc(allLabel) + '</option>' : '') +
      HALLS.map(function (h) { return '<option value="' + h.id + '">' + esc(h.label) + '</option>'; }).join('');
  }

  // ------------------------------------------------------------------ panels
  function showPanel(name) {
    if (name === 'scan' && !canScan()) name = 'reports';
    S.panel = name;
    document.querySelectorAll('.panel').forEach(function (p) { p.classList.toggle('on', p.id === 'panel-' + name); });
    document.querySelectorAll('#tabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.panel === name); });
    if (name !== 'scan') { stopCamera(); stopNfc(); }
    renderPanel(name);
  }
  function renderPanel(name) {
    if (name === 'scan') { renderHallButtons(); refreshToday(); refreshRecent(); keepAwake(); focusCode(); }
    else if (name === 'records') loadRecords(true);
    else if (name === 'reports') loadReport();
    else if (name === 'cards') renderCards();
    else if (name === 'companies') renderCompanies();
    else if (name === 'settings') renderSettings();
  }

  var wakeLock = null;
  function keepAwake() {
    if (wakeLock || !navigator.wakeLock || document.visibilityState !== 'visible') return;
    navigator.wakeLock.request('screen').then(function (l) {
      wakeLock = l; l.addEventListener('release', function () { wakeLock = null; });
    }).catch(function () { /* not allowed: the screen may turn off */ });
  }

  // ================================================================== SCAN
  function renderHallButtons() {
    $('halls').innerHTML = HALLS.map(function (h) {
      return '<button type="button" data-hall="' + h.id + '" style="--hc:' + h.color + '" class="' + (h.id === S.hall ? 'on' : '') + '">' +
        esc(h.label) + '<small>' + esc(h.sub) + '</small></button>';
    }).join('');
    $('halls').querySelectorAll('button').forEach(function (b) {
      b.onclick = function () {
        S.hall = b.dataset.hall; writeLocal('dining.hall', S.hall);
        renderHallButtons(); hideResult(); updateCounts(); refreshRecent(); focusCode();
      };
    });
  }

  function focusCode() {
    if (S.panel !== 'scan' || S.mode !== 'manual') return;
    var i = $('code'); if (i && !i.disabled) setTimeout(function () { i.focus(); }, 60);
  }

  $('manual').onsubmit = function (e) {
    e.preventDefault();
    var code = $('code').value; $('code').value = '';
    scan(code);
  };
  $('mode-manual').onclick = function () { setMode('manual'); };
  $('mode-camera').onclick = function () { setMode('camera'); };
  $('mode-nfc').onclick = function () { setMode('nfc'); };
  $('nfc-start').onclick = function () { startNfc(); };
  $('r-next').onclick = function () { hideResult(); focusCode(); };
  $('r-allow').onclick = function () { if (S.pending) scan(S.pending, 'allow', S.pendingMethod); };
  $('r-deny').onclick = function () { if (S.pending) scan(S.pending, 'deny', S.pendingMethod); };

  function setMode(mode) {
    S.mode = mode;
    ['manual', 'camera', 'nfc'].forEach(function (m) { $('mode-' + m).classList.toggle('on', mode === m); });
    $('manual').hidden = mode !== 'manual';
    $('camera').hidden = mode !== 'camera';
    $('nfc').hidden = mode !== 'nfc';
    stopCamera(); stopNfc();
    if (mode === 'camera') startCamera();
    else if (mode === 'nfc') startNfc();
    else focusCode();
  }

  /** @param {string} [method] 'nfc' when the card was read by NFC */
  function scan(raw, decision, method) {
    var code = norm(raw);
    if (!code) { toast('Scan or type a barcode'); return; }
    if (!S.online) { beepNo(); toast('No connection — scanning is stopped'); return; }
    if (S.busy) return;
    S.busy = true; setScanEnabled(false);
    ctx(); // phones only allow sound after a touch: open it now
    api('POST', '/api/dining/scan', { hall: S.hall, barcode: code, decision: decision, method: method === 'nfc' ? 'nfc' : 'code' })
      .then(function (r) { setOnline(true); showResult(r); })
      .catch(function (e) {
        if (!e || !e.status || e.status >= 502) { setOnline(false); showProblem('NOT CHECKED', 'No connection to the server. Scan this card again when the connection is back.'); }
        else if (e.status !== 401) showProblem('NOT CHECKED', e.message);
      })
      .then(function () { S.busy = false; setScanEnabled(S.online); if (S.mode === 'manual' && !S.pending) focusCode(); });
  }

  function setScanEnabled(on) { $('code').disabled = !on; $('manual').querySelector('button').disabled = !on; }

  function detailsHtml(rows) {
    return rows.filter(function (r) { return r[1]; }).map(function (r) {
      return '<div class="drow"><span>' + esc(r[0]) + '</span><span>' + r[1] + '</span></div>';
    }).join('');
  }

  function showResult(r) {
    clearTimeout(S.resultTimer);
    var box = $('result');
    box.hidden = false;
    if (r.result === 'unregistered') {
      S.pending = r.barcode;
      S.pendingMethod = r.method;
      box.className = 'result unregistered';
      $('r-icon').textContent = '❓';
      $('r-title').textContent = 'NOT REGISTERED';
      $('r-reason').textContent = r.canAllow ? 'This card belongs to nobody. Allow or deny?' : 'This card belongs to nobody. Entry is not allowed.';
      $('r-details').innerHTML = detailsHtml([['Barcode', '<span class="mono">' + esc(r.barcode) + '</span>'], ['Dining hall', badge(r.hall)]]);
      $('r-choice').hidden = false;
      $('r-allow').hidden = !r.canAllow;
      $('r-next').hidden = true;
      beepNo(); vibrate([80, 60, 80]);
      return;
    }
    S.pending = null;
    var ok = r.result === 'allowed';
    box.className = 'result ' + (ok ? 'allowed' : 'denied');
    $('r-icon').textContent = ok ? '✓' : r.code === 'already' ? '🔁' : '⛔';
    $('r-title').textContent = r.title;
    $('r-reason').textContent = r.reason + (r.previousAt ? ' at ' + timeOf(r.previousAt) : '');
    var p = r.person;
    $('r-details').innerHTML = detailsHtml(p ? [
      ['Name', esc(p.name)], ['Company', esc(p.company || '—')], ['Room', esc(p.room || '—')],
      ['Dining hall', badge(p.hall)], ['Barcode', '<span class="mono">' + esc(p.barcode) + '</span>']
    ] : [['Barcode', '<span class="mono">' + esc(r.barcode) + '</span>']]);
    $('r-choice').hidden = true;
    $('r-next').hidden = false;
    if (ok) { beepOk(); vibrate(60); } else { beepNo(); vibrate([120, 60, 120]); }
    if (r.counts) { S.counts = r.counts; updateCounts(); }
    refreshRecent();
    S.resultTimer = setTimeout(hideResult, RESULT_MS);
  }

  function showProblem(title, text) {
    clearTimeout(S.resultTimer);
    S.pending = null;
    var box = $('result'); box.hidden = false; box.className = 'result denied';
    $('r-icon').textContent = '⚠'; $('r-title').textContent = title; $('r-reason').textContent = text;
    $('r-details').innerHTML = ''; $('r-choice').hidden = true; $('r-next').hidden = false;
    beepNo();
  }

  function hideResult() { clearTimeout(S.resultTimer); S.pending = null; $('result').hidden = true; }

  function setOnline(on) {
    if (S.online === on) return;
    S.online = on;
    $('offline').hidden = on;
    setScanEnabled(on && !S.busy);
    if (!on) {
      beepNo();
      clearTimeout(S.retryTimer);
      S.retryTimer = setTimeout(function retry() { refreshToday().then(function () { if (!S.online) S.retryTimer = setTimeout(retry, RETRY_MS); }); }, RETRY_MS);
    } else { toast('Connection is back — scanning again'); focusCode(); }
  }

  function refreshToday() {
    return api('GET', '/api/dining/today').then(function (t) {
      setOnline(true);
      S.counts = t.counts;
      $('meal-now').textContent = t.entryRule === 'day' ? 'One entry per day' : t.meal;
      updateCounts();
    }, function (e) { if (!e || !e.status || e.status >= 502) setOnline(false); });
  }

  function updateCounts() {
    var c = S.counts || { total: 0, byHall: {} };
    $('st-hall').textContent = c.byHall[S.hall] || 0;
    $('st-total').textContent = c.total || 0;
  }

  function refreshRecent() {
    if (S.panel !== 'scan') return;
    var d = today();
    api('GET', '/api/dining/scans?from=' + d + '&to=' + d + '&hall=' + encodeURIComponent(S.hall) + '&limit=8').then(function (r) {
      $('recent').innerHTML = r.rows.length ? r.rows.map(recordHtml).join('') : '<div class="empty">No scans at this hall yet today</div>';
    }, function () { });
  }

  function onScanElsewhere() {
    if (S.panel === 'scan') { refreshToday(); refreshRecent(); }
    else if (S.panel === 'records') loadRecords(true);
    else if (S.panel === 'reports') loadReport();
  }

  // ------------------------------------------------------------------ camera
  var cam = { stream: null, timer: null, quagga: false };
  function onCameraCode(code) {
    code = norm(code);
    var now = Date.now();
    if (!code || S.busy || S.pending || !S.online) return;
    if (code === S.lastCode && now - S.lastCodeAt < SAME_CODE_MS) return;
    S.lastCode = code; S.lastCodeAt = now;
    scan(code);
  }
  function camMessage(t) { $('cam-msg').textContent = t; }

  function startCamera() {
    stopCamera();
    camMessage('Starting the camera…');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      camMessage('This browser cannot use the camera here. Use Chrome on the phone.'); return;
    }
    if ('BarcodeDetector' in window) startNative(); else startQuagga();
  }

  function startNative() {
    var wanted = ['code_128', 'code_39', 'code_93', 'ean_13', 'ean_8', 'upc_a', 'qr_code'];
    window.BarcodeDetector.getSupportedFormats().then(function (formats) {
      var use = wanted.filter(function (f) { return formats.indexOf(f) >= 0; });
      if (!use.length) { startQuagga(); return; }
      var detector = new window.BarcodeDetector({ formats: use });
      return navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false }).then(function (stream) {
        if (S.mode !== 'camera' || S.panel !== 'scan') { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
        cam.stream = stream;
        var v = $('video'); v.hidden = false; v.srcObject = stream;
        return v.play().then(function () {
          camMessage('Point the camera at the barcode.');
          var busy = false;
          cam.timer = setInterval(function () {
            if (busy || v.readyState < 2) return;
            busy = true;
            detector.detect(v).then(function (codes) { if (codes.length) onCameraCode(codes[0].rawValue); })
              .catch(function () { }).then(function () { busy = false; });
          }, 200);
        });
      });
    }).catch(cameraError);
  }

  function startQuagga() {
    if (!window.Quagga) { camMessage('The camera reader did not load. Reload the page.'); return; }
    $('video').hidden = true;
    window.Quagga.init({
      inputStream: { name: 'Live', type: 'LiveStream', target: $('cam-view'), constraints: { facingMode: 'environment' } },
      decoder: { readers: ['code_128_reader', 'code_39_reader', 'ean_reader', 'ean_8_reader'] },
      locate: true
    }, function (err) {
      if (err) { cameraError(err); return; }
      if (S.mode !== 'camera' || S.panel !== 'scan') { try { window.Quagga.stop(); } catch (e) { /* stopped */ } return; }
      cam.quagga = true;
      window.Quagga.onDetected(function (data) { if (data && data.codeResult) onCameraCode(data.codeResult.code); });
      window.Quagga.start();
      camMessage('Point the camera at the barcode.');
    });
  }

  function cameraError(err) {
    var name = err && err.name;
    camMessage(name === 'NotAllowedError' ? 'The camera is blocked. In Chrome tap the lock icon next to the address and allow the Camera, then try again.'
      : name === 'NotFoundError' ? 'No camera was found on this device.' : 'The camera could not start: ' + ((err && err.message) || err));
    stopCamera(true);
  }

  function stopCamera(keepMessage) {
    clearInterval(cam.timer); cam.timer = null;
    if (cam.stream) { cam.stream.getTracks().forEach(function (t) { t.stop(); }); cam.stream = null; }
    var v = $('video'); if (v) { v.srcObject = null; }
    if (cam.quagga) {
      try { window.Quagga.offDetected(); window.Quagga.stop(); } catch (e) { /* already stopped */ }
      cam.quagga = false;
      $('cam-view').querySelectorAll('video:not(#video),canvas').forEach(function (el) { el.remove(); });
    }
    if (!keepMessage && $('cam-msg')) camMessage('Point the camera at the barcode.');
  }

  // ------------------------------------------------------------------ NFC (Chrome on Android phones with NFC)
  var nfc = { ctrl: null };
  function nfcSupported() { return 'NDEFReader' in window; }
  function nfcMessage(t, on) { $('nfc-msg').textContent = t; $('nfc-box').classList.toggle('on', !!on); }

  /** What a tag gives: the card number written on it (text), else its own serial number. */
  function tagCode(e) {
    var recs = (e.message && e.message.records) || [];
    for (var i = 0; i < recs.length; i++) {
      var r = recs[i];
      if (r.recordType !== 'text' || !r.data) continue;
      try {
        var t = new TextDecoder(r.encoding || 'utf-8').decode(r.data).trim();
        if (/^[A-Za-z0-9\-_.]{3,40}$/.test(t)) return t;
      } catch (err) { /* unreadable record */ }
    }
    return e.serialNumber || '';
  }

  /**
   * Starts reading tags; `onTag(code, serial)` for each one. Returns a Promise that rejects with a
   * message the user can act on. Chrome needs a tap on the page before the first start.
   */
  function readTags(onTag, ctrl) {
    if (!nfcSupported()) return Promise.reject(new Error('NFC works in Chrome on Android phones that have NFC. Use the scanner or the camera on this device.'));
    var reader = new window.NDEFReader();
    reader.onreading = function (e) { onTag(tagCode(e), e.serialNumber || ''); };
    reader.onreadingerror = function () { toast('This tag could not be read — hold it still and try again'); };
    return reader.scan({ signal: ctrl.signal }).catch(function (err) {
      var n = err && err.name;
      throw new Error(n === 'NotAllowedError' ? 'NFC is not allowed. Allow NFC for this site (lock icon next to the address), then tap "Start NFC reading".'
        : n === 'NotSupportedError' || n === 'NotReadableError' ? 'NFC is switched off or not available. Switch NFC on in the phone settings, then tap "Start NFC reading".'
        : 'NFC could not start: ' + ((err && err.message) || err));
    });
  }

  function startNfc() {
    stopNfc();
    $('nfc-start').hidden = true;
    if (!nfcSupported()) { nfcMessage('NFC works in Chrome on Android phones that have NFC. Use the scanner or the camera on this device.'); return; }
    var ctrl = new AbortController();
    nfc.ctrl = ctrl;
    nfcMessage('Starting NFC…');
    readTags(function (code) {
      if (nfc.ctrl !== ctrl) return;
      onNfcCode(code);
    }, ctrl).then(function () {
      if (nfc.ctrl === ctrl) nfcMessage('Ready — hold the card against the back of the phone.', true);
    }, function (err) {
      if (nfc.ctrl !== ctrl) return;
      nfc.ctrl = null;
      nfcMessage(err.message);
      $('nfc-start').hidden = false; // a tap on the page lets Chrome start NFC
    });
  }
  function stopNfc() {
    if (nfc.ctrl) { try { nfc.ctrl.abort(); } catch (e) { /* stopped */ } nfc.ctrl = null; }
    if ($('nfc-box')) $('nfc-box').classList.remove('on');
  }
  function onNfcCode(code) {
    code = norm(code);
    var now = Date.now();
    if (!code || S.busy || S.pending || !S.online) return;
    if (code === S.lastCode && now - S.lastCodeAt < SAME_CODE_MS) return;
    S.lastCode = code; S.lastCodeAt = now;
    vibrate(30);
    scan(code, undefined, 'nfc');
  }

  // ================================================================== RECORDS
  function recordHtml(r) {
    var unreg = !r.personId && r.source === 'scan';
    var who = r.name || (unreg ? 'Card not registered' : '—');
    return '<div class="item"><span class="sdot ' + r.status + '"></span><div class="info">' +
      '<div class="name">' + esc(who) + ' <span class="pill ' + (r.status === 'allowed' ? 'ok' : 'no') + '">' + (r.status === 'allowed' ? 'IN' : 'DENIED') + '</span></div>' +
      '<div class="meta">' + badge(r.hall) + ' ' + esc([r.company, r.meal, r.reason + (r.released ? ' (let in again)' : ''), r.scannedByName].filter(Boolean).join(' · ')) + '</div>' +
      '<div class="mono">' + (r.method === 'nfc' ? '📶 ' : '') + esc(r.barcode) + (r.source === 'import' ? ' · from a backup' : '') + '</div></div>' +
      '<div class="time">' + esc(timeOf(r.at)) + '<br><small>' + esc(dayLabel(r.day)) + '</small></div></div>';
  }

  function recordQuery() {
    var q = new URLSearchParams();
    var from = $('rec-from').value, to = $('rec-to').value;
    if (from && to && from > to) { var t = from; from = to; to = t; }
    q.set('from', from || today()); q.set('to', to || today());
    if ($('rec-hall').value) q.set('hall', $('rec-hall').value);
    if ($('rec-status').value) q.set('status', $('rec-status').value);
    if ($('rec-q').value.trim()) q.set('q', $('rec-q').value.trim());
    return q;
  }

  function loadRecords(reset) {
    var q = recordQuery();
    $('rec-csv').href = Portal.withCamp('/api/dining/scans.csv?' + q.toString());
    if (reset) S.recBefore = null;
    if (S.recBefore) q.set('beforeId', S.recBefore);
    q.set('limit', LIST_PAGE);
    api('GET', '/api/dining/scans?' + q.toString()).then(function (r) {
      var html = r.rows.map(recordHtml).join('');
      if (reset) $('rec-list').innerHTML = html || '<div class="empty">No scans for these choices</div>';
      else $('rec-list').insertAdjacentHTML('beforeend', html);
      S.recBefore = r.rows.length ? r.rows[r.rows.length - 1].id : S.recBefore;
      $('rec-more').hidden = !r.more;
    }, function (e) { toast(e.message); });
  }
  ['rec-from', 'rec-to', 'rec-hall', 'rec-status'].forEach(function (id) { $(id).onchange = function () { loadRecords(true); }; });
  $('rec-q').oninput = debounce(function () { loadRecords(true); }, 350);
  $('rec-more').onclick = function () { loadRecords(false); };

  // ================================================================== REPORTS
  var report = null;
  function setRange(kind, quiet) {
    var t = today(), from = t, to = t;
    if (kind === 'week') from = addDays(t, -6);
    else if (kind === 'month') from = t.slice(0, 8) + '01';
    else if (kind === 'last-month') { to = addDays(t.slice(0, 8) + '01', -1); from = to.slice(0, 8) + '01'; }
    $('rep-from').value = from; $('rep-to').value = to;
    if (!quiet) loadReport();
  }
  $('rep-quick').querySelectorAll('button').forEach(function (b) { b.onclick = function () { setRange(b.dataset.range); }; });
  $('rep-from').onchange = $('rep-to').onchange = function () { loadReport(); };

  function loadReport() {
    var from = $('rep-from').value, to = $('rep-to').value;
    if (!from || !to) return;
    if (from > to) { var t = from; from = to; to = t; }
    api('GET', '/api/dining/report?from=' + from + '&to=' + to).then(function (r) { report = r; renderReport(); }, function (e) { toast(e.message); });
  }

  function mealRank(m) { var i = MEALS.indexOf(m); return i < 0 ? 9 : i; }

  function dailyRows() {
    var map = {};
    report.daily.forEach(function (x) {
      var k = x.day + '|' + x.meal;
      var row = map[k] || (map[k] = { day: x.day, meal: x.meal, halls: {}, total: 0 });
      row.halls[x.hall] = (row.halls[x.hall] || 0) + x.n; row.total += x.n;
    });
    return Object.keys(map).map(function (k) { return map[k]; })
      .sort(function (a, b) { return a.day === b.day ? mealRank(a.meal) - mealRank(b.meal) : (a.day < b.day ? 1 : -1); });
  }
  function companyRows() {
    return report.byCompany.slice().sort(function (a, b) {
      if (a.day !== b.day) return a.day < b.day ? 1 : -1;
      if (a.meal !== b.meal) return mealRank(a.meal) - mealRank(b.meal);
      if (a.hall !== b.hall) return HALLS.indexOf(hallOf(a.hall)) - HALLS.indexOf(hallOf(b.hall));
      return String(a.company).localeCompare(String(b.company));
    });
  }

  function renderReport() {
    var rows = dailyRows();
    var total = rows.reduce(function (a, r) { return a + r.total; }, 0);
    var days = {}; rows.forEach(function (r) { days[r.day] = 1; });
    var nDays = Object.keys(days).length;
    var cos = {}; report.byCompany.forEach(function (x) { if (x.company) cos[x.company] = 1; });
    $('rep-meals').textContent = total;
    $('rep-days').textContent = nDays;
    $('rep-avg').textContent = nDays ? Math.round(total / nDays) : 0;
    $('rep-cos').textContent = Object.keys(cos).length;

    var head = '<tr><th>Date</th><th>Meal</th>' + HALLS.map(function (h) { return '<th>' + esc(h.short) + '</th>'; }).join('') + '<th class="tot">Total</th></tr>';
    var sums = {}, prev = null;
    var body = rows.map(function (r) {
      var first = r.day !== prev; prev = r.day;
      return '<tr><td>' + (first ? '<b>' + esc(dayLabel(r.day)) + '</b>' : '') + '</td><td class="m-' + esc(r.meal) + '">' + esc(r.meal) + '</td>' +
        HALLS.map(function (h) { var n = r.halls[h.id] || 0; sums[h.id] = (sums[h.id] || 0) + n; return '<td class="' + (n ? '' : 'zero') + '">' + (n || '–') + '</td>'; }).join('') +
        '<td class="tot">' + r.total + '</td></tr>';
    }).join('');
    var sum = rows.length ? '<tr class="sum"><td>Total</td><td></td>' + HALLS.map(function (h) { return '<td>' + (sums[h.id] || 0) + '</td>'; }).join('') + '<td class="tot">' + total + '</td></tr>' : '';
    $('rep-daily').innerHTML = head + (body || '<tr><td colspan="' + (HALLS.length + 3) + '" class="empty">No meals in these dates</td></tr>') + sum;

    var cr = companyRows(); prev = null;
    $('rep-co').innerHTML = '<tr><th>Date</th><th>Meal</th><th>Hall</th><th>Company</th><th class="tot">Meals</th></tr>' +
      (cr.map(function (x) {
        var first = x.day !== prev; prev = x.day;
        return '<tr><td>' + (first ? '<b>' + esc(dayLabel(x.day)) + '</b>' : '') + '</td><td class="m-' + esc(x.meal) + '">' + esc(x.meal) + '</td><td>' + badge(x.hall) + '</td>' +
          '<td class="co">' + esc(x.company || '(no company)') + '</td><td class="tot">' + x.n + '</td></tr>';
      }).join('') || '<tr><td colspan="5" class="empty">No meals in these dates</td></tr>');
  }

  $('rep-csv-daily').onclick = function () {
    if (!report) return;
    var rows = [['Date', 'Meal'].concat(HALLS.map(function (h) { return h.label; }), ['Total'])];
    dailyRows().forEach(function (r) { rows.push([r.day, r.meal].concat(HALLS.map(function (h) { return r.halls[h.id] || 0; }), [r.total])); });
    download('dining_meals_per_day_' + report.from + '_to_' + report.to + '.csv', csv(rows));
  };
  $('rep-csv-co').onclick = function () {
    if (!report) return;
    var rows = [['Date', 'Meal', 'Dining hall', 'Company', 'Meals']];
    companyRows().forEach(function (x) { rows.push([x.day, x.meal, hallOf(x.hall).label, x.company || '(no company)', x.n]); });
    download('dining_meals_per_company_' + report.from + '_to_' + report.to + '.csv', csv(rows));
  };

  // ================================================================== PEOPLE & CARDS
  function cardList() {
    var byCode = {};
    people().forEach(function (p) { var c = norm(p.barcode); if (c && !byCode[c]) byCode[c] = p; });
    var list = [], seen = {};
    var top = Math.max(POOL_START, (Number(D.nextBarcode) || POOL_START + 1) - 1);
    for (var i = 1; i <= top; i++) { var c = poolCode(i); seen[c] = 1; list.push({ code: c, person: byCode[c] || null }); }
    Object.keys(byCode).forEach(function (c) { if (!seen[c]) list.push({ code: c, person: byCode[c] }); });
    return list;
  }

  function filteredCards() {
    var f = S.cardsFilter, hall = $('cards-hall').value, co = $('cards-co').value, q = $('cards-q').value.trim().toLowerCase();
    return cardList().filter(function (x) {
      var p = x.person;
      if (f === 'assigned' && !p) return false;
      if (f === 'free' && p) return false;
      if (f === 'blocked' && !(p && p.allowed === false)) return false;
      if ((hall || co) && !p) return false;
      if (hall && p.hall !== hall) return false;
      if (co && p.company !== co) return false;
      if (q && x.code.toLowerCase().indexOf(q) < 0 && !(p && ((p.name || '').toLowerCase().indexOf(q) >= 0 || (p.room || '').toLowerCase().indexOf(q) >= 0 || (p.nfc || '').toLowerCase().indexOf(q) >= 0))) return false;
      return true;
    });
  }

  function renderCards() {
    var all = cardList();
    var used = all.filter(function (x) { return x.person; }).length;
    $('cards-info').textContent = used + ' assigned · ' + (all.length - used) + ' free · ' + all.length + ' cards';
    var keep = $('cards-co').value;
    $('cards-co').innerHTML = '<option value="">All companies</option>' + companies().map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('');
    $('cards-co').value = keep;
    var list = filteredCards();
    var shown = list.slice(0, CARDS_SHOWN);
    $('cards-list').innerHTML = shown.map(function (x) {
      var p = x.person, h = p ? hallOf(p.hall) : null;
      var cls = 'cardrow' + (p ? (p.allowed === false ? ' blocked' : '') : ' free');
      var acts = isAdmin() ? '<div class="act">' +
        (p ? '<button type="button" class="lt" data-block="' + esc(x.code) + '">' + (p.allowed === false ? 'Allow' : 'Block') + '</button>' : '') +
        '<button type="button" data-edit="' + esc(x.code) + '">' + (p ? '✏️ Edit' : '➕ Assign') + '</button></div>' : '';
      return '<div class="' + cls + '" style="--hc:' + (h ? h.color : '#9aa0ab') + '"><div class="info">' +
        '<div class="name">' + (p ? esc(p.name) : '<span style="color:var(--gray3);font-style:italic">Free card</span>') + ' ' + (p ? badge(p.hall) : '') +
        (p && p.allowed === false ? ' <span class="pill no">BLOCKED</span>' : '') + '</div>' +
        '<div class="meta">' + (p ? esc((p.company || '—') + ' · Room ' + (p.room || '—')) : 'Not assigned') + '</div>' +
        '<div class="mono">' + esc(x.code) + (p && p.nfc ? ' · 📶 ' + esc(p.nfc) : '') + '</div></div>' + acts + '</div>';
    }).join('') + (list.length > shown.length ? '<div class="empty">+ ' + (list.length - shown.length) + ' more — use the search or filters</div>' : '') +
      (list.length ? '' : '<div class="empty">No cards for these choices</div>');
    $('cards-list').querySelectorAll('[data-edit]').forEach(function (b) { b.onclick = function () { openPerson(b.dataset.edit); }; });
    $('cards-list').querySelectorAll('[data-block]').forEach(function (b) {
      b.onclick = function () {
        var p = findByCode(b.dataset.block); if (!p) return;
        p.allowed = p.allowed === false; save(); renderCards();
        toast(p.name + (p.allowed ? ' can enter again' : ' is blocked'));
      };
    });
  }
  $('cards-filter').querySelectorAll('button').forEach(function (b) {
    b.onclick = function () {
      S.cardsFilter = b.dataset.f;
      $('cards-filter').querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x === b); });
      renderCards();
    };
  });
  $('cards-hall').onchange = $('cards-co').onchange = renderCards;
  $('cards-q').oninput = debounce(renderCards, 250);

  function findByCode(code) {
    code = norm(code);
    return people().find(function (p) { return norm(p.barcode) === code; }) || null;
  }

  $('gen-btn').onclick = function () {
    var n = parseInt($('gen-count').value, 10);
    if (!(n >= 1 && n <= 500)) { toast('Enter 1 to 500'); return; }
    var next = Math.max(Number(D.nextBarcode) || POOL_START + 1, POOL_START + 1);
    if (!confirm('Add ' + n + ' new cards: ' + poolCode(next) + ' to ' + poolCode(next + n - 1) + '?')) return;
    D.nextBarcode = next + n; save(); renderCards();
    toast(n + ' cards added');
  };

  $('print-btn').onclick = function () {
    var list = filteredCards();
    if (!list.length) { toast('No cards to print'); return; }
    if (list.length > PRINT_MAX) { alert('Too many cards (' + list.length + '). Use the filters to print at most ' + PRINT_MAX + ' at a time.'); return; }
    var area = $('print-area');
    area.innerHTML = list.map(function (x) {
      var p = x.person, h = p ? hallOf(p.hall) : null;
      return '<div class="pcard" style="--hc:' + (h ? h.color : '#9aa0ab') + '"><div class="ph">' + esc(h ? h.label.toUpperCase() : 'UNASSIGNED') + '</div>' +
        '<svg data-code="' + esc(x.code) + '"></svg><div class="pc">' + esc(x.code) + '</div>' +
        '<div class="pn">' + esc(p ? p.name : '—') + '</div><div class="pi">' + esc(p ? (p.company || '-') + ' | Rm ' + (p.room || '-') : '') + '</div></div>';
    }).join('');
    area.querySelectorAll('svg').forEach(function (s) {
      try { window.JsBarcode(s, s.getAttribute('data-code'), { format: 'CODE128', width: 1.6, height: 44, displayValue: false, margin: 4 }); } catch (e) { /* bad code */ }
    });
    setTimeout(function () { window.print(); }, 200);
  };

  // ------------------------------------------------------------------ assign / edit dialog
  var editing = null;
  function openPerson(code) {
    var p = findByCode(code);
    editing = { code: norm(code), person: p };
    $('pf-title').textContent = p ? 'Edit card' : 'Assign card';
    $('pf-code').textContent = '🔲 ' + editing.code;
    $('pf-name').value = p ? p.name : '';
    $('pf-room').value = p ? p.room : '';
    $('pf-hall').value = p && hallOf(p.hall).color !== '#6b7280' ? p.hall : (S.hall || 'Senior');
    var cos = companies().slice();
    if (p && p.company && cos.indexOf(p.company) < 0) cos.push(p.company);
    $('pf-co').innerHTML = '<option value="">— Choose company —</option>' + cos.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('');
    $('pf-co').value = p ? p.company : '';
    $('pf-allowed').checked = !p || p.allowed !== false;
    $('pf-nfc').value = p && p.nfc ? p.nfc : '';
    $('pf-nfc-msg').textContent = nfcSupported() ? '' : 'Reading and writing tags works in Chrome on an Android phone with NFC. You can also type the tag number.';
    $('pf-remove').hidden = !p;
    $('pf-error').textContent = cos.length ? '' : 'Add the companies first (Companies tab).';
    $('dlg-person').showModal();
    setTimeout(function () { $('pf-name').focus(); }, 50);
  }
  $('pf-close').onclick = function () { $('dlg-person').close(); };
  $('dlg-person').addEventListener('close', stopTagTool);

  // ------------------------------------------------------------------ linking an NFC tag to a card
  var tagTool = null;
  function normTag(v) { var s = String(v || '').replace(/[\s:\-]/g, '').toUpperCase(); return /^[0-9A-Z]{4,40}$/.test(s) ? s : ''; }
  function stopTagTool() { if (tagTool) { try { tagTool.abort(); } catch (e) { /* stopped */ } tagTool = null; } }
  function tagToolStart(text) {
    stopTagTool();
    stopNfc(); // only one NFC reader at a time
    var ctrl = new AbortController();
    tagTool = ctrl;
    setTimeout(function () { if (tagTool === ctrl) { stopTagTool(); $('pf-nfc-msg').textContent = 'No tag was found. Try again.'; } }, 30000);
    $('pf-nfc-msg').textContent = text;
    return ctrl;
  }
  $('pf-nfc-read').onclick = function () {
    var ctrl = tagToolStart('Hold the tag against the back of the phone…');
    readTags(function (code, serial) {
      if (tagTool !== ctrl) return;
      var id = normTag(serial) || normTag(code);
      stopTagTool();
      if (!id) { $('pf-nfc-msg').textContent = 'This tag has no number that can be used. Try another tag.'; return; }
      $('pf-nfc').value = id; vibrate(60);
      $('pf-nfc-msg').textContent = '✅ Tag read. Press Save to link it to this card.';
    }, ctrl).catch(function (err) { if (tagTool === ctrl) { stopTagTool(); $('pf-nfc-msg').textContent = err.message; } });
  };
  $('pf-nfc-write').onclick = function () {
    if (!nfcSupported()) { $('pf-nfc-msg').textContent = 'Writing tags works in Chrome on an Android phone with NFC.'; return; }
    var ctrl = tagToolStart('Hold the tag against the back of the phone to write ' + editing.code + '…');
    new window.NDEFReader().write({ records: [{ recordType: 'text', data: editing.code }] }, { signal: ctrl.signal }).then(function () {
      if (tagTool !== ctrl) return;
      stopTagTool(); vibrate(60);
      $('pf-nfc-msg').textContent = '✅ ' + editing.code + ' was written on the tag. It now works at every gate as this card.';
    }, function (err) {
      if (tagTool !== ctrl) return;
      stopTagTool();
      $('pf-nfc-msg').textContent = 'The tag could not be written' + (err && err.name === 'NotAllowedError' ? ' (NFC is not allowed for this site).' : ' (it may be locked or read-only). You can still link it with "Read tag".');
    });
  };
  $('person-form').onsubmit = function (e) {
    e.preventDefault();
    var name = $('pf-name').value.trim(), room = $('pf-room').value.trim(), co = $('pf-co').value, hall = $('pf-hall').value;
    if (!name) { $('pf-error').textContent = 'Enter the name.'; return; }
    if (!room) { $('pf-error').textContent = 'Enter the room.'; return; }
    if (!co) { $('pf-error').textContent = 'Choose the company.'; return; }
    var rawTag = $('pf-nfc').value.trim(), tag = normTag(rawTag);
    if (rawTag && !tag) { $('pf-error').textContent = 'The NFC tag number should be 4 to 40 letters or digits.'; return; }
    var p = editing.person && people().indexOf(editing.person) >= 0 ? editing.person : findByCode(editing.code);
    var other = tag ? people().find(function (x) { return x !== p && normTag(x.nfc) === tag; }) : null;
    if (other && !confirm('This NFC tag is linked to ' + other.name + ' (' + other.barcode + ').\n\nMove it to this card?')) return;
    if (other) delete other.nfc;
    if (p) {
      Object.assign(p, { name: name, room: room, company: co, hall: hall, allowed: $('pf-allowed').checked });
      if (tag) p.nfc = tag; else delete p.nfc;
    } else {
      if (!Array.isArray(D.people)) D.people = [];
      var np = { id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: name, company: co, room: room, hall: hall, barcode: editing.code, allowed: $('pf-allowed').checked };
      if (tag) np.nfc = tag;
      D.people.push(np);
    }
    save(); $('dlg-person').close(); renderCards();
    toast('✅ ' + name + ' saved');
  };
  $('pf-remove').onclick = function () {
    var p = editing && findByCode(editing.code);
    if (!p || !confirm('Free card ' + editing.code + '? ' + p.name + ' will be removed from Dining Halls (past meals stay in the records).')) return;
    D.people = people().filter(function (x) { return x !== p; });
    save(); $('dlg-person').close(); renderCards();
    toast('Card ' + editing.code + ' is free');
  };

  // ================================================================== COMPANIES
  function renderCompanies() {
    var count = {};
    people().forEach(function (p) { count[p.company] = (count[p.company] || 0) + 1; });
    var list = companies();
    $('co-count').textContent = list.length + ' companies';
    $('co-list').innerHTML = list.length ? list.map(function (c, i) {
      return '<div class="item"><div class="info"><div class="name">🏢 ' + esc(c) + '</div><div class="meta">' + (count[c] || 0) + ' people</div></div>' +
        '<button type="button" class="btn-light" data-del="' + i + '">🗑</button></div>';
    }).join('') : '<div class="empty">No companies yet</div>';
    $('co-list').querySelectorAll('[data-del]').forEach(function (b) {
      b.onclick = function () {
        var c = list[Number(b.dataset.del)];
        var n = count[c] || 0;
        if (!confirm('Delete company "' + c + '"?' + (n ? '\n\n' + n + ' people still have it; they keep it until you change them.' : ''))) return;
        D.companies = companies().filter(function (x) { return x !== c; });
        save(); renderCompanies();
      };
    });
  }
  $('co-form').onsubmit = function (e) {
    e.preventDefault();
    var name = $('co-name').value.trim();
    if (!name) return;
    if (companies().some(function (c) { return c.toLowerCase() === name.toLowerCase(); })) { toast('Already in the list'); return; }
    D.companies = companies().concat([name]).sort(function (a, b) { return a.localeCompare(b); });
    save(); $('co-name').value = ''; renderCompanies(); toast('✅ ' + name + ' added');
  };

  // ================================================================== SETTINGS
  function hourOptions(sel, from, to) {
    var h = '';
    for (var i = from; i <= to; i++) h += '<option value="' + i + '">' + String(i).padStart(2, '0') + ':00</option>';
    sel.innerHTML = h;
  }
  function renderSettings() {
    var s = settings();
    document.querySelectorAll('input[name="rule"]').forEach(function (r) { r.checked = r.value === s.entryRule; });
    hourOptions($('set-lunch'), 1, 22); hourOptions($('set-dinner'), 2, 23);
    $('set-lunch').value = s.lunchFrom; $('set-dinner').value = s.dinnerFrom;
    $('set-unreg').checked = s.allowUnregistered !== false;
  }
  $('set-save').onclick = function () {
    var rule = (document.querySelector('input[name="rule"]:checked') || {}).value || 'meal';
    var lunch = Number($('set-lunch').value), dinner = Number($('set-dinner').value);
    if (!(lunch < dinner)) { alert('Dinner must start after lunch.'); return; }
    D.settings = { entryRule: rule, lunchFrom: lunch, dinnerFrom: dinner, allowUnregistered: $('set-unreg').checked };
    save(); toast('Settings saved');
  };

  // ------------------------------------------------------------------ backup download
  $('bk-range').onclick = function () {
    var from = $('bk-from').value, to = $('bk-to').value;
    if (!from || !to) { toast('Choose both dates'); return; }
    if (from > to) { var t = from; from = to; to = t; }
    location.href = Portal.withCamp('/api/dining/backup?from=' + from + '&to=' + to);
  };

  $('rel-btn').onclick = function () {
    var hall = $('rel-hall').value;
    if (!confirm('Let everybody who already entered ' + (hall ? hallOf(hall).label : 'any dining hall') + ' today in once more?\n\nToday\'s meals stay counted.')) return;
    api('POST', '/api/dining/release', { hall: hall || null }).then(function (r) {
      toast(r.released + ' people can scan in again');
    }, function (e) { alert(e.message); });
  };

  // ------------------------------------------------------------------ import of the old app's backups
  $('imp-files').onchange = function () {
    var files = Array.prototype.slice.call(this.files || []);
    S.importFiles = [];
    $('imp-result').textContent = '';
    if (!files.length) { $('imp-choose').innerHTML = ''; $('imp-btn').disabled = true; return; }
    Promise.all(files.map(function (f) {
      return f.text().then(function (t) {
        try { return { name: f.name, content: JSON.parse(t) }; } catch (e) { return { name: f.name, error: 'not a JSON file' }; }
      });
    })).then(function (list) {
      var bad = list.filter(function (x) { return x.error || !x.content || (!Array.isArray(x.content.people) && !Array.isArray(x.content.entryLog)); });
      if (bad.length) { $('imp-choose').innerHTML = '<div class="error">Not a Dining Halls / Mess Hall backup: ' + esc(bad.map(function (x) { return x.name; }).join(', ')) + '</div>'; $('imp-btn').disabled = true; return; }
      S.importFiles = list;
      var most = 0;
      list.forEach(function (x, i) { if ((x.content.people || []).length > (list[most].content.people || []).length) most = i; });
      var keepCurrent = people().length > 0;
      $('imp-choose').innerHTML = '<p class="note"><b>People, cards and companies</b> — take them from:</p>' +
        '<label class="opt"><input type="radio" name="imp-setup" value="-1"' + (keepCurrent ? ' checked' : '') + '><span>Keep the current ones (' + people().length + ' people)</span></label>' +
        list.map(function (x, i) {
          return '<label class="opt"><input type="radio" name="imp-setup" value="' + i + '"' + (!keepCurrent && i === most ? ' checked' : '') + '><span><b>' + esc(x.name) + '</b><br><small>' +
            (x.content.people || []).length + ' people · ' + (x.content.companies || []).length + ' companies · ' + (x.content.entryLog || []).length + ' scan records</small></span></label>';
        }).join('');
      $('imp-btn').disabled = false;
    });
  };
  $('imp-btn').onclick = function () {
    var choice = document.querySelector('input[name="imp-setup"]:checked');
    var setupFrom = choice ? Number(choice.value) : -1;
    var records = S.importFiles.reduce(function (a, x) { return a + (x.content.entryLog || []).length; }, 0);
    if (!confirm('Bring in ' + S.importFiles.length + ' file(s) with ' + records + ' scan records?' +
      (setupFrom >= 0 ? '\n\nThe people, cards and companies will be REPLACED by the ones in "' + S.importFiles[setupFrom].name + '" (the current ones are kept as a backup on the server).' : ''))) return;
    $('imp-btn').disabled = true;
    $('imp-result').textContent = 'Working…';
    api('POST', '/api/dining/import', { files: S.importFiles.map(function (x) { return { name: x.name, content: x.content }; }), setupFrom: setupFrom })
      .then(function (r) {
        var msg = '✅ ' + r.added + ' scan records added' + (r.skipped ? ', ' + r.skipped + ' already there (skipped)' : '') + '.' +
          (r.people !== null ? '\n' + r.people + ' people and their cards were brought in.' : '');
        $('imp-result').textContent = msg;
        alert(msg + (r.setupRev ? '\n\nThe page will now reload.' : ''));
      }, function (e) { $('imp-result').textContent = '❌ ' + e.message; $('imp-btn').disabled = false; });
  };
})();
