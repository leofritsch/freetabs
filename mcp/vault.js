import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/** What an AI sees in place of a tab saved from an incognito window. */
export const INCOGNITO_PLACEHOLDER = '<incognito link>';

const HIDDEN_NOTE =
  'They were saved from incognito windows, and incognito tabs never leave the user’s browser, so they are hidden from AI on purpose. The user can still open them in FreeTabs.';

/**
 * Where the vault comes from, read fresh on every call:
 * - FREETABS_VAULT: a JSON backup exported from FreeTabs › Settings › Export
 * - otherwise the FreeTabs folder FreeTabs keeps in your browser's bookmarks
 *   (FREETABS_BOOKMARKS can point at a specific profile's Bookmarks file)
 */
export async function load() {
  if (process.env.FREETABS_VAULT) return loadVault(process.env.FREETABS_VAULT);
  const file = process.env.FREETABS_BOOKMARKS || (await findBookmarksFile());
  if (!file) {
    throw new Error(
      'No FreeTabs backup found in your browser’s bookmarks. In FreeTabs, open Settings and turn on “Back up to Chrome bookmarks”. ' +
        'Using another profile or browser? Set FREETABS_BOOKMARKS to that profile’s Bookmarks file.',
    );
  }
  return loadFromBookmarks(file);
}

/** A JSON backup exported from FreeTabs. */
export async function loadVault(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`No FreeTabs backup found at ${file}.`);
    throw error;
  }
  const vault = JSON.parse(text);
  if (vault.app !== 'FreeTabs' || !Array.isArray(vault.folders) || !Array.isArray(vault.tabs)) {
    throw new Error(`${file} is not a FreeTabs backup.`);
  }
  return vault;
}

// ---------- reading the bookmarks backup ----------

const META_MARK = '#freetabs=';
/** Chrome stores times as microseconds since 1601. */
const fromChromeTime = (value) => (value ? Number(BigInt(value) / 1000n) - 11644473600000 : 0);

function browserDirs() {
  const home = homedir();
  if (process.platform === 'darwin') {
    const base = path.join(home, 'Library', 'Application Support');
    return ['Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome Canary', 'Chromium', 'BraveSoftware/Brave-Browser', 'Microsoft Edge', 'Arc/User Data', 'Vivaldi'].map(
      (d) => path.join(base, d),
    );
  }
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return ['Google/Chrome/User Data', 'Chromium/User Data', 'BraveSoftware/Brave-Browser/User Data', 'Microsoft/Edge/User Data', 'Vivaldi/User Data'].map((d) =>
      path.join(base, d),
    );
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return ['google-chrome', 'google-chrome-beta', 'chromium', 'BraveSoftware/Brave-Browser', 'microsoft-edge', 'vivaldi'].map((d) => path.join(base, d));
}

/** The FreeTabs folder: the one holding the "Open FreeTabs" bookmark FreeTabs writes. */
function findFreeTabsFolder(node, depth = 0) {
  if (!node?.children || depth > 3) return null;
  if (node.type === 'folder' && node.children.some((c) => c.type === 'url' && c.url?.includes(META_MARK))) return node;
  for (const child of node.children) {
    const hit = findFreeTabsFolder(child, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** Every browser profile with a FreeTabs folder; the most recently changed wins. */
export async function findBookmarksFile(dirs = browserDirs()) {
  let best = null;
  for (const dir of dirs) {
    const profiles = await readdir(dir).catch(() => []);
    for (const profile of profiles.filter((p) => p === 'Default' || /^Profile \d+$/.test(p))) {
      const file = path.join(dir, profile, 'Bookmarks');
      try {
        const json = JSON.parse(await readFile(file, 'utf8'));
        if (!Object.values(json.roots ?? {}).some((root) => findFreeTabsFolder(root))) continue;
        const { mtimeMs } = await stat(file);
        if (!best || mtimeMs > best.mtimeMs) best = { file, mtimeMs };
      } catch {
        // no Bookmarks file in this profile
      }
    }
  }
  return best?.file ?? null;
}

/** Turn the bookmarks backup into the same shape as a JSON export. */
export async function loadFromBookmarks(file) {
  const json = JSON.parse(await readFile(file, 'utf8'));
  const root = Object.values(json.roots ?? {})
    .map((r) => findFreeTabsFolder(r))
    .find(Boolean);
  if (!root) throw new Error(`${file} has no FreeTabs folder.`);
  const metaUrl = root.children.find((c) => c.type === 'url' && c.url.includes(META_MARK)).url;
  let meta = {};
  try {
    meta = JSON.parse(decodeURIComponent(metaUrl.slice(metaUrl.indexOf(META_MARK) + META_MARK.length)));
  } catch {
    // an older or edited marker: no hidden counts
  }
  const folders = [];
  const tabs = [];
  for (const node of root.children.filter((c) => c.type === 'folder')) {
    const links = (node.children ?? []).filter((c) => c.type === 'url');
    const id = `bm-${node.id}`;
    const updatedAt = Math.max(fromChromeTime(node.date_added), ...links.map((l) => fromChromeTime(l.date_added)));
    folders.push({ id, name: node.name, kind: node.name === 'Inbox' ? 'inbox' : 'user', updatedAt });
    for (const l of links) {
      tabs.push({ id: `bm-${l.id}`, folderId: id, url: l.url, title: l.name, savedAt: fromChromeTime(l.date_added), incognito: false });
    }
    // Incognito tabs never reach bookmarks; FreeTabs only says how many there are.
    for (let i = 0; i < (meta.hidden?.[node.name] ?? 0); i++) {
      tabs.push({ id: `${id}-hidden-${i}`, folderId: id, url: '', title: '', savedAt: 0, incognito: true });
    }
  }
  const { mtimeMs } = await stat(file);
  return { app: 'FreeTabs', format: 1, exportedAt: new Date(mtimeMs).toISOString(), ai: { seesIncognito: false }, folders, tabs };
}

// ---------- formatting for the model ----------

const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const domainOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};
const canSee = (vault, tab) => !tab.incognito || vault.ai?.seesIncognito === true;

/**
 * Live from FreeTabs, tabs carry ids the write tools accept. The first 8
 * characters are plenty; the rare clash gets the full id.
 */
const shortIds = new WeakMap();
function shortId(vault, tab) {
  if (!vault.live || !tab.id) return '';
  let map = shortIds.get(vault);
  if (!map) {
    const counts = new Map();
    for (const t of vault.tabs) if (t.id) counts.set(t.id.slice(0, 8), (counts.get(t.id.slice(0, 8)) ?? 0) + 1);
    map = new Map(vault.tabs.filter((t) => t.id).map((t) => [t.id, counts.get(t.id.slice(0, 8)) > 1 ? t.id : t.id.slice(0, 8)]));
    shortIds.set(vault, map);
  }
  return map.get(tab.id) ?? '';
}
const isTrash = (vault, tab) => vault.folders.find((f) => f.id === tab.folderId)?.kind === 'trash';
const folderName = (vault, id) => vault.folders.find((f) => f.id === id)?.name ?? 'Unknown folder';

function line(vault, tab, { withFolder = false } = {}) {
  const visible = canSee(vault, tab);
  const meta = [
    withFolder && folderName(vault, tab.folderId),
    visible && domainOf(tab.url),
    tab.savedAt > 0 && `saved ${day(tab.savedAt)}`,
    visible && shortId(vault, tab) && `id ${shortId(vault, tab)}`,
  ]
    .filter(Boolean)
    .join(', ');
  if (!visible) return `- ${INCOGNITO_PLACEHOLDER} (${meta})`;
  const note = tab.note ? ` Note: ${tab.note}` : '';
  return `- [${tab.title || tab.url}](${tab.url}) (${meta})${note}`;
}

function hiddenFooter(count) {
  return count ? `\n\n${count} ${count === 1 ? 'tab is' : 'tabs are'} shown as ${INCOGNITO_PLACEHOLDER}. ${HIDDEN_NOTE}` : '';
}

export function listFolders(vault) {
  const rows = vault.folders.map((f) => {
    const tabs = vault.tabs.filter((t) => t.folderId === f.id);
    const hidden = tabs.filter((t) => !canSee(vault, t)).length;
    const extra = [
      f.kind === 'inbox' ? 'unsorted saves' : f.kind === 'trash' ? 'closed tabs, kept 30 days' : '',
      hidden ? `${hidden} hidden incognito` : '',
    ]
      .filter(Boolean)
      .join(', ');
    return `- ${f.name}: ${tabs.length} ${tabs.length === 1 ? 'tab' : 'tabs'}, last saved ${day(f.updatedAt)}${extra ? ` (${extra})` : ''}`;
  });
  const source = vault.live ? 'live from FreeTabs' : `from the bookmarks backup, updated ${vault.exportedAt}`;
  return `FreeTabs folders (${source}):\n${rows.join('\n')}`;
}

export function findFolder(vault, query) {
  const q = String(query).trim().toLowerCase();
  return (
    vault.folders.find((f) => f.id === query) ??
    vault.folders.find((f) => f.name.toLowerCase() === q) ??
    vault.folders.find((f) => f.name.toLowerCase().includes(q))
  );
}

export function getFolder(vault, query) {
  const folder = findFolder(vault, query);
  if (!folder) {
    throw new Error(`No folder called “${query}”. Folders: ${vault.folders.map((f) => f.name).join(', ')}.`);
  }
  const tabs = vault.tabs.filter((t) => t.folderId === folder.id).sort((a, b) => b.savedAt - a.savedAt);
  const hidden = tabs.filter((t) => !canSee(vault, t)).length;
  const body = tabs.length ? tabs.map((t) => line(vault, t)).join('\n') : '(empty)';
  return `${folder.name}: ${tabs.length} ${tabs.length === 1 ? 'tab' : 'tabs'}\n\n${body}${hiddenFooter(hidden)}`;
}

/** Every word must appear in the title or URL. Hidden tabs never match, and Trash is skipped. */
export function searchTabs(vault, query, limit = 25) {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  const hits = vault.tabs
    .filter((t) => !isTrash(vault, t) && canSee(vault, t))
    .filter((t) => words.every((w) => `${t.title} ${t.url}`.toLowerCase().includes(w)))
    .sort((a, b) => b.savedAt - a.savedAt);
  if (!hits.length) return `No saved tabs match “${query}”.`;
  const shown = hits.slice(0, limit);
  return `${hits.length} saved ${hits.length === 1 ? 'tab matches' : 'tabs match'} “${query}”${hits.length > limit ? ` (showing ${limit})` : ''}:\n\n${shown
    .map((t) => line(vault, t, { withFolder: true }))
    .join('\n')}`;
}

export function recentTabs(vault, { limit = 20, days } = {}) {
  const since = days ? Date.now() - days * 86400000 : 0;
  const tabs = vault.tabs
    .filter((t) => !isTrash(vault, t) && t.savedAt > 0 && t.savedAt >= since)
    .sort((a, b) => b.savedAt - a.savedAt)
    .slice(0, limit);
  if (!tabs.length) return days ? `Nothing saved in the last ${days} days.` : 'Nothing saved yet.';
  const hidden = tabs.filter((t) => !canSee(vault, t)).length;
  return `Most recently saved tabs:\n\n${tabs.map((t) => line(vault, t, { withFolder: true })).join('\n')}${hiddenFooter(hidden)}`;
}
