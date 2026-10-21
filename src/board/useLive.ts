import { useEffect, useState } from 'react';

export interface LiveWindow {
  id: number;
  incognito: boolean;
  tabs: chrome.tabs.Tab[];
}

/**
 * Every normal window and its tabs, kept in sync with Chrome.
 * Title/favicon updates patch one tab; structural changes re-query once per burst
 * (closing 80 tabs fires 80 events, but only one query).
 */
export function useLive() {
  const [windows, setWindows] = useState<LiveWindow[] | null>(null);
  const [boardTab, setBoardTab] = useState<chrome.tabs.Tab>();
  const [groups, setGroups] = useState<Map<number, chrome.tabGroups.TabGroup>>(new Map());

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // Windows and the board's own tab arrive together, so the first layout already knows "this window".
    const load = async () => {
      const [all, current, tabGroups] = await Promise.all([
        chrome.windows.getAll({ populate: true, windowTypes: ['normal'] }),
        chrome.tabs.getCurrent(),
        chrome.tabGroups.query({}),
      ]);
      if (disposed) return;
      all.sort((a, b) => a.id! - b.id!);
      setBoardTab(current);
      setGroups(new Map(tabGroups.map((g) => [g.id, g])));
      setWindows(all.map((w) => ({ id: w.id!, incognito: w.incognito, tabs: w.tabs ?? [] })));
    };
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(load, 40);
    };
    const patch = (tabId: number, change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => {
      if ('pinned' in change || 'groupId' in change) return refresh();
      setWindows((ws) =>
        ws?.map((w) => (w.id === tab.windowId ? { ...w, tabs: w.tabs.map((t) => (t.id === tabId ? tab : t)) } : w)) ?? ws,
      );
    };

    const structural = [
      chrome.tabs.onCreated,
      chrome.tabs.onRemoved,
      chrome.tabs.onMoved,
      chrome.tabs.onAttached,
      chrome.tabs.onDetached,
      chrome.tabs.onReplaced,
      chrome.windows.onCreated,
      chrome.windows.onRemoved,
      chrome.tabGroups.onCreated,
      chrome.tabGroups.onUpdated,
      chrome.tabGroups.onRemoved,
      chrome.tabGroups.onMoved,
    ] as unknown as chrome.events.Event<() => void>[];

    load();
    structural.forEach((e) => e.addListener(refresh));
    chrome.tabs.onUpdated.addListener(patch);
    // The board can sit in the background for hours; catch up when it comes back.
    const onVisible = () => document.visibilityState === 'visible' && refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      disposed = true;
      clearTimeout(timer);
      structural.forEach((e) => e.removeListener(refresh));
      chrome.tabs.onUpdated.removeListener(patch);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return { windows, boardTab, groups };
}
