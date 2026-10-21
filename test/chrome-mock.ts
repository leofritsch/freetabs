import { vi } from 'vitest';

/** A tiny in-memory Chrome: windows with ordered tabs. Enough for the vault's tabs/windows calls. */
export function installChrome() {
  let nextId = 100;
  const windows = new Map<number, { id: number; incognito: boolean; tabs: chrome.tabs.Tab[] }>();
  /** tabs whose page answers "Leave site?": they stay open and remove() never settles */
  const dirty = new Set<number>();
  /** tabs with text typed into a form (seen only by the optional typed-text check) */
  const typed = new Set<number>();
  const storage: Record<string, unknown> = {};
  const groups = new Map<number, { id: number; title: string; color: string; windowId: number }>();
  const grants = { origins: false };

  const reindex = (windowId: number) => {
    windows.get(windowId)?.tabs.forEach((t, i) => (t.index = i));
  };
  const find = (tabId: number) => {
    for (const w of windows.values()) {
      const tab = w.tabs.find((t) => t.id === tabId);
      if (tab) return { w, tab };
    }
    return null;
  };

  const api = {
    runtime: { getURL: (p: string) => `chrome-extension://freetabs/${p}`, sendMessage: vi.fn(async () => undefined) },
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: storage[key] })),
        set: vi.fn(async (items: Record<string, unknown>) => void Object.assign(storage, items)),
      },
    },
    permissions: { contains: vi.fn(async () => grants.origins) },
    scripting: {
      executeScript: vi.fn(async ({ target }: { target: { tabId: number } }) => [{ result: typed.has(target.tabId) }]),
    },
    tabGroups: {
      query: vi.fn(async () => [...groups.values()]),
      update: vi.fn(async (id: number, props: { title?: string; color?: string }) => Object.assign(groups.get(id)!, props)),
    },
    tabs: {
      TAB_ID_NONE: -1,
      // Like Chrome: an array with any unknown id fails as a whole and closes nothing.
      remove: vi.fn(async (ids: number | number[]) => {
        const list = Array.isArray(ids) ? ids : [ids];
        const missing = list.find((id) => !find(id));
        if (missing != null) throw new Error(`No tab with id: ${missing}.`);
        for (const id of list.filter((id) => !dirty.has(id))) {
          const hit = find(id)!;
          hit.w.tabs.splice(hit.w.tabs.indexOf(hit.tab), 1);
          reindex(hit.w.id);
          if (!hit.w.tabs.length) windows.delete(hit.w.id);
        }
        if (list.some((id) => dirty.has(id))) await new Promise(() => {});
      }),
      query: vi.fn(async () => [...windows.values()].flatMap((w) => w.tabs.map((t) => ({ ...t })))),
      group: vi.fn(async ({ tabIds, createProperties }: { tabIds: number[]; createProperties?: { windowId?: number } }) => {
        const id = nextId++;
        groups.set(id, { id, title: '', color: 'grey', windowId: createProperties?.windowId ?? -1 });
        for (const tabId of tabIds) {
          const hit = find(tabId);
          if (hit) hit.tab.groupId = id;
        }
        return id;
      }),
      create: vi.fn(async ({ windowId, index, url, pinned }: chrome.tabs.CreateProperties) => {
        const w = windows.get(windowId!)!;
        const tab = { id: nextId++, windowId: w.id, url: url ?? 'chrome://newtab/', title: url ?? '', pinned: !!pinned, incognito: w.incognito } as chrome.tabs.Tab;
        w.tabs.splice(index ?? w.tabs.length, 0, tab);
        reindex(w.id);
        return tab;
      }),
      update: vi.fn(async (tabId: number, props: chrome.tabs.UpdateProperties) => {
        const hit = find(tabId);
        if (hit) Object.assign(hit.tab, props);
        return hit?.tab;
      }),
      move: vi.fn(async () => undefined),
    },
    windows: {
      getAll: vi.fn(async () => [...windows.values()].map((w) => ({ ...w, tabs: w.tabs.map((t) => ({ ...t })) }))),
      get: vi.fn(async (id: number) => {
        const w = windows.get(id);
        if (!w) throw new Error(`No window with id: ${id}.`);
        return { ...w };
      }),
      create: vi.fn(async ({ url, incognito }: chrome.windows.CreateData) => {
        const id = nextId++;
        const urls = Array.isArray(url) ? url : [url ?? 'chrome://newtab/'];
        const w = { id, incognito: !!incognito, tabs: [] as chrome.tabs.Tab[] };
        windows.set(id, w);
        urls.forEach((u) => w.tabs.push({ id: nextId++, windowId: id, url: u, title: u, pinned: false, incognito: !!incognito } as chrome.tabs.Tab));
        reindex(id);
        return { ...w };
      }),
    },
  };
  (globalThis as unknown as { chrome: typeof api }).chrome = api;

  return {
    api,
    windows,
    dirty,
    typed,
    storage,
    groups,
    grants,
    /** Open a window with these urls; returns its tabs. */
    open(urls: string[], { incognito = false } = {}) {
      const id = nextId++;
      const tabs = urls.map((url, i) => ({ id: nextId++, windowId: id, index: i, url, title: `Title of ${url}`, pinned: false, incognito }) as chrome.tabs.Tab);
      windows.set(id, { id, incognito, tabs });
      return [...tabs];
    },
    openUrls() {
      return [...windows.values()].flatMap((w) => w.tabs.map((t) => t.url));
    },
  };
}
