import { describe, expect, it } from 'vitest';
import { DEFAULT_MARKS, markMatcher, type Marks } from '../src/lib/marks';

const lists = (good: string[], bad: string[] = []): Marks => ({ good: { sites: good }, bad: { sites: bad } });

describe('good list and bad list', () => {
  it('a bare site covers its subdomains and every page', () => {
    const mark = markMatcher(lists(['site.com']));
    expect(mark('https://site.com/')).toBe('good');
    expect(mark('https://www.site.com/a/b?c=1')).toBe('good');
    expect(mark('https://blog.site.com/post')).toBe('good');
    expect(mark('https://notsite.com/')).toBeNull();
    expect(mark('https://site.com.evil.io/')).toBeNull();
  });

  it('a subdomain or a path narrows it', () => {
    const mark = markMatcher(lists(['music.youtube.com', 'youtube.com/shorts']));
    expect(mark('https://music.youtube.com/watch')).toBe('good');
    expect(mark('https://www.youtube.com/shorts/abc')).toBe('good');
    expect(mark('https://www.youtube.com/watch?v=1')).toBeNull();
  });

  it('the more specific entry wins across lists', () => {
    const mark = markMatcher(lists(['youtube.com/@experimentempire'], ['youtube.com']));
    expect(mark('https://www.youtube.com/@experimentempire/videos')).toBe('good');
    expect(mark('https://www.youtube.com/watch?v=x')).toBe('bad');
  });

  it('accepts pasted URLs and wildcards', () => {
    const mark = markMatcher(lists(['https://www.reddit.com/r/design/', '*.substack.com']));
    expect(mark('https://reddit.com/r/design/comments/1')).toBe('good');
    expect(mark('https://reddit.com/r/funny')).toBeNull();
    expect(mark('https://someone.substack.com/p/x')).toBe('good');
  });

  it('ships with experimentempire.com on the good list', () => {
    expect(markMatcher(DEFAULT_MARKS)('https://experimentempire.com/labs')).toBe('good');
  });
});
