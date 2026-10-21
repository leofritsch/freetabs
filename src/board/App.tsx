import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Dexie from 'dexie';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, INBOX_ID, TRASH_ID, type Folder, type Op, type SavedTab } from '../lib/db';
import { pendingRestore, restoreFromBookmarks, setAsideOldBackup } from '../lib/bookmarks';
import * as vault from '../lib/vault';
import { liveUrl } from '../lib/vault';
import { suggestFolderName } from '../lib/url';
import { aiChatUrl, toAI, toLinks, toMarkdown, type AIProvider, type ExportGroup } from '../lib/export';
import { DEFAULT_SETTINGS, getSettings, type Settings } from '../lib/settings';
import { markMatcher } from '../lib/marks';
import { useLive } from './useLive';
import {
  ago,
  ContextMenu,
  DotsIcon,
  FolderRow,
  faviconFor,
  IncognitoIcon,
  NameInput,
  plural,
  Row,
  Toast,
  type MenuEntry,
  type ToastState,
} from './components';
import { SettingsDialog } from './Settings';
import { Onboarding } from './Onboarding';
import { Palette } from './Palette';

vault.onVaultChange(() => {
  chrome.runtime.sendMessage({ type: 'vault-changed' }).catch(() => undefined);
});

type Source = 'live' | 'saved';
type View = { kind: 'live' } | { kind: 'saved' } | { kind: 'folder'; id: string };
/** How many recent tabs each folder shows on the Saved tabs board. */
const PREVIEW = 8;
interface Selection {
  source: Source;
  keys: Set<string>;
}
const EMPTY: Selection = { source: 'live', keys: new Set() };

type Gesture =
  | { kind: 'press'; key: string; source: Source; x: number; y: number; meta: boolean; shift: boolean; wasSelected: boolean }
  | { kind: 'drag'; source: Source; keys: string[]; over: string | null; group?: string }
  /** press on a window, tab group or folder header: hold to lift it, move to carry it */
  | { kind: 'grab'; group: string; x: number; y: number; timer: number; lifted: boolean }
  | {
      kind: 'lasso';
      source: Source;
      startX: number;
      startContentY: number;
      base: Set<string>;
      rows: HTMLElement[];
      moved: boolean;
    };

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Follow the pointer, flipping to the other side near the window's edges.
 * The tilt leans the ghost into the direction of travel, like a card held between two fingers.
 */
function placeGhostAt(el: HTMLElement | null, p: { x: number; y: number }, tilt = { x: 0, y: 0 }) {
  if (!el) return;
  let x = p.x + 14;
  let y = p.y + 10;
  if (x + el.offsetWidth > window.innerWidth - 8) x = p.x - el.offsetWidth - 14;
  if (y + el.offsetHeight > window.innerHeight - 8) y = p.y - el.offsetHeight - 10;
  el.style.transform = `translate3d(${x}px, ${y}px, 0) perspective(700px) rotateY(${tilt.x.toFixed(2)}deg) rotateX(${(-tilt.y).toFixed(2)}deg) rotate(${(tilt.x * 0.2).toFixed(2)}deg)`;
}

const AI_NAMES: Record<AIProvider, string> = { claude: 'Claude', chatgpt: 'ChatGPT' };
const TRASH_PROMPT =
  'These are tabs I opened, then threw away. Look for patterns: which sites and topics keep pulling me in and eating my attention? Name my top 3 distractions, how often each shows up here, and one simple rule I could follow to beat each one.';
const isBoard = (url: string) => url.startsWith(chrome.runtime.getURL('board.html'));
const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((k) => b.has(k));
const agoLong = (ms: number) => {
  const a = ago(ms);
  return a === 'now' ? 'just now' : /\d[mhd]$/.test(a) ? `${a} ago` : `on ${a}`;
};

function useSettings(): Settings {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  useEffect(() => {
    getSettings().then(setSettings);
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes.settings) setSettings({ ...DEFAULT_SETTINGS, ...(changes.settings.newValue as Settings) });
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);
  return settings;
}

const COL_MIN = 236;
const COL_GAP = 20;

/** How many window columns fit in an element's content box. */
function useColumnCount(ref: React.RefObject<HTMLElement | null>) {
  const [count, setCount] = useState(3);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setCount(Math.max(1, Math.floor((entry.contentRect.width + COL_GAP) / (COL_MIN + COL_GAP))));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return count;
}

/**
 * Masonry for windows. A window keeps its column while you work, so saving tabs
 * out of it never makes it jump; new windows go to the shortest column.
 */
function useStickyColumns<T extends { id: number | string; tabs: unknown[] }>(items: T[], count: number): T[][] {
  const placed = useRef<{ count: number; map: Map<number | string, number> }>({ count, map: new Map() });
  return useMemo(() => {
    if (placed.current.count !== count) placed.current = { count, map: new Map() };
    const { map } = placed.current;
    const heights = Array(count).fill(0);
    const cols: T[][] = Array.from({ length: count }, () => []);
    const weight = (w: T) => 3 + w.tabs.length * 2.2;
    for (const w of items) {
      const c = map.get(w.id);
      if (c != null && c < count) heights[c] += weight(w);
    }
    for (const w of items) {
      let c = map.get(w.id);
      if (c == null || c >= count) {
        c = heights.indexOf(Math.min(...heights));
        map.set(w.id, c);
        heights[c] += weight(w);
      }
      cols[c].push(w);
    }
    return cols;
  }, [items, count]);
}

export function App() {
  const { windows, boardTab, groups: tabGroups } = useLive();
  const settings = useSettings();
  const folders = useLiveQuery(() => db.folders.toArray(), [], [] as Folder[]);
  const counts = useLiveQuery(
    async () => {
      const keys = await db.tabs.orderBy('folderId').keys();
      const map = new Map<string, number>();
      for (const k of keys) map.set(String(k), (map.get(String(k)) ?? 0) + 1);
      return map;
    },
    [],
    new Map<string, number>(),
  );
  const lastOp = useLiveQuery(() => vault.lastUndoable(), []);
  // Only saves left unfinished from before (a crash, a closed board), never one still in progress.
  const [interrupted, setInterrupted] = useState<Op[]>([]);
  useEffect(() => {
    const check = () =>
      vault.interruptedOps().then((ops) => setInterrupted(ops.filter((op) => Date.now() - op.createdAt > 20000)), () => undefined);
    check();
    const onVisible = () => document.visibilityState === 'visible' && check();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  const [view, setView] = useState<View>({ kind: 'live' });
  /** the last board (open or saved) a folder was opened from */
  const lastBoard = useRef<View>({ kind: 'live' });
  useEffect(() => {
    if (view.kind !== 'folder') lastBoard.current = view;
  }, [view]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sel, setSel] = useState<Selection>(EMPTY);
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<{ source: Source; keys: string[]; title: string; group?: string; meta?: string; favs?: string[] } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [lassoing, setLassoing] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuEntry[] } | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** live tabs whose page answered "Leave site?" when we tried to close them */
  const [unsaved, setUnsaved] = useState<Set<string>>(new Set());
  const [restore, setRestore] = useState<{ tabs: number } | null>(null);
  useEffect(() => {
    pendingRestore().then(setRestore, () => undefined);
  }, []);
  /** the window, tab group or folder held up by a long press (and dimmed while carried) */
  const [lifted, setLifted] = useState<string | null>(null);
  const [renamingGroup, setRenamingGroup] = useState<number | null>(null);
  const [intro, setIntro] = useState(false);
  const [askIncognito, setAskIncognito] = useState(false);
  useEffect(() => {
    Promise.all([chrome.extension.isAllowedIncognitoAccess(), chrome.storage.local.get('incognitoHintDismissed')]).then(
      ([allowed, { incognitoHintDismissed }]) => setAskIncognito(!allowed && !incognitoHintDismissed),
      () => undefined,
    );
  }, []);
  useEffect(() => {
    chrome.storage.local.get('onboarded').then(({ onboarded }) => setIntro(!onboarded));
  }, []);
  const finishIntro = () => {
    setIntro(false);
    chrome.storage.local.set({ onboarded: true });
  };

  const folderId = view.kind === 'folder' ? view.id : null;
  // Tagged with the folder they belong to, so a view never shows another folder's tabs, or a false "empty", while loading.
  const folderData = useLiveQuery(
    async () => (folderId ? { id: folderId, tabs: await db.tabs.where('folderId').equals(folderId).reverse().sortBy('savedAt') } : null),
    [folderId],
  );
  const folderLoaded = !folderId || folderData?.id === folderId;
  const folderTabs = useMemo(() => (folderLoaded && folderData ? folderData.tabs : []), [folderLoaded, folderData]);
  // The Saved tabs board: each folder's most recent tabs.
  const overview = useLiveQuery(
    async () => {
      if (view.kind !== 'saved') return new Map<string, SavedTab[]>();
      const ids = (await db.folders.toArray()).filter((f) => f.kind !== 'trash').map((f) => f.id);
      const lists = await Promise.all(
        ids.map((id) =>
          db.tabs.where('[folderId+savedAt]').between([id, Dexie.minKey], [id, Dexie.maxKey]).reverse().limit(PREVIEW).toArray(),
        ),
      );
      return new Map(ids.map((id, i) => [id, lists[i]]));
    },
    [view.kind],
    new Map<string, SavedTab[]>(),
  );
  // A peek inside each folder for the sidebar: the latest few favicons.
  const peeks = useLiveQuery(
    async () => {
      const ids = (await db.folders.toArray()).filter((f) => f.kind !== 'trash').map((f) => f.id);
      const lists = await Promise.all(
        ids.map((id) => db.tabs.where('[folderId+savedAt]').between([id, Dexie.minKey], [id, Dexie.maxKey]).reverse().limit(5).toArray()),
      );
      return new Map(ids.map((id, i) => [id, lists[i].map((t) => t.url)]));
    },
    [],
    new Map<string, string[]>(),
  );
  // ---------- derived ----------
  const inbox = folders.find((f) => f.id === INBOX_ID);
  const trash = folders.find((f) => f.id === TRASH_ID);
  // Oldest first, so the 1–9 shortcuts never shift when a folder is added.
  const userFolders = useMemo(() => folders.filter((f) => f.kind === 'user').sort((a, b) => a.order - b.order), [folders]);
  const folderById = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);
  const viewFolder = folderId ? folderById.get(folderId) : undefined;
  useEffect(() => {
    if (view.kind === 'folder' && folders.length && !folderById.has(view.id)) setView({ kind: 'live' });
  }, [view, folders, folderById]);

  const allWindows = windows ?? [];
  const liveById = useMemo(
    () => new Map(allWindows.flatMap((w) => w.tabs.map((t) => [String(t.id), t] as const))),
    [allWindows],
  );
  const liveCount = useMemo(() => allWindows.reduce((n, w) => n + w.tabs.filter((t) => !isBoard(liveUrl(t))).length, 0), [allWindows]);
  const savedTotal = [...counts.entries()].reduce((n, [id, c]) => (id === TRASH_ID ? n : n + c), 0);

  // This window first, then the ones untouched the longest: the likeliest to clear out.
  // Order and numbers are fixed for the session so nothing jumps while you work.
  const boardWindowId = boardTab?.windowId;
  const windowOrder = useRef({ next: 0, rank: new Map<number, number>(), number: new Map<number, number>() });
  const visibleWindows = useMemo(() => {
    const lastUsed = (w: (typeof allWindows)[number]) => Math.max(0, ...w.tabs.map((t) => t.lastAccessed ?? 0));
    const order = windowOrder.current;
    const fresh = allWindows
      .filter((w) => !order.rank.has(w.id))
      .sort((a, b) => Number(b.id === boardWindowId) - Number(a.id === boardWindowId) || lastUsed(a) - lastUsed(b));
    if (boardWindowId != null) {
      for (const w of fresh) {
        order.rank.set(w.id, order.next++);
        if (w.id !== boardWindowId) order.number.set(w.id, order.number.size + 1);
      }
    }
    const rank = (w: (typeof allWindows)[number]) => order.rank.get(w.id) ?? Infinity;
    return [...allWindows]
      .sort((a, b) => rank(a) - rank(b))
      .map((w) => ({
        ...w,
        number: order.number.get(w.id) ?? 0,
        lastUsed: lastUsed(w),
      }));
  }, [allWindows, boardWindowId]);
  const scrollRef = useRef<HTMLElement>(null);
  const columnCount = useColumnCount(scrollRef);
  const windowColumns = useStickyColumns(visibleWindows, columnCount);
  const markOf = useMemo(() => markMatcher(settings.marks), [settings.marks]);
  const lassoable = useCallback(
    (t: chrome.tabs.Tab) => !isBoard(liveUrl(t)) && (settings.lassoPinned || !t.pinned),
    [settings.lassoPinned],
  );
  const overviewGroups = useMemo(
    () =>
      [inbox, ...userFolders]
        .filter((f): f is Folder => !!f)
        .map((folder) => ({ id: folder.id, folder, tabs: overview.get(folder.id) ?? [] })),
    [inbox, userFolders, overview],
  );
  const overviewColumns = useStickyColumns(overviewGroups, columnCount);
  const savedById = useMemo(
    () => new Map([...folderTabs, ...[...overview.values()].flat()].map((t) => [t.id, t] as const)),
    [folderTabs, overview],
  );
  // Drop live keys from the selection (and from leaving rows) once their tabs are gone.
  useEffect(() => {
    const prune = (set: Set<string>) => (set.size && [...set].some((k) => !liveById.has(k)) ? new Set([...set].filter((k) => liveById.has(k))) : set);
    setLeaving(prune);
    setUnsaved(prune);
    setSel((s) => {
      if (s.source !== 'live' || !s.keys.size) return s;
      const keys = new Set([...s.keys].filter((k) => liveById.has(k)));
      return keys.size === s.keys.size ? s : { source: 'live', keys };
    });
  }, [liveById]);

  // ---------- feedback ----------
  const say = useCallback((message: string, extra: Partial<ToastState> = {}) => {
    setToast({ id: Date.now() + Math.random(), message, ...extra });
  }, []);
  const fail = useCallback((error: unknown) => {
    say(error instanceof Error ? error.message : String(error), { tone: 'error' });
  }, [say]);
  const pulse = (id: string) => {
    setFlash(id);
    setTimeout(() => setFlash((f) => (f === id ? null : f)), 700);
  };
  const copy = async (text: string, message: string) => {
    try {
      await navigator.clipboard.writeText(text);
      say(message);
    } catch {
      say('Couldn’t reach the clipboard. Click the board once and try again.', { tone: 'error' });
    }
  };

  /** Long work gets a calm spinner, but only if it outlasts 300 ms; quick work just shows its result. */
  const busyTimer = useRef<number>(0);
  const busy = async <T,>(label: string, work: () => Promise<T>): Promise<T> => {
    clearTimeout(busyTimer.current);
    busyTimer.current = window.setTimeout(() => setToast({ id: Date.now(), message: label, pending: true }), 300);
    try {
      return await work();
    } finally {
      clearTimeout(busyTimer.current);
      setToast((t) => (t?.pending ? null : t));
    }
  };

  const doUndo = async () => {
    try {
      const op = await vault.undo();
      say(op ? `Undid: ${op.label}` : 'Nothing to undo.');
    } catch (error) {
      fail(error);
    }
  };
  const undoAction = { label: 'Undo', run: () => void doUndo() };

  // An AI app changed folders through freetabs-mcp: say what happened, with a way back.
  useEffect(() => {
    const listener = (message: { type?: string; text?: string }) => {
      if (message?.type === 'ai-change' && message.text) say(message.text, { action: undoAction });
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [say]);

  // ---------- actions ----------
  const saveLive = async (tabs: chrome.tabs.Tab[], target: string, newName?: string) => {
    if (!tabs.length) return;
    const keys = tabs.map((t) => String(t.id));
    setLeaving(new Set(keys));
    try {
      const res = await busy(target === TRASH_ID ? `Closing ${plural(tabs.length, 'tab')}…` : `Saving ${plural(tabs.length, 'tab')}…`, () =>
        vault.saveAndClose(tabs, target === 'new-folder' ? { newFolderName: newName || suggestFolderName(tabs.map(liveUrl)) } : { folderId: target }),
      );
      setSel(EMPTY);
      pulse(res.folder.id);
      const done =
        res.folder.id === TRASH_ID ? `Moved ${plural(tabs.length, 'tab')} to Trash` : `Saved ${plural(tabs.length, 'tab')} to ${res.folder.name}`;
      const stuck = res.stillOpen.map(String);
      if (stuck.length) {
        // Chrome is asking "Leave site?" on these: show them again, flagged, and point at the prompt.
        setLeaving((l) => new Set([...l].filter((k) => !stuck.includes(k))));
        setUnsaved((u) => new Set([...u, ...stuck]));
        say(`${done}. ${stuck.length === 1 ? '1 page has' : `${stuck.length} pages have`} unsaved changes and stayed open.`, {
          action: { label: 'Show', run: () => void vault.focusTab(res.stillOpen[0]) },
        });
      } else {
        say(done, { action: undoAction });
      }
      if (target === 'new-folder') setRenaming(res.folder.id);
      // Leaving rows stay hidden until Chrome reports their tabs gone (see the prune effect).
    } catch (error) {
      setLeaving(new Set());
      fail(error);
    }
  };

  const moveSavedTo = async (ids: string[], target: string) => {
    try {
      const tabs = ids.map((id) => savedById.get(id)).filter((t): t is SavedTab => !!t);
      const res = await vault.moveSaved(
        ids,
        target === 'new-folder' ? { newFolderName: suggestFolderName(tabs.map((t) => t.url)) } : { folderId: target },
      );
      setSel(EMPTY);
      if (!res.moved) return;
      pulse(res.folder.id);
      say(`Moved ${plural(res.moved, 'tab')} to ${res.folder.name}`, { action: undoAction });
      if (target === 'new-folder') setRenaming(res.folder.id);
    } catch (error) {
      fail(error);
    }
  };

  const openSaved = async (ids: string[], keep: boolean, windowId?: number) => {
    try {
      const n = await busy(`Opening ${plural(ids.length, 'tab')}…`, () => vault.openSaved(ids, { keep, windowId }));
      setSel(EMPTY);
      say(keep ? `Opened ${plural(n, 'tab')}` : `Opened ${plural(n, 'tab')}. ${n === 1 ? 'It stays' : 'They stay'} in Trash for 30 days.`, keep ? {} : { action: undoAction });
    } catch (error) {
      fail(error);
    }
  };

  const performDrop = async (target: string, source: Source, keys: string[]) => {
    if (target === 'new-window') {
      if (source === 'saved') return openSaved(keys, false);
      const tabs = keys.map((k) => liveById.get(k)).filter((t): t is chrome.tabs.Tab => !!t);
      try {
        const n = await busy('Making a new window…', () => vault.moveToNewWindow(tabs));
        setSel(EMPTY);
        if (n) say(`Moved ${plural(n, 'tab')} to a new window`, { action: undoAction });
      } catch (error) {
        fail(error);
      }
      return;
    }
    const groupId = target.startsWith('group:') ? Number(target.slice(6)) : undefined;
    const windowId = target.startsWith('window:') ? Number(target.slice(7)) : groupId != null ? tabGroups.get(groupId)?.windowId : undefined;
    const folder = target.startsWith('folder:') ? target.slice(7) : target;
    if (source === 'live') {
      const tabs = keys.map((k) => liveById.get(k)).filter((t): t is chrome.tabs.Tab => !!t);
      if (groupId != null) {
        try {
          const n = await vault.addToGroup(tabs, groupId);
          setSel(EMPTY);
          say(n ? `Added ${plural(n, 'tab')} to ${tabGroups.get(groupId)?.title || 'the group'}` : 'Those tabs are already in that group.', n ? { action: undoAction } : {});
        } catch (error) {
          fail(error);
        }
        return;
      }
      if (windowId != null) {
        try {
          const n = await vault.moveLive(tabs, windowId);
          setSel(EMPTY);
          say(n ? `Moved ${plural(n, 'tab')} to another window` : 'Those tabs can’t move there. Incognito and normal tabs stay apart.', n ? { action: undoAction } : {});
        } catch (error) {
          fail(error);
        }
        return;
      }
      return saveLive(tabs, folder);
    }
    if (windowId != null) return openSaved(keys, false, windowId);
    return moveSavedTo(keys, folder);
  };

  /** Live tabs of a window or tab group being carried. */
  const tabsOfGroup = (group: string): chrome.tabs.Tab[] => {
    const [kind, raw] = group.split(':');
    const id = Number(raw);
    const all = allWindows.flatMap((w) => w.tabs).filter((t) => !isBoard(liveUrl(t)));
    if (kind === 'window') return all.filter((t) => t.windowId === id);
    if (kind === 'tgroup') return all.filter((t) => t.groupId === id);
    return [];
  };
  const groupName = (group: string): string => {
    const [kind, raw] = group.split(':');
    if (kind === 'folder') return folderById.get(raw)?.name ?? 'Folder';
    if (kind === 'tgroup') return tabGroups.get(Number(raw))?.title || 'Tab group';
    const w = visibleWindows.find((w) => w.id === Number(raw));
    return w ? windowName(w) : 'Window';
  };

  /** A whole window, tab group or folder was dropped somewhere. */
  const performGroupDrop = async (group: string, target: string) => {
    if (group.startsWith('folder:')) {
      if (target === 'new-window' || target.startsWith('window:')) {
        // A folder dropped on the board comes back out as tabs: in that window, or a new one.
        const ids = await db.tabs.where('folderId').equals(group.slice(7)).primaryKeys();
        if (ids.length) await openSaved(ids, false, target.startsWith('window:') ? Number(target.slice(7)) : undefined);
        return;
      }
      if (!target.startsWith('folder:')) return;
      try {
        const res = await vault.mergeFolder(group.slice(7), target.slice(7));
        if (!res) return;
        pulse(res.target.id);
        say(
          res.target.id === TRASH_ID
            ? `Deleted ${groupName(group)}. Its tabs are in Trash.`
            : `Moved ${groupName(group)} into ${res.target.name}`,
          { action: undoAction },
        );
      } catch (error) {
        fail(error);
      }
      return;
    }
    const tabs = tabsOfGroup(group);
    if (!tabs.length) return;
    if (target === 'new-window') return performDrop(target, 'live', tabs.map((t) => String(t.id)));
    if (target.startsWith('window:') || target.startsWith('group:')) {
      if (target.startsWith('group:') && group.startsWith('tgroup:')) return;
      return performDrop(target, 'live', tabs.map((t) => String(t.id)));
    }
    const title = group.startsWith('tgroup:') ? tabGroups.get(Number(group.slice(7)))?.title : undefined;
    return saveLive(tabs, target.startsWith('folder:') ? target.slice(7) : target, title || undefined);
  };

  const groupMenu = (groupId: number, x: number, y: number) => {
    const g = tabGroups.get(groupId);
    const tabs = tabsOfGroup(`tgroup:${groupId}`);
    const n = tabs.length;
    const name = g?.title || 'Tab group';
    const now = Date.now();
    const groups = [{ name, tabs: tabs.map((t) => ({ url: liveUrl(t), title: t.title ?? '', incognito: !!t.incognito, savedAt: now })) }];
    const items: MenuEntry[] = [
      { heading: `Save all ${plural(n, 'tab')} to` },
      { label: g?.title ? `A new folder, “${g.title}”` : 'A new folder', inset: true, run: () => saveLive(tabs, 'new-folder', g?.title || undefined) },
      ...[inbox, ...userFolders]
        .filter((f): f is Folder => !!f)
        .map<MenuEntry>((f) => ({ label: f.name, inset: true, run: () => saveLive(tabs, f.id) })),
      'sep',
      { label: 'Rename', run: () => setRenamingGroup(groupId) },
      { swatches: true, palette: 'group', current: g?.color ?? null, pick: (color) => color && chrome.tabGroups.update(groupId, { color: color as chrome.tabGroups.TabGroup['color'] }) },
      { label: g?.collapsed ? 'Expand in Chrome' : 'Collapse in Chrome', run: () => chrome.tabGroups.update(groupId, { collapsed: !g?.collapsed }) },
      { label: 'Move to a new window', run: () => performDrop('new-window', 'live', tabs.map((t) => String(t.id))) },
      'sep',
      { label: 'Copy as links', run: () => copy(toLinks(groups), `Copied ${plural(n, 'link')}`) },
      { label: 'Copy as Markdown', run: () => copy(toMarkdown(groups), `Copied ${name} as Markdown`) },
      {
        label: 'Copy for AI',
        run: () => copy(toAI(groups, { prompt: settings.aiPrompt, aiSeesIncognito: settings.aiSeesIncognito }), `Copied ${plural(n, 'tab')} for AI`),
      },
      'sep',
      { label: 'Ungroup', run: () => chrome.tabs.ungroup(tabs.map((t) => t.id!) as [number, ...number[]]).then(() => say(`Ungrouped ${name}`), fail) },
      { label: 'Move all to Trash', danger: true, run: () => saveLive(tabs, TRASH_ID) },
    ];
    setMenu({ x, y, items });
  };

  const groupSelection = async (current: Selection = sel) => {
    const tabs = [...current.keys].map((k) => liveById.get(k)).filter((t): t is chrome.tabs.Tab => !!t);
    if (!tabs.length || current.source !== 'live') return;
    try {
      const res = await vault.groupLive(tabs);
      if (!res) return;
      setSel(EMPTY);
      setRenamingGroup(res.groupId);
      say(`Grouped ${plural(res.count, 'tab')}`, { action: undoAction });
    } catch (error) {
      fail(error);
    }
  };

  const trashSelection = (current: Selection = sel) => {
    const keys = [...current.keys];
    if (!keys.length) return;
    if (current.source === 'live') return saveLive(keys.map((k) => liveById.get(k)!).filter(Boolean), TRASH_ID);
    if (folderId === TRASH_ID) {
      return vault.deleteForever(keys).then(() => {
        setSel(EMPTY);
        say(`Deleted ${plural(keys.length, 'tab')}`, { action: undoAction });
      }, fail);
    }
    return moveSavedTo(keys, TRASH_ID);
  };

  const askAI = (provider: AIProvider, groups: ExportGroup[]) =>
    askAIText(
      provider,
      toAI(groups, { prompt: settings.aiPrompt, aiSeesIncognito: settings.aiSeesIncognito }),
      groups.reduce((s, g) => s + g.tabs.length, 0),
    );

  /** Trash, read by an AI: what keeps pulling you away. */
  const trashReview = (tabs: SavedTab[]) => toAI([{ name: 'Trash', tabs }], { prompt: TRASH_PROMPT, aiSeesIncognito: settings.aiSeesIncognito });

  const askAIText = async (provider: AIProvider, text: string, n: number) => {
    const { url, prefilled } = aiChatUrl(provider, text);
    try {
      if (!prefilled) await navigator.clipboard.writeText(text);
      await chrome.tabs.create({ url, windowId: boardTab?.windowId, index: (boardTab?.index ?? 0) + 1 });
      say(prefilled ? `Opened ${AI_NAMES[provider]} with ${plural(n, 'tab')}` : `Copied ${plural(n, 'tab')}. Paste them into ${AI_NAMES[provider]}.`);
    } catch (error) {
      fail(error);
    }
  };

  const groupsForSelection = (sel: Selection): ExportGroup[] => {
    if (sel.source === 'live') {
      const now = Date.now();
      return [
        {
          name: 'Selected tabs',
          tabs: [...sel.keys]
            .map((k) => liveById.get(k))
            .filter((t): t is chrome.tabs.Tab => !!t)
            .map((t) => ({ url: liveUrl(t), title: t.title ?? '', incognito: !!t.incognito, savedAt: now })),
        },
      ];
    }
    const tabs = [...sel.keys].map((k) => savedById.get(k)).filter((t): t is SavedTab => !!t);
    return [{ name: viewFolder?.name ?? 'Selected tabs', tabs }];
  };

  const folderMenu = async (folder: Folder, x: number, y: number) => {
    const tabs = await db.tabs.where('folderId').equals(folder.id).reverse().sortBy('savedAt');
    const groups = [{ name: folder.name, tabs }];
    const ids = tabs.map((t) => t.id);
    const n = tabs.length;
    const copyItems: MenuEntry[] = [
      { label: 'Copy as links', run: () => copy(toLinks(groups), `Copied ${plural(n, 'link')}`), disabled: !n },
      { label: 'Copy as Markdown', run: () => copy(toMarkdown(groups), `Copied ${folder.name} as Markdown`), disabled: !n },
      {
        label: 'Copy for AI',
        run: () => copy(toAI(groups, { prompt: settings.aiPrompt, aiSeesIncognito: settings.aiSeesIncognito }), `Copied ${plural(n, 'tab')} for AI`),
        disabled: !n,
      },
      'sep',
      { label: 'Ask Claude', run: () => askAI('claude', groups), disabled: !n },
      { label: 'Ask ChatGPT', run: () => askAI('chatgpt', groups), disabled: !n },
      'sep',
    ];
    let items: MenuEntry[];
    if (folder.kind === 'trash') {
      const review = trashReview(tabs);
      items = [
        { label: 'Copy for AI: find my distractions', run: () => copy(review, `Copied ${plural(n, 'tab')} for AI`), disabled: !n },
        { label: 'Ask Claude about my distractions', run: () => askAIText('claude', review, n), disabled: !n },
        'sep',
        { label: 'Open all in a new window', run: () => openSaved(ids, true), disabled: !n },
        'sep',
        { label: 'Empty Trash', danger: true, run: () => vault.emptyTrash().then(() => say('Emptied Trash', { action: undoAction }), fail), disabled: !n },
      ];
    } else {
      items = [
        ...copyItems,
        { label: 'Restore all in a new window', run: () => openSaved(ids, false), disabled: !n },
        { label: 'Restore and keep saved', run: () => openSaved(ids, true), disabled: !n },
        ...(folder.kind === 'user'
          ? ([
              'sep',
              { label: 'Rename', run: () => setRenaming(folder.id) },
              { swatches: true, current: folder.color, pick: (color) => vault.updateFolder(folder.id, { color }) },
              {
                label: 'Delete folder',
                danger: true,
                run: () => vault.deleteFolder(folder.id).then(() => say(`Deleted ${folder.name}. Its tabs are in Trash.`, { action: undoAction }), fail),
              },
            ] satisfies MenuEntry[])
          : []),
      ];
    }
    setMenu({ x, y, items });
  };

  const windowMenu = (w: { tabs: chrome.tabs.Tab[] }, name: string, x: number, y: number) => {
    const own = w.tabs.filter((t) => !isBoard(liveUrl(t)));
    const n = own.length;
    const now = Date.now();
    const groups = [{ name, tabs: own.map((t) => ({ url: liveUrl(t), title: t.title ?? '', incognito: !!t.incognito, savedAt: now })) }];
    const items: MenuEntry[] = [
      { heading: `Save all ${plural(n, 'tab')} to` },
      { label: 'A new folder', inset: true, disabled: !n, run: () => saveLive(own, 'new-folder') },
      ...[inbox, ...userFolders]
        .filter((f): f is Folder => !!f)
        .map<MenuEntry>((f) => ({ label: f.name, inset: true, disabled: !n, run: () => saveLive(own, f.id) })),
      'sep',
      { label: 'Copy as links', disabled: !n, run: () => copy(toLinks(groups), `Copied ${plural(n, 'link')}`) },
      { label: 'Copy as Markdown', disabled: !n, run: () => copy(toMarkdown(groups), `Copied ${name} as Markdown`) },
      {
        label: 'Copy for AI',
        disabled: !n,
        run: () => copy(toAI(groups, { prompt: settings.aiPrompt, aiSeesIncognito: settings.aiSeesIncognito }), `Copied ${plural(n, 'tab')} for AI`),
      },
      'sep',
      { label: 'Move all to Trash', danger: true, disabled: !n, run: () => saveLive(own, TRASH_ID) },
    ];
    setMenu({ x, y, items });
  };

  const selectionMenu = (x: number, y: number, sel: Selection) => {
    const groups = groupsForSelection(sel);
    const n = sel.keys.size;
    const keys = [...sel.keys];
    const copyItems: MenuEntry[] = [
      { label: 'Copy as links', run: () => copy(toLinks(groups), `Copied ${plural(n, 'link')}`) },
      { label: 'Copy as Markdown', run: () => copy(toMarkdown(groups), `Copied ${plural(n, 'tab')} as Markdown`) },
      {
        label: 'Copy for AI',
        run: () => copy(toAI(groups, { prompt: settings.aiPrompt, aiSeesIncognito: settings.aiSeesIncognito }), `Copied ${plural(n, 'tab')} for AI`),
      },
    ];
    const items: MenuEntry[] =
      sel.source === 'live'
        ? [
            { label: `Save ${plural(n, 'tab')} to Inbox`, run: () => performDrop(`folder:${INBOX_ID}`, 'live', keys) },
            { label: 'Save to a new folder', hint: 'N', run: () => performDrop('new-folder', 'live', keys) },
            { label: 'Move to Trash', hint: '⌫', run: () => trashSelection(sel) },
            'sep',
            { label: 'Create tab group', hint: 'G', run: () => groupSelection(sel) },
            ...(keys.some((k) => (liveById.get(k)?.groupId ?? -1) !== -1)
              ? [
                  {
                    label: 'Remove from group',
                    run: () =>
                      chrome.tabs
                        .ungroup(keys.map(Number) as [number, ...number[]])
                        .then(() => say(`Removed ${plural(n, 'tab')} from their group`), fail),
                  } satisfies MenuEntry,
                ]
              : []),
            'sep',
            ...copyItems,
          ]
        : folderId === TRASH_ID
          ? [
              { label: 'Put back', run: () => vault.restoreFromTrash(keys).then((c) => { setSel(EMPTY); say(`Put back ${plural(c, 'tab')}`, { action: undoAction }); }, fail) },
              { label: 'Open', run: () => openSaved(keys, true) },
              'sep',
              { label: 'Delete forever', hint: '⌫', danger: true, run: () => trashSelection(sel) },
            ]
          : [
              { label: 'Open', run: () => openSaved(keys, true) },
              { label: 'Open and move to Trash', run: () => openSaved(keys, false) },
              'sep',
              ...copyItems,
              'sep',
              { label: 'Move to Trash', hint: '⌫', run: () => trashSelection(sel) },
            ];
    setMenu({ x, y, items });
  };

  /** ⌘A: everything in the hovered window or folder, else everything in view. */
  const selectAll = (hovered: string | null) => {
    if (view.kind === 'folder') {
      setSel({ source: 'saved', keys: new Set(folderTabs.map((t) => t.id)) });
      return;
    }
    if (view.kind === 'saved') {
      const pool = overviewGroups.filter((g) => hovered == null || hovered === `folder:${g.id}`);
      setSel({ source: 'saved', keys: new Set(pool.flatMap((g) => g.tabs.map((t) => t.id))) });
      return;
    }
    const pool = visibleWindows.filter((w) => hovered == null || hovered === `window:${w.id}`);
    setSel({ source: 'live', keys: new Set(pool.flatMap((w) => w.tabs.filter(lassoable).map((t) => String(t.id)))) });
  };

  // Ordered keys of the list a row belongs to, for shift-click ranges.
  const listOf = (key: string, source: Source): string[] => {
    if (source === 'live') {
      const w = visibleWindows.find((w) => w.tabs.some((t) => String(t.id) === key));
      return w ? w.tabs.filter((t) => !isBoard(liveUrl(t))).map((t) => String(t.id)) : [key];
    }
    if (view.kind === 'folder') return folderTabs.map((t) => t.id);
    const group = overviewGroups.find((g) => g.tabs.some((t) => t.id === key));
    return group ? group.tabs.map((t) => t.id) : [key];
  };

  const anchor = useRef<string | null>(null);
  const clickRow = (key: string, source: Source, meta: boolean, shift: boolean) => {
    if (meta) {
      setSel((s) => {
        const keys = new Set(s.source === source ? s.keys : []);
        keys.has(key) ? keys.delete(key) : keys.add(key);
        return { source, keys };
      });
      anchor.current = key;
      return;
    }
    if (shift && anchor.current) {
      const list = listOf(key, source);
      const a = list.indexOf(anchor.current);
      const b = list.indexOf(key);
      if (a !== -1 && b !== -1) {
        const range = list.slice(Math.min(a, b), Math.max(a, b) + 1);
        setSel((s) => ({ source, keys: new Set([...(s.source === source ? s.keys : []), ...range]) }));
        return;
      }
    }
    setSel({ source, keys: new Set([key]) });
    anchor.current = key;
  };

  const openRow = (key: string, source: Source) => {
    if (source === 'live') {
      const tab = liveById.get(key);
      if (tab?.id == null) return;
      chrome.tabs.update(tab.id, { active: true });
      chrome.windows.update(tab.windowId, { focused: true });
    } else {
      openSaved([key], true);
    }
  };

  const titleFor = (key: string, source: Source) =>
    source === 'live' ? (liveById.get(key)?.title ?? '') : (savedById.get(key)?.title ?? '');

  // ---------- pointer engine: click, lasso and drag share one gesture ----------
  const rootRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const lassoRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const pointer = useRef({ x: 0, y: 0 });
  /** the window or folder group under the pointer, for ⌘A */
  const hoverGroup = useRef<string | null>(null);

  // Handlers read the latest render through this ref; listeners attach once.
  const liftGroup = (group: string) => {
    setLifted(group);
    if (!group.startsWith('folder:')) setSel({ source: 'live', keys: new Set(tabsOfGroup(group).map((t) => String(t.id))) });
  };
  const startGroupDrag = (group: string) => {
    const tabs = tabsOfGroup(group);
    const count = group.startsWith('folder:') ? (counts.get(group.slice(7)) ?? 0) : tabs.length;
    const favs = group.startsWith('folder:') ? (peeks.get(group.slice(7)) ?? []) : tabs.map(liveUrl).slice(0, 5);
    setLifted(group);
    setDrag({ source: group.startsWith('folder:') ? 'saved' : 'live', keys: [], title: groupName(group), group, meta: plural(count, 'tab'), favs });
  };
  const api = useRef({ sel, view, clickRow, openRow, performDrop, performGroupDrop, liftGroup, startGroupDrag, setLifted, titleFor, setSel, trashSelection, groupSelection, selectAll, doUndo, userFolders, folderId });
  api.current = { sel, view, clickRow, openRow, performDrop, performGroupDrop, liftGroup, startGroupDrag, setLifted, titleFor, setSel, trashSelection, groupSelection, selectAll, doUndo, userFolders, folderId };

  useEffect(() => {
    const root = rootRef.current!;
    let frame = 0;
    /** a long press or a carry ends with a click we don't want (it would open the folder) */
    let suppressClick = false;
    const tilt = { x: 0, y: 0 };
    const velocity = { x: 0, y: 0 };

    const dropAt = (x: number, y: number, source: Source, group?: string): string | null => {
      const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-drop]');
      const target = el?.dataset.drop ?? null;
      if (!target || target === group) return null;
      if (group?.startsWith('folder:')) return target.startsWith('folder:') || target.startsWith('window:') || target === 'new-window' ? target : null;
      if (group?.startsWith('tgroup:') && target.startsWith('group:')) return null;
      // A whole window is already a window.
      if (group?.startsWith('window:') && target === 'new-window') return null;
      if (source === 'saved' && (target === `folder:${api.current.folderId}` || target.startsWith('group:'))) return null;
      return target;
    };

    const placeGhost = () => placeGhostAt(ghostRef.current, pointer.current, tilt);

    const paintLasso = () => {
      const g = gesture.current;
      const scroller = scrollRef.current;
      if (g?.kind !== 'lasso' || !scroller) return;
      const sr = scroller.getBoundingClientRect();
      const startY = g.startContentY + sr.top - scroller.scrollTop;
      const { x, y } = pointer.current;
      const left = Math.min(g.startX, x);
      const right = Math.max(g.startX, x);
      const top = Math.max(sr.top, Math.min(startY, y));
      const bottom = Math.min(sr.bottom, Math.max(startY, y));
      const el = lassoRef.current;
      if (el) {
        el.style.transform = `translate3d(${left}px, ${top}px, 0)`;
        el.style.width = `${right - left}px`;
        el.style.height = `${Math.max(0, bottom - top)}px`;
      }
      const fullTop = Math.min(startY, y);
      const fullBottom = Math.max(startY, y);
      const hits = new Set(g.base);
      for (const row of g.rows) {
        const r = row.getBoundingClientRect();
        if (r.right > left && r.left < right && r.bottom > fullTop && r.top < fullBottom) hits.add(row.dataset.row!);
      }
      const cur = api.current.sel;
      if (cur.source !== g.source || !sameSet(cur.keys, hits)) api.current.setSel({ source: g.source, keys: hits });
    };

    // Scroll the board while dragging or lassoing near its top or bottom edge.
    const tick = () => {
      frame = 0;
      const g = gesture.current;
      const scroller = scrollRef.current;
      if (!g || g.kind === 'press' || g.kind === 'grab' || !scroller) return;
      if (g.kind === 'drag') {
        // Ease the tilt toward the pointer's speed, and back to flat when it rests.
        const still = reducedMotion();
        tilt.x += ((still ? 0 : Math.max(-16, Math.min(16, velocity.x * 1.4))) - tilt.x) * 0.22;
        tilt.y += ((still ? 0 : Math.max(-10, Math.min(10, velocity.y * 0.9))) - tilt.y) * 0.22;
        velocity.x *= 0.7;
        velocity.y *= 0.7;
        placeGhost();
      }
      const r = scroller.getBoundingClientRect();
      const { x, y } = pointer.current;
      let dy = 0;
      if (y < r.top + 56) dy = -Math.min(24, Math.ceil((r.top + 56 - y) / 3));
      else if (y > r.bottom - 56) dy = Math.min(24, Math.ceil((y - r.bottom + 56) / 3));
      if (dy && x > r.left && x < r.right) {
        scroller.scrollTop += dy;
        if (g.kind === 'lasso') paintLasso();
      }
      frame = requestAnimationFrame(tick);
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      suppressClick = false;
      const target = e.target as HTMLElement;
      const grab = target.closest<HTMLElement>('[data-grab]');
      if (grab && !target.closest('.win__more, input, .menu, dialog')) {
        pointer.current = { x: e.clientX, y: e.clientY };
        const group = grab.dataset.grab!;
        const g: Gesture = { kind: 'grab', group, x: e.clientX, y: e.clientY, timer: 0, lifted: false };
        g.timer = window.setTimeout(() => {
          if (gesture.current !== g) return;
          g.lifted = true;
          api.current.liftGroup(group);
        }, 280);
        gesture.current = g;
        return;
      }
      if (target.closest('input, textarea, button, a, select, dialog, .menu, [data-no-lasso]')) return;
      pointer.current = { x: e.clientX, y: e.clientY };
      const row = target.closest<HTMLElement>('[data-row]');
      if (row) {
        const key = row.dataset.row!;
        const source = row.dataset.source as Source;
        const { sel } = api.current;
        gesture.current = {
          kind: 'press',
          key,
          source,
          x: e.clientX,
          y: e.clientY,
          meta: e.metaKey || e.ctrlKey,
          shift: e.shiftKey,
          wasSelected: sel.source === source && sel.keys.has(key),
        };
        return;
      }
      const scroller = scrollRef.current;
      if (scroller && target.closest('[data-lasso-zone]')) {
        const source: Source = api.current.view.kind === 'live' ? 'live' : 'saved';
        const additive = e.metaKey || e.ctrlKey || e.shiftKey;
        const { sel } = api.current;
        const sr = scroller.getBoundingClientRect();
        gesture.current = {
          kind: 'lasso',
          source,
          startX: e.clientX,
          startContentY: e.clientY - sr.top + scroller.scrollTop,
          base: additive && sel.source === source ? new Set(sel.keys) : new Set(),
          rows: [...scroller.querySelectorAll<HTMLElement>(`[data-row][data-source="${source}"][data-lassoable="true"]`)],
          moved: false,
        };
      }
    };

    const onMove = (e: PointerEvent) => {
      velocity.x += e.clientX - pointer.current.x;
      velocity.y += e.clientY - pointer.current.y;
      pointer.current = { x: e.clientX, y: e.clientY };
      const g = gesture.current;
      if (!g) {
        hoverGroup.current = (e.target as HTMLElement).closest?.<HTMLElement>('.win[data-drop]')?.dataset.drop ?? null;
        return;
      }
      if (g.kind === 'grab') {
        if (Math.hypot(e.clientX - g.x, e.clientY - g.y) < 5) return;
        clearTimeout(g.timer);
        suppressClick = true;
        tilt.x = tilt.y = 0;
        gesture.current = { kind: 'drag', source: g.group.startsWith('folder:') ? 'saved' : 'live', keys: [], over: null, group: g.group };
        api.current.startGroupDrag(g.group);
        document.body.dataset.dragging = 'true';
        frame ||= requestAnimationFrame(tick);
        return;
      }
      if (g.kind === 'press') {
        if (Math.hypot(e.clientX - g.x, e.clientY - g.y) < 5) return;
        tilt.x = tilt.y = 0;
        const { sel } = api.current;
        let keys: string[];
        if (g.wasSelected) keys = [...sel.keys];
        else if (g.meta && sel.source === g.source) keys = [...sel.keys, g.key];
        else keys = [g.key];
        api.current.setSel({ source: g.source, keys: new Set(keys) });
        gesture.current = { kind: 'drag', source: g.source, keys, over: null };
        setDrag({ source: g.source, keys, title: api.current.titleFor(g.key, g.source) });
        document.body.dataset.dragging = 'true';
        frame ||= requestAnimationFrame(tick);
        return;
      }
      if (g.kind === 'drag') {
        placeGhost();
        const target = dropAt(e.clientX, e.clientY, g.source, g.group);
        if (target !== g.over) {
          g.over = target;
          setOver(target);
        }
        return;
      }
      if (!g.moved) {
        if (Math.hypot(e.clientX - g.startX, e.clientY - (g.startContentY + scrollRef.current!.getBoundingClientRect().top - scrollRef.current!.scrollTop)) < 5) return;
        g.moved = true;
        setLassoing(true);
        frame ||= requestAnimationFrame(tick);
      }
      paintLasso();
    };

    const end = (e: PointerEvent, cancelled: boolean) => {
      const g = gesture.current;
      gesture.current = null;
      cancelAnimationFrame(frame);
      frame = 0;
      delete document.body.dataset.dragging;
      if (!g) return;
      if (g.kind === 'grab') {
        clearTimeout(g.timer);
        if (g.lifted) {
          // Held, then let go in place: it stays selected, ready for a menu or a key.
          suppressClick = true;
          api.current.setLifted(null);
        }
        return;
      }
      if (g.kind === 'press') {
        if (!cancelled) api.current.clickRow(g.key, g.source, g.meta, g.shift);
        return;
      }
      if (g.kind === 'drag') {
        setDrag(null);
        setOver(null);
        if (!cancelled) {
          const target = dropAt(e.clientX, e.clientY, g.source, g.group);
          if (target && g.group) api.current.performGroupDrop(g.group, target);
          else if (target) api.current.performDrop(target, g.source, g.keys);
        }
        if (g.group) api.current.setLifted(null);
        return;
      }
      setLassoing(false);
      if (!g.moved && !cancelled) api.current.setSel(EMPTY);
    };
    const onUp = (e: PointerEvent) => end(e, false);
    const onCancel = (e: PointerEvent) => end(e, true);
    const onKeyEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && gesture.current) {
        // Cancel the drag or lasso, keep the selection.
        e.stopPropagation();
        const g = gesture.current;
        if (g.kind === 'grab') clearTimeout(g.timer);
        gesture.current = null;
        setDrag(null);
        setOver(null);
        setLassoing(false);
        api.current.setLifted(null);
        delete document.body.dataset.dragging;
      }
    };
    const onClickCapture = (e: MouseEvent) => {
      if (!suppressClick) return;
      suppressClick = false;
      e.stopPropagation();
      e.preventDefault();
    };

    root.addEventListener('pointerdown', onDown);
    root.addEventListener('click', onClickCapture, true);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKeyEsc, true);
    return () => {
      root.removeEventListener('pointerdown', onDown);
      root.removeEventListener('click', onClickCapture, true);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKeyEsc, true);
      cancelAnimationFrame(frame);
    };
  }, []);

  useLayoutEffect(() => {
    if (drag) placeGhostAt(ghostRef.current, pointer.current);
  }, [drag, over]);

  // ---------- keyboard ----------
  const searchRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, dialog, .palette')) return;
      const a = api.current;
      const mod = e.metaKey || e.ctrlKey;
      if ((e.key === '/' || (e.key === 'Enter' && !a.sel.keys.size)) && !mod && !e.shiftKey) {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        a.doUndo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        a.selectAll(hoverGroup.current);
        return;
      }
      if (e.key === 'Escape') {
        a.setSel(EMPTY);
        return;
      }
      if (!a.sel.keys.size || mod || e.altKey) return;
      const keys = [...a.sel.keys];
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        a.trashSelection();
      } else if (/^[1-9]$/.test(e.key)) {
        const folder = a.userFolders[Number(e.key) - 1];
        if (folder) a.performDrop(`folder:${folder.id}`, a.sel.source, keys);
      } else if (e.key.toLowerCase() === 'n') {
        e.preventDefault();
        a.performDrop('new-folder', a.sel.source, keys);
      } else if (e.key.toLowerCase() === 'g' && a.sel.source === 'live') {
        e.preventDefault();
        a.groupSelection();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---------- render ----------
  const onContextMenu = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea')) return;
    const folderEl = target.closest<HTMLElement>('[data-folder]');
    if (folderEl) {
      e.preventDefault();
      const folder = folderById.get(folderEl.dataset.folder!);
      if (folder) folderMenu(folder, e.clientX, e.clientY);
      return;
    }
    const groupHead = target.closest<HTMLElement>('[data-group-head]');
    if (groupHead) {
      e.preventDefault();
      groupMenu(Number(groupHead.dataset.groupHead), e.clientX, e.clientY);
      return;
    }
    const head = target.closest<HTMLElement>('[data-window-head]');
    if (head) {
      e.preventDefault();
      const w = visibleWindows.find((w) => w.id === Number(head.dataset.windowHead));
      if (w) windowMenu(w, windowName(w), e.clientX, e.clientY);
      return;
    }
    const row = target.closest<HTMLElement>('[data-row]');
    if (row) {
      e.preventDefault();
      const key = row.dataset.row!;
      const source = row.dataset.source as Source;
      const current = sel.source === source && sel.keys.has(key) ? sel : { source, keys: new Set([key]) };
      if (current !== sel) setSel(current);
      selectionMenu(e.clientX, e.clientY, current);
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>('[data-group-chip]');
    if (chip) {
      setRenamingGroup(Number(chip.dataset.groupChip));
      return;
    }
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-row]');
    if (row) openRow(row.dataset.row!, row.dataset.source as Source);
  };

  const show = (next: View) => {
    setView(next);
    setSel(EMPTY);
  };
  const windowName = (w: { id: number; number: number }) => (w.id === boardWindowId ? 'This window' : `Window ${w.number}`);
  const menuAt = (e: React.MouseEvent<HTMLElement>, open: (x: number, y: number) => void) => {
    const r = e.currentTarget.getBoundingClientRect();
    open(r.right - 230, r.bottom + 6);
  };

  const onSidebarClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('input')) return;
    const folderEl = target.closest<HTMLElement>('[data-folder]');
    if (folderEl) {
      const id = folderEl.dataset.folder!;
      // Clicking the folder you're in (Trash included) takes you back where you were.
      show(folderId === id ? lastBoard.current : { kind: 'folder', id });
      return;
    }
    if (target.closest('.vault__head')) {
      show({ kind: 'saved' });
      return;
    }
    if (target.closest('[data-drop="new-folder"]')) {
      vault.createFolder('New folder').then((f) => setRenaming(f.id), fail);
    }
  };

  const finishRename = (id: string, name: string | null) => {
    setRenaming(null);
    if (name != null) vault.updateFolder(id, { name }).catch(fail);
  };

  const dropHint = (() => {
    if (!drag) return '';
    if (drag.group) {
      if (!over) return '';
      if (over === 'new-window') return drag.group.startsWith('folder:') ? 'Open everything in a new window' : 'Move to a new window';
      if (drag.group.startsWith('folder:') && over.startsWith('window:')) return 'Open everything in this window';
      const name = over.startsWith('folder:') ? (folderById.get(over.slice(7))?.name ?? 'folder') : '';
      if (drag.group.startsWith('folder:')) return over === `folder:${TRASH_ID}` ? 'Delete folder (tabs go to Trash)' : `Move everything into ${name}`;
      if (over === 'new-folder') return 'Save all to a new folder';
      if (over === `folder:${TRASH_ID}`) return 'Move all to Trash';
      if (over.startsWith('folder:')) return `Save all to ${name}`;
      if (over.startsWith('group:')) return `Add all to ${tabGroups.get(Number(over.slice(6)))?.title || 'this group'}`;
      return drag.group.startsWith('tgroup:') ? 'Move the group to this window' : 'Move all tabs to this window';
    }
    const n = drag.keys.length;
    const what = n > 1 ? ` ${n} tabs` : '';
    if (!over) return n > 1 ? `${n} tabs` : '';
    const verb = drag.source === 'live' ? 'Save' : 'Move';
    if (over === 'new-window') return drag.source === 'live' ? `Move${what} to a new window` : `Open${what} in a new window`;
    if (over === 'new-folder') return `${verb}${what} to a new folder`;
    if (over === `folder:${TRASH_ID}`) return `Move${what} to Trash`;
    if (over.startsWith('folder:')) return `${verb}${what} to ${folderById.get(over.slice(7))?.name ?? 'folder'}`;
    if (over.startsWith('group:')) return `Add${what} to ${tabGroups.get(Number(over.slice(6)))?.title || 'this group'}`;
    return drag.source === 'live' ? `Move${what} to this window` : `Open${what} in this window`;
  })();

  // The pill's indicator follows the active view; the first placement doesn't animate.
  const pillRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const pill = pillRef.current;
    const glow = pill?.querySelector<HTMLElement>('.pill__glow');
    const active = pill?.querySelector<HTMLElement>('.pill__seg[aria-current]');
    if (!pill || !glow || !active) return;
    glow.style.transform = `translateX(${active.offsetLeft - 3}px)`;
    glow.style.width = `${active.offsetWidth}px`;
    if (!pill.dataset.ready) requestAnimationFrame(() => (pill.dataset.ready = 'true'));
  }, [view.kind]);

  const closeToast = useCallback(() => setToast(null), []);
  const showDigits = sel.keys.size > 0;
  const liveSel = sel.source === 'live' ? sel.keys : null;
  const savedSel = sel.source === 'saved' ? sel.keys : null;

  /** Chrome keeps a group's tabs together, so a window is runs of loose tabs and groups. */
  const segment = (tabs: chrome.tabs.Tab[]) => {
    const parts: { groupId: number | null; tabs: chrome.tabs.Tab[] }[] = [];
    for (const t of tabs) {
      const gid = t.groupId != null && t.groupId !== -1 ? t.groupId : null;
      const last = parts.at(-1);
      if (gid != null && last?.groupId === gid) last.tabs.push(t);
      else parts.push({ groupId: gid, tabs: [t] });
    }
    return parts;
  };

  const renderLiveRow = (t: chrome.tabs.Tab, windowId: number) =>
    isBoard(liveUrl(t)) ? (
      <div className="row row--here" key={t.id}>
        <span className="fav fav--here" aria-hidden="true" />
        <span className="row__title">FreeTabs</span>
        <span className="row__meta">You are here</span>
      </div>
    ) : (
      <Row
        key={t.id}
        rowKey={String(t.id)}
        source="live"
        url={liveUrl(t)}
        title={t.title ?? ''}
        selected={!!liveSel?.has(String(t.id))}
        lassoable={lassoable(t)}
        windowId={windowId}
        leaving={leaving.has(String(t.id))}
        pinned={t.pinned}
        audible={t.audible}
        unsaved={unsaved.has(String(t.id))}
        mark={markOf(liveUrl(t))}
      />
    );

  // A Chrome tab group inside a window: its colored name, then its tabs on a matching rail.
  const renderTabGroup = (groupId: number, tabs: chrome.tabs.Tab[], windowId: number) => {
    const g = tabGroups.get(groupId);
    const title = g?.title || 'Unnamed group';
    return (
      <div
        key={`g${groupId}`}
        className="tgroup"
        data-color={g?.color ?? 'grey'}
        data-drop={`group:${groupId}`}
        data-over={over === `group:${groupId}` || undefined}
        data-lifted={(lifted === `tgroup:${groupId}` && (drag ? 'carried' : 'held')) || undefined}
      >
        <div className="tgroup__head" data-grab={`tgroup:${groupId}`} data-group-head={groupId} title="Hold to grab the whole group">
          {renamingGroup === groupId ? (
            <NameInput
              className="tgroup__input"
              label="Group name"
              initial={g?.title ?? ''}
              onDone={(value) => {
                setRenamingGroup(null);
                if (value != null) vault.renameGroup(groupId, value.trim()).catch(fail);
              }}
            />
          ) : (
            <span className="tgroup__chip" data-group-chip={groupId} data-empty={!g?.title || undefined}>
              {title}
            </span>
          )}
          <span className="tgroup__count">{tabs.length}</span>
          {g?.collapsed && <span className="tgroup__note">collapsed</span>}
          <button className="win__more tgroup__more" aria-label={`Actions for ${title}`} onClick={(e) => menuAt(e, (x, y) => groupMenu(groupId, x, y))}>
            <DotsIcon />
          </button>
        </div>
        {tabs.map((t) => renderLiveRow(t, windowId))}
      </div>
    );
  };

  const restoreBanner = restore && (
    <div className="banner" role="status">
      <span>
        Found a FreeTabs backup in your bookmarks with {plural(restore.tabs, 'tab')}. Restore it, or start fresh and keep it as an old backup.
      </span>
      <button
        className="btn"
        onClick={() =>
          restoreFromBookmarks().then((r) => {
            setRestore(null);
            say(`Restored ${plural(r.tabs, 'tab')} from bookmarks`);
            chrome.runtime.sendMessage({ type: 'vault-changed' }).catch(() => undefined);
          }, fail)
        }
      >
        Restore
      </button>
      <button
        className="textbtn"
        onClick={() =>
          setAsideOldBackup().then(() => {
            setRestore(null);
            chrome.runtime.sendMessage({ type: 'vault-changed' }).catch(() => undefined);
          }, fail)
        }
      >
        Start fresh
      </button>
    </div>
  );

  const renderSavedRow = (t: SavedTab, meta?: string) => (
    <Row
      key={t.id}
      rowKey={t.id}
      source="saved"
      url={t.url}
      title={t.title}
      selected={!!savedSel?.has(t.id)}
      lassoable
      incognito={t.incognito}
      pinned={t.pinned}
      meta={meta ?? ago(t.savedAt)}
      mark={markOf(t.url)}
    />
  );

  return (
    <div
      className="app"
      ref={rootRef}
      onContextMenu={onContextMenu}
      onDoubleClick={onDoubleClick}
      data-has-selection={showDigits || undefined}
    >
      <header className="top">
        <span className="brand">FreeTabs</span>
        <nav className="pill" aria-label="View" ref={pillRef}>
          <span className="pill__glow" aria-hidden="true" />
          <button className="pill__seg" aria-current={view.kind === 'live' || undefined} onClick={() => show({ kind: 'live' })}>
            Open tabs
          </button>
          <button className="pill__seg" aria-current={view.kind !== 'live' || undefined} onClick={() => show({ kind: 'saved' })}>
            Saved tabs
          </button>
        </nav>
        <button className="search" ref={searchRef} onClick={() => setPaletteOpen(true)} data-open={paletteOpen || undefined} aria-haspopup="dialog">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <circle cx="7" cy="7" r="4.75" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <span className="search__label">Search open and saved tabs</span>
          <kbd title="Enter or /">↵</kbd>
        </button>
        <span className="top__count" aria-live="polite">
          <strong>{liveCount}</strong> {liveCount === 1 ? 'tab' : 'tabs'} in <strong>{allWindows.length}</strong> {allWindows.length === 1 ? 'window' : 'windows'}
        </span>
        <button className="textbtn" disabled={!lastOp} onClick={doUndo} title={lastOp ? `Undo: ${lastOp.label} (⌘Z)` : 'Nothing to undo'}>
          Undo
        </button>
        <button className="textbtn" onClick={() => setSettingsOpen(true)}>
          Settings
        </button>
      </header>

      <div className="body">
        <main className="main" ref={scrollRef} data-lasso-zone data-drop="new-window" data-over={over === 'new-window' || undefined}>
          {restoreBanner}
          {askIncognito && !intro && view.kind === 'live' && (
            <div className="banner banner--quiet" role="status">
              <IncognitoIcon title="Incognito" />
              <span>Incognito windows aren’t on the board. Allow FreeTabs in incognito to see, count and save them too.</span>
              <button className="textbtn" onClick={() => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` })}>
                Allow in incognito
              </button>
              <button
                className="textbtn"
                onClick={() => {
                  setAskIncognito(false);
                  chrome.storage.local.set({ incognitoHintDismissed: true });
                }}
              >
                Not now
              </button>
            </div>
          )}
          {interrupted.map((op) => (
            <div className="banner" key={op.id} role="alert">
              <span>
                A save was interrupted before its tabs closed. They’re safely saved ({op.label.toLowerCase()}), but some may still be open.
              </span>
              <button className="textbtn" onClick={() => vault.finishInterrupted(op, true).then(() => setInterrupted((l) => l.filter((o) => o.id !== op.id)))}>
                Close them
              </button>
              <button className="textbtn" onClick={() => vault.finishInterrupted(op, false).then(() => setInterrupted((l) => l.filter((o) => o.id !== op.id)))}>
                Keep them open
              </button>
            </div>
          ))}

          {view.kind === 'live' ? (
            <>
              {windows && liveCount === 0 ? (
                <div className="clean">
                  <p className="clean__title">One clean window.</p>
                  <p className="clean__sub">
                    {savedTotal ? `Everything else is saved: ${plural(savedTotal, 'tab')} in ${plural(userFolders.length + 1, 'folder')}.` : 'Open some tabs, then come back here to sweep them into folders.'}
                  </p>
                </div>
              ) : (
                <div className="windows" style={{ gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` }}>
                  {windowColumns.map((col, ci) => (
                  <div className="wincol" key={ci}>
                  {col.map((w) => {
                    const own = w.tabs.filter((t) => !isBoard(liveUrl(t)));
                    const here = w.id === boardWindowId;
                    const name = windowName(w);
                    return (
                      <section
                        className="win"
                        key={w.id}
                        data-drop={`window:${w.id}`}
                        data-over={over === `window:${w.id}` || undefined}
                        data-current={here || undefined}
                        data-incognito={w.incognito || undefined}
                        data-lifted={(lifted === `window:${w.id}` && (drag ? 'carried' : 'held')) || undefined}
                      >
                        <header className="win__head" data-window-head={w.id} data-grab={own.length ? `window:${w.id}` : undefined} title="Hold to grab the whole window">
                          {w.incognito && <IncognitoIcon title="Incognito window" />}
                          <span className="win__name">{w.incognito && !here ? `Incognito ${w.number}` : name}</span>
                          <span className="win__count">{own.length}</span>
                          {!here && w.lastUsed > 0 && Date.now() - w.lastUsed > 3600e3 && (
                            <span className="win__idle" title={`Last used ${new Date(w.lastUsed).toLocaleString()}`}>
                              idle {ago(w.lastUsed)}
                            </span>
                          )}
                          <button className="win__more" aria-label={`Actions for ${name}`} onClick={(e) => menuAt(e, (x, y) => windowMenu(w, name, x, y))}>
                            <DotsIcon />
                          </button>
                        </header>
                        <div className="win__rows" role="listbox" aria-multiselectable="true" aria-label={name}>
                          {segment(w.tabs).map((part) =>
                            part.groupId == null ? (
                              renderLiveRow(part.tabs[0], w.id)
                            ) : (
                              renderTabGroup(part.groupId, part.tabs, w.id)
                            ),
                          )}
                        </div>
                      </section>
                    );
                  })}
                  </div>
                  ))}
                </div>
              )}
            </>
          ) : view.kind === 'saved' ? (
              <div className="windows" style={{ gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` }}>
                {overviewColumns.map((col, ci) => (
                  <div className="wincol" key={ci}>
                    {col.map(({ id, folder, tabs }) => {
                      const n = counts.get(id) ?? 0;
                      return (
                        <section
                          className="win"
                          key={id}
                          data-drop={`folder:${id}`}
                          data-over={over === `folder:${id}` || undefined}
                          data-flash={flash === id || undefined}
                          data-lifted={(lifted === `folder:${id}` && (drag ? 'carried' : 'held')) || undefined}
                        >
                          <header className="win__head" data-folder={id} data-grab={`folder:${id}`} title="Hold to grab the whole folder">
                            <span className="folder__dot" data-color={folder.kind === 'user' ? (folder.color ?? 'none') : folder.kind} aria-hidden="true" />
                            <button className="win__name win__link" onClick={() => show({ kind: 'folder', id })}>
                              {folder.name}
                            </button>
                            <span className="win__count">{n}</span>
                            <button className="win__more" aria-label={`Actions for ${folder.name}`} onClick={(e) => menuAt(e, (x, y) => folderMenu(folder, x, y))}>
                              <DotsIcon />
                            </button>
                          </header>
                          {tabs.length > 0 && (
                            <div className="win__rows" role="listbox" aria-multiselectable="true" aria-label={folder.name}>
                              {tabs.map((t) => renderSavedRow(t))}
                            </div>
                          )}
                          {n > tabs.length && (
                            <button className="win__all" onClick={() => show({ kind: 'folder', id })}>
                              Show all {n}
                            </button>
                          )}
                          {n === 0 && <p className="win__empty">Empty. Drag tabs here to save them.</p>}
                        </section>
                      );
                    })}
                  </div>
                ))}
              </div>
          ) : viewFolder ? (
            <section className="fv">
              <header className="fv__head">
                <button className="fv__back" onClick={() => show({ kind: 'saved' })}>
                  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                    <path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Saved tabs
                </button>
                <h1 className="fv__title" onDoubleClick={() => viewFolder.kind === 'user' && setRenaming(viewFolder.id)}>
                  {viewFolder.name}
                </h1>
                <p className="fv__meta" style={folderLoaded ? undefined : { visibility: 'hidden' }}>
                  {plural(folderTabs.length, 'tab')}
                  {viewFolder.kind === 'trash'
                    ? ', each kept for 30 days. Ask an AI what they say about where your attention goes.'
                    : folderTabs.length
                      ? `, last saved ${agoLong(viewFolder.updatedAt)}`
                      : ''}
                </p>
                {folderTabs.length > 0 && (
                  <div className="fv__actions">
                    {viewFolder.kind === 'trash' ? (
                      <>
                        <button className="btn" onClick={() => copy(trashReview(folderTabs), `Copied ${plural(folderTabs.length, 'tab')} for AI`)}>
                          Copy for AI: find my distractions
                        </button>
                        <button className="textbtn" onClick={() => askAIText('claude', trashReview(folderTabs), folderTabs.length)}>
                          Ask Claude
                        </button>
                        <button className="textbtn" onClick={() => vault.emptyTrash().then(() => say('Emptied Trash', { action: undoAction }), fail)}>
                          Empty Trash
                        </button>
                      </>
                    ) : (
                      <>
                        <button className="btn" onClick={() => openSaved(folderTabs.map((t) => t.id), false)}>
                          Restore all
                        </button>
                        <button className="textbtn" onClick={() => askAI('claude', [{ name: viewFolder.name, tabs: folderTabs }])}>
                          Ask Claude
                        </button>
                        <button className="textbtn" onClick={() => askAI('chatgpt', [{ name: viewFolder.name, tabs: folderTabs }])}>
                          Ask ChatGPT
                        </button>
                        <button
                          className="textbtn"
                          onClick={(e) => {
                            const r = e.currentTarget.getBoundingClientRect();
                            folderMenu(viewFolder, r.left, r.bottom + 6);
                          }}
                        >
                          More
                        </button>
                      </>
                    )}
                  </div>
                )}
              </header>
              {!folderLoaded ? null : folderTabs.length ? (
                <div className="fv__rows" role="listbox" aria-multiselectable="true" aria-label={viewFolder.name}>
                  {folderTabs.map((t) =>
                    renderSavedRow(t, viewFolder.kind === 'trash' && t.fromFolderName ? `from ${t.fromFolderName}` : undefined),
                  )}
                </div>
              ) : (
                <p className="empty">
                  {viewFolder.kind === 'trash'
                    ? 'Trash is empty. Trashed tabs stay here for 30 days.'
                    : 'Nothing here yet. Drag tabs onto this folder to save them.'}
                </p>
              )}
            </section>
          ) : null}
        </main>

        <aside className="vault" onClick={onSidebarClick} aria-label="Saved folders">
          <div className="vault__scroll">
            <div className="vault__head" role="button" tabIndex={0} title="Browse all saved tabs">
              <span className="vault__title">Saved</span>
              <span className="vault__total">{plural(savedTotal, 'tab')}</span>
            </div>
            <ul className="folders">
              {[inbox, ...userFolders]
                .filter((f): f is Folder => !!f)
                .map((f) => {
                  const digitIndex = userFolders.indexOf(f);
                  return (
                    <FolderRow
                      key={f.id}
                      folder={f}
                      count={counts.get(f.id) ?? 0}
                      preview={peeks.get(f.id) ?? []}
                      active={folderId === f.id}
                      over={over === `folder:${f.id}`}
                      flash={flash === f.id}
                      lifted={lifted === `folder:${f.id}` ? (drag ? 'carried' : 'held') : undefined}
                      digit={showDigits && digitIndex >= 0 && digitIndex < 9 ? digitIndex + 1 : undefined}
                      renaming={renaming === f.id}
                      onRename={(name) => finishRename(f.id, name)}
                    />
                  );
                })}
            </ul>
            <div className="folder folder--new" data-drop="new-folder" data-over={over === 'new-folder' || undefined} role="button" tabIndex={0}>
              <span className="folder__top">
                <span className="folder__plus" aria-hidden="true">+</span>
                <span className="folder__name">New folder</span>
              </span>
            </div>
          </div>
          {trash && (
            <ul className="folders folders--trash">
              <FolderRow
                folder={trash}
                count={counts.get(trash.id) ?? 0}
                preview={[]}
                active={folderId === trash.id}
                over={over === `folder:${trash.id}`}
                flash={flash === trash.id}
                renaming={false}
                onRename={() => undefined}
                compact
              />
            </ul>
          )}
        </aside>
      </div>

      {drag &&
        (drag.group ? (
          <div className="ghost" ref={ghostRef} aria-hidden="true">
            <div className="ghost__body ghost__body--card" data-kind={drag.group.split(':')[0]}>
              <span className="ghost__name">{drag.title}</span>
              <span className="ghost__favs">
                {drag.favs?.map((url, i) => <img key={i} src={faviconFor(url)} width={16} height={16} alt="" />)}
                <span>{drag.meta}</span>
              </span>
              {dropHint && <span className="ghost__hint">{dropHint}</span>}
            </div>
          </div>
        ) : (
          <div className="ghost" ref={ghostRef} aria-hidden="true">
            <div className="ghost__body" data-stack={Math.min(drag.keys.length, 3)}>
              <span className="ghost__title">{drag.title}</span>
              {dropHint && <span className="ghost__hint">{dropHint}</span>}
            </div>
          </div>
        ))}
      {lassoing && <div className="lasso" ref={lassoRef} aria-hidden="true" />}
      {sel.keys.size > 1 && !drag && (
        <div className="chip" role="status">
          {sel.keys.size} selected
        </div>
      )}
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
      <Toast toast={toast} onDone={closeToast} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} say={say} onShowIntro={() => { setSettingsOpen(false); setIntro(true); }} />
      {intro && <Onboarding onDone={finishIntro} />}
      <Palette
        open={paletteOpen}
        trigger={searchRef.current}
        windows={visibleWindows.map((w) => ({ name: windowName(w), tabs: w.tabs }))}
        folderName={(id) => folderById.get(id)?.name ?? 'a folder'}
        markOf={markOf}
        savedTotal={savedTotal}
        onClose={() => setPaletteOpen(false)}
        onGoLive={(tab) => openRow(String(tab.id), 'live')}
        onOpenSaved={(id) => openSaved([id], true)}
        onSelectLive={(ids) => {
          show({ kind: 'live' });
          setSel({ source: 'live', keys: new Set(ids.map(String)) });
          say(`Selected ${plural(ids.length, 'tab')}. Drag them to a folder, or press 1–9.`);
        }}
      />
    </div>
  );
}
