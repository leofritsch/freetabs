/** Chrome tab groups: remembered when tabs are saved, recreated when they come back. */

export type GroupColor = chrome.tabGroups.TabGroup['color'];

export interface GroupMeta {
  title: string;
  color: GroupColor;
}

export const GROUP_COLORS: GroupColor[] = ['blue', 'green', 'yellow', 'pink', 'purple', 'cyan', 'orange', 'red', 'grey'];

export const NO_GROUP = -1;

/** chrome.tabs.group/ungroup want a non-empty list; callers check length first. */
export const ids = (list: number[]) => list as [number, ...number[]];

/** Title and color of every open tab group, by group id. */
export async function groupMeta(): Promise<Map<number, GroupMeta>> {
  if (!chrome.tabGroups) return new Map();
  const groups = await chrome.tabGroups.query({});
  return new Map(groups.map((g) => [g.id, { title: g.title ?? '', color: g.color }]));
}

/** A color not already used by another group in the window, if there is one. */
export function nextColor(used: GroupColor[]): GroupColor {
  return GROUP_COLORS.find((c) => !used.includes(c)) ?? GROUP_COLORS[used.length % GROUP_COLORS.length];
}

/** Gather reopened tabs back into groups with the same title and color, per window. */
export async function regroup(entries: { tabId?: number; windowId: number; group?: GroupMeta }[]) {
  const buckets = new Map<string, { windowId: number; group: GroupMeta; tabIds: number[] }>();
  for (const e of entries) {
    if (!e.group || e.tabId == null) continue;
    const key = `${e.windowId}\u0000${e.group.title}\u0000${e.group.color}`;
    const bucket = buckets.get(key) ?? { windowId: e.windowId, group: e.group, tabIds: [] };
    bucket.tabIds.push(e.tabId);
    buckets.set(key, bucket);
  }
  for (const { windowId, group, tabIds } of buckets.values()) {
    try {
      const groupId = await chrome.tabs.group({ tabIds: ids(tabIds), createProperties: { windowId } });
      await chrome.tabGroups.update(groupId, { title: group.title, color: group.color });
    } catch {
      // The tabs still came back; only the grouping is lost.
    }
  }
}
