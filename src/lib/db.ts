import Dexie, { type EntityTable } from 'dexie';
import type { GroupMeta } from './groups';

export type FolderKind = 'inbox' | 'trash' | 'user';

export interface Folder {
  id: string;
  name: string;
  kind: FolderKind;
  color: string | null;
  order: number;
  createdAt: number;
  updatedAt: number;
}

export interface SavedTab {
  id: string;
  folderId: string;
  url: string;
  /** normalizeUrl(url), the dedupe key within a folder */
  key: string;
  title: string;
  savedAt: number;
  incognito: boolean;
  pinned?: boolean;
  sourceWindowId?: number;
  note?: string;
  /** set while in Trash */
  trashedAt?: number;
  /** where a trashed tab came from, for restoring it */
  fromFolderId?: string;
  fromFolderName?: string;
  /** the Chrome tab group it was in, recreated when it's restored */
  group?: GroupMeta;
}

/** Where a live tab sat before it was closed, so undo can put it back. */
export interface Origin {
  tabId?: number;
  windowId: number;
  index: number;
  url: string;
  pinned: boolean;
  incognito: boolean;
  group?: GroupMeta;
}

export interface SnapshotWindow {
  id: number;
  incognito: boolean;
  tabs: { url: string; title: string; pinned: boolean }[];
}

export interface Snapshot {
  id: string;
  createdAt: number;
  reason: string;
  windows: SnapshotWindow[];
}

/** The inverse of an operation. Undo applies it field by field. */
export interface Inverse {
  reopen?: Origin[];
  removeTabIds?: string[];
  putTabs?: SavedTab[];
  putFolders?: Folder[];
  removeFolderIds?: string[];
  moveLive?: { tabId: number; windowId: number; index: number }[];
  moveGroups?: { groupId: number; windowId: number; index: number }[];
  ungroup?: number[];
}

export interface Op {
  id: string;
  createdAt: number;
  label: string;
  /** 'closing' means saved and verified, tabs not yet confirmed closed */
  status: 'closing' | 'done' | 'undone';
  inverse: Inverse;
  /** live tab ids this op closes; used to finish an interrupted close */
  closeTabIds?: number[];
}

export const INBOX_ID = 'inbox';
export const TRASH_ID = 'trash';
export const TRASH_DAYS = 30;
export const SNAPSHOTS_KEPT = 20;
export const OPS_KEPT = 50;

export class VaultDB extends Dexie {
  folders!: EntityTable<Folder, 'id'>;
  tabs!: EntityTable<SavedTab, 'id'>;
  snapshots!: EntityTable<Snapshot, 'id'>;
  ops!: EntityTable<Op, 'id'>;

  constructor(name = 'freetabs') {
    super(name);
    this.version(1).stores({
      folders: 'id, kind, order',
      tabs: 'id, folderId, [folderId+key], savedAt, trashedAt',
      snapshots: 'id, createdAt',
      ops: 'id, createdAt, status',
    });
    // v2: newest-first per folder for the Saved view, and two starter folders.
    this.version(2)
      .stores({ tabs: 'id, folderId, [folderId+key], [folderId+savedAt], savedAt, trashedAt' })
      .upgrade(async (tx) => {
        const folders = tx.table<Folder, string>('folders');
        const names = new Set((await folders.toArray()).map((f) => f.name.toLowerCase()));
        await folders.bulkAdd(starterFolders(Date.now()).filter((f) => !names.has(f.name.toLowerCase())));
      });
    this.on('populate', (tx) => {
      const now = Date.now();
      tx.table('folders').bulkAdd([...systemFolders(now), ...starterFolders(now)]);
    });
  }
}

export function systemFolders(now: number): Folder[] {
  return [
    { id: INBOX_ID, name: 'Inbox', kind: 'inbox', color: null, order: -2, createdAt: now, updatedAt: now },
    { id: TRASH_ID, name: 'Trash', kind: 'trash', color: null, order: -1, createdAt: now, updatedAt: now },
  ];
}

/** Regular folders every vault starts with; renamable and deletable like any other. */
export function starterFolders(now: number): Folder[] {
  return [
    { id: 'watch-later', name: 'Watch later', kind: 'user', color: null, order: 1, createdAt: now, updatedAt: now },
    { id: 'read-later', name: 'Read later', kind: 'user', color: null, order: 2, createdAt: now, updatedAt: now },
  ];
}

export const db = new VaultDB();

export const uid = () => crypto.randomUUID();
