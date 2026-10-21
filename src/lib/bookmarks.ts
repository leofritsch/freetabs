import { db, type SavedTab } from './db';
import { importGroups, type ImportGroup, type ImportResult } from './mirror';
import { getSettings, type BackupStatus } from './settings';
import { normalizeUrl } from './url';

/**
 * Backup without files: the vault mirrored into Other bookmarks › FreeTabs.
 * Bookmarks belong to the browser profile, so they survive uninstalling
 * FreeTabs, follow Chrome Sync, show up in the address bar, and freetabs-mcp
 * reads them from Chrome's Bookmarks file. Incognito tabs are never written here.
 */
export const ROOT_TITLE = 'FreeTabs';
/** One bookmark at the top of the folder opens the board and carries what the MCP server needs. */
export const META_MARK = '#freetabs=';

type Node = chrome.bookmarks.BookmarkTreeNode;

interface Link {
  root?: string;
  /** FreeTabs folder id → bookmark folder id, so renames stay renames */
  folders: Record<string, string>;
  /** false until this vault has adopted (or set aside) whatever backup was already there */
  linked: boolean;
}

async function getLink(): Promise<Link> {
  const { bookmarkLink } = await chrome.storage.local.get('bookmarkLink');
  return { folders: {}, linked: false, ...(bookmarkLink as Partial<Link> | undefined) };
}
const setLink = (link: Link) => chrome.storage.local.set({ bookmarkLink: link });

async function otherBookmarks(): Promise<Node> {
  const [tree] = await chrome.bookmarks.getTree();
  const roots = tree.children ?? [];
  return roots.find((n) => n.folderType === 'other') ?? roots.find((n) => n.id === '2') ?? roots[roots.length - 1];
}

async function findRoot(link: Link): Promise<Node | undefined> {
  if (link.root) {
    const [node] = await chrome.bookmarks.getSubTree(link.root).catch(() => [] as Node[]);
    if (node && !node.url) return node;
  }
  const other = await otherBookmarks();
  const hit = other.children?.find((n) => !n.url && n.title === ROOT_TITLE);
  return hit ? (await chrome.bookmarks.getSubTree(hit.id))[0] : undefined;
}

const isMeta = (n: Node) => !!n.url?.includes(META_MARK);
const countLinks = (n: Node): number =>
  (n.children ?? []).reduce((sum, c) => sum + (c.url ? (isMeta(c) ? 0 : 1) : countLinks(c)), 0);

/** A backup already in bookmarks that this vault hasn't adopted yet (fresh install or reinstall). */
export async function pendingRestore(): Promise<{ tabs: number } | null> {
  const link = await getLink();
  if (link.linked) return null;
  const root = await findRoot(link);
  const tabs = root ? countLinks(root) : 0;
  return tabs ? { tabs } : null;
}

/** Bring a bookmarks backup into the vault, then keep that folder in sync from here on. */
export async function restoreFromBookmarks(): Promise<ImportResult> {
  const link = await getLink();
  const root = await findRoot(link);
  if (!root) return { folders: 0, tabs: 0, skipped: 0 };
  const groups: ImportGroup[] = (root.children ?? [])
    .filter((n) => !n.url)
    .map((f) => ({
      name: f.title,
      kind: f.title === 'Inbox' ? 'inbox' : 'user',
      tabs: (f.children ?? [])
        .filter((c) => c.url)
        .map((c) => ({ url: c.url!, title: c.title || c.url!, savedAt: c.dateAdded ?? Date.now(), incognito: false })),
    }));
  const result = await importGroups(groups);
  await setLink({ root: root.id, folders: {}, linked: true });
  return result;
}

/** Start fresh. The old backup is renamed and kept, never deleted. */
export async function setAsideOldBackup() {
  const link = await getLink();
  const root = await findRoot(link);
  if (root) {
    const day = new Date().toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
    await chrome.bookmarks.update(root.id, { title: `${ROOT_TITLE} (old backup, ${day})` });
  }
  await setLink({ folders: {}, linked: true });
}

let queue: Promise<unknown> = Promise.resolve();
/** Runs one sync at a time; overlapping requests wait their turn. */
export function syncBookmarks(): Promise<BackupStatus | null> {
  const run = queue.then(syncNow, syncNow);
  queue = run;
  return run;
}

async function syncNow(): Promise<BackupStatus | null> {
  const settings = await getSettings();
  if (!settings.bookmarkBackup) return null;
  const link = await getLink();
  let root = await findRoot(link);
  if (!link.linked) {
    // Never overwrite a backup this vault hasn't adopted: the board offers to restore it first.
    if (root && countLinks(root) > 0) return null;
    link.linked = true;
  }

  let status: BackupStatus;
  try {
    if (!root) {
      const other = await otherBookmarks();
      root = { ...(await chrome.bookmarks.create({ parentId: other.id, title: ROOT_TITLE })), children: [] };
    }
    link.root = root.id;
    const folders = (await db.folders.toArray()).filter((f) => f.kind !== 'trash').sort((a, b) => a.order - b.order);
    const tabs = await db.tabs.toArray();
    const children = root.children ?? [];
    const kept = new Set<string>();
    const hidden: Record<string, number> = {};
    let written = 0;

    for (const folder of folders) {
      const mine = tabs.filter((t) => t.folderId === folder.id);
      const shareable = mine.filter((t) => !t.incognito).sort((a, b) => a.savedAt - b.savedAt);
      if (shareable.length < mine.length) hidden[folder.name] = mine.length - shareable.length;
      let node =
        children.find((c) => !c.url && c.id === link.folders[folder.id]) ??
        children.find((c) => !c.url && c.title === folder.name && !kept.has(c.id));
      if (!node) {
        node = { ...(await chrome.bookmarks.create({ parentId: root.id, title: folder.name })), children: [] };
      } else if (node.title !== folder.name) {
        await chrome.bookmarks.update(node.id, { title: folder.name });
      }
      kept.add(node.id);
      link.folders[folder.id] = node.id;
      written += await syncFolder(node, shareable);
    }
    // A folder deleted in FreeTabs goes away here too (its tabs are in FreeTabs' Trash).
    for (const c of children) if (!c.url && !kept.has(c.id)) await chrome.bookmarks.removeTree(c.id);
    for (const id of Object.keys(link.folders)) if (!folders.some((f) => f.id === id)) delete link.folders[id];
    await writeMeta(root, hidden);
    await setLink(link);
    status = { at: Date.now(), ok: true, tabs: written };
  } catch (error) {
    status = { at: Date.now(), ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  await chrome.storage.local.set({ backupStatus: status });
  return status;
}

/** Make one bookmark folder match a FreeTabs folder: newest first, matched by URL. */
async function syncFolder(node: Node, tabs: SavedTab[]): Promise<number> {
  const existing = (node.children ?? []).filter((c) => c.url);
  const byKey = new Map<string, Node[]>();
  for (const c of existing) {
    const key = normalizeUrl(c.url!);
    byKey.set(key, [...(byKey.get(key) ?? []), c]);
  }
  const keep = new Set<string>();
  for (const tab of tabs) {
    const match = byKey.get(tab.key)?.shift();
    if (match) {
      keep.add(match.id);
      if (match.title !== tab.title) await chrome.bookmarks.update(match.id, { title: tab.title });
      continue;
    }
    try {
      keep.add((await chrome.bookmarks.create({ parentId: node.id, title: tab.title, url: tab.url, index: 0 })).id);
    } catch {
      // A URL bookmarks refuse (javascript:, some browser pages) stays only in the vault.
    }
  }
  for (const c of existing) if (!keep.has(c.id)) await chrome.bookmarks.remove(c.id);
  return keep.size;
}

async function writeMeta(root: Node, hidden: Record<string, number>) {
  const url = `${chrome.runtime.getURL('board.html')}${META_MARK}${encodeURIComponent(JSON.stringify({ v: 1, hidden }))}`;
  const metas = (root.children ?? []).filter(isMeta);
  const [meta, ...extra] = metas;
  if (!meta) await chrome.bookmarks.create({ parentId: root.id, index: 0, title: 'Open FreeTabs', url });
  else if (meta.url !== url) await chrome.bookmarks.update(meta.id, { url });
  for (const m of extra) await chrome.bookmarks.remove(m.id);
}
