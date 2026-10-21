const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref_src)$/i;

const BLANK_URLS = new Set([
  '',
  'about:blank',
  'chrome://newtab/',
  'chrome://new-tab-page/',
  'chrome-search://local-ntp/local-ntp.html',
]);

/** Key used to dedupe saved tabs inside a folder. Keeps the hash: SPAs route with it. */
export function normalizeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw.trim();
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return url.href;
  url.hostname = url.hostname.toLowerCase();
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  let out = url.href;
  if (url.pathname.length > 1 && url.pathname.endsWith('/') && !url.search && !url.hash) {
    out = out.slice(0, -1);
  }
  return out;
}

export function domainOf(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.hostname.replace(/^www\./, '');
    if (url.protocol === 'file:') return 'Local file';
    if (url.protocol === 'chrome:') return `chrome://${url.hostname}`;
    return url.protocol.replace(/:$/, '');
  } catch {
    return '';
  }
}

export function isBlankUrl(raw: string | undefined): boolean {
  return BLANK_URLS.has(raw ?? '');
}

/** Browser-internal pages that can be saved but may not reopen everywhere. */
export function isSystemUrl(raw: string): boolean {
  return /^(chrome|chrome-extension|edge|about|devtools|view-source|file):/i.test(raw);
}

/** Folder name suggested for a set of tabs: the dominant domain, else the date. */
export function suggestFolderName(urls: string[], now = new Date()): string {
  const counts = new Map<string, number>();
  for (const url of urls) {
    const domain = domainOf(url);
    if (domain) counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  let best = '';
  let bestCount = 0;
  for (const [domain, count] of counts) {
    if (count > bestCount) {
      best = domain;
      bestCount = count;
    }
  }
  if (best && (bestCount / urls.length >= 0.5 || urls.length === 1)) return best;
  return `Saved ${now.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}
