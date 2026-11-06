import { AI_LINK_ALARM, connectAiLink, disconnectAiLink } from './lib/ailink';
import { db, INBOX_ID } from './lib/db';
import { syncBookmarks } from './lib/bookmarks';
import { beamFrames, INK, type BeamFrame } from './lib/icon';
import { getSettings } from './lib/settings';
import { isNewTabUrl } from './lib/url';
import { ensureSystemFolders, onVaultChange, purgeTrash, saveAndClose } from './lib/vault';

const BOARD_URL = chrome.runtime.getURL('board.html');
const MENU_ROOT = 'freetabs-save';
const tabUrl = (t: chrome.tabs.Tab) => t.pendingUrl || t.url || '';
/** Chrome reports a new tab as chrome://newtab/ even when the board is what it shows. Incognito keeps Chrome's default. */
const isBoard = (t: chrome.tabs.Tab) => tabUrl(t).startsWith(BOARD_URL) || (!t.incognito && tabUrl(t).startsWith('chrome://newtab'));

/** Tabs really showing the board, whichever extension's page chrome://newtab/ happens to be. */
async function boardTabIds() {
  const pages = await chrome.runtime.getContexts({ contextTypes: ['TAB' as chrome.runtime.ContextType], documentUrls: [BOARD_URL] });
  return new Set(pages.map((p) => p.tabId));
}

/**
 * Go to the board: the one in this window if there is one, otherwise a new tab beside the current one.
 * With new tabs off there's only ever one board, so it's focused wherever it is. An incognito window can't
 * hold the board, so it opens in a normal window, and pressing again goes back to that one.
 */
async function openBoard() {
  const { newTab } = await getSettings();
  const [current] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const ids = await boardTabIds();
  // Match patterns can't express chrome-extension:// URLs, so filter by hand.
  const boards = (await chrome.tabs.query({})).filter((t) => ids.has(t.id!));
  const openHere = !!current && !current.incognito;
  const existing = boards.find((t) => t.windowId === current?.windowId) ?? (newTab && openHere ? undefined : boards[0]);
  if (existing?.id != null) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
    return;
  }
  if (!openHere) {
    const tab = await chrome.tabs.create({ url: BOARD_URL });
    await chrome.windows.update(tab.windowId, { focused: true });
    return;
  }
  const tab = await chrome.tabs.create({ url: newTab ? 'chrome://newtab/' : BOARD_URL, windowId: current.windowId, index: current.index + 1 });
  if (!newTab || tab.id == null) return;
  // Another extension may hold the new tab page. The button still has to lead to the board.
  await new Promise((done) => setTimeout(done, 500));
  const opened = await chrome.tabs.get(tab.id).catch(() => undefined);
  if (opened && isNewTabUrl(tabUrl(opened)) && !(await boardTabIds()).has(tab.id)) await chrome.tabs.update(tab.id, { url: BOARD_URL });
}

// ---------- backup: mirror the vault into bookmarks shortly after each change ----------
let backupTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleBackup() {
  clearTimeout(backupTimer);
  backupTimer = setTimeout(() => void syncBookmarks(), 1500);
  // In case the worker sleeps before the timer fires.
  chrome.alarms.create('backup', { delayInMinutes: 1 });
  scheduleMenus();
}
onVaultChange(scheduleBackup);

// ---------- toolbar icon: open-tab count, red and pulsing above the limit ----------
let frames: BeamFrame[] | undefined;
let beamTimer: ReturnType<typeof setInterval> | undefined;
let frame = 0;

function startBeam() {
  if (beamTimer) return;
  frames ??= beamFrames();
  chrome.action.setBadgeTextColor({ color: '#ffffff' });
  // Each icon update also keeps the worker awake while it pulses.
  beamTimer = setInterval(() => {
    const f = frames![frame++ % frames!.length];
    chrome.action.setIcon({ imageData: f.icon as Record<string, ImageData> });
    chrome.action.setBadgeBackgroundColor({ color: f.badge });
  }, 110);
}

async function stopBeam() {
  if (!beamTimer) return;
  clearInterval(beamTimer);
  beamTimer = undefined;
  await chrome.action.setIcon({ path: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' } });
}

async function refreshBadge() {
  const settings = await getSettings();
  // Includes incognito tabs once FreeTabs is allowed in incognito.
  const count = (await chrome.tabs.query({})).filter((t) => !isBoard(t) && !isNewTabUrl(tabUrl(t))).length;
  const over = settings.tabLimit > 0 && count > settings.tabLimit;
  if (!settings.badge) {
    await stopBeam();
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: 'Open FreeTabs' });
    return;
  }
  await chrome.action.setBadgeText({ text: count > 999 ? '999+' : String(count) });
  await chrome.action.setTitle({
    title: over
      ? `${count} open tabs, over your limit of ${settings.tabLimit}. Click to clean up.`
      : `${count} open tabs. Open FreeTabs`,
  });
  if (over) return startBeam();
  await stopBeam();
  await chrome.action.setBadgeBackgroundColor({ color: INK });
  await chrome.action.setBadgeTextColor({ color: '#ede8df' });
}

let badgeTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleBadge() {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => void refreshBadge(), 150);
  // A good moment to look for an AI app too (at most every 10 seconds).
  void connectAiLink();
}
for (const event of [
  chrome.tabs.onCreated,
  chrome.tabs.onRemoved,
  chrome.tabs.onReplaced,
  chrome.windows.onCreated,
  chrome.windows.onRemoved,
] as unknown as chrome.events.Event<() => void>[]) {
  event.addListener(scheduleBadge);
}
// New tabs don't count, so a new tab that goes somewhere changes the count.
chrome.tabs.onUpdated.addListener((_id, change) => {
  if (change.url) scheduleBadge();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  scheduleBadge();
  const before = (changes.settings.oldValue as { aiLink?: boolean } | undefined)?.aiLink ?? true;
  const after = (changes.settings.newValue as { aiLink?: boolean } | undefined)?.aiLink ?? true;
  if (before !== after) void setAiLink(after);
});
// The worker may have been asleep: catch up (and resume pulsing) whenever it starts.
scheduleBadge();

// ---------- AI link: freetabs-mcp on this computer ----------
async function setAiLink(on: boolean) {
  if (!on) {
    disconnectAiLink();
    await chrome.alarms.clear(AI_LINK_ALARM);
    return;
  }
  if ((await chrome.storage.local.get('aiLinkSeen')).aiLinkSeen) chrome.alarms.create(AI_LINK_ALARM, { periodInMinutes: 0.5 });
  await connectAiLink({ force: true });
}
void connectAiLink({ force: true });

// ---------- right-click menu ----------
let menuTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleMenus() {
  clearTimeout(menuTimer);
  menuTimer = setTimeout(buildMenus, 300);
}

/** Right-click on any page: "Save tab to FreeTabs" › Inbox, then every folder. */
async function buildMenus() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: MENU_ROOT, title: 'Save tab to FreeTabs', contexts: ['page', 'action'] });
  chrome.contextMenus.create({ id: `folder:${INBOX_ID}`, parentId: MENU_ROOT, title: 'Inbox', contexts: ['page', 'action'] });
  const folders = await db.folders.where('kind').equals('user').toArray();
  folders.sort((a, b) => a.order - b.order);
  if (folders.length) {
    chrome.contextMenus.create({ id: 'sep', parentId: MENU_ROOT, type: 'separator', contexts: ['page', 'action'] });
    for (const f of folders.slice(0, 30)) {
      chrome.contextMenus.create({ id: `folder:${f.id}`, parentId: MENU_ROOT, title: f.name.replace(/&/g, '&&'), contexts: ['page', 'action'] });
    }
  }
}

async function saveSingle(tab: chrome.tabs.Tab | undefined, folderId: string) {
  if (!tab || isBoard(tab)) return;
  try {
    await saveAndClose([tab], { folderId });
  } catch (error) {
    console.warn('[FreeTabs] save failed', error);
  }
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await ensureSystemFolders();
  await buildMenus();
  chrome.alarms.create('purge', { periodInMinutes: 360 });
  scheduleBackup();
  if (reason === 'install') await chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureSystemFolders();
  await buildMenus();
  await purgeTrash();
});

chrome.action.onClicked.addListener(() => void openBoard());

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === 'open-board') return openBoard();
  if (command === 'save-current-tab') {
    const active = tab ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    return saveSingle(active, INBOX_ID);
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const id = String(info.menuItemId);
  if (id.startsWith('folder:')) await saveSingle(tab, id.slice('folder:'.length));
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'backup') await syncBookmarks();
  if (alarm.name === 'purge') await purgeTrash();
  if (alarm.name === AI_LINK_ALARM) await connectAiLink({ force: true });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'vault-changed') {
    scheduleBackup();
    return;
  }
  if (message?.type === 'backup-now') {
    syncBookmarks().then(sendResponse);
    return true;
  }
  // Someone just set up the MCP from FreeTabs: start looking for it right away, and keep looking.
  if (message?.type === 'ai-link-wanted') {
    chrome.storage.local.set({ aiLinkSeen: true }).then(() => setAiLink(true));
  }
});
