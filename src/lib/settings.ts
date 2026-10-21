import { DEFAULT_MARKS, type Marks } from './marks';

export interface Settings {
  /** mirror folders into a FreeTabs bookmarks folder (survives uninstall, readable by freetabs-mcp) */
  bookmarkBackup: boolean;
  /** let "Copy for AI" and "Ask Claude/ChatGPT" include incognito tabs */
  aiSeesIncognito: boolean;
  /** lasso also picks up pinned tabs */
  lassoPinned: boolean;
  /** first line of the "For AI" export; {folder} and {count} are filled in */
  aiPrompt: string;
  /** show the open-tab count on the toolbar icon */
  badge: boolean;
  /** above this many open tabs the icon turns red and pulses; 0 turns that off */
  tabLimit: number;
  /** look inside pages for typed form text before closing them (needs an optional permission) */
  checkTyped: boolean;
  /** good list and bad list: sites that glow green or red */
  marks: Marks;
  /** let AI apps running freetabs-mcp on this computer read and organize folders */
  aiLink: boolean;
}

export const DEFAULT_PROMPT =
  'These are tabs I saved in {folder}. Summarize each one in a line, then tell me which 3 matter most and why.';

export const DEFAULT_SETTINGS: Settings = {
  bookmarkBackup: true,
  aiSeesIncognito: false,
  lassoPinned: false,
  aiPrompt: DEFAULT_PROMPT,
  badge: true,
  tabLimit: 20,
  checkTyped: false,
  marks: DEFAULT_MARKS,
  aiLink: true,
};

export async function getSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings as Partial<Settings> | undefined) };
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export interface BackupStatus {
  at: number;
  ok: boolean;
  error?: string;
  tabs?: number;
}
