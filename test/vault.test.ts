import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installChrome } from './chrome-mock';
import { db, INBOX_ID, TRASH_ID, VaultDB } from '../src/lib/db';
import * as vault from '../src/lib/vault';

let chromeMock: ReturnType<typeof installChrome>;

beforeEach(async () => {
  vi.restoreAllMocks();
  chromeMock = installChrome();
  vault.closeConfig.stallMs = 150;
  vault.closeConfig.pollMs = 20;
  await Promise.all([db.tabs.clear(), db.ops.clear(), db.snapshots.clear(), db.folders.clear()]);
  await vault.ensureSystemFolders();
});

describe('saveAndClose', () => {
  it('writes, verifies, then closes', async () => {
    const tabs = chromeMock.open(['https://a.com/', 'https://b.com/x']);
    const res = await vault.saveAndClose(tabs, { folderId: INBOX_ID });

    expect(res).toMatchObject({ saved: 2, merged: 0, closed: 2 });
    const saved = await db.tabs.where('folderId').equals(INBOX_ID).toArray();
    expect(saved.map((t) => t.url).sort()).toEqual(['https://a.com/', 'https://b.com/x']);
    expect(chromeMock.openUrls()).toEqual([]);
    expect(await db.snapshots.count()).toBe(1);
    expect((await db.ops.toArray())[0].status).toBe('done');
  });

  it('closes nothing when the write fails', async () => {
    const tabs = chromeMock.open(['https://a.com/', 'https://b.com/']);
    vi.spyOn(db.tabs, 'bulkPut').mockRejectedValueOnce(new Error('disk full'));

    await expect(vault.saveAndClose(tabs, { folderId: INBOX_ID })).rejects.toThrow();
    expect(chromeMock.api.tabs.remove).not.toHaveBeenCalled();
    expect(chromeMock.openUrls()).toHaveLength(2);
    expect(await db.tabs.count()).toBe(0);
  });

  it('closes nothing when the read-back does not match, and rolls the write back', async () => {
    const tabs = chromeMock.open(['https://a.com/']);
    vi.spyOn(db.tabs, 'bulkGet').mockResolvedValueOnce([undefined]);

    await expect(vault.saveAndClose(tabs, { folderId: INBOX_ID })).rejects.toThrow(/could not be verified/);
    expect(chromeMock.api.tabs.remove).not.toHaveBeenCalled();
    expect(chromeMock.openUrls()).toEqual(['https://a.com/']);
    expect(await db.tabs.count()).toBe(0);
    expect(await vault.lastUndoable()).toBeUndefined();
  });

  it('still closes the rest when one tab was already closed by hand', async () => {
    const tabs = chromeMock.open(['https://a.com/', 'https://b.com/', 'https://c.com/']);
    await chromeMock.api.tabs.remove(tabs[1].id!);
    const res = await vault.saveAndClose(tabs, { folderId: INBOX_ID });
    expect(res.saved).toBe(3);
    expect(chromeMock.openUrls()).toEqual([]);
  });

  it('a page that asks "Leave site?" stays open without stalling the save', async () => {
    const tabs = chromeMock.open(['https://a.com/', 'https://draft.com/compose', 'https://c.com/']);
    chromeMock.dirty.add(tabs[1].id!);
    const res = await vault.saveAndClose(tabs, { folderId: INBOX_ID });

    expect(res.stillOpen).toEqual([tabs[1].id]);
    expect(res).toMatchObject({ saved: 3, closed: 2 });
    expect(chromeMock.openUrls()).toEqual(['https://draft.com/compose']);
    const op = await vault.lastUndoable();
    expect(op?.status).toBe('done');
    // Undo reopens only what actually closed.
    expect(op?.inverse.reopen?.map((o) => o.url)).toEqual(['https://a.com/', 'https://c.com/']);
  });

  it('never closes the board itself', async () => {
    const tabs = chromeMock.open(['chrome-extension://freetabs/board.html', 'https://a.com/']);
    const res = await vault.saveAndClose(tabs, { folderId: INBOX_ID });
    expect(res.closed).toBe(1);
    expect(chromeMock.openUrls()).toEqual(['chrome-extension://freetabs/board.html']);
  });

  it('closes blank tabs without saving them', async () => {
    const tabs = chromeMock.open(['chrome://newtab/', 'https://a.com/']);
    const res = await vault.saveAndClose(tabs, { folderId: INBOX_ID });
    expect(res).toMatchObject({ saved: 1, closed: 2 });
    expect((await db.tabs.toArray()).map((t) => t.url)).toEqual(['https://a.com/']);
  });

  it('merges duplicates within a drop and with the folder', async () => {
    const first = chromeMock.open(['https://a.com/page?utm_source=x']);
    await vault.saveAndClose(first, { folderId: INBOX_ID });
    const again = chromeMock.open(['https://a.com/page', 'https://a.com/page/', 'https://b.com/']);
    const res = await vault.saveAndClose(again, { folderId: INBOX_ID });

    expect(res).toMatchObject({ saved: 1, merged: 1, closed: 3 });
    expect(await db.tabs.count()).toBe(2);
  });

  it('creates a new folder on the fly', async () => {
    const tabs = chromeMock.open(['https://a.com/']);
    const res = await vault.saveAndClose(tabs, { newFolderName: 'Research' });
    expect(res.folder.name).toBe('Research');
    expect(await db.tabs.where('folderId').equals(res.folder.id).count()).toBe(1);
  });

  it('keeps incognito tabs flagged', async () => {
    const tabs = chromeMock.open(['https://secret.example/'], { incognito: true });
    await vault.saveAndClose(tabs, { folderId: INBOX_ID });
    expect((await db.tabs.toArray())[0].incognito).toBe(true);
  });
});

describe('unsaved work', () => {
  it('with the opt-in check on, a page with typed text is saved but stays open', async () => {
    chromeMock.storage.settings = { checkTyped: true };
    chromeMock.grants.origins = true;
    const tabs = chromeMock.open(['https://a.com/', 'https://form.com/apply']);
    chromeMock.typed.add(tabs[1].id!);
    const res = await vault.saveAndClose(tabs, { folderId: INBOX_ID });
    expect(res.stillOpen).toEqual([tabs[1].id]);
    expect(res.saved).toBe(2);
    expect(chromeMock.openUrls()).toEqual(['https://form.com/apply']);
  });

  it('without the permission, the check never runs', async () => {
    chromeMock.storage.settings = { checkTyped: true };
    const tabs = chromeMock.open(['https://form.com/apply']);
    chromeMock.typed.add(tabs[0].id!);
    const res = await vault.saveAndClose(tabs, { folderId: INBOX_ID });
    expect(res.stillOpen).toEqual([]);
    expect(chromeMock.api.scripting.executeScript).not.toHaveBeenCalled();
  });
});

describe('tab groups', () => {
  it('remembers a tab group when saving and recreates it on restore', async () => {
    const tabs = chromeMock.open(['https://a.com/', 'https://b.com/', 'https://c.com/']);
    chromeMock.groups.set(7, { id: 7, title: 'Trip', color: 'green', windowId: tabs[0].windowId });
    tabs[0].groupId = 7;
    tabs[1].groupId = 7;
    await vault.saveAndClose(tabs, { folderId: INBOX_ID });
    const saved = await db.tabs.toArray();
    expect(saved.filter((t) => t.group?.title === 'Trip').map((t) => t.url).sort()).toEqual(['https://a.com/', 'https://b.com/']);

    await vault.openSaved(saved.map((t) => t.id), { keep: true });
    expect(chromeMock.api.tabs.group).toHaveBeenCalledTimes(1);
    const recreated = [...chromeMock.groups.values()].find((g) => g.id !== 7);
    expect(recreated).toMatchObject({ title: 'Trip', color: 'green' });
  });
});

describe('new vaults', () => {
  it('start with Inbox, Trash, Watch later and Read later', async () => {
    const fresh = new VaultDB(`fresh-${Math.random()}`);
    const names = (await fresh.folders.orderBy('order').toArray()).map((f) => f.name);
    expect(names).toEqual(['Inbox', 'Trash', 'Watch later', 'Read later']);
    fresh.close();
  });
});

describe('undo', () => {
  it('reopens tabs in their window at their position and removes them from the folder', async () => {
    const tabs = chromeMock.open(['https://keep.com/', 'https://a.com/', 'https://b.com/', 'https://keep2.com/']);
    await vault.saveAndClose([tabs[1], tabs[2]], { newFolderName: 'Temp' });
    expect(chromeMock.openUrls()).toEqual(['https://keep.com/', 'https://keep2.com/']);

    const op = await vault.undo();
    expect(op?.label).toMatch(/Saved 2 tabs/);
    expect(chromeMock.openUrls()).toEqual(['https://keep.com/', 'https://a.com/', 'https://b.com/', 'https://keep2.com/']);
    expect(await db.tabs.count()).toBe(0);
    expect(await db.folders.where('kind').equals('user').count()).toBe(0);
  });

  it('reopens a closed window as a new window', async () => {
    const tabs = chromeMock.open(['https://a.com/', 'https://b.com/']);
    await vault.saveAndClose(tabs, { folderId: INBOX_ID });
    expect(chromeMock.windows.size).toBe(0);
    await vault.undo();
    expect(chromeMock.openUrls()).toEqual(['https://a.com/', 'https://b.com/']);
  });

  it('restores the previous version of merged tabs', async () => {
    const a = chromeMock.open(['https://a.com/']);
    await vault.saveAndClose(a, { folderId: INBOX_ID });
    const before = (await db.tabs.toArray())[0];
    const again = chromeMock.open(['https://a.com/']);
    await vault.saveAndClose(again, { folderId: INBOX_ID });
    await vault.undo();
    const after = await db.tabs.toArray();
    expect(after).toHaveLength(1);
    expect(after[0].savedAt).toBe(before.savedAt);
  });
});

describe('folders and trash', () => {
  it('deleting a folder sends its tabs to Trash, and they come back into a folder of the same name', async () => {
    const tabs = chromeMock.open(['https://a.com/', 'https://b.com/']);
    const { folder } = await vault.saveAndClose(tabs, { newFolderName: 'Reading' });
    await vault.deleteFolder(folder.id);
    expect(await db.tabs.where('folderId').equals(TRASH_ID).count()).toBe(2);

    const ids = await db.tabs.where('folderId').equals(TRASH_ID).primaryKeys();
    await vault.restoreFromTrash(ids);
    const reading = await db.folders.where('kind').equals('user').first();
    expect(reading?.name).toBe('Reading');
    expect(await db.tabs.where('folderId').equals(reading!.id).count()).toBe(2);
  });

  it('moving saved tabs merges duplicates in the target', async () => {
    const one = await vault.saveAndClose(chromeMock.open(['https://a.com/']), { newFolderName: 'One' });
    await vault.saveAndClose(chromeMock.open(['https://a.com/', 'https://b.com/']), { newFolderName: 'Two' });
    const two = await db.folders.where('kind').equals('user').filter((f) => f.name === 'Two').first();
    const ids = await db.tabs.where('folderId').equals(two!.id).primaryKeys();
    await vault.moveSaved(ids, { folderId: one.folder.id });
    expect(await db.tabs.where('folderId').equals(one.folder.id).count()).toBe(2);
    expect(await db.tabs.count()).toBe(2);
  });

  it('dropping a folder onto another moves everything over and removes it, in one undo', async () => {
    const a = await vault.saveAndClose(chromeMock.open(['https://a.com/', 'https://b.com/']), { newFolderName: 'Old' });
    const b = await vault.saveAndClose(chromeMock.open(['https://b.com/', 'https://c.com/']), { newFolderName: 'New' });
    await vault.mergeFolder(a.folder.id, b.folder.id);
    expect(await db.folders.get(a.folder.id)).toBeUndefined();
    expect((await db.tabs.where('folderId').equals(b.folder.id).toArray()).map((t) => t.url).sort()).toEqual([
      'https://a.com/',
      'https://b.com/',
      'https://c.com/',
    ]);
    await vault.undo();
    expect(await db.folders.get(a.folder.id)).toBeDefined();
    expect(await db.tabs.where('folderId').equals(a.folder.id).count()).toBe(2);
    expect(await db.tabs.where('folderId').equals(b.folder.id).count()).toBe(2);
  });

  it('purges Trash after 30 days', async () => {
    await vault.saveAndClose(chromeMock.open(['https://a.com/']), { folderId: TRASH_ID });
    expect(await vault.purgeTrash(Date.now() + 29 * 86400000)).toBe(0);
    expect(await vault.purgeTrash(Date.now() + 31 * 86400000)).toBe(1);
  });

  it('opening saved tabs without keeping them moves them to Trash', async () => {
    await vault.saveAndClose(chromeMock.open(['https://a.com/']), { folderId: INBOX_ID });
    const ids = await db.tabs.where('folderId').equals(INBOX_ID).primaryKeys();
    await vault.openSaved(ids, { keep: false });
    expect(chromeMock.openUrls()).toEqual(['https://a.com/']);
    expect(await db.tabs.where('folderId').equals(TRASH_ID).count()).toBe(1);
  });
});

describe('changes from AI apps', () => {
  it('copies tabs into a new folder in the order given, keeps the originals, and undoes in one step', async () => {
    await vault.saveAndClose(chromeMock.open(['https://a.com/', 'https://b.com/', 'https://c.com/']), { folderId: INBOX_ID });
    const inbox = await db.tabs.where('folderId').equals(INBOX_ID).toArray();
    const pick = ['https://c.com/', 'https://a.com/'].map((url) => inbox.find((t) => t.url === url)!.id);

    const r = await vault.copySaved(pick, { newFolderName: 'Top prospects' }, 'Claude copied 2 tabs to Top prospects');
    expect(r).toMatchObject({ created: true, added: 2, skipped: 0 });
    const copies = await db.tabs.where('folderId').equals(r.folder.id).toArray();
    expect(copies.sort((x, y) => y.savedAt - x.savedAt).map((t) => t.url)).toEqual(['https://c.com/', 'https://a.com/']);
    expect(await db.tabs.where('folderId').equals(INBOX_ID).count()).toBe(3);

    // Copying again skips what's already there.
    expect((await vault.copySaved(pick, { folderId: r.folder.id })).skipped).toBe(2);
    await vault.undo();
    expect(await db.tabs.where('folderId').equals(r.folder.id).count()).toBe(2);
    expect((await vault.undo())?.label).toBe('Claude copied 2 tabs to Top prospects');
    expect(await db.folders.get(r.folder.id)).toBeUndefined();
  });

  it('adds only web links, skipping duplicates', async () => {
    const r = await vault.addLinks(
      [
        { url: 'https://example.com/a', title: 'A' },
        { url: 'https://example.com/a' },
        { url: 'javascript:alert(1)' },
        { url: 'http://example.com/b' },
      ],
      { newFolderName: 'Reading list' },
    );
    expect(r).toMatchObject({ created: true, added: 2, skipped: 2 });
    const saved = await db.tabs.where('folderId').equals(r.folder.id).toArray();
    expect(saved.map((t) => t.title).sort()).toEqual(['A', 'http://example.com/b']);
  });

  it('an undoable new folder', async () => {
    const folder = await vault.createFolder('Prospects', 'Claude created Prospects');
    expect((await vault.undo())?.label).toBe('Claude created Prospects');
    expect(await db.folders.get(folder.id)).toBeUndefined();
  });
});
