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

let current = 'month'; // a TIME_VIEWS id, or a session id (number)
let cat = 'all'; // 'all' or a db.CATEGORIES id
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
  if (!m) info.set(t, (m = { hay: (t.title + ' ' + t.url).toLowerCase(), cat: db.category(t.url), site: db.siteOf(t.url) }));
  return m;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const favicon = (url) => `/_favicon/?pageUrl=${encodeURIComponent(url)}&size=16`;
const shortUrl = (url) => url.replace(/^https?:\/\/(www\.)?/, '');
const inSession = () => typeof current === 'number';
const session = () => sessions.find((s) => s.id === current);
const n = (x) => x.toLocaleString();

// Compact "last saved" age for the row's right edge.
function age(t, now) {
  const ms = seen(t);
  if (!ms) return '—';
  const d = Math.floor((now - ms) / DAY);
  if (d < 1) return 'today';
  if (d < 7) return d + 'd';
  if (d < 60) return Math.floor(d / 7) + 'w';
  if (d < 365) return Math.floor(d / 30) + 'mo';
  return Math.floor(d / 365) + 'y';
}

async function load() {
  [sessions, commonTabs] = await Promise.all([db.getSessions(), db.getAllTabs()]);
  if (inSession() && !session()) current = 'month';
  const keys = new Set(commonTabs.concat(sessions.flatMap((s) => s.tabs)).map((t) => t.key));
  selected = new Set([...selected].filter((k) => keys.has(k)));
  const last = await db.getMeta('lastBackup');
  $('#lastBackup').textContent = last ? `Backed up ${new Date(last).toLocaleDateString()}` : 'No backup yet';
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
  base = sortList(base);
  document.body.classList.toggle('in-session', inSession());
  $('#viewTitle').textContent = inSession() ? session().name : TIME_VIEWS.find(([id]) => id === current)[1];
  renderNav(now);
  renderCats();
  filter();
}

// Tabs saved in the same click share a time, so ties fall back to URL order.
function sortList(list) {
  const mode = $('#sort').value;
  const out = [...list].sort(db.bySortKey);
  if (mode !== 'url') {
    const dir = mode === 'newest' ? -1 : 1;
    out.sort((a, b) => dir * (seen(a) - seen(b)));
  }
  return out;
}

function renderNav(now) {
  const item = (id, name, count) =>
    `<div class="nav-item${id === current ? ' active' : ''}" data-id="${id}"><span>${esc(name)}</span><span class="n">${n(count)}</span></div>`;
  $('#nav').innerHTML =
    '<div class="nav-label">Saved tabs</div>' +
    TIME_VIEWS.map(([id, name, test]) => item(id, name, commonTabs.filter((t) => test(t, now)).length)).join('') +
    (sessions.length ? '<div class="nav-label">Sessions</div>' : '') +
    sessions.map((s) => item(s.id, s.name, s.tabs.length)).join('');
}

function renderCats() {
  const counts = { all: base.length };
  for (const t of base) counts[meta(t).cat] = (counts[meta(t).cat] ?? 0) + 1;
  $('#cats').innerHTML = [['all', 'All'], ...db.CATEGORIES]
    .map(([id, name]) => `<button class="chip${id === cat ? ' active' : ''}" data-cat="${id}">${name} <span>${n(counts[id] ?? 0)}</span></button>`)
    .join('');
}

function filter() {
  const terms = $('#q').value.toLowerCase().split(/\s+/).filter(Boolean);
  view = base.filter((t) => (cat === 'all' || meta(t).cat === cat) && terms.every((w) => meta(t).hay.includes(w)));
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
        <span class="chev">${r.open ? '▾' : '▸'}</span>
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
      <img src="${favicon(t.url)}" alt="">
      <a href="${esc(t.url)}">${esc(t.title)}</a>
      <span class="url" title="${esc(t.url)}">${esc(shortUrl(t.url))}</span>
      <span class="age" title="Last saved ${seen(t) ? new Date(seen(t)).toLocaleString() : 'date unknown'}">${age(t, now)}</span>
      <button class="del" title="Remove">✕</button>
    </div>`;
  }
  const emptyMsg = commonTabs.length || sessions.length
    ? '<b>Nothing here</b>Try another view, category or search.'
    : '<b>No tabs saved yet</b>Click the Tab Vault icon in the toolbar to save every open tab. Coming from Session Buddy or restoring a backup? Use Import at the bottom left.';
  spacer.innerHTML = rows.length ? html : `<div class="empty">${emptyMsg}</div>`;

  const sites = grouped ? new Set(view.map((t) => meta(t).site)).size : 0;
  const filtered = view.length !== base.length;
  $('#count').textContent =
    (filtered ? `${n(view.length)} of ${n(base.length)} tabs` : `${n(base.length)} tabs`) +
    (grouped ? ` on ${n(sites)} site${sites === 1 ? '' : 's'}` : '');
  document.body.classList.toggle('selecting', selected.size > 0);
  $('#selCount').textContent = `${n(selected.size)} selected`;
}

async function removeKeys(keys) {
  const drop = new Set(keys);
  if (inSession()) {
    const s = session();
    await db.putSession({ ...s, tabs: s.tabs.filter((t) => !drop.has(t.key)) });
  } else {
    await db.deleteTabs(keys);
  }
  for (const k of keys) selected.delete(k);
  await load();
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
});

function onRowClick(e) {
  const row = e.target.closest('.row');
  if (!row) return;
  const i = +row.dataset.i;
  const r = rows[i];

  if (r.site) {
    if (e.target.closest('.del')) {
      if (confirm(`Delete all ${r.tabs.length} tabs from ${r.site}?`)) removeKeys(r.tabs.map((t) => t.key));
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
  const id = item.dataset.id;
  current = /^\d+$/.test(id) ? +id : id;
  $('#q').value = '';
  resetPosition();
  recompute();
});

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

$('#sort').value = pref('sort', 'url');
$('#sort').onchange = () => {
  setPref('sort', $('#sort').value);
  lastClicked = -1;
  viewport.scrollTop = 0;
  recompute();
};

grouped = pref('grouped', '0') === '1';
$('#group').setAttribute('aria-pressed', grouped);
$('#group').onclick = () => {
  grouped = !grouped;
  setPref('grouped', grouped ? '1' : '0');
  $('#group').setAttribute('aria-pressed', grouped);
  lastClicked = -1;
  viewport.scrollTop = 0;
  buildRows();
};

$('#selAll').onclick = () => {
  view.forEach((t) => selected.add(t.key));
  render();
};
$('#selNone').onclick = () => {
  selected.clear();
  render();
};
$('#open').onclick = () => openUrls(base.filter((t) => selected.has(t.key)).map((t) => t.url));
$('#del').onclick = () => {
  if (confirm(`Delete ${selected.size} tabs from this list?`)) removeKeys([...selected]);
};

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
  if (!confirm(`Delete session "${session().name}"?`)) return;
  await db.deleteSession(current);
  current = 'month';
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
$('#file').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const { added, sessions } = data.collections ? await importSessionBuddy(data) : await db.importAll(data);
    if (added === undefined) return; // cancelled
    alert(`Imported ${n(added)} new tabs and ${sessions} sessions.`);
    load();
  } catch (err) {
    alert('Import failed: ' + err.message);
  }
};

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
