import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Folder } from '../lib/db';
import { GROUP_COLORS } from '../lib/groups';
import { domainOf, isNewTabUrl, isSystemUrl } from '../lib/url';

export const FOLDER_COLORS = ['ink', 'sage', 'ochre', 'slate', 'plum', 'teal'] as const;

export const faviconFor = (url: string) => `/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`;

export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** For a sentence: "just now", "3d ago", "on Oct 20". */
export function agoLong(ms: number): string {
  const a = ago(ms);
  return a === 'now' ? 'just now' : /\d[mhd]$/.test(a) ? `${a} ago` : `on ${a}`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Hat and glasses, the way Chrome draws incognito. */
export function IncognitoIcon({ title = 'Incognito' }: { title?: string }) {
  return (
    <svg className="incognito" viewBox="0 0 24 24" width="14" height="14" role="img" aria-label={title}>
      <title>{title}</title>
      <path d="M8.2 3.4c.2-.6.8-.9 1.4-.7l2.4.7 2.4-.7c.6-.2 1.2.1 1.4.7L18 10H6z" fill="currentColor" />
      <path d="M2.5 11.5h19" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="7" cy="17" r="3.1" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="17" cy="17" r="3.1" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M10.1 16.6c1.3-.9 2.5-.9 3.8 0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function DotsIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <circle cx="3.5" cy="8" r="1.3" fill="currentColor" />
      <circle cx="8" cy="8" r="1.3" fill="currentColor" />
      <circle cx="12.5" cy="8" r="1.3" fill="currentColor" />
    </svg>
  );
}

function Favicon({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  if (failed || !url) return <span className="fav fav--letter">{(domainOf(url)[0] ?? '·').toUpperCase()}</span>;
  return <img className="fav" src={faviconFor(url)} width={16} height={16} alt="" decoding="async" onError={() => setFailed(true)} />;
}

/**
 * Follow the pointer, flipping to the other side near the window's edges.
 * The tilt leans the ghost into the direction of travel, like a card held between two fingers.
 */
export function placeGhostAt(el: HTMLElement | null, p: { x: number; y: number }, tilt = { x: 0, y: 0 }) {
  if (!el) return;
  let x = p.x + 14;
  let y = p.y + 10;
  if (x + el.offsetWidth > window.innerWidth - 8) x = p.x - el.offsetWidth - 14;
  if (y + el.offsetHeight > window.innerHeight - 8) y = p.y - el.offsetHeight - 10;
  el.style.transform = `translate3d(${x}px, ${y}px, 0) perspective(700px) rotateY(${tilt.x.toFixed(2)}deg) rotateX(${(-tilt.y).toFixed(2)}deg) rotate(${(tilt.x * 0.2).toFixed(2)}deg)`;
}

export interface RowProps {
  rowKey: string;
  source: 'live' | 'saved';
  url: string;
  title: string;
  selected: boolean;
  lassoable: boolean;
  windowId?: number;
  leaving?: boolean;
  pinned?: boolean;
  audible?: boolean;
  incognito?: boolean;
  /** the page asked "Leave site?" when FreeTabs tried to close it */
  unsaved?: boolean;
  meta?: string;
  /** on the good list or the bad list */
  mark?: 'good' | 'bad' | null;
}

const PULSE_MS = 2600;

export const Row = memo(function Row(p: RowProps) {
  const domain = domainOf(p.url);
  // Every marked row breathes on the same clock, wherever and whenever it mounted.
  const [phase] = useState(() => -(Date.now() % PULSE_MS));
  return (
    <div
      className="row"
      data-row={p.rowKey}
      data-source={p.source}
      data-window={p.windowId}
      data-lassoable={p.lassoable}
      data-leaving={p.leaving || undefined}
      data-mark={p.mark || undefined}
      style={p.mark ? ({ '--phase': `${phase}ms` } as React.CSSProperties) : undefined}
      aria-selected={p.selected}
      role="option"
      title={`${p.title}\n${p.url}`}
    >
      <Favicon url={p.url} />
      <span className="row__title">{p.title || p.url}</span>
      <span className="row__meta">
        {!isNewTabUrl(p.url) && <span className="row__domain">{domain}</span>}
        {p.pinned && <span className="tag">Pinned</span>}
        {p.audible && <span className="tag">Playing sound</span>}
        {isSystemUrl(p.url) && !isNewTabUrl(p.url) && <span className="tag">Browser page</span>}
        {p.unsaved && <span className="tag tag--warn">Unsaved changes</span>}
        {p.incognito && <IncognitoIcon title="From an incognito window. Hidden from AI." />}
        {p.meta && <span className="row__when">{p.meta}</span>}
      </span>
    </div>
  );
});

/** A folder on the right: big enough to aim a drop at, with a peek at what's inside. */
export function FolderRow({
  folder,
  count,
  preview,
  active,
  over,
  flash,
  digit,
  renaming,
  onRename,
  compact,
  lifted,
}: {
  folder: Folder;
  count: number;
  preview: string[];
  lifted?: 'held' | 'carried';
  active: boolean;
  over: boolean;
  flash: boolean;
  digit?: number;
  renaming: boolean;
  onRename: (name: string | null) => void;
  compact?: boolean;
}) {
  const shown = preview.slice(0, 5);
  return (
    <li>
      <div
        className="folder"
        data-compact={compact || undefined}
        data-drop={`folder:${folder.id}`}
        data-folder={folder.id}
        data-grab={folder.kind === 'trash' ? undefined : `folder:${folder.id}`}
        data-over={over || undefined}
        data-flash={flash || undefined}
        data-lifted={lifted}
        aria-current={active || undefined}
        role="button"
        tabIndex={0}
      >
        <span className="folder__top">
          <span className="folder__dot" data-color={folder.kind === 'user' ? (folder.color ?? 'none') : folder.kind} aria-hidden="true" />
          {renaming ? <NameInput initial={folder.name} onDone={onRename} /> : <span className="folder__name">{folder.name}</span>}
          {digit != null && <kbd className="folder__digit">{digit}</kbd>}
          <span className="folder__count">{count}</span>
        </span>
        {!compact && (
          <span className="folder__peek" aria-hidden="true">
            {shown.map((url, i) => (
              <img key={i} className="folder__fav" src={faviconFor(url)} width={16} height={16} alt="" decoding="async" />
            ))}
            {count > shown.length && shown.length > 0 && <span className="folder__more">+{count - shown.length}</span>}
            {count ? (
              <span className="folder__when">saved {agoLong(folder.updatedAt)}</span>
            ) : (
              <span className="folder__when folder__when--empty">Drop tabs here</span>
            )}
          </span>
        )}
      </div>
    </li>
  );
}

export function NameInput({
  initial,
  onDone,
  className = 'folder__input',
  label = 'Folder name',
}: {
  initial: string;
  onDone: (name: string | null) => void;
  className?: string;
  label?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(value);
  };
  return (
    <input
      ref={ref}
      className={className}
      defaultValue={initial}
      aria-label={label}
      data-no-lasso
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(e.currentTarget.value);
        if (e.key === 'Escape') finish(null);
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}

export type MenuEntry =
  | { label: string; run: () => void; hint?: string; danger?: boolean; disabled?: boolean; inset?: boolean }
  | { heading: string }
  | { swatches: true; current: string | null; pick: (color: string | null) => void; palette?: 'folder' | 'group' }
  | 'sep';

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuEntry[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // offset sizes ignore the entrance scale, so the clamp is exact
    setPos({
      x: Math.max(8, Math.min(x, window.innerWidth - el.offsetWidth - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - el.offsetHeight - 8)),
    });
    el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [x, y]);
  useEffect(() => {
    const close = (e: Event) => {
      if (e.type === 'keydown' && (e as KeyboardEvent).key !== 'Escape') return;
      if (e.type === 'pointerdown' && ref.current?.contains(e.target as Node)) return;
      // Escape closes the menu only; the selection underneath stays.
      if (e.type === 'keydown') e.stopPropagation();
      onClose();
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', close, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', close, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="menu"
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('.menu__item:not(:disabled)') ?? [])];
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }}
    >
      {items.map((item, i) => {
        if (item === 'sep') return <div key={i} className="menu__sep" role="separator" />;
        if ('heading' in item)
          return (
            <div key={i} className="menu__heading" role="presentation">
              {item.heading}
            </div>
          );
        if ('swatches' in item)
          return (
            <div key={i} className="menu__swatches" role="group" aria-label="Color" data-palette={item.palette ?? 'folder'}>
              {(item.palette === 'group' ? GROUP_COLORS : FOLDER_COLORS).map((c) => (
                <button
                  key={c}
                  className="swatch"
                  data-color={c}
                  aria-label={c}
                  aria-pressed={item.current === c}
                  onClick={() => {
                    item.pick(item.palette === 'group' ? c : item.current === c ? null : c);
                    onClose();
                  }}
                />
              ))}
            </div>
          );
        return (
          <button
            key={i}
            className="menu__item"
            role="menuitem"
            data-danger={item.danger || undefined}
            data-inset={item.inset || undefined}
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.run();
            }}
          >
            <span>{item.label}</span>
            {item.hint && <kbd>{item.hint}</kbd>}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Saved tabs just landed on a window: should the folder keep them too?
 * Opens where they were dropped. C or M chooses, Escape or a click elsewhere backs out.
 */
export function DropChoice({
  x,
  y,
  heading,
  keeps,
  leaves,
  onChoose,
  onCancel,
}: {
  x: number;
  y: number;
  heading: string;
  keeps: string;
  leaves: string;
  onChoose: (mode: 'copy' | 'move', remember: boolean) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [remember, setRemember] = useState(false);
  const latest = useRef({ remember, onChoose, onCancel });
  latest.current = { remember, onChoose, onCancel };

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPos({
      x: Math.max(8, Math.min(x, window.innerWidth - el.offsetWidth - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - el.offsetHeight - 8)),
    });
    el.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }, [x, y]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (key !== 'escape' && key !== 'c' && key !== 'm' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      const { remember, onChoose, onCancel } = latest.current;
      if (key === 'escape') onCancel();
      else if (key === 'c') onChoose('copy', remember);
      else if (key === 'm') onChoose('move', remember);
      else [...(ref.current?.querySelectorAll<HTMLButtonElement>('.choice__opt') ?? [])][e.key === 'ArrowLeft' ? 0 : 1]?.focus();
    };
    const onDown = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) latest.current.onCancel();
    };
    const onResize = () => latest.current.onCancel();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  return (
    <div ref={ref} className="choice" role="dialog" aria-label={heading} data-no-lasso style={{ left: pos.x, top: pos.y }}>
      <p className="choice__heading">{heading}</p>
      <div className="choice__opts">
        <button className="choice__opt" onClick={() => onChoose('copy', remember)}>
          <span className="choice__top">
            <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
              <rect x="6.5" y="6.5" width="9" height="9" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <path d="M11.5 3.5H5a2 2 0 0 0-2 2V12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <span className="choice__name">Copy</span>
            <kbd>C</kbd>
          </span>
          <span className="choice__help">{keeps}</span>
        </button>
        <button className="choice__opt" onClick={() => onChoose('move', remember)}>
          <span className="choice__top">
            <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
              <path d="M8 3.5H5.5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2H8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <path d="M7.5 9h7.5M12 6l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="choice__name">Move</span>
            <kbd>M</kbd>
          </span>
          <span className="choice__help">{leaves}</span>
        </button>
      </div>
      <label className="choice__remember">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        Always do this, don’t ask again
      </label>
    </div>
  );
}

export interface ToastState {
  id: number;
  message: string;
  tone?: 'error';
  action?: { label: string; run: () => void };
  /** work still running: a spinner, no timeout, no close button */
  pending?: boolean;
}

export function Toast({ toast, onDone }: { toast: ToastState | null; onDone: () => void }) {
  useEffect(() => {
    if (!toast || toast.pending) return;
    const t = setTimeout(onDone, toast.tone === 'error' ? 15000 : 10000);
    return () => clearTimeout(t);
  }, [toast, onDone]);
  if (!toast) return null;
  return (
    <div className="toast" key={toast.pending ? 'pending' : 'done'} role={toast.tone === 'error' ? 'alert' : 'status'} data-tone={toast.tone} data-pending={toast.pending || undefined}>
      {toast.pending && <span className="spinner" aria-hidden="true" />}
      <span>{toast.message}</span>
      {toast.action && (
        <button
          className="toast__action"
          onClick={() => {
            toast.action!.run();
            onDone();
          }}
        >
          {toast.action.label}
        </button>
      )}
      {!toast.pending && (
        <button className="toast__close" aria-label="Dismiss" onClick={onDone}>
          ×
        </button>
      )}
    </div>
  );
}
