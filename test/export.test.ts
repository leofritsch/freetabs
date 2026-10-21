import { describe, expect, it } from 'vitest';
import { aiChatUrl, INCOGNITO_PLACEHOLDER, parseOneTab, toAI, toLinks, toMarkdown } from '../src/lib/export';
import { normalizeUrl, suggestFolderName } from '../src/lib/url';

const day = Date.UTC(2026, 9, 20);
const groups = [
  {
    name: 'Research',
    tabs: [
      { url: 'https://a.com/x', title: 'A [draft] page', incognito: false, savedAt: day },
      { url: 'https://secret.example/', title: 'Secret', incognito: true, savedAt: day },
    ],
  },
];

describe('exports', () => {
  it('links: one URL per line, including incognito', () => {
    expect(toLinks(groups)).toBe('https://a.com/x\nhttps://secret.example/\n');
  });

  it('markdown escapes brackets', () => {
    expect(toMarkdown(groups)).toContain('- [A \\[draft\\] page](https://a.com/x)');
  });

  it('for AI hides incognito tabs behind a placeholder and says why', () => {
    const text = toAI(groups, { prompt: 'Summarize {folder} ({count})', aiSeesIncognito: false });
    expect(text).toContain('Summarize “Research” (2)');
    expect(text).toContain(`- ${INCOGNITO_PLACEHOLDER}`);
    expect(text).not.toContain('secret.example');
    expect(text).toMatch(/hidden from AI/);
  });

  it('for AI shows incognito tabs when allowed', () => {
    const text = toAI(groups, { prompt: '', aiSeesIncognito: true });
    expect(text).toContain('secret.example');
    expect(text).not.toContain(INCOGNITO_PLACEHOLDER);
  });

  it('falls back to the clipboard for long prompts', () => {
    expect(aiChatUrl('claude', 'hi')).toEqual({ url: 'https://claude.ai/new?q=hi', prefilled: true });
    expect(aiChatUrl('chatgpt', 'x'.repeat(9000)).prefilled).toBe(false);
  });

  it('parses OneTab exports into groups', () => {
    const parsed = parseOneTab('https://a.com | A\nhttps://b.com | B | with bar\n\nhttps://c.com\n');
    expect(parsed).toEqual([
      { name: 'OneTab 1', tabs: [{ url: 'https://a.com', title: 'A' }, { url: 'https://b.com', title: 'B | with bar' }] },
      { name: 'OneTab 2', tabs: [{ url: 'https://c.com', title: 'https://c.com' }] },
    ]);
  });
});

describe('urls', () => {
  it('normalizes for dedupe but keeps the hash', () => {
    expect(normalizeUrl('https://WWW.A.com/p/?utm_source=x&b=2&a=1')).toBe('https://www.a.com/p/?a=1&b=2');
    expect(normalizeUrl('https://a.com/p/')).toBe('https://a.com/p');
    expect(normalizeUrl('https://mail.google.com/#inbox/abc')).toBe('https://mail.google.com/#inbox/abc');
  });

  it('suggests the dominant domain as a folder name', () => {
    expect(suggestFolderName(['https://www.youtube.com/a', 'https://youtube.com/b', 'https://x.com'])).toBe('youtube.com');
    expect(suggestFolderName(['https://a.com', 'https://b.com', 'https://c.com'], new Date(day))).toMatch(/^Saved /);
  });
});
