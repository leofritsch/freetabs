import { getSettings } from './settings';

/**
 * Optional, off by default: before closing, look inside pages for text the user
 * typed into a form that the page itself doesn't guard with "Leave site?".
 * Needs the optional <all_urls> host permission, granted from Settings.
 */
export const TYPED_ORIGINS = ['<all_urls>'];

export const hasTypedPermission = () => chrome.permissions.contains({ origins: TYPED_ORIGINS });

/** Runs inside the page. Must stay self-contained: it's serialized by chrome.scripting. */
export function pageHasTypedText(): boolean {
  for (const el of document.querySelectorAll('input, textarea, select')) {
    if (el instanceof HTMLTextAreaElement) {
      if (el.value.trim() && el.value !== el.defaultValue) return true;
    } else if (el instanceof HTMLSelectElement) {
      // With nothing marked selected, a single select shows its first option by default.
      const options = [...el.options];
      if (el.multiple) {
        if (options.some((o) => o.selected !== o.defaultSelected)) return true;
      } else if (options.length && el.selectedIndex !== Math.max(0, options.findIndex((o) => o.defaultSelected))) {
        return true;
      }
    } else if (el instanceof HTMLInputElement) {
      if (['hidden', 'submit', 'button', 'reset', 'image', 'file', 'range', 'color'].includes(el.type)) continue;
      if (el.type === 'checkbox' || el.type === 'radio') {
        if (el.checked !== el.defaultChecked) return true;
      } else if (el.value.trim() && el.value !== el.defaultValue) {
        return true;
      }
    }
  }
  const active = document.activeElement;
  return active instanceof HTMLElement && active.isContentEditable && active.innerText.trim().length > 0;
}

const CHECK_TIMEOUT = 600;

/** Tab ids whose pages hold typed text. Empty when the setting is off or permission is missing. */
export async function findTypedTabs(tabs: chrome.tabs.Tab[]): Promise<Set<number>> {
  if (!(await getSettings()).checkTyped) return new Set();
  if (!(await hasTypedPermission().catch(() => false))) return new Set();
  const checkable = tabs.filter((t) => t.id != null && !t.discarded && /^(https?|file):/.test(t.url ?? ''));
  const hits = await Promise.all(
    checkable.map((t) =>
      Promise.race([
        chrome.scripting
          .executeScript({ target: { tabId: t.id!, allFrames: true }, func: pageHasTypedText })
          .then((results) => results.some((r) => r.result === true))
          .catch(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), CHECK_TIMEOUT)),
      ]).then((typed) => (typed ? t.id! : null)),
    ),
  );
  return new Set(hits.filter((id): id is number => id != null));
}
