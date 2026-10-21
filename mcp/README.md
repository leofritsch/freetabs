# freetabs-mcp

Let Claude, or any MCP app, read your [FreeTabs](https://github.com/leofritsch/freetabs) folders and organize them when you ask. "Copy my top five prospects into a new folder", then open that folder in one click from FreeTabs.

## Set up

**Claude Desktop:** [download freetabs.mcpb](https://github.com/leofritsch/freetabs/releases/latest/download/freetabs.mcpb), open it, and click Install. Nothing else to install.

**Claude Code, or any other MCP app:** run it from this repo (Node 18 or newer).

```sh
git clone https://github.com/leofritsch/freetabs.git
cd freetabs/mcp
npm install
claude mcp add -s user freetabs -- node "$PWD/index.js"
```

Other apps take the same command in their MCP config:

```json
{
  "mcpServers": {
    "freetabs": { "command": "node", "args": ["/path/to/freetabs/mcp/index.js"] }
  }
}
```

## Tools

| Tool | What it does |
| --- | --- |
| `list_folders` | Every folder with its tab count and when it was last saved to |
| `get_folder` | Every tab in one folder (match by name or part of it), with ids |
| `search_tabs` | Tabs whose title or URL contain all the words in a query |
| `recent_tabs` | The latest saved tabs, optionally only from the last N days |
| `create_folder` | A new, empty folder |
| `add_links` | Save http(s) links into a folder; the folder is created if needed |
| `move_tabs` | Move tabs (by id) to another folder |
| `copy_tabs` | Copy tabs into another folder, keeping the originals and the order given |
| `trash_tabs` | Move tabs to Trash, where FreeTabs keeps them for 30 days |

The AI can't delete anything for good or empty Trash.

## How it works

While FreeTabs is running in Chrome, it connects to this server on `ws://127.0.0.1:47811`. Reads are live, and changes go through FreeTabs itself. Each change shows on the board with an Undo button, and ⌘Z works too. The server only accepts the FreeTabs extension and other copies of itself, never web pages.

Several AI apps can run it at once, like Claude Desktop and a few Claude Code sessions. The first one hosts the connection and the others relay through it. When the host quits, another takes over.

If FreeTabs isn't running, or Settings › AI › "Let AI apps organize your folders" is off, reading still works. The server then reads the **FreeTabs** folder from your browser's own Bookmarks file, as long as Settings › Backup › "Back up to Chrome bookmarks" is on. Chrome, Chromium, Brave, Edge, Arc and Vivaldi profiles are found automatically; the most recently changed one wins.

| Environment variable | Use |
| --- | --- |
| `FREETABS_BOOKMARKS` | Read a specific profile's Bookmarks file, e.g. `/Users/you/Library/Application Support/Google/Chrome/Profile 1/Bookmarks` |
| `FREETABS_VAULT` | Read a JSON backup exported from FreeTabs instead |
| `FREETABS_PORT` | Use another port (for development) |

## Incognito tabs stay hidden

Tabs saved from incognito windows never reach this server. FreeTabs only says how many there are per folder, so they appear as `<incognito link>`, with no URL, title or id. Search never matches them, and they can't be moved or trashed from here. The AI can tell you they exist but can't read them.
