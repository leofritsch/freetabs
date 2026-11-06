import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { placeGhostAt, plural, Toast, type ToastState } from '../board/components';
import { suggestFolderName } from '../lib/url';

/**
 * A practice board: the real board's rows, windows and folders, on made-up tabs.
 * Nothing here touches the browser. Same moves as the real thing: lasso from
 * empty space, click, ⌘-click, drag to a folder, ⌘Z.
 */

interface DemoTab {
  id: string;
  title: string;
  site: string;
  tint: 'sage' | 'ochre' | 'slate' | 'plum' | 'teal' | 'ink';
}
interface DemoWindow {
  id: string;
  name: string;
  idle?: string;
  tabs: DemoTab[];
}
interface DemoFolder {
  id: string;
  name: string;
  color: string;
  tabs: DemoTab[];
}

const tab = (id: string, title: string, site: string, tint: DemoTab['tint']): DemoTab => ({ id, title, site, tint });

const START_WINDOWS: DemoWindow[] = [
  {
    id: 'w1',
    name: 'This window',
    tabs: [
      tab('a', 'Q4 plan, final final v3', 'docs.northwind.co', 'slate'),
      tab('b', 'Why is my Mac so slow?', 'askatech.net', 'teal'),
      tab('c', 'Flights to Lisbon in March', 'farehopper.com', 'ochre'),
      tab('d', 'Invoice 2041 from Studio Hale', 'billbox.io', 'ink'),
      tab('e', 'Standing desk reviews', 'deskreport.org', 'sage'),
      tab('f', 'Miso aubergine in 25 minutes', 'smallkitchen.co', 'plum'),
      tab('g', 'How to read more books', 'longreads.page', 'teal'),
    ],
  },
  {
    id: 'w2',
    name: 'Window 2',
    idle: 'idle 3d',
    tabs: [
      tab('h', 'Two bedrooms in Porto', 'roomhunt.pt', 'ochre'),
      tab('i', 'Deep focus, a 3 hour mix', 'streamline.fm', 'plum'),
      tab('j', 'The case for doing one thing', 'longreads.page', 'teal'),
      tab('k', 'Competitor pricing', 'halcyon.so', 'slate'),
      tab('l', 'Spanish in 10 minutes a day', 'hablaya.app', 'sage'),
      tab('m', 'Tax deadline checklist', 'filewell.org', 'ink'),
    ],
  },
  {
    id: 'w3',
    name: 'Window 3',
    idle: 'idle 9d',
    tabs: [
      tab('n', 'Gift ideas for Mum', 'giftly.shop', 'plum'),
      tab('o', 'Standup notes, Tuesday', 'docs.northwind.co', 'slate'),
      tab('p', 'Why do cats knock things over?', 'pawfacts.org', 'teal'),
      tab('q', 'Learn to make ramen', 'smallkitchen.co', 'ochre'),
    ],
  },
];

const START_FOLDERS: DemoFolder[] = [
  { id: 'read', name: 'Read later', color: 'slate', tabs: [] },
  { id: 'watch', name: 'Watch later', color: 'plum', tabs: [] },
];

const TOTAL = START_WINDOWS.reduce((n, w) => n + w.tabs.length, 0);

type Point = { x: number; y: number };
type Gesture =
  | { kind: 'press'; key: string; x: number; y: number; meta: boolean; wasSelected: boolean }
  | { kind: 'drag'; keys: string[]; over: string | null }
  | { kind: 'lasso'; startX: number; startY: number; base: Set<string>; moved: boolean };

export interface DemoProgress {
  left: number;
  total: number;
  selected: number;
  saved: number;
  /** how many folders hold something */
  folders: number;
  /** the person has pressed something, so the hint is over */
  touched: boolean;
}

const ease = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);
const rect = (el: Element) => el.getBoundingClientRect();

export function Demo({ onProgress }: { onProgress: (p: DemoProgress) => void }) {
  const [windows, setWindows] = useState(START_WINDOWS);
  const [folders, setFolders] = useState(START_FOLDERS);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<{ keys: string[]; title: string } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [lassoing, setLassoing] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [touched, setTouched] = useState(false);
  const [hand, setHand] = useState<'off' | 'up' | 'down'>('off');

  const rootRef = useRef<HTMLDivElement>(null);
  const lassoRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const handRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const pointer = useRef<Point>({ x: 0, y: 0 });
  const history = useRef<{ windows: DemoWindow[]; folders: DemoFolder[] }[]>([]);
  const stopHint = useRef<() => void>(() => undefined);

  const left = windows.reduce((n, w) => n + w.tabs.length, 0);
  const saved = folders.reduce((n, f) => n + f.tabs.length, 0);

  useEffect(() => {
    // Rows on their way to a folder still count, so the hint doesn't flash back to the first instruction.
    onProgress({ left, total: TOTAL, selected: touched ? sel.size + leaving.size : 0, saved, folders: folders.filter((f) => f.tabs.length).length, touched });
  }, [left, saved, folders, sel.size, leaving.size, touched, onProgress]);

  // ---------- what the moves do ----------
  const undo = () => {
    const last = history.current.pop();
    if (!last) return;
    setWindows(last.windows);
    setFolders(last.folders);
    setToast({ id: Date.now(), message: 'They’re back where they were' });
  };

  const save = (keys: string[], target: string) => {
    const tabs = windows.flatMap((w) => w.tabs).filter((t) => keys.includes(t.id));
    if (!tabs.length) return;
    history.current.push({ windows, folders });
    let folder = folders.find((f) => f.id === target);
    const isNew = !folder;
    folder ??= { id: `new${Date.now()}`, name: suggestFolderName(tabs.map((t) => `https://${t.site}/`)), color: 'teal', tabs: [] };
    const landed = { ...folder, tabs: [...tabs, ...folder.tabs] };
    setSel(new Set());
    setLeaving(new Set(keys));
    setFlash(landed.id);
    setTimeout(() => setFlash((f) => (f === landed.id ? null : f)), 700);
    setTimeout(() => {
      setWindows((ws) => ws.map((w) => ({ ...w, tabs: w.tabs.filter((t) => !keys.includes(t.id)) })));
      setFolders((fs) => (isNew ? [...fs, landed] : fs.map((f) => (f.id === landed.id ? { ...f, tabs: [...tabs, ...f.tabs] } : f))));
      setLeaving(new Set());
    }, 190);
    setToast({ id: Date.now(), message: `Saved ${plural(tabs.length, 'tab')} to ${landed.name}`, action: { label: 'Undo', run: undo } });
  };

  const hintFor = (keys: string[], target: string | null) => {
    const what = keys.length > 1 ? ` ${keys.length} tabs` : '';
    if (!target) return keys.length > 1 ? `${keys.length} tabs` : '';
    if (target === 'new') return `Save${what} to a new folder`;
    return `Save${what} to ${folders.find((f) => f.id === target)?.name ?? 'folder'}`;
  };

  const api = useRef({ save, undo, sel, windows });
  api.current = { save, undo, sel, windows };

  // ---------- pointer engine, the board's in miniature ----------
  useEffect(() => {
    const root = rootRef.current!;
    const tilt = { x: 0, y: 0 };
    const velocity = { x: 0, y: 0 };
    let frame = 0;
    /** the hint is over, or never started */
    let stopped = matchMedia('(prefers-reduced-motion: reduce)').matches;

    const dropAt = (p: Point) => document.elementFromPoint(p.x, p.y)?.closest<HTMLElement>('[data-drop]')?.dataset.drop ?? null;

    const paintLasso = (g: Extract<Gesture, { kind: 'lasso' }>, p: Point) => {
      const l = Math.min(g.startX, p.x);
      const r = Math.max(g.startX, p.x);
      const t = Math.min(g.startY, p.y);
      const b = Math.max(g.startY, p.y);
      const el = lassoRef.current;
      if (el) {
        el.style.transform = `translate3d(${l}px, ${t}px, 0)`;
        el.style.width = `${r - l}px`;
        el.style.height = `${b - t}px`;
      }
      const hits = new Set(g.base);
      for (const row of root.querySelectorAll<HTMLElement>('[data-row]')) {
        const box = rect(row);
        if (box.right > l && box.left < r && box.bottom > t && box.top < b) hits.add(row.dataset.row!);
      }
      setSel((cur) => (cur.size === hits.size && [...cur].every((k) => hits.has(k)) ? cur : hits));
    };

    const tick = () => {
      frame = 0;
      if (gesture.current?.kind !== 'drag') return;
      const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
      tilt.x += ((still ? 0 : Math.max(-16, Math.min(16, velocity.x * 1.4))) - tilt.x) * 0.22;
      tilt.y += ((still ? 0 : Math.max(-10, Math.min(10, velocity.y * 0.9))) - tilt.y) * 0.22;
      velocity.x *= 0.7;
      velocity.y *= 0.7;
      placeGhostAt(ghostRef.current, pointer.current, tilt);
      frame = requestAnimationFrame(tick);
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      // Anywhere on the page counts as empty space, so a lasso can start in the margin.
      if (target.closest('button, a, input, .wel__top, .wel__foot, .demo__vault, .toast')) return;
      // What the hint had selected isn't yours: it's cleared by the time you move.
      const hinting = !stopped;
      stopHint.current();
      setTouched(true);
      pointer.current = { x: e.clientX, y: e.clientY };
      const row = target.closest<HTMLElement>('[data-row]');
      if (row) {
        const key = row.dataset.row!;
        gesture.current = { kind: 'press', key, x: e.clientX, y: e.clientY, meta: e.metaKey || e.ctrlKey, wasSelected: !hinting && api.current.sel.has(key) };
        return;
      }
      gesture.current = { kind: 'lasso', startX: e.clientX, startY: e.clientY, base: !hinting && (e.metaKey || e.ctrlKey || e.shiftKey) ? new Set(api.current.sel) : new Set(), moved: false };
    };

    const onMove = (e: PointerEvent) => {
      const g = gesture.current;
      if (!g) return;
      velocity.x += e.clientX - pointer.current.x;
      velocity.y += e.clientY - pointer.current.y;
      pointer.current = { x: e.clientX, y: e.clientY };
      if (g.kind === 'press') {
        if (Math.hypot(e.clientX - g.x, e.clientY - g.y) < 5) return;
        const { sel, windows } = api.current;
        const keys = g.wasSelected ? [...sel] : g.meta ? [...sel, g.key] : [g.key];
        setSel(new Set(keys));
        gesture.current = { kind: 'drag', keys, over: null };
        tilt.x = tilt.y = 0;
        setDrag({ keys, title: windows.flatMap((w) => w.tabs).find((t) => t.id === g.key)?.title ?? '' });
        document.body.dataset.dragging = 'true';
        frame ||= requestAnimationFrame(tick);
        return;
      }
      if (g.kind === 'drag') {
        const target = dropAt(pointer.current);
        if (target !== g.over) {
          g.over = target;
          setOver(target);
        }
        return;
      }
      if (!g.moved) {
        if (Math.hypot(e.clientX - g.startX, e.clientY - g.startY) < 5) return;
        g.moved = true;
        setLassoing(true);
      }
      paintLasso(g, pointer.current);
    };

    const onUp = (e: PointerEvent) => {
      const g = gesture.current;
      gesture.current = null;
      cancelAnimationFrame(frame);
      frame = 0;
      delete document.body.dataset.dragging;
      if (!g) return;
      if (g.kind === 'press') {
        setSel((cur) => {
          if (!g.meta) return new Set([g.key]);
          const next = new Set(cur);
          if (next.has(g.key)) next.delete(g.key);
          else next.add(g.key);
          return next;
        });
      } else if (g.kind === 'drag') {
        setDrag(null);
        setOver(null);
        const target = dropAt({ x: e.clientX, y: e.clientY });
        if (target) api.current.save(g.keys, target);
      } else {
        setLassoing(false);
        if (!g.moved) setSel(new Set());
      }
    };

    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        api.current.undo();
      } else if (e.key === 'Escape') {
        gesture.current = null;
        setDrag(null);
        setOver(null);
        setLassoing(false);
        setSel(new Set());
        delete document.body.dataset.dragging;
      }
    };

    window.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey);

    // ---------- the hint: a hand plays the two moves through, without saving anything ----------
    const cleanUp = () => {
      setHand('off');
      setLassoing(false);
      setDrag(null);
      setOver(null);
      setSel(new Set());
    };
    stopHint.current = () => {
      if (stopped) return;
      stopped = true;
      cleanUp();
    };
    const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
    const moveHand = (p: Point) => {
      if (handRef.current) handRef.current.style.transform = `translate3d(${p.x}px, ${p.y}px, 0)`;
    };
    const glide = (from: Point, to: Point, ms: number, each?: (p: Point) => void) =>
      new Promise<void>((done) => {
        const t0 = performance.now();
        const step = (now: number) => {
          if (stopped) return done();
          const k = ease(Math.min(1, (now - t0) / ms));
          const p = { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k };
          moveHand(p);
          each?.(p);
          if (k < 1) requestAnimationFrame(step);
          else done();
        };
        requestAnimationFrame(step);
      });

    const playHint = async () => {
      const col = (i: number) => [...root.querySelectorAll(`[data-col="${i}"] [data-row]`)];
      const first = col(0);
      const second = col(1);
      const third = root.querySelector('[data-col="2"] .win');
      const folder = root.querySelector('[data-drop="read"]');
      if (first.length < 7 || second.length < 6 || !third || !folder) return;
      // From the empty space under the third window, up and across the first two.
      const from = { x: rect(third).left + 44, y: rect(second[5]).bottom - 4 };
      const to = { x: rect(first[4]).left + 52, y: rect(first[4]).top + 9 };
      const grab = { x: rect(second[4]).left + 90, y: rect(second[4]).top + 20 };
      const box = rect(folder);
      const onFolder = { x: box.left + box.width * 0.4, y: box.top + box.height / 2 };

      moveHand(from);
      setHand('up');
      await wait(420);
      if (stopped) return;
      setHand('down');
      await wait(140);
      if (stopped) return;
      setLassoing(true);
      const lasso: Extract<Gesture, { kind: 'lasso' }> = { kind: 'lasso', startX: from.x, startY: from.y, base: new Set(), moved: true };
      await glide(from, to, 1050, (p) => paintLasso(lasso, p));
      if (stopped) return;
      setLassoing(false);
      setHand('up');
      await wait(420);
      if (stopped) return;
      await glide(to, grab, 460);
      if (stopped) return;
      setHand('down');
      await wait(120);
      if (stopped) return;
      const keys = [...api.current.sel];
      pointer.current = grab;
      setDrag({ keys, title: 'Spanish in 10 minutes a day' });
      await glide(grab, onFolder, 920, (p) => {
        pointer.current = p;
        placeGhostAt(ghostRef.current, p);
        setOver(dropAt(p));
      });
      if (stopped) return;
      await wait(620);
      if (stopped) return;
      cleanUp();
    };

    void (async () => {
      await wait(1100);
      for (let i = 0; i < 3 && !stopped; i++) {
        await playHint();
        await wait(4200);
      }
      stopped = true;
    })();

    return () => {
      stopped = true;
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKey);
      cancelAnimationFrame(frame);
      delete document.body.dataset.dragging;
    };
  }, []);

  useLayoutEffect(() => {
    if (drag) placeGhostAt(ghostRef.current, pointer.current);
  }, [drag, over]);

  const closeToast = () => setToast(null);

  return (
    <div className="demo" ref={rootRef} aria-label="A practice board you can try with a mouse">
      <div className="demo__board">
          {windows.map((w, i) => (
            <div className="wincol" data-col={i} key={w.id}>
              {w.tabs.length > 0 && (
                <section className="win" data-current={i === 0 || undefined}>
                  <header className="win__head">
                    <span className="win__name">{w.name}</span>
                    <span className="win__count">{w.tabs.length}</span>
                    {w.idle && <span className="win__idle">{w.idle}</span>}
                  </header>
                  <div className="win__rows">
                    {w.tabs.map((t) => (
                      <div className="row" key={t.id} data-row={t.id} aria-selected={sel.has(t.id)} data-leaving={leaving.has(t.id) || undefined}>
                        <span className="fav fav--letter demo__fav" data-tint={t.tint}>
                          {t.site[0].toUpperCase()}
                        </span>
                        <span className="row__title">{t.title}</span>
                        <span className="row__meta">
                          <span className="row__domain">{t.site}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          ))}
      </div>

      <aside className="demo__vault">
        <div className="vault__head demo__vaulthead">
          <span className="vault__title">Saved</span>
          <span className="vault__total">{plural(saved, 'tab')}</span>
        </div>
        <ul className="folders">
          {folders.map((f) => (
            <li key={f.id}>
              <div className="folder" data-drop={f.id} data-over={over === f.id || undefined} data-flash={flash === f.id || undefined}>
                <span className="folder__top">
                  <span className="folder__dot" data-color={f.color} aria-hidden="true" />
                  <span className="folder__name">{f.name}</span>
                  <span className="folder__count">{f.tabs.length}</span>
                </span>
                <span className="folder__peek" aria-hidden="true">
                  {f.tabs.slice(0, 5).map((t) => (
                    <span key={t.id} className="fav fav--letter folder__fav demo__fav" data-tint={t.tint}>
                      {t.site[0].toUpperCase()}
                    </span>
                  ))}
                  {f.tabs.length > 5 && <span className="folder__more">+{f.tabs.length - 5}</span>}
                  {f.tabs.length ? <span className="folder__when">saved just now</span> : <span className="folder__when folder__when--empty">Drop tabs here</span>}
                </span>
              </div>
            </li>
          ))}
        </ul>
        <div className="folder folder--new" data-drop="new" data-over={over === 'new' || undefined}>
          <span className="folder__top">
            <span className="folder__plus" aria-hidden="true">
              +
            </span>
            <span className="folder__name">New folder</span>
          </span>
        </div>
      </aside>

      {drag && (
        <div className="ghost" ref={ghostRef} aria-hidden="true">
          <div className="ghost__body" data-stack={Math.min(drag.keys.length, 3)}>
            <span className="ghost__title">{drag.title}</span>
            {hintFor(drag.keys, over) && <span className="ghost__hint">{hintFor(drag.keys, over)}</span>}
          </div>
        </div>
      )}
      {lassoing && <div className="lasso" ref={lassoRef} aria-hidden="true" />}
      {sel.size > 1 && !drag && (
        <div className="chip" role="status">
          {sel.size} selected
        </div>
      )}
      <div className="demo__hand" ref={handRef} data-state={hand} aria-hidden="true">
        <svg viewBox="0 0 24 24" width="26" height="26">
          <path d="M5 3 19 12.5l-6.2 1.2 3.6 6.6-2.7 1.4-3.5-6.7L5.5 19z" fill="#2a2520" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
        </svg>
      </div>
      <Toast toast={toast} onDone={closeToast} />
    </div>
  );
}
