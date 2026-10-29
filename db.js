// Storage layer. Everything lives in IndexedDB (fast, handles 100k+ rows,
// unlimited with the "unlimitedStorage" permission).
//
//   tabs     – the common list, keyed by dedup key, indexed by sort key
//   sessions – separately saved collections: { id, name, created, tabs: [...] }
//   archive, archivedSessions – everything ever backed up. Only ever grows, so a
//              backup never loses a link even after you delete it from the list.
//   meta     – small key/value settings (last backup time, backup download ids)

const DB_NAME = 'tab-vault';
let dbPromise;

function db() {
  return (dbPromise ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 2);
    r.onupgradeneeded = (e) => {
      const d = r.result;
      if (e.oldVersion < 1) {
        d.createObjectStore('tabs', { keyPath: 'key' }).createIndex('sortKey', 'sortKey');
        d.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
      }
      if (e.oldVersion < 2) {
        d.createObjectStore('archive', { keyPath: 'key' });
        d.createObjectStore('archivedSessions', { keyPath: 'created' });
        d.createObjectStore('meta');
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}

const done = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = tx.onabort = () => reject(tx.error);
  });

const result = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

async function store(name, mode = 'readonly') {
  const tx = (await db()).transaction(name, mode);
  return [tx.objectStore(name), tx];
}

// ---------- URL rules ----------

// Duplicates: same URL ignoring the #fragment, http vs https, and "www.".
export function dedupKey(url) {
  try {
    const u = new URL(url);
    // Keep the fragment where it identifies the page: Gmail messages and "#/route" or "#!route" apps.
    const routed = u.hostname === 'mail.google.com' || /^#[/!]/.test(u.hash);
    if (!routed) u.hash = '';
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return 'https://' + u.host.replace(/^www\./, '') + u.pathname + u.search + u.hash;
    }
    return u.href;
  } catch {
    return url;
  }
}

// Sort: by domain (ignoring scheme and "www."), then path and query.
export function sortKey(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    return (host ? host + u.pathname : u.protocol + u.pathname).toLowerCase() + u.search;
  } catch {
    return url.toLowerCase();
  }
}

export const bySortKey = (a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0);

function skip(url) {
  return (
    !url ||
    url === 'about:blank' ||
    url.startsWith('chrome://newtab') ||
    url.startsWith('chrome://new-tab-page') ||
    (globalThis.chrome?.runtime?.id && url.startsWith(chrome.runtime.getURL('')))
  );
}

// Turn raw tabs ({url, title}) into deduped, sorted entries.
export function prepare(tabs, now = Date.now()) {
  const map = new Map();
  for (const t of tabs) {
    if (skip(t.url)) continue;
    const key = dedupKey(t.url);
    if (!map.has(key)) {
      const added = t.added ?? now;
      // added = first saved, seen = last saved (re-saving an open tab refreshes it)
      map.set(key, { key, url: t.url, title: t.title || t.url, sortKey: sortKey(t.url), added, seen: t.seen ?? added });
    }
  }
  return [...map.values()].sort(bySortKey);
}

export async function captureOpenTabs({ currentWindowOnly = false } = {}) {
  const tabs = await chrome.tabs.query(currentWindowOnly ? { currentWindow: true } : {});
  return prepare(tabs);
}

// ---------- common list ----------

// Adds entries that aren't already present. Returns { added, dupes }.
// Links already present get their "last saved" time refreshed, which keeps them out of the Archive.
export const mergeIntoCommon = (entries) => mergeInto('tabs', entries, true);

async function mergeInto(storeName, entries, touch = false) {
  const [s, tx] = await store(storeName, 'readwrite');
  let added = 0;
  for (const e of entries) {
    s.get(e.key).onsuccess = (ev) => {
      const old = ev.target.result;
      if (!old) {
        s.put(e);
        added++;
      } else if (touch && e.seen > (old.seen ?? old.added)) {
        s.put({ ...old, seen: e.seen });
      }
    };
  }
  await done(tx);
  return { added, dupes: entries.length - added };
}

// Already sorted, because it's read through the sortKey index.
export async function getAllTabs() {
  const [s] = await store('tabs');
  return result(s.index('sortKey').getAll());
}

export async function countTabs() {
  const [s] = await store('tabs');
  return result(s.count());
}

export async function deleteTabs(keys) {
  const [s, tx] = await store('tabs', 'readwrite');
  for (const k of keys) s.delete(k);
  await done(tx);
}

// ---------- sessions ----------

export async function addSession(name, entries) {
  const [s, tx] = await store('sessions', 'readwrite');
  s.add({ name, created: Date.now(), tabs: entries });
  await done(tx);
}

export async function getSessions() {
  const [s] = await store('sessions');
  return (await result(s.getAll())).sort((a, b) => b.created - a.created);
}

export async function putSession(session) {
  const [s, tx] = await store('sessions', 'readwrite');
  s.put(session);
  await done(tx);
}

export async function deleteSession(id) {
  const [s, tx] = await store('sessions', 'readwrite');
  s.delete(id);
  await done(tx);
}

// ---------- meta ----------

export async function getMeta(key) {
  const [s] = await store('meta');
  return result(s.get(key));
}

export async function setMeta(key, value) {
  const [s, tx] = await store('meta', 'readwrite');
  s.put(value, key);
  await done(tx);
}

// ---------- backup ----------

// Union archived sessions with `list`, matching by creation time. Tabs are only added, never removed.
async function mergeArchivedSessions(list) {
  const [s] = await store('archivedSessions');
  const archived = new Map((await result(s.getAll())).map((a) => [a.created, a]));
  for (const { name, created, tabs } of list) {
    const old = archived.get(created);
    archived.set(created, { name, created, tabs: old ? prepare([...old.tabs, ...tabs]) : prepare(tabs) });
  }
  const [w, tx] = await store('archivedSessions', 'readwrite');
  for (const a of archived.values()) w.put(a);
  await done(tx);
  return [...archived.values()].sort((a, b) => b.created - a.created);
}

// Backup file: the live data (what you see) plus the archive (every link ever backed up).
// Folds the live data into the archive first, so each backup is a superset of the last.
export async function exportAll() {
  const [tabs, sessions] = await Promise.all([getAllTabs(), getSessions()]);
  await mergeInto('archive', prepare([...tabs, ...sessions.flatMap((s) => s.tabs)]));
  const archivedSessions = await mergeArchivedSessions(sessions);
  const [a] = await store('archive');
  const archiveTabs = (await result(a.getAll())).sort(bySortKey);
  return {
    app: 'tab-vault',
    version: 2,
    exported: new Date().toISOString(),
    tabs,
    sessions,
    archive: { tabs: archiveTabs, sessions: archivedSessions },
  };
}

// Merges a backup into the current data (never overwrites or removes anything).
export async function importAll(data) {
  if (data?.app !== 'tab-vault') throw new Error('Not a Tab Vault backup file');
  const { added } = await mergeIntoCommon(prepare(data.tabs ?? []));
  const existing = new Set((await getSessions()).map((s) => s.created));
  let sessions = 0;
  for (const s of data.sessions ?? []) {
    if (existing.has(s.created)) continue;
    const [st, tx] = await store('sessions', 'readwrite');
    st.add({ name: s.name, created: s.created, tabs: prepare(s.tabs ?? []) });
    await done(tx);
    sessions++;
  }
  if (data.archive) {
    await mergeInto('archive', prepare(data.archive.tabs ?? []));
    await mergeArchivedSessions(data.archive.sessions ?? []);
  }
  return { added, sessions };
}

export function notifyChanged() {
  chrome.runtime.sendMessage({ type: 'changed' }).catch(() => {});
}

// ---------- categories ----------

export const CATEGORIES = [
  ['search', 'Google Search'],
  ['youtube', 'YouTube'],
  ['linkedin', 'LinkedIn'],
  ['gmail', 'Gmail'],
  ['drive', 'Drive & Docs'],
  ['other', 'Other'],
];

export function siteOf(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') || u.protocol.replace(':', '');
  } catch {
    return url;
  }
}

export function category(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return 'other';
  }
  const h = u.hostname.replace(/^www\./, '');
  const is = (d) => h === d || h.endsWith('.' + d);
  if (/^google\.[a-z.]+$/.test(h) && u.pathname === '/search') return 'search';
  if (is('youtube.com') || h === 'youtu.be') return 'youtube';
  if (is('linkedin.com')) return 'linkedin';
  if (h === 'mail.google.com') return 'gmail';
  if (h === 'drive.google.com' || h === 'docs.google.com') return 'drive';
  return 'other';
}
