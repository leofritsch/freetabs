#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createLink } from './link.js';
import { clientLabel, describe } from './write.js';
import { getFolder, listFolders, load, recentTabs, searchTabs } from './vault.js';

const { version: VERSION } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

const server = new McpServer(
  { name: 'freetabs', version: VERSION },
  {
    instructions:
      'FreeTabs holds browser tabs the user saved into folders. Start with list_folders, then get_folder, or use search_tabs and recent_tabs. ' +
      'While FreeTabs is running in Chrome you can also organize folders: create_folder, add_links, move_tabs, copy_tabs and trash_tabs. ' +
      'They take tab ids from get_folder, search_tabs or recent_tabs, and every change can be undone in FreeTabs. ' +
      'Only change folders when the user asks. To make a shortlist from a folder, copy unless the user says move. ' +
      'Tabs shown as <incognito link> were saved from incognito windows and are hidden on purpose: say they exist but that you cannot see them, ' +
      'because incognito tabs never leave the user’s browser.',
  },
);

const link = createLink();
link.start();
server.server.oninitialized = () => link.setClient(clientLabel(server.server.getClientVersion()?.name));

const text = (value) => ({ content: [{ type: 'text', text: value }] });
const failure = (error) => ({ content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true });

/** Live from FreeTabs when it's running; otherwise the bookmarks backup (or a JSON export). */
async function readVault() {
  if (await link.waitForExtension(1500)) {
    try {
      return await link.request('snapshot');
    } catch {
      // fall back to the backup below
    }
  }
  return load();
}

const read = (format) => async (args) => {
  try {
    return text(format(await readVault(), args ?? {}));
  } catch (error) {
    return failure(error);
  }
};

const NOT_CONNECTED =
  'Couldn’t reach FreeTabs, so nothing changed. Changes need FreeTabs running in Chrome, with Settings › AI › “Let AI apps organize your folders” on. ' +
  'If Chrome is open, ask the user to switch to it for a second, then try again. Reading folders still works from the bookmarks backup.';

/** Changes go to FreeTabs itself, which may take a few seconds to wake up. */
const write = (method) => async (args) => {
  try {
    if (!(await link.waitForExtension(30_000))) return failure(NOT_CONNECTED);
    return text(describe(method, await link.request(method, args ?? {})));
  } catch (error) {
    return failure(error);
  }
};

const readOnly = { readOnlyHint: true, openWorldHint: false };
const changes = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const ids = z.array(z.string()).min(1).max(500).describe('Tab ids, as listed by get_folder, search_tabs or recent_tabs');
const folder = z.string().min(1).describe('Folder name. An existing folder is matched by its exact name; otherwise a new folder is made.');

server.registerTool(
  'list_folders',
  {
    title: 'List folders',
    description: 'List the user’s FreeTabs folders of saved browser tabs, with tab counts and when each was last saved to.',
    annotations: readOnly,
  },
  read((vault) => listFolders(vault)),
);

server.registerTool(
  'get_folder',
  {
    title: 'Get folder',
    description: 'Get every saved tab in one FreeTabs folder: title, URL, the date it was saved and its id.',
    inputSchema: { folder: z.string().describe('Folder name (or part of it), e.g. "Read later" or "Inbox"') },
    annotations: readOnly,
  },
  read((vault, { folder }) => getFolder(vault, folder)),
);

server.registerTool(
  'search_tabs',
  {
    title: 'Search saved tabs',
    description: 'Search saved tabs across all folders by words in their title or URL.',
    inputSchema: {
      query: z.string().describe('Words to look for, e.g. "chrome extension mv3"'),
      limit: z.number().int().min(1).max(100).optional().describe('Most results to return (default 25)'),
    },
    annotations: readOnly,
  },
  read((vault, { query, limit }) => searchTabs(vault, query, limit)),
);

server.registerTool(
  'recent_tabs',
  {
    title: 'Recently saved tabs',
    description: 'The most recently saved tabs across all folders, for questions like “what did I save this week?”.',
    inputSchema: {
      limit: z.number().int().min(1).max(100).optional().describe('Most tabs to return (default 20)'),
      days: z.number().min(1).max(365).optional().describe('Only tabs saved in the last N days'),
    },
    annotations: readOnly,
  },
  read((vault, { limit, days }) => recentTabs(vault, { limit, days })),
);

server.registerTool(
  'create_folder',
  {
    title: 'Create folder',
    description: 'Create an empty FreeTabs folder. To create one with tabs in it, use copy_tabs, move_tabs or add_links with the new name.',
    inputSchema: { name: z.string().min(1).describe('Name of the new folder') },
    annotations: changes,
  },
  write('createFolder'),
);

server.registerTool(
  'add_links',
  {
    title: 'Add links',
    description:
      'Save web links into a folder, for example a reading list you put together. The user can then open the whole folder in one click. ' +
      'Links already in the folder are skipped; only http and https links are saved.',
    inputSchema: {
      folder,
      links: z
        .array(z.object({ url: z.string().describe('Full http(s) URL'), title: z.string().optional().describe('Title to show') }))
        .min(1)
        .max(200),
    },
    annotations: changes,
  },
  write('addLinks'),
);

server.registerTool(
  'move_tabs',
  {
    title: 'Move tabs',
    description: 'Move saved tabs to another folder.',
    inputSchema: { ids, folder },
    annotations: changes,
  },
  write('moveTabs'),
);

server.registerTool(
  'copy_tabs',
  {
    title: 'Copy tabs',
    description:
      'Copy saved tabs into another folder and keep the originals, for example to make a shortlist. They keep the order given: the first one shows at the top.',
    inputSchema: { ids, folder },
    annotations: changes,
  },
  write('copyTabs'),
);

server.registerTool(
  'trash_tabs',
  {
    title: 'Trash tabs',
    description: 'Move saved tabs to FreeTabs’ Trash, where they stay for 30 days. Only when the user asks.',
    inputSchema: { ids },
    annotations: { ...changes, destructiveHint: true },
  },
  write('trashTabs'),
);

const transport = new StdioServerTransport();
// When the AI app goes away, free the port right away so another one can take over.
const quit = () => {
  link.close();
  process.exit(0);
};
server.server.onclose = quit;
process.stdin.on('close', quit);
process.on('SIGTERM', quit);
process.on('SIGINT', quit);
await server.connect(transport);
