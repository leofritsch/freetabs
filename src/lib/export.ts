import { domainOf } from './url';

/** What an AI sees in place of a tab saved from an incognito window. */
export const INCOGNITO_PLACEHOLDER = '<incognito link>';

export interface ExportTab {
  url: string;
  title: string;
  incognito: boolean;
  savedAt: number;
}

export interface ExportGroup {
  name: string;
  tabs: ExportTab[];
}

const mdText = (s: string) => s.replace(/([\\[\]])/g, '\\$1').replace(/\s+/g, ' ').trim();
const mdUrl = (s: string) => s.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\s/g, '%20');

export function toLinks(groups: ExportGroup[]): string {
  return groups.flatMap((g) => g.tabs.map((t) => t.url)).join('\n') + '\n';
}

export function toMarkdown(groups: ExportGroup[]): string {
  return (
    groups
      .map((g) => [`## ${g.name}`, '', ...g.tabs.map((t) => `- [${mdText(t.title || t.url)}](${mdUrl(t.url)})`)].join('\n'))
      .join('\n\n') + '\n'
  );
}

const day = (ms: number) => new Date(ms).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });

export function fillPrompt(template: string, groups: ExportGroup[]): string {
  const names = groups.map((g) => `“${g.name}”`);
  const folder = names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  const count = groups.reduce((n, g) => n + g.tabs.length, 0);
  return template.replaceAll('{folder}', folder).replaceAll('{count}', String(count));
}

/**
 * Markdown plus a header an AI can work with. Incognito tabs are replaced by a
 * placeholder unless the user allowed AI to see them.
 */
export function toAI(
  groups: ExportGroup[],
  { prompt, aiSeesIncognito }: { prompt: string; aiSeesIncognito: boolean },
): string {
  const all = groups.flatMap((g) => g.tabs);
  const count = all.length;
  const times = all.map((t) => t.savedAt).filter(Boolean);
  const first = times.length ? Math.min(...times) : 0;
  const last = times.length ? Math.max(...times) : 0;
  const hidden = aiSeesIncognito ? 0 : all.filter((t) => t.incognito).length;

  const lines = [
    `# Saved tabs: ${groups.map((g) => g.name).join(', ')}`,
    '',
    `${count} ${count === 1 ? 'tab' : 'tabs'}, saved ${first && day(first) !== day(last) ? `${day(first)} to ${day(last)}` : first ? day(first) : ''}, exported from FreeTabs.`,
    '',
    fillPrompt(prompt, groups),
  ];
  for (const g of groups) {
    lines.push('', `## ${g.name}`, '');
    for (const t of g.tabs) {
      if (t.incognito && !aiSeesIncognito) lines.push(`- ${INCOGNITO_PLACEHOLDER}`);
      else lines.push(`- [${mdText(t.title || t.url)}](${mdUrl(t.url)}) (${domainOf(t.url)})`);
    }
  }
  if (hidden) {
    lines.push(
      '',
      `Note: ${hidden} of these ${hidden === 1 ? 'tab was' : 'tabs were'} saved from an incognito window. The user keeps incognito tabs hidden from AI, so ${hidden === 1 ? 'it appears' : 'they appear'} as ${INCOGNITO_PLACEHOLDER}. Only the user can open ${hidden === 1 ? 'it' : 'them'}, in FreeTabs.`,
    );
  }
  return lines.join('\n') + '\n';
}

export type AIProvider = 'claude' | 'chatgpt';

/** Longest prefilled chat URL we open; anything longer goes through the clipboard. */
const MAX_PREFILL_URL = 8000;

export function aiChatUrl(provider: AIProvider, text: string): { url: string; prefilled: boolean } {
  const base = provider === 'claude' ? 'https://claude.ai/new' : 'https://chatgpt.com/';
  const url = `${base}?q=${encodeURIComponent(text)}`;
  return url.length <= MAX_PREFILL_URL ? { url, prefilled: true } : { url: base, prefilled: false };
}

const html = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Netscape bookmark file, importable by every browser. */
export function toBookmarksHtml(groups: ExportGroup[]): string {
  const sec = (ms: number) => Math.floor(ms / 1000);
  const body = groups
    .map(
      (g) =>
        `    <DT><H3>${html(g.name)}</H3>\n    <DL><p>\n${g.tabs
          .map((t) => `        <DT><A HREF="${html(t.url)}" ADD_DATE="${sec(t.savedAt)}">${html(t.title || t.url)}</A>`)
          .join('\n')}\n    </DL><p>`,
    )
    .join('\n');
  return `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>FreeTabs</TITLE>
<H1>FreeTabs</H1>
<DL><p>
    <DT><H3>FreeTabs</H3>
    <DL><p>
${body}
    </DL><p>
</DL><p>
`;
}

/** OneTab's "Export URLs" text: one "url | title" per line, groups separated by blank lines. */
export function parseOneTab(text: string): { name: string; tabs: { url: string; title: string }[] }[] {
  const groups: { name: string; tabs: { url: string; title: string }[] }[] = [];
  let current: { url: string; title: string }[] = [];
  const flush = () => {
    if (current.length) groups.push({ name: `OneTab ${groups.length + 1}`, tabs: current });
    current = [];
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const bar = line.indexOf(' | ');
    const url = (bar === -1 ? line : line.slice(0, bar)).trim();
    const title = bar === -1 ? '' : line.slice(bar + 3).trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) current.push({ url, title: title || url });
  }
  flush();
  if (groups.length === 1) groups[0].name = 'From OneTab';
  return groups;
}
