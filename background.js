import { captureOpenTabs, mergeIntoCommon, notifyChanged, exportAll, getMeta, setMeta, countTabs, getSessions } from './db.js';

const BACKUP_EVERY = 7 * 24 * 60 * 60 * 1000;
const KEEP_BACKUPS = 2;

// Clicking the icon saves every tab in every window, then shows the list.
chrome.action.onClicked.addListener(async () => {
  await saveAll();
  await openManager();
});

// Alt+Shift+S: save without switching to the list. Badge shows how many were new.
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'save-all') await saveAll();
});

async function saveAll() {
  const { added, dupes } = await mergeIntoCommon(await captureOpenTabs());
  await chrome.storage.session.set({ lastSave: { added, dupes, at: Date.now() } });
  notifyChanged();
  await chrome.action.setBadgeBackgroundColor({ color: '#2f7d4f' });
  await chrome.action.setBadgeText({ text: '+' + added });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000);
}

async function openManager() {
  const url = chrome.runtime.getURL('manager.html');
  const [tab] = await chrome.tabs.query({ url });
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

// ---------- weekly backup ----------
//
// Every 7 days a dated JSON file goes to Downloads/TabVault/. The newest two are kept;
// older ones are deleted. Only files this extension created (by download id) are ever
// deleted, so after a Chrome wipe your old backup files are left untouched.

chrome.runtime.onInstalled.addListener(() => chrome.alarms.create('backup-check', { periodInMinutes: 6 * 60 }));
chrome.runtime.onStartup.addListener(maybeBackup);
chrome.alarms.onAlarm.addListener((a) => a.name === 'backup-check' && maybeBackup());

chrome.runtime.onMessage.addListener((m, _sender, reply) => {
  if (m.type !== 'backup-now') return;
  runBackup().then(
    () => reply({ ok: true }),
    (e) => reply({ ok: false, error: e.message }),
  );
  return true;
});

async function maybeBackup() {
  const last = (await getMeta('lastBackup')) ?? 0;
  if (Date.now() - last < BACKUP_EVERY) return;
  // Nothing saved yet (fresh install or wiped Chrome): don't write an empty backup.
  if (!(await countTabs()) && !(await getSessions()).length) return;
  await runBackup();
}

async function runBackup() {
  const json = JSON.stringify(await exportAll());
  const url = await blobUrl(json);
  const stamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
  const id = await chrome.downloads.download({
    url,
    filename: `TabVault/tab-vault-backup-${stamp}.json`,
    saveAs: false,
    conflictAction: 'uniquify',
  });
  await waitForDownload(id);
  await chrome.offscreen.closeDocument().catch(() => {});

  const ids = [...((await getMeta('backupIds')) ?? []), id];
  while (ids.length > KEEP_BACKUPS) {
    const old = ids.shift();
    await chrome.downloads.removeFile(old).catch(() => {});
    await chrome.downloads.erase({ id: old }).catch(() => {});
  }
  await setMeta('backupIds', ids);
  await setMeta('lastBackup', Date.now());
  notifyChanged();
}

async function blobUrl(json) {
  if (!(await chrome.offscreen.hasDocument())) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Create a blob URL for the backup download',
    });
  }
  return chrome.runtime.sendMessage({ type: 'make-blob-url', json });
}

function waitForDownload(id) {
  return new Promise((resolve, reject) => {
    const listener = (d) => {
      if (d.id !== id || !d.state) return;
      if (d.state.current === 'in_progress') return;
      chrome.downloads.onChanged.removeListener(listener);
      d.state.current === 'complete' ? resolve() : reject(new Error('Backup download was interrupted'));
    };
    chrome.downloads.onChanged.addListener(listener);
  });
}
