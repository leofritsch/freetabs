import { db, TRASH_ID, type SavedTab } from './db';
import { getSettings } from './settings';
import { addLinks, copySaved, createFolder, moveSaved, type Target } from './vault';

/**
 * The live link to freetabs-mcp: AI apps on this computer (Claude Desktop,
 * Claude Code…) run that small server, and the worker connects to it on
 * 127.0.0.1. Through it an AI can read folders and organize them. Every change
 * goes through the vault, so it can be undone like any other. Incognito tabs
 * never cross: the AI only learns how many there are.
 */
export const AI_LINK_PORT = 47811;

/** Always the newest release's file, so the link never needs updating. */
export const MCPB_URL = 'https://github.com/leofritsch/freetabs/releases/latest/download/freetabs.mcpb';
/** Claude Code and other MCP apps run the server from the source code. */
export const MCP_SETUP_URL = 'https://github.com/leofritsch/freetabs/tree/main/mcp#readme';
/** Someone is setting up the MCP from FreeTabs: start looking for it now. */
export const aiLinkWanted = () => chrome.runtime.sendMessage({ type: 'ai-link-wanted' }).catch(() => undefined);
const PROTOCOL = 1;
/** How often a sleeping worker looks for a server again, once the link has been used. */
export const AI_LINK_ALARM = 'ai-link';
const RETRY_MS = 10_000;

export interface AiLinkStatus {
  connected: boolean;
  /** the AI apps on the other end, e.g. ["Claude", "Claude Code"] */
  clients: string[];
}

let socket: WebSocket | null = null;
let connecting = false;
let lastTry = 0;

const setStatus = (status: AiLinkStatus) => chrome.storage.session.set({ aiLink: status }).catch(() => undefined);

/** Try to reach the server. Cheap when nothing listens: one refused local connection, no console error. */
export async function connectAiLink({ force = false } = {}) {
  if (socket || connecting) return;
  if (!force && Date.now() - lastTry < RETRY_MS) return;
  lastTry = Date.now();
  connecting = true;
  let ws: WebSocket;
  try {
    if (!(await getSettings()).aiLink) return;
    // Tests point FreeTabs at another port, so they never meet a real AI app.
    const { aiLinkPort } = await chrome.storage.local.get('aiLinkPort');
    ws = new WebSocket(`ws://127.0.0.1:${Number(aiLinkPort) || AI_LINK_PORT}`);
    socket = ws;
  } finally {
    connecting = false;
  }
  ws.onopen = () => send(ws, { type: 'hello', app: 'freetabs', protocol: PROTOCOL, version: chrome.runtime.getManifest().version });
  ws.onmessage = (event) => void onMessage(ws, event.data);
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    void setStatus({ connected: false, clients: [] });
    // The AI app that hosted the link quit; another one may take over in a moment.
    if (welcomed.delete(ws)) setTimeout(() => void connectAiLink({ force: true }), 2000);
  };
}

const welcomed = new WeakSet<WebSocket>();

export function disconnectAiLink() {
  const ws = socket;
  socket = null;
  ws?.close();
  void setStatus({ connected: false, clients: [] });
}

function send(ws: WebSocket, message: unknown) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

async function onMessage(ws: WebSocket, data: unknown) {
  let message: { type?: string; id?: string; client?: string; method?: string; params?: Record<string, unknown>; clients?: string[] };
  try {
    message = JSON.parse(String(data));
  } catch {
    return;
  }
  if (message.type === 'ping') return send(ws, { type: 'pong' });
  if (message.type === 'welcome' || message.type === 'clients') {
    welcomed.add(ws);
    await setStatus({ connected: true, clients: message.clients ?? [] });
    // Used once: from now on a sleeping worker checks back every 30 seconds.
    await chrome.storage.local.set({ aiLinkSeen: true });
    chrome.alarms.create(AI_LINK_ALARM, { periodInMinutes: 0.5 });
    return;
  }
  if (message.type !== 'req' || !message.id) return;
  const handler = handlers[message.method as keyof typeof handlers];
  try {
    if (!handler) throw new Error(`Unknown request: ${message.method}`);
    const result = await handler((message.params ?? {}) as never, message.client || 'An AI app');
    send(ws, { type: 'res', id: message.id, result });
  } catch (error) {
    send(ws, { type: 'res', id: message.id, error: error instanceof Error ? error.message : String(error) });
  }
}

// ---------- what an AI can ask for ----------

/** Tell an open board what just happened, so it can show it with an Undo button. */
function announce(text: string) {
  chrome.runtime.sendMessage({ type: 'ai-change', text }).catch(() => undefined);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Folders and tabs as the AI sees them: no Trash, and incognito tabs reduced to a count. */
async function snapshot() {
  const folders = (await db.folders.orderBy('order').toArray()).filter((f) => f.kind !== 'trash');
  const tabs = (await db.tabs.toArray()).filter((t) => t.folderId !== TRASH_ID);
  return {
    app: 'FreeTabs',
    format: 1,
    live: true,
    exportedAt: new Date().toISOString(),
    ai: { seesIncognito: false },
    folders: folders.map((f) => ({ id: f.id, name: f.name, kind: f.kind, updatedAt: f.updatedAt })),
    tabs: tabs.map((t) =>
      t.incognito
        ? { id: '', folderId: t.folderId, url: '', title: '', savedAt: t.savedAt, incognito: true }
        : { id: t.id, folderId: t.folderId, url: t.url, title: t.title, savedAt: t.savedAt, incognito: false, ...(t.note ? { note: t.note } : {}) },
    ),
  };
}

/** A folder by its exact name (any case). Missing ones are created when asked. */
async function folderTarget(name: unknown, create: boolean): Promise<{ target: Target; name: string; created: boolean } | null> {
  const clean = String(name ?? '').trim();
  if (!clean) throw new Error('Give the folder a name.');
  const hit = (await db.folders.toArray()).find((f) => f.name.toLowerCase() === clean.toLowerCase());
  if (hit?.kind === 'trash') throw new Error('Use trash_tabs to move tabs to Trash.');
  if (hit) return { target: { folderId: hit.id }, name: hit.name, created: false };
  return create ? { target: { newFolderName: clean }, name: clean, created: true } : null;
}

/**
 * Tab ids as the AI saw them: full ids or their first characters. Only tabs the
 * AI could see qualify (not Trash, not incognito).
 */
async function resolveTabs(ids: unknown): Promise<{ tabs: SavedTab[]; unknown: string[] }> {
  const wanted = (Array.isArray(ids) ? ids : []).map((id) => String(id).trim().toLowerCase()).filter(Boolean);
  if (!wanted.length) throw new Error('Pass the ids of the tabs, as listed by get_folder, search_tabs or recent_tabs.');
  const visible = (await db.tabs.toArray()).filter((t) => t.folderId !== TRASH_ID && !t.incognito);
  const tabs: SavedTab[] = [];
  const unknown: string[] = [];
  for (const id of wanted) {
    const hits = id.length >= 6 ? visible.filter((t) => t.id.toLowerCase().startsWith(id)) : [];
    if (hits.length === 1) {
      if (!tabs.includes(hits[0])) tabs.push(hits[0]);
    } else unknown.push(id);
  }
  return { tabs, unknown };
}

type Params = Record<string, unknown>;

const handlers = {
  snapshot: () => snapshot(),

  async createFolder(p: Params, who: string) {
    const existing = await folderTarget(p.name, false);
    if (existing) return { folder: existing.name, created: false };
    const folder = await createFolder(String(p.name), `${who} created ${String(p.name).trim()}`);
    announce(`${who} created the folder ${folder.name}`);
    return { folder: folder.name, created: true };
  },

  async addLinks(p: Params, who: string) {
    const links = (Array.isArray(p.links) ? p.links : []).map((l: { url?: unknown; title?: unknown }) => ({
      url: String(l?.url ?? ''),
      title: l?.title == null ? undefined : String(l.title),
    }));
    if (!links.length) throw new Error('Pass at least one link.');
    const where = (await folderTarget(p.folder, true))!;
    const r = await addLinks(links, where.target, `${who} added links to ${where.name}`);
    announce(`${who} added ${plural(r.added, 'link')} to ${r.folder.name}`);
    return { folder: r.folder.name, created: r.created, added: r.added, skipped: r.skipped };
  },

  async moveTabs(p: Params, who: string) {
    const { tabs, unknown } = await resolveTabs(p.ids);
    const where = (await folderTarget(p.folder, true))!;
    if (!tabs.length) return { folder: where.name, created: false, moved: 0, unknown };
    const r = await moveSaved(
      tabs.map((t) => t.id),
      where.target,
      `${who} moved ${plural(tabs.length, 'tab')} to ${where.name}`,
    );
    announce(`${who} moved ${plural(r.moved, 'tab')} to ${r.folder.name}`);
    return { folder: r.folder.name, created: where.created, moved: r.moved, unknown };
  },

  async copyTabs(p: Params, who: string) {
    const { tabs, unknown } = await resolveTabs(p.ids);
    const where = (await folderTarget(p.folder, true))!;
    if (!tabs.length) return { folder: where.name, created: false, copied: 0, skipped: 0, unknown };
    const r = await copySaved(
      tabs.map((t) => t.id),
      where.target,
      `${who} copied ${plural(tabs.length, 'tab')} to ${where.name}`,
    );
    announce(`${who} copied ${plural(r.added, 'tab')} to ${r.folder.name}`);
    return { folder: r.folder.name, created: r.created, copied: r.added, skipped: r.skipped, unknown };
  },

  async trashTabs(p: Params, who: string) {
    const { tabs, unknown } = await resolveTabs(p.ids);
    if (!tabs.length) return { trashed: 0, unknown };
    const r = await moveSaved(
      tabs.map((t) => t.id),
      { folderId: TRASH_ID },
      `${who} moved ${plural(tabs.length, 'tab')} to Trash`,
    );
    announce(`${who} moved ${plural(r.moved, 'tab')} to Trash`);
    return { trashed: r.moved, unknown };
  },
};
