/**
 * Good list and bad list: sites that glow green or red wherever their tabs show up.
 *
 * "youtube.com" covers the site, every subdomain and every page. Writing more
 * narrows it the way you'd expect: "music.youtube.com" is that subdomain (and
 * its own subdomains), "youtube.com/shorts" is that part of the site. A "*"
 * works as a wildcard for anything fancier.
 */
export type Mark = 'good' | 'bad';

export interface SiteList {
  sites: string[];
}

export interface Marks {
  good: SiteList;
  bad: SiteList;
}

export const DEFAULT_MARKS: Marks = {
  good: { sites: ['experimentempire.com'] },
  bad: { sites: [] },
};

interface Rule {
  mark: Mark;
  /** longer entries are more specific and win when both lists match */
  weight: number;
  test: (host: string, rest: string) => boolean;
}

const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/** Tidy what someone typed into the comparable form: no scheme, no www, lower case. */
export function cleanSite(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '');
}

function rule(raw: string, mark: Mark): Rule | null {
  const entry = cleanSite(raw);
  if (!entry) return null;
  if (entry.includes('*')) {
    const pattern = entry.split('*').map(escape).join('.*');
    const re = new RegExp(`^${pattern}${entry.includes('/') ? '' : '(/.*)?'}$`);
    return { mark, weight: entry.replace(/\*/g, '').length, test: (host, rest) => re.test(host + rest) };
  }
  const slash = entry.indexOf('/');
  const site = slash === -1 ? entry : entry.slice(0, slash);
  const path = slash === -1 ? '' : entry.slice(slash);
  return {
    mark,
    weight: entry.length,
    test: (host, rest) => (host === site || host.endsWith(`.${site}`)) && (!path || rest.startsWith(path)),
  };
}

/** Build the lookup once per settings change; call it for every tab. */
export function markMatcher(marks: Marks): (url: string) => Mark | null {
  const rules = [
    ...marks.good.sites.map((s) => rule(s, 'good')),
    ...marks.bad.sites.map((s) => rule(s, 'bad')),
  ].filter((r): r is Rule => !!r);
  if (!rules.length) return () => null;
  return (url) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const rest = (parsed.pathname + parsed.search).toLowerCase();
    let best: Rule | null = null;
    for (const r of rules) {
      if (!r.test(host, rest)) continue;
      if (!best || r.weight > best.weight || (r.weight === best.weight && r.mark === 'bad')) best = r;
    }
    return best?.mark ?? null;
  };
}
