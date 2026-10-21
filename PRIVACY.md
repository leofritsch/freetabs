# FreeTabs privacy policy

FreeTabs is a Chrome extension that saves open tabs into folders and closes them. It has no account, no server and no analytics. The only connection it makes is to your own computer (`127.0.0.1`), to talk to freetabs-mcp when an AI app you connected is running.

## What it handles

- The titles and URLs of your open tabs, to show them on the board.
- The tabs you choose to save, plus your folders and settings.

## Where it's kept

- On your computer, in the extension's IndexedDB and Chrome storage.
- In a **FreeTabs** folder in your Chrome bookmarks, as a backup. If Chrome Sync is on, Chrome syncs that folder like any other bookmark. Tabs from incognito windows are never written there. You can turn the backup off in Settings.

Nothing is sent to the developer or to anyone else. Nothing is sold or shared, or used for anything other than saving and restoring your tabs.

## When something leaves your computer

Only when you ask for it:

- **Ask Claude** and **Ask ChatGPT** open claude.ai or chatgpt.com with the folder's links filled in. Tabs from incognito windows are left out unless you turn that on in Settings.
- **Copy** actions put text on your clipboard.
- **Export** downloads a file to your computer.
- **An AI app you connected** through freetabs-mcp (below) receives what it reads from your folders, never incognito tabs.

## The optional typed-text check

Off by default. If you turn it on in Settings, Chrome asks you for permission to read pages. Right before FreeTabs closes a tab, it checks that page's form fields for text you typed, so it doesn't close unsaved work. Nothing is stored or sent. Turning the setting off removes the permission.

## freetabs-mcp

The optional MCP server runs on your computer, started by an AI app you connected (Claude Desktop or Claude Code, for example). FreeTabs talks to it over `127.0.0.1` only, and it accepts no connections from web pages.

Through it, that AI app can read your folders, and organize them when you ask: create folders, add links, and move, copy or trash tabs. Every change shows in FreeTabs with an Undo. Turn off Settings › AI › "Let AI apps organize your folders" and the server can only read the FreeTabs folder in your browser's Bookmarks file.

What you ask that AI app, and what it reads through the server, is handled by that app under its own privacy policy. Tabs saved from incognito windows never reach the server: the AI only learns how many there are.

## Contact

Questions: open an issue at [github.com/leofritsch/freetabs](https://github.com/leofritsch/freetabs/issues).
