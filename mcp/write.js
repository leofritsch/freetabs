/** What the write tools tell the model, from what FreeTabs reports back. */

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const UNDO = 'The user can undo this in FreeTabs (⌘Z, or Undo in its toast).';

function unknownIds(result) {
  return result.unknown?.length
    ? ` These ids didn’t match a saved tab: ${result.unknown.join(', ')}. Get current ids from get_folder or search_tabs.`
    : '';
}

const newFolder = (result) => (result.created ? ' (a new folder)' : '');

export function describe(method, r) {
  switch (method) {
    case 'createFolder':
      return r.created ? `Created the folder “${r.folder}”. ${UNDO}` : `A folder called “${r.folder}” already exists, so nothing changed.`;
    case 'addLinks':
      return (
        `Added ${plural(r.added, 'link')} to “${r.folder}”${newFolder(r)}.` +
        (r.skipped ? ` Skipped ${r.skipped}: already in the folder, or not an http(s) link.` : '') +
        (r.added ? ` ${UNDO}` : '')
      );
    case 'moveTabs':
      return `Moved ${plural(r.moved, 'tab')} to “${r.folder}”${newFolder(r)}.${unknownIds(r)}${r.moved ? ` ${UNDO}` : ''}`;
    case 'copyTabs':
      return (
        `Copied ${plural(r.copied, 'tab')} to “${r.folder}”${newFolder(r)}; the originals stay where they were.` +
        (r.skipped ? ` Skipped ${r.skipped} already in that folder.` : '') +
        unknownIds(r) +
        (r.copied ? ` ${UNDO}` : '')
      );
    case 'trashTabs':
      return `Moved ${plural(r.trashed, 'tab')} to Trash, where they stay for 30 days.${unknownIds(r)}${r.trashed ? ` ${UNDO}` : ''}`;
    default:
      return JSON.stringify(r);
  }
}

/** A friendly name for the AI app, from the name it gives when it connects. */
export function clientLabel(name = '') {
  if (/claude[-\s]?code/i.test(name)) return 'Claude Code';
  if (/^claude/i.test(name)) return 'Claude';
  if (/cursor/i.test(name)) return 'Cursor';
  if (/windsurf/i.test(name)) return 'Windsurf';
  if (/visual studio code|vscode/i.test(name)) return 'VS Code';
  if (/codex/i.test(name)) return 'Codex';
  if (/chatgpt|openai/i.test(name)) return 'ChatGPT';
  return 'An AI app';
}
