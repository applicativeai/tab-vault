import * as db from './db.js';

// Rows are virtualized: only the ~50 visible rows exist in the DOM, so 10k+ tabs stay instant.
const ROW = 32;
const OPEN_WARN = 20;
const DAY = 24 * 60 * 60 * 1000;

const $ = (s) => document.querySelector(s);
const viewport = $('#viewport');
const spacer = $('#spacer');

// Time views over the common list. "Last saved" time decides where a link shows up,
// so anything you haven't saved again in 30 days drops into the Archive.
const seen = (t) => t.seen ?? t.added ?? 0;
const TIME_VIEWS = [
  ['today', 'Today', (t, now) => seen(t) >= new Date(now).setHours(0, 0, 0, 0)],
  ['week', 'Last 7 days', (t, now) => seen(t) >= now - 7 * DAY],
  ['month', 'Last 30 days', (t, now) => seen(t) >= now - 30 * DAY],
  ['archive', 'Archive (30+ days)', (t, now) => seen(t) < now - 30 * DAY],
  ['everything', 'All time', () => true],
];

const DEFAULT_VIEW = 'today';
let current = DEFAULT_VIEW; // a TIME_VIEWS id, or a session id (number)
let cat = 'all'; // chip filter: 'all', a db.CATEGORIES id, or a site like 'github.com'
let grouped = false;
let expanded = new Set(); // sites opened while grouped
let sessions = [];
let commonTabs = []; // the whole common list
let base = []; // current time view or session, sorted
let view = []; // base after category + search
let rows = []; // what's drawn: { t } tab rows and { site, tabs } group rows
let selected = new Set(); // dedup keys
let lastClicked = -1;

const info = new WeakMap(); // entry -> { hay, cat, site }, computed once per entry
function meta(t) {
  let m = info.get(t);
  if (!m) {
    const site = db.siteOf(t.url);
    const c = db.category(t.url);
    m = {
      hay: (t.title + ' ' + t.url).toLowerCase(),
      site,
      // Chip key: the category where one applies (splits Google into Search, Gmail, Drive), else the site.
      chip: c === 'other' ? site : c,
      // A→Z by main site, so subdomains sit together; local hosts and IPs go last.
      siteKey: (db.isLocalSite(site) ? '~' : '') + site + '\u0000' + t.sortKey,
    };
    info.set(t, m);
  }
  return m;
}
const CAT_NAMES = Object.fromEntries(db.CATEGORIES);
const TOP_CHIPS = 10;
let titleCounts = new Map(); // title -> how many tabs in the current list share it

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const favicon = (url) => `/_favicon/?pageUrl=${encodeURIComponent(url)}&size=16`;
const shortUrl = (url) => url.replace(/^https?:\/\/(www\.)?/, '');
const inSession = () => typeof current === 'number';
const session = () => sessions.find((s) => s.id === current);
const n = (x) => x.toLocaleString();

// The distinguishing end of a URL, shown next to titles many tabs share ("solveit" ×284).
function urlTail(url) {
  try {
    const u = new URL(url);
    let s = u.pathname.split('/').filter(Boolean).slice(-2).join('/') + u.search + u.hash;
    if (!s) s = u.hostname.split('.')[0];
    try { s = decodeURIComponent(s); } catch {}
    return s.length > 60 ? '…' + s.slice(-59) : s;
  } catch {
    return '';
  }
}

// Compact "last saved" age for the row's right edge.
function age(t, now) {
  const ms = seen(t);
  if (!ms) return ''; // imported without a date
  const d = Math.floor((now - ms) / DAY);
  if (d < 1) return 'today';
  if (d < 7) return d + 'd';
  if (d < 60) return Math.floor(d / 7) + 'w';
  if (d < 365) return Math.floor(d / 30) + 'mo';
  return Math.floor(d / 365) + 'y';
}

async function load() {
  [sessions, commonTabs] = await Promise.all([db.getSessions(), db.getAllTabs()]);
  if (inSession() && !session()) current = DEFAULT_VIEW;
  const keys = new Set(commonTabs.concat(sessions.flatMap((s) => s.tabs)).map((t) => t.key));
  selected = new Set([...selected].filter((k) => keys.has(k)));
  const last = await db.getMeta('lastBackup');
  $('#lastBackup').textContent = last ? `Backed up ${new Date(last).toLocaleDateString()}` : 'No backup yet';
  $('#lastBackup').title = 'A backup is saved to Downloads/TabVault every 7 days';
  recompute();
}

// Rebuild the base list for the current view (after load, view switch or sort change).
function recompute() {
  const now = Date.now();
  if (inSession()) {
    base = session().tabs;
  } else {
    const test = TIME_VIEWS.find(([id]) => id === current)[2];
    base = commonTabs.filter((t) => test(t, now));
  }
  if (opts.source !== 'all') base = base.filter((t) => !t.auto === (opts.source === 'mine'));
  base = sortList(base);
  titleCounts = new Map();
  for (const t of base) titleCounts.set(t.title, (titleCounts.get(t.title) ?? 0) + 1);
  document.body.classList.toggle('in-session', inSession());
  $('#q').placeholder = `Search ${n(base.length)} tab${base.length === 1 ? '' : 's'}   /`;
  $('#viewTitle').textContent = inSession() ? session().name : TIME_VIEWS.find(([id]) => id === current)[1];
  renderNav(now);
  renderCats();
  filter();
}

// Tabs saved in the same click share a time, so ties fall back to URL order.
function sortList(list) {
  const mode = opts.sort;
  const out = [...list].sort((a, b) => (meta(a).siteKey < meta(b).siteKey ? -1 : meta(a).siteKey > meta(b).siteKey ? 1 : 0));
  if (mode !== 'url') {
    const dir = mode === 'newest' ? -1 : 1;
    out.sort((a, b) => dir * (seen(a) - seen(b)));
  }
  return out;
}

const icon = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICONS = {
  today: icon('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  week: icon('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>'),
  month: icon('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4M8 14h.01M12 14h.01M16 14h.01M8 17.5h.01M12 17.5h.01"/>'),
  archive: icon('<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4"/>'),
  everything: icon('<path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="m3 13 9 5 9-5"/>'),
  session: icon('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
};

function renderNav(now) {
  const item = (id, name, count, svg) =>
    `<div class="nav-item${id === current ? ' active' : ''}" data-id="${id}">${svg}<span class="name">${esc(name)}</span><span class="n">${n(count)}</span></div>`;
  $('#nav').innerHTML =
    '<div class="menu-label">Saved tabs</div>' +
    TIME_VIEWS.map(([id, name, test]) => item(id, name, commonTabs.filter((t) => test(t, now)).length, ICONS[id])).join('') +
    (sessions.length ? '<div class="menu-label">Sessions</div>' : '') +
    sessions.map((s) => item(s.id, s.name, s.tabs.length, ICONS.session)).join('');
}

// Chips for the biggest sites/categories in the current list; no row when there's only one.
function renderCats() {
  const counts = new Map();
  for (const t of base) counts.set(meta(t).chip, (counts.get(meta(t).chip) ?? 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, TOP_CHIPS).map(([id]) => id);
  if (cat !== 'all' && !top.includes(cat)) top.push(cat);
  const chip = (id, label, count) => `<button class="chip${id === cat ? ' active' : ''}" data-cat="${esc(id)}">${esc(label)} <span>${n(count)}</span></button>`;
  $('#cats').innerHTML = counts.size <= 1 && cat === 'all' ? '' :
    chip('all', 'All', base.length) + top.map((id) => chip(id, CAT_NAMES[id] ?? id, counts.get(id) ?? 0)).join('');
}

function filter() {
  const terms = $('#q').value.toLowerCase().split(/\s+/).filter(Boolean);
  view = base.filter((t) => (cat === 'all' || meta(t).chip === cat) && terms.every((w) => meta(t).hay.includes(w)));
  buildRows();
}

// Grouped: one header row per site, its tabs underneath when expanded (always expanded while searching).
// A site with a single tab is shown as a plain row.
function buildRows() {
  if (!grouped) {
    rows = view.map((t) => ({ t }));
  } else {
    const sites = new Map(); // insertion order follows the current sort
    for (const t of view) {
      const s = meta(t).site;
      if (!sites.has(s)) sites.set(s, []);
      sites.get(s).push(t);
    }
    const searching = $('#q').value.trim() !== '';
    rows = [];
    for (const [site, tabs] of sites) {
      if (tabs.length === 1) {
        rows.push({ t: tabs[0] });
        continue;
      }
      const open = searching || expanded.has(site);
      rows.push({ site, tabs, open });
      if (open) for (const t of tabs) rows.push({ t, nested: true });
    }
  }
  spacer.style.height = rows.length * ROW + 'px';
  render();
}

function render() {
  const now = Date.now();
  const start = Math.max(0, Math.floor(viewport.scrollTop / ROW) - 10);
  const end = Math.min(rows.length, start + Math.ceil(viewport.clientHeight / ROW) + 20);
  let html = '';
  for (let i = start; i < end; i++) {
    const r = rows[i];
    if (r.site) {
      const nSel = r.tabs.filter((t) => selected.has(t.key)).length;
      html += `<div class="row group${nSel === r.tabs.length ? ' sel' : ''}" style="top:${i * ROW}px" data-i="${i}">
        <input type="checkbox"${nSel === r.tabs.length ? ' checked' : ''}>
        <span class="chev${r.open ? ' open' : ''}">›</span>
        <img src="${favicon(r.tabs[0].url)}" alt="">
        <span class="site">${esc(r.site)}</span>
        <span class="n">${n(r.tabs.length)}${nSel ? ` · ${n(nSel)} selected` : ''}</span>
        <button class="del" title="Delete all ${r.tabs.length} tabs from this site">✕</button>
      </div>`;
      continue;
    }
    const t = r.t;
    const sel = selected.has(t.key);
    html += `<div class="row${sel ? ' sel' : ''}${r.nested ? ' nested' : ''}" style="top:${i * ROW}px" data-i="${i}">
      <input type="checkbox"${sel ? ' checked' : ''}>
      ${grouped && !r.nested ? '<span class="chev"></span>' : ''}
      <img src="${favicon(t.url)}" alt="">
      <a href="${esc(t.url)}">${esc(t.title)}${titleCounts.get(t.title) >= 3 ? `<span class="hint">${esc(urlTail(t.url))}</span>` : ''}</a>
      ${t.auto ? '<span class="tag" title="Saved by the hourly auto-save, not by you">auto</span>' : ''}
      <span class="url" title="${esc(t.url)}">${esc(shortUrl(t.url))}</span>
      <span class="age" title="Last saved ${seen(t) ? new Date(seen(t)).toLocaleString() : 'date unknown'}">${age(t, now)}</span>
      <button class="del" title="Remove">✕</button>
    </div>`;
  }
  const searching = $('#q').value.trim() || cat !== 'all';
  const emptyMsg = !commonTabs.length && !sessions.length
    ? '<b>No tabs saved yet</b>Click the Tab Vault icon in the toolbar to save every open tab. Coming from Session Buddy or restoring a backup? Use Import at the bottom left, or drop the file here.'
    : searching || inSession() || current === 'everything'
      ? '<b>No matches</b>Try another search or category.'
      : `<b>Nothing in ${esc(TIME_VIEWS.find(([id]) => id === current)[1].toLowerCase())}</b>Click the Tab Vault icon to save your open tabs.<br><button data-view="everything">Show all time</button>`;
  spacer.innerHTML = rows.length ? html : `<div class="empty">${emptyMsg}</div>`;

  const sites = grouped ? new Set(view.map((t) => meta(t).site)).size : 0;
  const filtered = view.length !== base.length;
  $('#count').textContent =
    (filtered ? `${n(view.length)} of ${n(base.length)} tabs` : `${n(base.length)} tabs`) +
    (grouped ? ` on ${n(sites)} site${sites === 1 ? '' : 's'}` : '');
  document.body.classList.toggle('selecting', selected.size > 0);
  $('#selCount').textContent = `${n(selected.size)} selected`;
  const allSelected = view.every((t) => selected.has(t.key));
  $('#selAll').hidden = allSelected;
  $('#selAll').textContent = `Select all ${n(view.length)}`;
}

async function removeKeys(keys) {
  const drop = new Set(keys);
  let undo;
  if (inSession()) {
    const before = session();
    await db.putSession({ ...before, tabs: before.tabs.filter((t) => !drop.has(t.key)) });
    undo = () => db.putSession(before);
  } else {
    const removed = commonTabs.filter((t) => drop.has(t.key));
    await db.deleteTabs(keys);
    undo = () => db.mergeIntoCommon(removed);
  }
  for (const k of keys) selected.delete(k);
  showUndo(`Deleted ${n(keys.length)} tab${keys.length === 1 ? '' : 's'}`, undo);
  await load();
}

// Every delete is undoable for 10 seconds (button or Cmd/Ctrl+Z). Only the latest delete.
let undoAction = null;
let undoTimer;
function showUndo(message, undo) {
  undoAction = undo;
  $('#toastMsg').textContent = message;
  $('#toast').classList.add('show');
  clearTimeout(undoTimer);
  undoTimer = setTimeout(hideUndo, 10000);
}
function hideUndo() {
  undoAction = null;
  $('#toast').classList.remove('show');
}
async function runUndo() {
  const undo = undoAction;
  hideUndo();
  if (undo) {
    await undo();
    await load();
  }
}

function openUrls(urls, active = false) {
  if (urls.length > OPEN_WARN && !confirm(`Open ${urls.length} tabs?`)) return;
  urls.forEach((url, i) => chrome.tabs.create({ url, active: active && i === 0 }));
}

function resetPosition() {
  selected.clear();
  lastClicked = -1;
  viewport.scrollTop = 0;
}

// ---------- events ----------

let raf = 0;
viewport.addEventListener('scroll', () => {
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(render);
});
window.addEventListener('resize', render);

let debounce;
$('#q').addEventListener('input', () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    viewport.scrollTop = 0;
    lastClicked = -1;
    filter();
  }, 80);
});

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== $('#q')) {
    e.preventDefault();
    $('#q').focus();
  }
  if (e.key === '[' && !e.target.matches('input')) toggleSidebar();
  if (e.key === 'Escape' && selected.size) {
    selected.clear();
    render();
  }
});
spacer.addEventListener('click', (e) => e.target.dataset.view && switchView(e.target.dataset.view));

function onRowClick(e) {
  const row = e.target.closest('.row');
  if (!row) return;
  const i = +row.dataset.i;
  const r = rows[i];

  if (r.site) {
    if (e.target.closest('.del')) {
      removeKeys(r.tabs.map((t) => t.key));
    } else if (e.button !== 0) {
      return;
    } else if (e.target.matches('input[type=checkbox]')) {
      const all = r.tabs.every((t) => selected.has(t.key));
      for (const t of r.tabs) all ? selected.delete(t.key) : selected.add(t.key);
      render();
    } else {
      expanded.has(r.site) ? expanded.delete(r.site) : expanded.add(r.site);
      lastClicked = -1;
      buildRows();
    }
    return;
  }

  const t = r.t;
  if (e.target.closest('a')) {
    e.preventDefault();
    // Plain click opens and switches; Cmd/Ctrl-click or middle-click opens in background.
    openUrls([t.url], e.button === 0 && !e.metaKey && !e.ctrlKey);
    return;
  }
  if (e.target.closest('.del')) {
    removeKeys([t.key]);
    return;
  }
  if (e.button !== 0) return;
  // Click anywhere else on the row toggles selection; Shift-click selects a range.
  if (e.shiftKey && lastClicked >= 0) {
    const [a, b] = [Math.min(lastClicked, i), Math.max(lastClicked, i)];
    for (let j = a; j <= b; j++) for (const x of rows[j].site ? rows[j].tabs : [rows[j].t]) selected.add(x.key);
  } else if (selected.has(t.key)) {
    selected.delete(t.key);
  } else {
    selected.add(t.key);
  }
  lastClicked = i;
  render();
}
spacer.addEventListener('click', onRowClick);
spacer.addEventListener('auxclick', (e) => e.button === 1 && onRowClick(e));
// Stop the checkbox toggling itself; onRowClick owns selection state.
spacer.addEventListener('click', (e) => e.target.matches('input[type=checkbox]') && e.preventDefault(), true);
spacer.addEventListener('mousedown', (e) => e.shiftKey && e.preventDefault()); // no text selection on shift-click

$('#nav').addEventListener('click', (e) => {
  const item = e.target.closest('.nav-item');
  if (!item) return;
  switchView(item.dataset.id);
});

function switchView(id) {
  current = /^\d+$/.test(id) ? +id : id;
  $('#q').value = '';
  resetPosition();
  recompute();
}

$('#cats').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  cat = chip.dataset.cat;
  resetPosition();
  renderCats();
  filter();
});

// Remembered per browser; storage can be unavailable, so never let it break the page.
const pref = (k, fallback) => {
  try {
    return localStorage[k] ?? fallback;
  } catch {
    return fallback;
  }
};
const setPref = (k, v) => {
  try {
    localStorage[k] = v;
  } catch {}
};

// ---------- view controls (all visible in the header) ----------
const DEFAULTS = { source: 'all', sort: 'url', grouped: '0', urls: '1' };
const opts = Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, pref(k, DEFAULTS[k])]));

function applyOpts() {
  $('#source').value = opts.source;
  $('#sort').value = opts.sort;
  grouped = opts.grouped === '1';
  $('#group').setAttribute('aria-pressed', grouped);
  $('#urls').setAttribute('aria-pressed', opts.urls === '1');
  document.body.classList.toggle('hide-urls', opts.urls !== '1');
}

function setOpts(changes) {
  Object.assign(opts, changes);
  for (const k in changes) setPref(k, changes[k]);
  applyOpts();
  lastClicked = -1;
  viewport.scrollTop = 0;
  recompute();
}

applyOpts();
for (const id of ['source', 'sort']) $('#' + id).onchange = (e) => setOpts({ [id]: e.target.value });
$('#group').onclick = () => setOpts({ grouped: grouped ? '0' : '1' });

// Sidebar toggle: button or the [ key. Remembered.
// One toggle, fixed in the top-left corner, so it's in the same spot whether the sidebar is open or not.
const applySidebar = (show) => document.body.classList.toggle('no-sidebar', !show);
applySidebar(pref('sidebar', '1') === '1');
const toggleSidebar = () => {
  const show = document.body.classList.contains('no-sidebar');
  setPref('sidebar', show ? '1' : '0');
  applySidebar(show);
  render();
};
$('#sidebarToggle').onclick = toggleSidebar;
$('#urls').onclick = () => setOpts({ urls: opts.urls === '1' ? '0' : '1' });

$('#selAll').onclick = () => {
  view.forEach((t) => selected.add(t.key));
  render();
};
$('#selNone').onclick = () => {
  selected.clear();
  render();
};
$('#open').onclick = () => openUrls(base.filter((t) => selected.has(t.key)).map((t) => t.url));
$('#del').onclick = () => removeKeys([...selected]);
$('#undo').onclick = runUndo;
document.addEventListener('keydown', (e) => {
  if (undoAction && (e.metaKey || e.ctrlKey) && e.key === 'z' && document.activeElement !== $('#q')) {
    e.preventDefault();
    runUndo();
  }
});

$('#merge').onclick = async () => {
  const { added, dupes } = await db.mergeIntoCommon(session().tabs);
  alert(`Merged: ${added} new, ${dupes} already in the common list.`);
  load();
};
$('#rename').onclick = async () => {
  const name = prompt('Session name', session().name);
  if (name?.trim()) {
    await db.putSession({ ...session(), name: name.trim() });
    load();
  }
};
$('#delSession').onclick = async () => {
  const s = session();
  await db.deleteSession(s.id);
  showUndo(`Deleted session "${s.name}"`, () => db.putSession(s));
  current = DEFAULT_VIEW;
  load();
};

$('#export').onclick = async () => {
  const blob = new Blob([JSON.stringify(await db.exportAll())], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tab-vault-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};
$('#backupNow').onclick = async () => {
  $('#backupNow').disabled = true;
  const r = await chrome.runtime.sendMessage({ type: 'backup-now' });
  $('#backupNow').disabled = false;
  if (!r?.ok) alert('Backup failed: ' + (r?.error ?? 'unknown error'));
};
$('#import').onclick = () => $('#file').click();
$('#file').onchange = (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) importFile(file);
};

// Dropping a backup or Session Buddy file anywhere on the page imports it too.
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  document.body.classList.add('dropping');
});
document.addEventListener('dragleave', (e) => e.relatedTarget || document.body.classList.remove('dropping'));
document.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dropping');
  const file = e.dataTransfer.files[0];
  if (file) importFile(file);
});

async function importFile(file) {
  try {
    const data = JSON.parse(await file.text());
    const { added, sessions } = data.collections ? await importSessionBuddy(data) : await db.importAll(data);
    if (added === undefined) return; // cancelled
    alert(`Imported ${n(added)} new tabs and ${sessions} sessions.`);
    load();
  } catch (err) {
    alert('Import failed: ' + err.message);
  }
}

// Session Buddy export: let the user pick where each collection goes.
function importSessionBuddy(data) {
  const plan = db.readSessionBuddy(data);
  $('#sbRows').innerHTML = plan
    .map(
      (c) => `<div class="sb-row">
        <span class="t" title="${esc(c.title)}">${esc(c.title)}</span>
        <span class="c">${n(c.links.length)}</span>
        <select data-i="${c.i}">
          <option value="common"${c.target === 'common' ? ' selected' : ''}>Common list</option>
          <option value="session"${c.target === 'session' ? ' selected' : ''}>Session</option>
          <option value="skip">Skip</option>
        </select>
      </div>`,
    )
    .join('');
  const dlg = $('#sbDialog');
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.onclose = async () => {
      if (dlg.returnValue !== 'ok') return resolve({});
      for (const sel of dlg.querySelectorAll('select')) plan[+sel.dataset.i].target = sel.value;
      resolve(await db.importSessionBuddy(plan));
    };
  });
}

// Refresh when the icon or shortcut saves tabs.
chrome.runtime.onMessage.addListener((m) => m.type === 'changed' && load());

$('#saveSession').onclick = async () => {
  const name = prompt('Name for this session', new Date().toLocaleString());
  if (name === null) return;
  const entries = await db.captureOpenTabs();
  await db.addSession(name.trim() || new Date().toLocaleString(), entries);
  current = (await db.getSessions())[0].id;
  resetPosition();
  load();
};

// Show the result of the last icon click / shortcut save for a few seconds.
let savedTimer;
async function showLastSave() {
  const { lastSave } = await chrome.storage.session.get('lastSave');
  if (!lastSave || Date.now() - lastSave.at > 10000) return;
  $('#saved').textContent = `· Saved: ${lastSave.added} new, ${lastSave.dupes} already there`;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => ($('#saved').textContent = ''), 6000);
}
chrome.storage.session.onChanged.addListener(showLastSave);
showLastSave();

load();
