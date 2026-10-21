import {
  db,
  uid,
  INBOX_ID,
  TRASH_ID,
  TRASH_DAYS,
  SNAPSHOTS_KEPT,
  OPS_KEPT,
  type Folder,
  type Inverse,
  type Op,
  type Origin,
  type SavedTab,
  type Snapshot,
} from './db';
import { groupMeta, ids as tabIds, nextColor, NO_GROUP, regroup, type GroupColor, type GroupMeta } from './groups';
import { findTypedTabs } from './typed';
import { isBlankUrl, normalizeUrl, suggestFolderName } from './url';

/**
 * The vault: every write that touches saved tabs goes through here.
 * The rule: write, verify, then close. If anything fails, tabs stay open.
 */

type LiveTab = chrome.tabs.Tab;

let notify: () => void = () => {};
/** Called after every committed change (the board pings the worker, the worker schedules a backup). */
export function onVaultChange(fn: () => void) {
  notify = fn;
}

export class SaveError extends Error {}

export type Target = { folderId: string } | { newFolderName: string };

export interface SaveResult {
  opId: string;
  folder: Folder;
  saved: number;
  merged: number;
  closed: number;
  /** tabs left open because they hold unsaved work ("Leave site?" or typed text); they're saved too */
  stillOpen: number[];
}

export const liveUrl = (tab: LiveTab) => tab.url || tab.pendingUrl || '';

const isBoardUrl = (url: string) => url.startsWith(chrome.runtime.getURL('board.html'));

export async function nextFolderOrder(): Promise<number> {
  const last = await db.folders.orderBy('order').last();
  return Math.max(Date.now(), (last?.order ?? 0) + 1);
}

async function resolveTarget(target: Target, now: number): Promise<{ folder: Folder; isNew: boolean }> {
  if ('folderId' in target) {
    const folder = await db.folders.get(target.folderId);
    if (!folder) throw new SaveError('That folder no longer exists.');
    return { folder, isNew: false };
  }
  const folder: Folder = {
    id: uid(),
    name: target.newFolderName.trim() || 'New folder',
    kind: 'user',
    color: null,
    order: await nextFolderOrder(),
    createdAt: now,
    updatedAt: now,
  };
  return { folder, isNew: true };
}

export async function takeSnapshot(reason: string, now = Date.now()): Promise<Snapshot> {
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  return {
    id: uid(),
    createdAt: now,
    reason,
    windows: windows.map((w) => ({
      id: w.id!,
      incognito: w.incognito,
      tabs: (w.tabs ?? []).map((t) => ({ url: liveUrl(t), title: t.title ?? '', pinned: t.pinned })),
    })),
  };
}

async function pruneHistory() {
  const snapshotIds = await db.snapshots.orderBy('createdAt').reverse().offset(SNAPSHOTS_KEPT).primaryKeys();
  if (snapshotIds.length) await db.snapshots.bulkDelete(snapshotIds);
  const opIds = await db.ops.orderBy('createdAt').reverse().offset(OPS_KEPT).primaryKeys();
  if (opIds.length) await db.ops.bulkDelete(opIds);
}

/**
 * Save live tabs into a folder, verify the write by reading it back, then close them.
 * Blank tabs are closed without being saved (undo still reopens them).
 */
export async function saveAndClose(tabs: LiveTab[], target: Target, label?: string): Promise<SaveResult> {
  const now = Date.now();
  const live = tabs.filter((t) => t.id != null && t.id !== chrome.tabs.TAB_ID_NONE && !isBoardUrl(liveUrl(t)));
  if (!live.length) throw new SaveError('There are no tabs to save.');

  const snapshot = await takeSnapshot('before save', now);
  const groups = await groupMeta();
  const groupOf = (t: LiveTab) => (t.groupId != null && t.groupId !== NO_GROUP ? groups.get(t.groupId) : undefined);
  const { folder, isNew } = await resolveTarget(target, now);
  const toTrash = folder.id === TRASH_ID;
  const saveable = live.filter((t) => !isBlankUrl(liveUrl(t)));
  const opId = uid();
  let merged = 0;
  const records = new Map<string, SavedTab>();

  await db.transaction('rw', [db.folders, db.tabs, db.snapshots, db.ops], async () => {
    const inverse: Inverse = {
      reopen: live.map<Origin>((t) => ({
        tabId: t.id,
        windowId: t.windowId,
        index: t.index,
        url: liveUrl(t),
        pinned: !!t.pinned,
        incognito: !!t.incognito,
        group: groupOf(t),
      })),
      removeTabIds: [],
      putTabs: [],
    };
    if (isNew) {
      await db.folders.add(folder);
      inverse.removeFolderIds = [folder.id];
    } else {
      inverse.putFolders = [{ ...folder }];
      await db.folders.update(folder.id, { updatedAt: now });
    }

    const inFolder = new Map((await db.tabs.where('folderId').equals(folder.id).toArray()).map((t) => [t.key, t]));
    for (const tab of saveable) {
      const url = liveUrl(tab);
      const key = normalizeUrl(url);
      if (records.has(key)) continue;
      const existing = inFolder.get(key);
      if (existing) {
        inverse.putTabs!.push({ ...existing });
        records.set(key, {
          ...existing,
          title: tab.title || existing.title,
          savedAt: now,
          incognito: existing.incognito || !!tab.incognito,
          ...(groupOf(tab) ? { group: groupOf(tab) } : {}),
          ...(toTrash ? { trashedAt: now } : {}),
        });
        merged++;
      } else {
        const record: SavedTab = {
          id: uid(),
          folderId: folder.id,
          url,
          key,
          title: tab.title || url,
          savedAt: now,
          incognito: !!tab.incognito,
          sourceWindowId: tab.windowId,
        };
        if (tab.pinned) record.pinned = true;
        if (groupOf(tab)) record.group = groupOf(tab);
        if (toTrash) record.trashedAt = now;
        inverse.removeTabIds!.push(record.id);
        records.set(key, record);
      }
    }

    await db.tabs.bulkPut([...records.values()]);
    await db.snapshots.add(snapshot);
    const count = live.length;
    await db.ops.add({
      id: opId,
      createdAt: now,
      label: label ?? `${toTrash ? 'Trashed' : 'Saved'} ${count} ${count === 1 ? 'tab' : 'tabs'}${toTrash ? '' : ` to ${folder.name}`}`,
      status: 'closing',
      inverse,
      closeTabIds: live.map((t) => t.id!),
    });
  });
  await pruneHistory();

  // Read back by id before closing anything.
  const expected = [...records.values()];
  const stored = await db.tabs.bulkGet(expected.map((r) => r.id));
  const verified = stored.every((r, i) => r && r.folderId === folder.id && r.url === expected[i].url);
  if (!verified) {
    await revertOp(opId, { reopen: false });
    throw new SaveError('The save could not be verified, so nothing was closed. Your tabs are still open.');
  }

  // Saved either way; tabs holding typed text (optional check) simply stay open.
  const typed = await findTypedTabs(live);
  const stillOpen = [...typed, ...(await closeTabs(live.map((t) => t.id!).filter((id) => !typed.has(id))))];
  await db.transaction('rw', db.ops, async () => {
    const op = await db.ops.get(opId);
    if (!op) return;
    // Undo must not reopen tabs that never closed.
    const reopen = op.inverse.reopen?.filter((o) => o.tabId == null || !stillOpen.includes(o.tabId));
    await db.ops.update(opId, { status: 'done', inverse: { ...op.inverse, reopen } });
  });
  notify();
  return { opId, folder, saved: expected.length - merged, merged, closed: live.length - stillOpen.length, stillOpen };
}

/** How long closing may make no progress before we assume the rest are held by "Leave site?" prompts. */
export const closeConfig = { stallMs: 1500, pollMs: 250 };

async function openOf(ids: number[]): Promise<number[]> {
  const open = new Set((await chrome.tabs.query({})).map((t) => t.id));
  return ids.filter((id) => open.has(id));
}

/**
 * Close tabs and report the ones that stayed open. Chrome honors a page's
 * "Leave site?" prompt: those tabs stay open and tabs.remove never settles, so
 * we watch progress instead of waiting on the promise forever.
 */
async function closeTabs(ids: number[], retry = true): Promise<number[]> {
  if (!ids.length) return [];
  const result = { state: 'pending' as 'pending' | 'done' | 'failed' };
  chrome.tabs.remove(ids).then(
    () => (result.state = 'done'),
    () => (result.state = 'failed'),
  );
  let open = ids.length;
  let lastProgress = Date.now();
  while (result.state === 'pending') {
    await new Promise((r) => setTimeout(r, closeConfig.pollMs));
    if (result.state !== 'pending') break;
    const now = (await openOf(ids)).length;
    if (now < open) {
      open = now;
      lastProgress = Date.now();
    } else if (Date.now() - lastProgress > closeConfig.stallMs) {
      return openOf(ids);
    }
  }
  // A tab closed by hand meanwhile fails the whole batch; close the rest again.
  if (result.state === 'failed' && retry) return closeTabs(await openOf(ids), false);
  return openOf(ids);
}

/** Put saved tabs in another folder (or Trash). Duplicates merge into the existing entry. */
export async function moveSaved(ids: string[], target: Target, label?: string): Promise<{ folder: Folder; moved: number }> {
  const now = Date.now();
  const { folder, isNew } = await resolveTarget(target, now);
  const toTrash = folder.id === TRASH_ID;
  let moved = 0;

  await db.transaction('rw', [db.folders, db.tabs, db.ops], async () => {
    const inverse: Inverse = { putTabs: [] };
    if (isNew) {
      await db.folders.add(folder);
      inverse.removeFolderIds = [folder.id];
    } else {
      inverse.putFolders = [{ ...folder }];
      await db.folders.update(folder.id, { updatedAt: now });
    }
    const tabs = (await db.tabs.bulkGet(ids)).filter((t): t is SavedTab => !!t && t.folderId !== folder.id);
    const names = new Map((await db.folders.toArray()).map((f) => [f.id, f.name]));
    for (const tab of tabs) {
      inverse.putTabs!.push({ ...tab });
      const existing = await db.tabs.where('[folderId+key]').equals([folder.id, tab.key]).first();
      if (existing) {
        inverse.putTabs!.push({ ...existing });
        await db.tabs.update(existing.id, { savedAt: now, ...(toTrash ? { trashedAt: now } : {}) });
        await db.tabs.delete(tab.id);
      } else {
        const next: SavedTab = { ...tab, folderId: folder.id };
        delete next.trashedAt;
        delete next.fromFolderId;
        delete next.fromFolderName;
        if (toTrash) {
          next.trashedAt = now;
          next.fromFolderId = tab.folderId;
          next.fromFolderName = names.get(tab.folderId);
        }
        await db.tabs.put(next);
      }
      moved++;
    }
    await db.ops.add({
      id: uid(),
      createdAt: now,
      label: label ?? `Moved ${moved} ${moved === 1 ? 'tab' : 'tabs'} to ${folder.name}`,
      status: 'done',
      inverse,
    });
  });
  await pruneHistory();
  notify();
  return { folder, moved };
}

export interface AddResult {
  folder: Folder;
  /** the folder was made for this */
  created: boolean;
  added: number;
  /** already in the folder, or not a web link */
  skipped: number;
}

/**
 * Write new saved tabs into a folder, skipping URLs it already holds. They keep
 * the order given: the first one shows at the top.
 */
async function addRecords(
  target: Target,
  entries: { url: string; title?: string; from?: SavedTab }[],
  label: (folder: Folder, added: number) => string,
): Promise<AddResult> {
  const now = Date.now();
  const { folder, isNew } = await resolveTarget(target, now);
  if (folder.id === TRASH_ID) throw new SaveError('Tabs can’t be added straight to Trash.');
  let added = 0;
  await db.transaction('rw', [db.folders, db.tabs, db.ops], async () => {
    const inverse: Inverse = { removeTabIds: [] };
    if (isNew) {
      await db.folders.add(folder);
      inverse.removeFolderIds = [folder.id];
    } else {
      inverse.putFolders = [{ ...folder }];
      await db.folders.update(folder.id, { updatedAt: now });
    }
    const keys = new Set((await db.tabs.where('folderId').equals(folder.id).toArray()).map((t) => t.key));
    const records: SavedTab[] = [];
    for (const entry of entries) {
      const key = normalizeUrl(entry.url);
      if (keys.has(key)) continue;
      keys.add(key);
      const record: SavedTab = {
        id: uid(),
        folderId: folder.id,
        url: entry.url,
        key,
        title: entry.title?.trim() || entry.from?.title || entry.url,
        savedAt: now - records.length,
        incognito: !!entry.from?.incognito,
      };
      if (entry.from?.pinned) record.pinned = true;
      if (entry.from?.group) record.group = entry.from.group;
      if (entry.from?.note) record.note = entry.from.note;
      records.push(record);
    }
    added = records.length;
    inverse.removeTabIds = records.map((r) => r.id);
    await db.tabs.bulkAdd(records);
    await db.ops.add({ id: uid(), createdAt: now, label: label(folder, added), status: 'done', inverse });
  });
  await pruneHistory();
  notify();
  return { folder, created: isNew, added, skipped: entries.length - added };
}

/** Copy saved tabs into another folder; the originals stay where they are. */
export async function copySaved(ids: string[], target: Target, label?: string): Promise<AddResult> {
  const tabs = (await db.tabs.bulkGet(ids)).filter((t): t is SavedTab => !!t && t.folderId !== TRASH_ID);
  return addRecords(
    target,
    tabs.map((t) => ({ url: t.url, from: t })),
    (folder, n) => label ?? `Copied ${n} ${n === 1 ? 'tab' : 'tabs'} to ${folder.name}`,
  );
}

/** Save web links that aren't open anywhere (an AI's list, say). Only http and https links are kept. */
export async function addLinks(links: { url: string; title?: string }[], target: Target, label?: string): Promise<AddResult> {
  const web = links.filter((l) => /^https?:\/\//i.test(l.url.trim())).map((l) => ({ url: l.url.trim(), title: l.title }));
  const result = await addRecords(target, web, (folder, n) => label ?? `Added ${n} ${n === 1 ? 'link' : 'links'} to ${folder.name}`);
  return { ...result, skipped: result.skipped + (links.length - web.length) };
}

/** Send trashed tabs back where they came from. A deleted folder comes back by name; otherwise Inbox. */
export async function restoreFromTrash(ids: string[]): Promise<number> {
  const tabs = (await db.tabs.bulkGet(ids)).filter((t): t is SavedTab => !!t && t.folderId === TRASH_ID);
  const folders = await db.folders.toArray();
  const groups = new Map<string, string[]>();
  for (const tab of tabs) {
    let home = INBOX_ID;
    if (tab.fromFolderId && folders.some((f) => f.id === tab.fromFolderId)) home = tab.fromFolderId;
    else if (tab.fromFolderName && tab.fromFolderId !== INBOX_ID) {
      const byName = folders.find((f) => f.kind === 'user' && f.name === tab.fromFolderName);
      home = byName?.id ?? `name:${tab.fromFolderName}`;
    }
    groups.set(home, [...(groups.get(home) ?? []), tab.id]);
  }
  for (const [home, group] of groups) {
    await moveSaved(group, home.startsWith('name:') ? { newFolderName: home.slice(5) } : { folderId: home });
  }
  return tabs.length;
}

/** Open saved tabs. Without keep, they move to Trash (still restorable for 30 days). */
export async function openSaved(
  ids: string[],
  { keep, windowId }: { keep: boolean; windowId?: number },
): Promise<number> {
  const tabs = (await db.tabs.bulkGet(ids)).filter((t): t is SavedTab => !!t);
  if (!tabs.length) return 0;
  let targetWindow: chrome.windows.Window | undefined;
  if (windowId != null) targetWindow = await chrome.windows.get(windowId).catch(() => undefined);

  const opened: { tabId?: number; windowId: number; group?: GroupMeta }[] = [];
  for (const incognito of [false, true]) {
    const batch = tabs.filter((t) => t.incognito === incognito);
    if (!batch.length) continue;
    if (targetWindow && targetWindow.incognito === incognito) {
      for (const tab of batch) {
        const created = await chrome.tabs.create({ windowId: targetWindow.id, url: tab.url, active: false, pinned: !!tab.pinned });
        opened.push({ tabId: created.id, windowId: targetWindow.id!, group: tab.group });
      }
    } else {
      const win = await chrome.windows.create({ url: batch.map((t) => t.url), incognito, focused: true });
      const created = win?.tabs ?? [];
      await Promise.allSettled(
        batch.map((t, i) => (t.pinned && created[i]?.id != null ? chrome.tabs.update(created[i].id!, { pinned: true }) : null)),
      );
      batch.forEach((t, i) => opened.push({ tabId: created[i]?.id, windowId: win!.id!, group: t.group }));
    }
  }
  await regroup(opened);

  if (!keep) {
    const rest = tabs.filter((t) => t.folderId !== TRASH_ID).map((t) => t.id);
    if (rest.length) await moveSaved(rest, { folderId: TRASH_ID });
  }
  return tabs.length;
}

/**
 * Move live tabs to another window. Whole tab groups travel as groups; a tab
 * taken out of a group arrives on its own. Incognito and normal stay apart.
 */
export async function moveLive(tabs: LiveTab[], windowId: number): Promise<number> {
  const target = await chrome.windows.get(windowId);
  const movable = tabs.filter(
    (t) => t.id != null && t.windowId !== windowId && !!t.incognito === target.incognito && !isBoardUrl(liveUrl(t)),
  );
  if (!movable.length) return 0;
  const inverse: Inverse = { moveLive: [], moveGroups: [] };
  const all = await chrome.tabs.query({});
  const ids = new Set(movable.map((t) => t.id));
  const whole = new Set<number>();
  for (const t of movable) {
    if (t.groupId == null || t.groupId === NO_GROUP || whole.has(t.groupId)) continue;
    if (all.filter((x) => x.groupId === t.groupId).every((x) => ids.has(x.id))) whole.add(t.groupId);
  }
  for (const groupId of whole) {
    const first = movable.filter((t) => t.groupId === groupId).sort((a, b) => a.index - b.index)[0];
    inverse.moveGroups!.push({ groupId, windowId: first.windowId, index: first.index });
    await chrome.tabGroups.move(groupId, { windowId, index: -1 });
  }
  const loose = movable.filter((t) => !whole.has(t.groupId ?? NO_GROUP));
  inverse.moveLive = loose.map((t) => ({ tabId: t.id!, windowId: t.windowId, index: t.index }));
  if (loose.length) {
    await chrome.tabs.move(
      loose.map((t) => t.id!),
      { windowId, index: -1 },
    );
  }
  await db.ops.add({
    id: uid(),
    createdAt: Date.now(),
    label: `Moved ${movable.length} ${movable.length === 1 ? 'tab' : 'tabs'} to another window`,
    status: 'done',
    inverse,
  });
  return movable.length;
}

/** Tear live tabs off into a new window (whole groups travel as groups). Undo puts them back. */
export async function moveToNewWindow(tabs: LiveTab[]): Promise<number> {
  const first = tabs.find((t) => t.id != null && !isBoardUrl(liveUrl(t)));
  if (!first) return 0;
  const win = await chrome.windows.create({ incognito: !!first.incognito, focused: false });
  const placeholder = win?.tabs?.[0]?.id;
  const moved = await moveLive(tabs, win!.id!);
  if (placeholder != null) await chrome.tabs.remove(placeholder).catch(() => undefined);
  if (!moved) await chrome.windows.remove(win!.id!).catch(() => undefined);
  return moved;
}

/** Make a Chrome tab group from live tabs, in the first tab's window. */
export async function groupLive(tabs: LiveTab[], title?: string): Promise<{ groupId: number; count: number } | null> {
  const first = tabs.find((t) => t.id != null && !isBoardUrl(liveUrl(t)));
  if (!first) return null;
  const members = tabs.filter((t) => t.id != null && !!t.incognito === !!first.incognito && !isBoardUrl(liveUrl(t)));
  const used = (await chrome.tabGroups.query({ windowId: first.windowId })).map((g) => g.color);
  const groupId = await chrome.tabs.group({ tabIds: tabIds(members.map((t) => t.id!)), createProperties: { windowId: first.windowId } });
  const name = title ?? suggestFolderName(members.map(liveUrl));
  await chrome.tabGroups.update(groupId, { title: name.startsWith('Saved ') ? '' : name, color: nextColor(used) });
  await db.ops.add({
    id: uid(),
    createdAt: Date.now(),
    label: `Grouped ${members.length} ${members.length === 1 ? 'tab' : 'tabs'}`,
    status: 'done',
    inverse: {
      ungroup: members.map((t) => t.id!),
      moveLive: members.filter((t) => t.windowId !== first.windowId).map((t) => ({ tabId: t.id!, windowId: t.windowId, index: t.index })),
    },
  });
  return { groupId, count: members.length };
}

/** Add live tabs to an existing tab group (they move to its window). */
export async function addToGroup(tabs: LiveTab[], groupId: number): Promise<number> {
  const group = await chrome.tabGroups.get(groupId);
  const win = await chrome.windows.get(group.windowId);
  const members = tabs.filter((t) => t.id != null && t.groupId !== groupId && !!t.incognito === win.incognito && !isBoardUrl(liveUrl(t)));
  if (!members.length) return 0;
  await chrome.tabs.group({ groupId, tabIds: tabIds(members.map((t) => t.id!)) });
  await db.ops.add({
    id: uid(),
    createdAt: Date.now(),
    label: `Added ${members.length} ${members.length === 1 ? 'tab' : 'tabs'} to ${group.title || 'a group'}`,
    status: 'done',
    inverse: {
      ungroup: members.map((t) => t.id!),
      moveLive: members.map((t) => ({ tabId: t.id!, windowId: t.windowId, index: t.index })),
    },
  });
  return members.length;
}

export async function renameGroup(groupId: number, title: string, color?: GroupColor) {
  await chrome.tabGroups.update(groupId, { title, ...(color ? { color } : {}) });
}

/** Drop one folder onto another: its tabs move over and the emptied folder goes away. One undo. */
export async function mergeFolder(sourceId: string, targetId: string): Promise<{ moved: number; target: Folder } | null> {
  if (sourceId === targetId) return null;
  const now = Date.now();
  let result: { moved: number; target: Folder } | null = null;
  await db.transaction('rw', [db.folders, db.tabs, db.ops], async () => {
    const source = await db.folders.get(sourceId);
    const target = await db.folders.get(targetId);
    if (!source || !target) return;
    const tabs = await db.tabs.where('folderId').equals(sourceId).toArray();
    const inTarget = new Map((await db.tabs.where('folderId').equals(targetId).toArray()).map((t) => [t.key, t]));
    const inverse: Inverse = { putTabs: tabs.map((t) => ({ ...t })), putFolders: [{ ...target }] };
    for (const tab of tabs) {
      const existing = inTarget.get(tab.key);
      if (existing) {
        inverse.putTabs!.push({ ...existing });
        await db.tabs.update(existing.id, { savedAt: Math.max(existing.savedAt, tab.savedAt) });
        await db.tabs.delete(tab.id);
        continue;
      }
      const next: SavedTab = { ...tab, folderId: targetId };
      delete next.trashedAt;
      delete next.fromFolderId;
      delete next.fromFolderName;
      if (targetId === TRASH_ID) Object.assign(next, { trashedAt: now, fromFolderId: sourceId, fromFolderName: source.name });
      await db.tabs.put(next);
    }
    await db.folders.update(targetId, { updatedAt: now });
    if (source.kind === 'user') {
      inverse.putFolders!.push({ ...source });
      await db.folders.delete(sourceId);
    }
    await db.ops.add({
      id: uid(),
      createdAt: now,
      label: targetId === TRASH_ID ? `Deleted ${source.name}` : `Moved ${source.name} into ${target.name}`,
      status: 'done',
      inverse,
    });
    result = { moved: tabs.length, target };
  });
  notify();
  return result;
}

/** With a label, the new folder is also an undoable step. */
export async function createFolder(name: string, label?: string): Promise<Folder> {
  const now = Date.now();
  const folder: Folder = {
    id: uid(),
    name: name.trim() || 'New folder',
    kind: 'user',
    color: null,
    order: await nextFolderOrder(),
    createdAt: now,
    updatedAt: now,
  };
  await db.transaction('rw', [db.folders, db.ops], async () => {
    await db.folders.add(folder);
    if (label) await db.ops.add({ id: uid(), createdAt: now, label, status: 'done', inverse: { removeFolderIds: [folder.id] } });
  });
  notify();
  return folder;
}

export async function updateFolder(id: string, changes: Partial<Pick<Folder, 'name' | 'color'>>) {
  const folder = await db.folders.get(id);
  if (!folder || folder.kind !== 'user') return;
  if (changes.name !== undefined) changes.name = changes.name.trim() || folder.name;
  await db.folders.update(id, changes);
  notify();
}

/** Delete a folder: its tabs go to Trash, so this is never destructive. */
export async function deleteFolder(id: string) {
  const now = Date.now();
  await db.transaction('rw', [db.folders, db.tabs, db.ops], async () => {
    const folder = await db.folders.get(id);
    if (!folder || folder.kind !== 'user') return;
    const tabs = await db.tabs.where('folderId').equals(id).toArray();
    await db.tabs.bulkPut(
      tabs.map((t) => ({ ...t, folderId: TRASH_ID, trashedAt: now, fromFolderId: id, fromFolderName: folder.name })),
    );
    await db.folders.delete(id);
    await db.ops.add({
      id: uid(),
      createdAt: now,
      label: `Deleted ${folder.name}`,
      status: 'done',
      inverse: { putFolders: [folder], putTabs: tabs },
    });
  });
  notify();
}

/** Permanent delete. Still undoable while the op is in history. */
export async function deleteForever(ids: string[]) {
  await db.transaction('rw', [db.tabs, db.ops], async () => {
    const tabs = (await db.tabs.bulkGet(ids)).filter((t): t is SavedTab => !!t);
    await db.tabs.bulkDelete(tabs.map((t) => t.id));
    await db.ops.add({
      id: uid(),
      createdAt: Date.now(),
      label: `Deleted ${tabs.length} ${tabs.length === 1 ? 'tab' : 'tabs'}`,
      status: 'done',
      inverse: { putTabs: tabs },
    });
  });
  notify();
}

export async function emptyTrash() {
  const ids = await db.tabs.where('folderId').equals(TRASH_ID).primaryKeys();
  if (ids.length) await deleteForever(ids);
}

/** Drop trashed tabs older than 30 days. */
export async function purgeTrash(now = Date.now()) {
  const cutoff = now - TRASH_DAYS * 24 * 60 * 60 * 1000;
  const old = await db.tabs.where('trashedAt').below(cutoff).primaryKeys();
  if (old.length) {
    await db.tabs.bulkDelete(old);
    notify();
  }
  return old.length;
}

export async function lastUndoable(): Promise<Op | undefined> {
  return db.ops
    .orderBy('createdAt')
    .reverse()
    .filter((op) => op.status === 'done')
    .first();
}

/** Undo the most recent operation: reopen tabs where they were, then revert the vault. */
export async function undo(): Promise<Op | undefined> {
  const op = await lastUndoable();
  if (!op) return undefined;
  await revertOp(op.id, { reopen: true });
  notify();
  return op;
}

async function revertOp(opId: string, { reopen }: { reopen: boolean }) {
  const op = await db.ops.get(opId);
  if (!op) return;
  const inv = op.inverse;
  if (reopen && inv.reopen?.length) await reopenOrigins(inv.reopen);
  if (reopen && inv.ungroup?.length) await chrome.tabs.ungroup(tabIds(inv.ungroup)).catch(() => undefined);
  if (reopen && inv.moveGroups?.length) {
    for (const g of inv.moveGroups) {
      await chrome.tabGroups.move(g.groupId, { windowId: g.windowId, index: g.index }).catch(() => undefined);
    }
  }
  if (reopen && inv.moveLive?.length) await moveBack(inv.moveLive);
  await db.transaction('rw', [db.folders, db.tabs, db.ops], async () => {
    if (inv.removeTabIds?.length) await db.tabs.bulkDelete(inv.removeTabIds);
    if (inv.putTabs?.length) await db.tabs.bulkPut(inv.putTabs);
    if (inv.putFolders?.length) await db.folders.bulkPut(inv.putFolders);
    for (const id of inv.removeFolderIds ?? []) {
      // Keep a folder that has since received other tabs.
      if ((await db.tabs.where('folderId').equals(id).count()) === 0) await db.folders.delete(id);
    }
    await db.ops.update(opId, { status: 'undone' });
  });
}

/** Put tabs back where they were; a window that has since closed comes back as a new one. */
async function moveBack(moves: { tabId: number; windowId: number; index: number }[]) {
  const replaced = new Map<number, number>();
  for (const m of [...moves].sort((a, b) => a.index - b.index)) {
    let windowId = replaced.get(m.windowId) ?? m.windowId;
    const exists = await chrome.windows.get(windowId).then(
      () => true,
      () => false,
    );
    if (!exists) {
      const win = await chrome.windows.create({ tabId: m.tabId, focused: false }).catch(() => undefined);
      if (win?.id != null) replaced.set(m.windowId, win.id);
      continue;
    }
    await chrome.tabs.move(m.tabId, { windowId, index: m.index }).catch(() => undefined);
  }
}

async function reopenOrigins(origins: Origin[]) {
  const reopened: { tabId?: number; windowId: number; group?: GroupMeta }[] = [];
  const byWindow = new Map<number, Origin[]>();
  for (const o of origins) byWindow.set(o.windowId, [...(byWindow.get(o.windowId) ?? []), o]);
  for (const [windowId, list] of byWindow) {
    list.sort((a, b) => a.index - b.index);
    const exists = await chrome.windows.get(windowId).then(
      () => true,
      () => false,
    );
    if (exists) {
      for (const o of list) {
        const tab = await chrome.tabs.create({ windowId, index: o.index, url: isBlankUrl(o.url) ? undefined : o.url, pinned: o.pinned, active: false });
        reopened.push({ tabId: tab.id, windowId, group: o.group });
      }
    } else {
      const win = await chrome.windows.create({
        url: list.map((o) => (isBlankUrl(o.url) ? 'chrome://newtab/' : o.url)),
        incognito: list[0].incognito,
        focused: false,
      });
      const created = win?.tabs ?? [];
      await Promise.allSettled(
        list.map((o, i) => (o.pinned && created[i]?.id != null ? chrome.tabs.update(created[i].id!, { pinned: true }) : null)),
      );
      list.forEach((o, i) => reopened.push({ tabId: created[i]?.id, windowId: win!.id!, group: o.group }));
    }
  }
  await regroup(reopened);
}

/** Saves that were verified but whose tabs were never confirmed closed (crash, board closed mid-move). */
export async function interruptedOps(): Promise<Op[]> {
  return db.ops.where('status').equals('closing').toArray();
}

export async function finishInterrupted(op: Op, close: boolean) {
  if (close && op.closeTabIds?.length) await closeTabs(await openOf(op.closeTabIds));
  await db.ops.update(op.id, { status: 'done' });
}

/** Focus a tab and its window (used to show a "Leave site?" prompt). */
export async function focusTab(tabId: number) {
  const tab = await chrome.tabs.update(tabId, { active: true });
  if (tab) await chrome.windows.update(tab.windowId, { focused: true });
}

export async function ensureSystemFolders() {
  const now = Date.now();
  await db.transaction('rw', db.folders, async () => {
    if (!(await db.folders.get(INBOX_ID)))
      await db.folders.add({ id: INBOX_ID, name: 'Inbox', kind: 'inbox', color: null, order: -2, createdAt: now, updatedAt: now });
    if (!(await db.folders.get(TRASH_ID)))
      await db.folders.add({ id: TRASH_ID, name: 'Trash', kind: 'trash', color: null, order: -1, createdAt: now, updatedAt: now });
  });
}
