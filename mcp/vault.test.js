import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findBookmarksFile, getFolder, INCOGNITO_PLACEHOLDER, listFolders, loadFromBookmarks, recentTabs, searchTabs } from './vault.js';

const now = Date.UTC(2026, 9, 20);
const vault = (seesIncognito = false) => ({
  app: 'FreeTabs',
  format: 1,
  exportedAt: '2026-10-20T12:00:00.000Z',
  ai: { seesIncognito },
  folders: [
    { id: 'inbox', name: 'Inbox', kind: 'inbox', updatedAt: now },
    { id: 'trash', name: 'Trash', kind: 'trash', updatedAt: now },
    { id: 'f1', name: 'Read later', kind: 'user', updatedAt: now },
  ],
  tabs: [
    { id: '1', folderId: 'f1', url: 'https://paulgraham.com/makersschedule.html', title: "Maker's Schedule", savedAt: now, incognito: false },
    { id: '2', folderId: 'f1', url: 'https://secret.example/private', title: 'Private thing', savedAt: now - 1000, incognito: true },
    { id: '3', folderId: 'trash', url: 'https://old.com/', title: 'Old schedule', savedAt: now, incognito: false, trashedAt: now },
  ],
});

test('incognito tabs are placeholders by default', () => {
  const text = getFolder(vault(), 'read later');
  assert.match(text, /Maker's Schedule/);
  assert.ok(text.includes(INCOGNITO_PLACEHOLDER));
  assert.ok(!text.includes('secret.example'));
  assert.ok(!text.includes('Private thing'));
  assert.match(text, /hidden from AI/);
});

test('incognito tabs show when the user allowed it', () => {
  const text = getFolder(vault(true), 'Read later');
  assert.ok(text.includes('secret.example'));
  assert.ok(!text.includes(INCOGNITO_PLACEHOLDER));
});

test('search never matches hidden tabs or Trash', () => {
  assert.match(searchTabs(vault(), 'private'), /No saved tabs match/);
  assert.match(searchTabs(vault(), 'schedule'), /1 saved tab matches/);
});

test('list and recent', () => {
  assert.match(listFolders(vault()), /Read later: 2 tabs.*1 hidden incognito/);
  const recent = recentTabs(vault());
  assert.ok(!recent.includes('old.com'));
  assert.ok(recent.includes(INCOGNITO_PLACEHOLDER));
});

test('unknown folder lists what exists', () => {
  assert.throws(() => getFolder(vault(), 'nope'), /Folders: Inbox, Trash, Read later/);
});

test('reads the FreeTabs folder from a Chrome Bookmarks file', async () => {
  const chromeTime = (ms) => String((BigInt(ms) + 11644473600000n) * 1000n);
  const saved = Date.UTC(2026, 9, 20, 12);
  const bookmarks = {
    roots: {
      bookmark_bar: { type: 'folder', name: 'Bookmarks bar', children: [] },
      other: {
        type: 'folder',
        name: 'Other bookmarks',
        children: [
          { type: 'url', name: 'Unrelated', url: 'https://unrelated.com/' },
          {
            type: 'folder',
            id: '10',
            name: 'FreeTabs',
            children: [
              { type: 'url', id: '11', name: 'Open FreeTabs', url: `chrome-extension://x/board.html#freetabs=${encodeURIComponent(JSON.stringify({ v: 1, hidden: { 'Read later': 2 } }))}` },
              { type: 'folder', id: '12', name: 'Inbox', date_added: chromeTime(saved), children: [] },
              {
                type: 'folder',
                id: '13',
                name: 'Read later',
                date_added: chromeTime(saved),
                children: [{ type: 'url', id: '14', name: "Maker's Schedule", url: 'https://paulgraham.com/makersschedule.html', date_added: chromeTime(saved) }],
              },
            ],
          },
        ],
      },
    },
  };
  const dir = mkdtempSync(path.join(tmpdir(), 'freetabs-mcp-'));
  mkdirSync(path.join(dir, 'Chrome', 'Profile 2'), { recursive: true });
  mkdirSync(path.join(dir, 'Chrome', 'Default'), { recursive: true });
  writeFileSync(path.join(dir, 'Chrome', 'Default', 'Bookmarks'), JSON.stringify({ roots: { other: { type: 'folder', children: [] } } }));
  const file = path.join(dir, 'Chrome', 'Profile 2', 'Bookmarks');
  writeFileSync(file, JSON.stringify(bookmarks));

  assert.equal(await findBookmarksFile([path.join(dir, 'Chrome')]), file);
  const vault = await loadFromBookmarks(file);
  assert.deepEqual(vault.folders.map((f) => f.name), ['Inbox', 'Read later']);
  const text = getFolder(vault, 'read later');
  assert.match(text, /Read later: 3 tabs/);
  assert.match(text, /\[Maker's Schedule\]\(https:\/\/paulgraham.com\/makersschedule.html\) \(paulgraham.com, saved 2026-10-20\)/);
  assert.equal(text.split('\n').filter((l) => l.startsWith(`- ${INCOGNITO_PLACEHOLDER}`)).length, 2);
  assert.match(text, /incognito tabs never leave/);
});

test('live from FreeTabs, tabs carry short ids for the write tools; the backup has none', () => {
  const live = { ...vault(), live: true };
  live.tabs = [
    { id: '3f2a9c1e-aaaa-4000-8000-000000000001', folderId: 'f1', url: 'https://a.com/', title: 'A', savedAt: now, incognito: false },
    { id: '3f2a9c1e-bbbb-4000-8000-000000000002', folderId: 'f1', url: 'https://b.com/', title: 'B', savedAt: now - 1, incognito: false },
    { id: '77d0e5b2-cccc-4000-8000-000000000003', folderId: 'f1', url: 'https://c.com/', title: 'C', savedAt: now - 2, incognito: false },
  ];
  const text = getFolder(live, 'read later');
  assert.match(text, /id 77d0e5b2\)/);
  assert.ok(text.includes('id 3f2a9c1e-aaaa-4000-8000-000000000001'), 'a clash on the first 8 characters falls back to the full id');
  assert.match(listFolders(live), /live from FreeTabs/);
  assert.ok(!getFolder(vault(), 'read later').includes(' id '), 'no ids from the bookmarks backup');
});
