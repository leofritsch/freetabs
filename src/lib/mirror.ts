import { db, INBOX_ID, TRASH_ID, uid, type Folder, type SavedTab } from './db';
import { parseOneTab } from './export';
import { getSettings } from './settings';
import { normalizeUrl } from './url';
import { nextFolderOrder } from './vault';

/** The whole vault as one JSON file: the manual export, re-importable, also readable by freetabs-mcp. */
export interface MirrorFile {
  app: 'FreeTabs';
  format: 1;
  exportedAt: string;
  /** read by freetabs-mcp from an exported file: incognito tabs stay hidden unless this is true */
  ai: { seesIncognito: boolean };
  folders: Pick<Folder, 'id' | 'name' | 'kind' | 'color' | 'createdAt' | 'updatedAt'>[];
  tabs: Pick<SavedTab, 'id' | 'folderId' | 'url' | 'title' | 'savedAt' | 'incognito' | 'pinned' | 'note' | 'trashedAt'>[];
}

export async function buildMirror({ includeIncognito }: { includeIncognito: boolean }): Promise<MirrorFile> {
  const settings = await getSettings();
  const [folders, tabs] = await Promise.all([db.folders.orderBy('order').toArray(), db.tabs.toArray()]);
  return {
    app: 'FreeTabs',
    format: 1,
    exportedAt: new Date().toISOString(),
    ai: { seesIncognito: settings.aiSeesIncognito },
    folders: folders.map(({ id, name, kind, color, createdAt, updatedAt }) => ({ id, name, kind, color, createdAt, updatedAt })),
    tabs: tabs
      .filter((t) => includeIncognito || !t.incognito)
      .sort((a, b) => b.savedAt - a.savedAt)
      .map(({ id, folderId, url, title, savedAt, incognito, pinned, note, trashedAt }) => ({
        id,
        folderId,
        url,
        title,
        savedAt,
        incognito,
        ...(pinned ? { pinned } : {}),
        ...(note ? { note } : {}),
        ...(trashedAt ? { trashedAt } : {}),
      })),
  };
}

export interface ImportResult {
  folders: number;
  tabs: number;
  skipped: number;
}

export interface ImportGroup {
  name: string;
  kind: Folder['kind'];
  color?: string | null;
  tabs: Omit<SavedTab, 'id' | 'folderId' | 'key'>[];
}

/** Import a FreeTabs JSON file or OneTab's export text. Merges by folder name and URL. */
export async function importText(text: string): Promise<ImportResult> {
  let incoming: ImportGroup[];
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    const file = JSON.parse(trimmed) as MirrorFile;
    if (file.app !== 'FreeTabs' || !Array.isArray(file.folders) || !Array.isArray(file.tabs)) {
      throw new Error('This file is not a FreeTabs backup.');
    }
    incoming = file.folders.map((f) => ({
      name: f.name,
      kind: f.kind,
      color: f.color,
      tabs: file.tabs
        .filter((t) => t.folderId === f.id)
        .map(({ url, title, savedAt, incognito, pinned, note, trashedAt }) => ({ url, title, savedAt, incognito, pinned, note, trashedAt })),
    }));
  } else {
    const groups = parseOneTab(trimmed);
    if (!groups.length) throw new Error('No links found. Paste a FreeTabs backup or OneTab’s “Export URLs” text.');
    const now = Date.now();
    incoming = groups.map((g) => ({
      name: g.name,
      kind: 'user' as const,
      tabs: g.tabs.map((t) => ({ url: t.url, title: t.title, savedAt: now, incognito: false })),
    }));
  }

  return importGroups(incoming);
}

/** Merge folders into the vault: same-named folders merge, URLs already in a folder are skipped. */
export async function importGroups(incoming: ImportGroup[]): Promise<ImportResult> {
  const result: ImportResult = { folders: 0, tabs: 0, skipped: 0 };
  const now = Date.now();
  let order = await nextFolderOrder();
  await db.transaction('rw', [db.folders, db.tabs], async () => {
    const existing = await db.folders.toArray();
    for (const group of incoming) {
      let folder =
        group.kind === 'inbox'
          ? existing.find((f) => f.id === INBOX_ID)
          : group.kind === 'trash'
            ? existing.find((f) => f.id === TRASH_ID)
            : existing.find((f) => f.kind === 'user' && f.name.toLowerCase() === group.name.toLowerCase());
      if (!folder) {
        folder = { id: uid(), name: group.name, kind: 'user', color: group.color ?? null, order: order++, createdAt: now, updatedAt: now };
        await db.folders.add(folder);
        existing.push(folder);
        result.folders++;
      }
      for (const tab of group.tabs) {
        const key = normalizeUrl(tab.url);
        if (await db.tabs.where('[folderId+key]').equals([folder.id, key]).first()) {
          result.skipped++;
          continue;
        }
        const record: SavedTab = { ...tab, id: uid(), folderId: folder.id, key, title: tab.title || tab.url };
        if (folder.id === TRASH_ID && !record.trashedAt) record.trashedAt = now;
        await db.tabs.add(record);
        result.tabs++;
      }
      await db.folders.update(folder.id, { updatedAt: now });
    }
  });
  return result;
}
