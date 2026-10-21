import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, TRASH_ID, type SavedTab } from '../lib/db';
import type { Mark } from '../lib/marks';
import { domainOf } from '../lib/url';
import { ago, faviconFor, plural } from './components';

const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

type Item =
  | { kind: 'live'; key: string; tab: chrome.tabs.Tab; where: string }
  | { kind: 'saved'; key: string; tab: SavedTab; where: string };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every word must appear somewhere in the title or the URL. */
const matchesAll = (words: string[], ...fields: string[]) => {
  const hay = fields.join(' ').toLowerCase();
  return words.every((w) => hay.includes(w));
};

function highlight(text: string, words: string[]): ReactNode {
  if (!words.length) return text;
  const parts = text.split(new RegExp(`(${words.map(escapeRe).join('|')})`, 'gi'));
  return parts.map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : <Fragment key={i}>{part}</Fragment>));
}

/**
 * Search, Raycast-style: it grows out of the search pill to the center, lists
 * matches as you type, and stays on the keyboard. ↵ goes to the tab, ⇧↵ selects
 * every matching open tab on the board (ready to drag or press 1–9).
 */
export function Palette({
  open,
  trigger,
  windows,
  folderName,
  markOf,
  savedTotal,
  onClose,
  onGoLive,
  onOpenSaved,
  onSelectLive,
}: {
  open: boolean;
  trigger: HTMLElement | null;
  windows: { name: string; tabs: chrome.tabs.Tab[] }[];
  folderName: (id: string) => string;
  markOf: (url: string) => Mark | null;
  savedTotal: number;
  onClose: () => void;
  onGoLive: (tab: chrome.tabs.Tab) => void;
  onOpenSaved: (id: string) => void;
  onSelectLive: (tabIds: number[]) => void;
}) {
  const [shown, setShown] = useState(open);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const words = useMemo(() => query.toLowerCase().split(/\s+/).filter(Boolean), [query]);

  const saved = useLiveQuery(
    async () =>
      words.length
        ? db.tabs.filter((t) => t.folderId !== TRASH_ID && matchesAll(words, t.title, t.url)).limit(60).toArray()
        : db.tabs.orderBy('savedAt').reverse().filter((t) => t.folderId !== TRASH_ID).limit(6).toArray(),
    [words.join(' ')],
    [] as SavedTab[],
  );

  const liveItems = useMemo<Item[]>(
    () =>
      words.length
        ? windows.flatMap((w) =>
            w.tabs
              .filter((t) => !(t.url ?? '').startsWith(chrome.runtime.getURL('board.html')) && matchesAll(words, t.title ?? '', t.url ?? ''))
              .map((t) => ({ kind: 'live' as const, key: `l${t.id}`, tab: t, where: w.name })),
          )
        : [],
    [windows, words],
  );
  const savedItems = useMemo<Item[]>(
    () => saved.map((t) => ({ kind: 'saved' as const, key: `s${t.id}`, tab: t, where: folderName(t.folderId) })),
    [saved, folderName],
  );
  const items = useMemo(() => [...liveItems, ...savedItems], [liveItems, savedItems]);
  useEffect(() => setActive(0), [query]);

  // Grow out of the search pill on open, shrink back into it on close.
  const flip = (direction: 'in' | 'out') => {
    const panel = panelRef.current;
    const backdrop = backdropRef.current;
    if (!panel) return null;
    const to = panel.getBoundingClientRect();
    const from = trigger?.getBoundingClientRect();
    const still = reduced() || !from;
    const scale = from ? from.width / to.width : 1;
    const start = still
      ? { opacity: 0, transform: 'none' }
      : { opacity: 0.2, transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${scale})` };
    const end = { opacity: 1, transform: 'none' };
    const timing = { duration: direction === 'in' ? 240 : 170, easing: EASE_OUT, fill: 'both' as const };
    backdrop?.animate([{ opacity: 0 }, { opacity: 1 }], { ...timing, direction: direction === 'in' ? 'normal' : 'reverse' });
    return panel.animate(direction === 'in' ? [start, end] : [end, start], timing);
  };

  useLayoutEffect(() => {
    if (open) {
      setShown(true);
      return;
    }
    if (!shown) return;
    const anim = flip('out');
    if (anim) anim.finished.then(() => setShown(false), () => setShown(false));
    else setShown(false);
  }, [open]);

  useLayoutEffect(() => {
    if (!shown || !open) return;
    setQuery('');
    flip('in');
    inputRef.current?.focus();
  }, [shown]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!shown) return null;

  const run = (item: Item | undefined) => {
    if (!item) return;
    if (item.kind === 'live') onGoLive(item.tab);
    else onOpenSaved(item.tab.id);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
      e.preventDefault();
      setActive((i) => Math.min(items.length - 1, i + 1));
    } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      if (liveItems.length) {
        onSelectLive(liveItems.map((i) => (i.tab as chrome.tabs.Tab).id!));
        onClose();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(items[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  const liveTotal = windows.reduce((n, w) => n + w.tabs.length, 0);
  let index = -1;
  const section = (title: string, list: Item[]) =>
    list.length > 0 && (
      <div className="palette__section" role="group" aria-label={title}>
        <div className="palette__heading">{title}</div>
        {list.map((item) => {
          index++;
          const i = index;
          const url = item.tab.url ?? '';
          const isActive = i === active;
          return (
            <div
              key={item.key}
              id={item.key}
              className="palette__item"
              role="option"
              aria-selected={isActive}
              data-active={isActive || undefined}
              data-mark={markOf(url) || undefined}
              onMouseMove={() => active !== i && setActive(i)}
              onClick={() => run(item)}
            >
              <img className="fav" src={faviconFor(url)} width={16} height={16} alt="" />
              <span className="palette__text">
                <span className="palette__title">{highlight(item.tab.title || url, words)}</span>
                <span className="palette__url">{highlight(domainOf(url), words)}</span>
              </span>
              <span className="palette__where">
                {isActive ? (item.kind === 'live' ? 'Switch to tab' : 'Open') : item.kind === 'saved' && !words.length ? ago((item.tab as SavedTab).savedAt) : item.where}
              </span>
            </div>
          );
        })}
      </div>
    );

  return (
    <div className="palette" role="presentation">
      <div className="palette__backdrop" ref={backdropRef} onPointerDown={onClose} />
      <div className="palette__panel" ref={panelRef} role="dialog" aria-label="Search tabs">
        <div className="palette__field">
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <circle cx="7" cy="7" r="4.75" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={`Search ${plural(liveTotal, 'open tab')} and ${plural(savedTotal, 'saved tab')}`}
            aria-label="Search open and saved tabs"
            aria-activedescendant={items[active]?.key}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            spellCheck={false}
          />
        </div>
        <div className="palette__list" id="palette-list" role="listbox" ref={listRef}>
          {section(words.length ? `Open tabs, ${liveItems.length}` : '', liveItems)}
          {section(words.length ? `Saved, ${savedItems.length}${savedItems.length === 60 ? '+' : ''}` : 'Recently saved', savedItems)}
          {words.length > 0 && !items.length && <p className="palette__empty">Nothing open or saved matches “{query.trim()}”.</p>}
        </div>
        <footer className="palette__foot">
          <span>
            <kbd>↵</kbd> {items[active]?.kind === 'saved' ? 'Open' : 'Switch to tab'}
          </span>
          {liveItems.length > 0 && (
            <span>
              <kbd>⇧</kbd>
              <kbd>↵</kbd> Select {plural(liveItems.length, 'matching tab')} on the board
            </span>
          )}
          <span className="palette__esc">
            <kbd>esc</kbd> Close
          </span>
        </footer>
      </div>
    </div>
  );
}
