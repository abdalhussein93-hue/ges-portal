'use strict';
/**
 * Builds the web versions of the three apps from their desktop programs.
 *
 *   node tools/build-apps.js            (paths in tools/app-sources.json)
 *
 * Output:
 *   public/apps/<app>/index.html + assets   (committed: contains no personal data)
 *   seed/<app>.json                          built-in starting data (personal data: NOT committed)
 *
 * The app screens are not rewritten. Only a few checked edits are made:
 *   - built-in personal data is moved out of the page into seed/
 *   - built-in passwords are removed (the server checks passwords)
 *   - the portal scripts are added; they connect each app's existing storage to the server
 */
const fs = require('fs');
const path = require('path');
const { readAppSource } = require('./lib/app-source');
const { HtmlEditor } = require('./lib/html-edit');

const ROOT = path.resolve(__dirname, '..');
const SOURCES_FILE = path.join(__dirname, 'app-sources.json');
const OUT = path.join(ROOT, 'public', 'apps');
const SEED = path.join(ROOT, 'seed');

const script = src => `<script src="${src}"></script>\n`;

/** Global Village Camp Management */
function buildCamp(html, seed) {
  const e = new HtmlEditor(html, 'camp');
  seed.campData = e.extractLiteral('built-in camp data', 'const INIT_DATA = ', '{}');
  seed.historyLog = e.extractLiteral('built-in history', '\n  historyLog=', '[]');

  const before = e.html;
  e.html = e.html.replace(/^let ADMIN_PW\s*=\s*'[^'\n]*';/m, 'let ADMIN_PW = null; // passwords are checked by the server');
  e.html = e.html.replace(/^let OPER_PW\s*=\s*'[^'\n]*';/m, 'let OPER_PW = null;');
  if (e.html === before || !/^let ADMIN_PW = null;/m.test(e.html) || !/^let OPER_PW = null;/m.test(e.html)) e.fail('passwords', 'built-in passwords not found');

  e.replaceOnce('start-up waits for the server',
    '(async function(){\n  // DESKTOP MODE: read the data file first, then start the app',
    'window.__gvcStart=async function(){\n  // DESKTOP MODE: read the data file first, then start the app');
  e.replaceOnce('start-up end', 'setInterval(()=>refreshData(true),60000);\n})();', 'setInterval(()=>refreshData(true),60000);\n};');
  e.replaceOnce('refresh reads the server', 'if(!(window.desktopStorage&&window.desktopStorage.isDesktop)&&!unsaved){',
    'if(false){ // web version: the live server keeps data current');
  addApprovalsAndMovement(e);
  e.insertBefore('portal scripts', '</body>',
    script('/patch.js') + script('/shared/portal-bar.js') + script('/shared/camp-approvals.js') + script('/shared/camp-sync.js'), { last: true });
  e.mustNotContain('no written-in password', 'ABD@');
  return e.html;
}

/**
 * Operator -> Admin approval workflow and Movement Summary (code in public/shared/camp-approvals.js).
 * The hook positions come from the version made for the single-file app (CAMP_MANGMENT.html).
 */
function addApprovalsAndMovement(e) {
  e.insertBefore('approvals: styles', '</head>', '<link rel="stylesheet" href="/shared/camp-approvals.css">\n');
  // menu, top bar, pages, bed window
  const dashNav = `<div class="nav-item active" onclick="showPage('dashboard',this)"><i class="ti ti-layout-dashboard"></i> Dashboard</div>`;
  e.replaceOnce('menu: Approvals', dashNav, dashNav + `\n    <div class="nav-item" id="navApprovals" onclick="showPage('approvals',this)"><i class="ti ti-checklist"></i> Approvals <span id="apNavBadge" class="ap-nav-badge" style="display:none">0</span></div>`);
  const logNav = `<div class="nav-item" onclick="showPage('history',this)"><i class="ti ti-history"></i> Check In/Out Log</div>`;
  e.replaceOnce('menu: Movement Summary', logNav, logNav + `\n    <div class="nav-item" onclick="showPage('movement',this)"><i class="ti ti-arrows-exchange"></i> Movement Summary</div>`);
  e.replaceOnce('top bar: Approvals button', '<button class="btn btn-sm" onclick="openNotifPanel()" id="notifBtn"',
    `<button class="btn btn-sm" onclick="openApprovals()" id="apBtn" title="Change approvals" style="background:var(--purple-bg);color:var(--purple);border:1.5px solid #c4b5fd;position:relative"><i class="ti ti-checklist"></i> Approvals<span id="apBadge" class="ap-badge" style="display:none">0</span></button>\n    <button class="btn btn-sm" onclick="openNotifPanel()" id="notifBtn"`);
  const lastPage = '<div class="page" id="page-vacantRooms"></div>';
  e.replaceOnce('pages', lastPage, lastPage + '\n    <div class="page" id="page-approvals"></div>\n    <div class="page" id="page-movement"></div>');
  const sub = '<div class="modal-sub" id="bedModalSub"></div>';
  e.replaceOnce('bed window: note area', sub, sub + '\n    <div id="bmApNote"></div>');
  e.replaceOnce('page titles', "vacantRooms:'100% Vacant Rooms'};", "vacantRooms:'100% Vacant Rooms',approvals:'Change Approvals',movement:'Movement Summary'};");
  e.replaceOnce('page renderers', 'vacantRooms:renderVacantRooms})[name]?.();', 'vacantRooms:renderVacantRooms,approvals:renderApprovals,movement:renderMovement})[name]?.();');

  // hooks inside existing screens: [label, text before, text after, inserted, how many places]
  const HOOKS = [
    ['dashboard: approval banner', 'et h=colorLegend();\n  h+=saveBtnHtml();\n  h+=', '`<div class="stats-grid">\n    <div class="sta', 'apDashBanner();\n  h+=', 1],
    ['dashboard: occupied pending', '</div><div class="stat-sub">${pct}% occupancy', '</div></div>\n    <div class="stat-card" style', "${apPendSub('occ')}", 1],
    ['dashboard: vacant pending', 'v><div class="stat-sub">${100-pct}% available', '</div></div>\n    <div class="stat-card" style', "${apPendSub('vac')}", 1],
    ['dashboard: reserved pending', '.res}</div><div class="stat-sub">Beds on hold', '</div></div>\n  </div>\n  <div class="sec-title', "${apPendSub('res')}", 1],
    ['dashboard: block chip', ' <div class="block-name">${bk}</div>\n        ', '<div style="font-size:10px;font-weight:700;co', '${apBlockChip(bk)}\n        ', 1],
    ['block page: pending note', "-green)';\n  let h=colorLegend()+saveBtnHtml()", ';\n  h+=`<div class="bk-summary">\n    <div cla', '+apBlockNote(bk)', 1],
    ['bed: pending outline (occupied)', '     return `<div class="bed-btn bed-occupied', `" title="Name:\${b.name||'—'} | Co:\${b.company`, '${apBedCls(bk,rid,i)}', 1],
    ['bed: pending outline (reserved)', '     return `<div class="bed-btn bed-reserved', `" title="Reserved: \${b.company||'—'}" onclick`, '${apBedCls(bk,rid,i)}', 1],
    ['bed: pending outline (vacant)', '\n      return `<div class="bed-btn bed-vacant', '" title="Vacant bed ${i+1}" onclick="openBedM', '${apBedCls(bk,rid,i)}', 1],
    ['bed window: approval note', 'y}x1 | Status: ${b.status.toUpperCase()}`;\n  ', "document.getElementById('bm_name').value=b.na", 'apBedModalNote(bk,rid,bi);\n  ', 2],
    ['transfer: no "complete" alert when queued', "lassList.add('hidden');\n  renderBlock(bk);\n  ", "alert(`✓ Transfer complete! ${oldBed.name||'R", 'if(apJustQueued())return;\n  ', 1],
    ['quick entry: queued message', "ntent=`✓ ${rid}: ${n} beds${co?' — '+co:''}`;", '\n}\n', "if(apJustQueued()){msg.style.color='var(--purple)';msg.textContent=`⏳ ${rid}: ${n} beds${co?' — '+co:''} — sent to Admin for approval`;}", 1],
    ['deleted log record is kept', "{if(!isAdmin()){showPwModal('admin');return;}", 'historyLog=historyLog.filter(e=>e.id!==id);sa', 'mvRecordDeletedLog(historyLog.find(e=>e.id===id));', 1],
    ['settings: approval card', 'n-bottom:16px">Settings</div>`+saveBtnHtml()+', '`\n  <div class="card" style="max-width:440px;', 'apSettingsCard()+', 1],
  ];
  for (const [label, before, after, insert, count] of HOOKS) e.insertBetween(label, before, after, insert, count);
}

/** GES Manpower System */
function buildManpower(html, seed) {
  const e = new HtmlEditor(html, 'manpower');
  seed.INIT_STAFF = e.extractLiteral('built-in staff list', 'var INIT_STAFF = ', 'window.__gvcInitStaff || []');
  seed.VAC_DUE = e.extractLiteral('built-in vacation due dates', 'var VAC_DUE = ', 'window.__gvcVacDue || {}');
  // Never replace saved staff with an empty built-in list (it is empty unless the server is being set up).
  e.replaceOnce('seed refresh guard',
    'if(localStorage.getItem("gesSeedVersion")===DATA_SEED_VERSION) return;',
    'if(localStorage.getItem("gesSeedVersion")===DATA_SEED_VERSION || !INIT_STAFF.length) return;');
  e.replaceOnce('timesheet message', 'Timesheet file loaded and remembered in this browser.', 'Timesheet file loaded and saved on the server for everyone.');
  e.insertBefore('portal scripts', '<script>',
    script('/patch.js') + script('/shared/kv.js') + script('/shared/portal-bar.js') + script('/shared/bridge.js') + script('/shared/manpower-bridge.js'));
  e.mustNotContain('no written-in password', 'ABD@');
  return e.html;
}

/** Daily Costing & Stock */
function buildCosting(html) {
  const e = new HtmlEditor(html, 'costing');
  // "Clear day" had a password written in the page: now it needs an Admin of this app who
  // re-enters their own password (checked by the server).
  e.replaceOnce('clear day: admin only', '$("#clearDay").onclick=()=>{\n    const _pw=prompt(',
    '$("#clearDay").onclick=async()=>{\n    if(!GESApp.isAppAdmin()){toast("Only an Admin of this app can clear a day","warn");return;}\n    const _pw=prompt(');
  e.html = e.html.replace(/if\(_pw!=="[^"\n]*"\)\{toast\("Wrong password — day not cleared"/,
    'if(!(await GESApp.verifyOwnPassword(_pw))){toast("Wrong password — day not cleared"');
  e.mustNotContain('no written-in password', '_pw!=="');
  e.mustNotContain('no written-in password', 'ABD@');
  e.insertBefore('portal scripts', '</head>',
    script('/patch.js') + script('/shared/portal-bar.js') + script('/shared/bridge.js') + script('/shared/costing-bridge.js'));
  return e.html;
}

const BUILDERS = { camp: buildCamp, manpower: buildManpower, costing: buildCosting };

function copyAssets(files, outDir) {
  let n = 0;
  for (const [rel, data] of files) {
    if (rel === 'icon.ico' || (rel.startsWith('vendor/') && !/README\.txt$/i.test(rel))) {
      const target = path.join(outDir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
      n++;
    }
  }
  return n;
}

function main() {
  if (!fs.existsSync(SOURCES_FILE)) throw new Error('tools/app-sources.json is missing. Copy tools/app-sources.example.json and edit the paths.');
  const sources = JSON.parse(fs.readFileSync(SOURCES_FILE, 'utf-8'));
  const only = process.argv.slice(2);
  fs.mkdirSync(SEED, { recursive: true });
  for (const [appId, build] of Object.entries(BUILDERS)) {
    if (only.length && !only.includes(appId)) continue;
    if (!sources[appId]) throw new Error(`[${appId}] no path in tools/app-sources.json`);
    const location = path.resolve(ROOT, sources[appId]); // relative paths start at the project folder
    const files = readAppSource(location);
    if (!files.has('index.html')) throw new Error(`[${appId}] index.html not found in ${location}`);
    const seed = {};
    const html = build(files.get('index.html').toString('utf-8'), seed);
    const outDir = path.join(OUT, appId);
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    const assets = copyAssets(files, outDir);
    fs.writeFileSync(path.join(outDir, 'index.html'), html, 'utf-8');
    if (Object.keys(seed).length) fs.writeFileSync(path.join(SEED, `${appId}.json`), JSON.stringify(seed), 'utf-8');
    console.log(`${appId.padEnd(9)} index.html ${Math.round(html.length / 1024)} KB, ${assets} assets` +
      (Object.keys(seed).length ? `, starting data -> seed/${appId}.json (${Object.keys(seed).join(', ')})` : ''));
  }
}

try { main(); } catch (err) { console.error(`BUILD FAILED: ${err.message}`); process.exit(1); }
