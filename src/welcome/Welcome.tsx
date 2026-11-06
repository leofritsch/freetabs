import { useCallback, useEffect, useRef, useState } from 'react';
import { aiLinkWanted, MCPB_URL } from '../lib/ailink';
import { getSettings, setSettings } from '../lib/settings';
import { plural } from '../board/components';
import { isNewTabUrl } from '../lib/url';
import { Demo, type DemoProgress } from './Demo';

const isMac = /mac/i.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl+';
const STUDIO_URL = 'https://experimentempire.com/?utm_source=freetabs&utm_medium=extension&utm_campaign=welcome';
const SOURCE_URL = 'https://github.com/leofritsch/freetabs';
/** Below this the headline stays general: "3 open tabs" is nothing to be freed from. */
const WORTH_NAMING = 10;
/** After the first drop: how long the new number stays up, then how long the fade takes (welcome.css has it too). */
const HOLD_AFTER_DROP = 300;
const FADE_TO_NEXT = 220;

/** Ease a number toward its target, so the headline counts down rather than jumps. */
function useTween(target: number | null) {
  const [value, setValue] = useState(target);
  const shown = useRef(target);
  useEffect(() => {
    if (target == null) return;
    const from = shown.current;
    if (from == null || from === target || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      shown.current = target;
      setValue(target);
      return;
    }
    const t0 = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      const k = Math.min(1, (now - t0) / 420);
      const eased = 1 - (1 - k) ** 3;
      shown.current = Math.round(from + (target - from) * eased);
      setValue(shown.current);
      if (k < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return value;
}

/** A small browser window, the frame both new tab choices are drawn in. */
function MiniBrowser({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 580 318" className="mini" aria-hidden="true">
      <rect x="0.75" y="0.75" width="578.5" height="316.5" rx="14" className="mini__frame" />
      <path d="M1 36 H579" className="mini__rule" />
      <circle cx="18" cy="18" r="4" className="mini__soft" />
      <circle cx="32" cy="18" r="4" className="mini__soft" />
      <circle cx="46" cy="18" r="4" className="mini__soft" />
      <path d="M64 36 V16 a6 6 0 0 1 6-6 H178 a6 6 0 0 1 6 6 V36" className="mini__tab" />
      <text x="78" y="27" className="mini__tabtext">
        New tab
      </text>
      <rect x="14" y="44" width="552" height="20" rx="10" className="mini__wash" />
      {children}
    </svg>
  );
}

function MiniBoard() {
  const win = (x: number, rows: number, inked: number[]) => (
    <g key={x}>
      <rect x={x} y="78" width="124" height={22 + rows * 22} rx="9" className="mini__line" />
      <rect x={x + 10} y="87" width="42" height="5" rx="2.5" className="mini__soft" />
      {Array.from({ length: rows }, (_, i) => {
        const on = inked.includes(i);
        return (
          <g key={i}>
            {on && <rect x={x + 4} y={100 + i * 22 - 3} width="116" height="22" rx="4" className="mini__ink" />}
            <rect x={x + 10} y={100 + i * 22 + 2} width="9" height="9" rx="2.5" className={on ? 'mini__paper' : 'mini__soft'} />
            <rect x={x + 25} y={100 + i * 22 + 4} width={72 - ((i * 17 + x) % 26)} height="5" rx="2.5" className={on ? 'mini__paper' : 'mini__soft'} />
          </g>
        );
      })}
    </g>
  );
  return (
    <MiniBrowser>
      {win(14, 8, [3, 4, 5])}
      {win(146, 6, [3, 4])}
      {win(278, 4, [])}
      <path d="M410 72 V316" className="mini__rule" />
      {[0, 1, 2].map((i) => (
        <g key={i}>
          <rect x="424" y={78 + i * 56} width="142" height="46" rx="9" className={i === 0 ? 'mini__ink' : 'mini__line'} />
          <circle cx="440" cy={94 + i * 56} r="4" className={i === 0 ? 'mini__paper' : 'mini__soft'} />
          <rect x="452" y={91 + i * 56} width={70 - i * 12} height="6" rx="3" className={i === 0 ? 'mini__paper' : 'mini__soft'} />
          {[0, 1, 2].map((j) => (
            <rect key={j} x={452 + j * 13} y={106 + i * 56} width="9" height="9" rx="2.5" className={i === 0 ? 'mini__paper' : 'mini__soft'} opacity={i === 2 ? 0 : 1} />
          ))}
        </g>
      ))}
    </MiniBrowser>
  );
}

function MiniChrome() {
  return (
    <MiniBrowser>
      <rect x="130" y="146" width="320" height="38" rx="19" className="mini__line" />
      <circle cx="152" cy="165" r="5" className="mini__soft" />
      <rect x="168" y="162" width="104" height="6" rx="3" className="mini__soft" />
      {[0, 1, 2, 3, 4].map((i) => (
        <circle key={i} cx={210 + i * 40} cy="218" r="13" className="mini__wash" />
      ))}
    </MiniBrowser>
  );
}

function NewTabStep() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    getSettings().then((s) => setOn(s.newTab));
    // Seeing this choice is the answer; the board won't ask again.
    void chrome.storage.local.set({ newTabAsked: true });
  }, []);
  const pick = (value: boolean) => {
    setOn(value);
    void setSettings({ newTab: value });
  };
  return (
    <>
      <h1 className="wel__title">Your board, on every new tab.</h1>
      <p className="wel__hint">Open a tab and all your others are right there. Or keep things as they were.</p>
      <div className="picks" role="radiogroup" aria-label="What a new tab shows">
        <button className="pick" role="radio" aria-checked={on === true} onClick={() => pick(true)}>
          <MiniBoard />
          <span className="pick__label">
            <span className="pick__dot" aria-hidden="true" />
            <span className="pick__name">FreeTabs on every new tab</span>
          </span>
          <span className="pick__help">The address bar still works, so type as usual.</span>
        </button>
        <button className="pick" role="radio" aria-checked={on === false} onClick={() => pick(false)}>
          <MiniChrome />
          <span className="pick__label">
            <span className="pick__dot" aria-hidden="true" />
            <span className="pick__name">Chrome’s default new tab</span>
          </span>
          <span className="pick__help">Open your board with the toolbar icon, or {MOD}⇧K.</span>
        </button>
      </div>
      <p className="wel__note">
        Press <kbd>{MOD}T</kbd> to try it. Chrome asks once, “Did you mean to change this page?” Choose Keep it: Change it back turns FreeTabs off.
      </p>
    </>
  );
}

function Check() {
  return (
    <span className="opt__done">
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Done
    </span>
  );
}

function ReadyStep({ tabs, windows }: { tabs: number | null; windows: number | null }) {
  const [pinned, setPinned] = useState(false);
  const [incognito, setIncognito] = useState(false);
  useEffect(() => {
    // These change in Chrome's own UI, so look again whenever you might have been there.
    const check = () => {
      chrome.action.getUserSettings().then((s) => setPinned(!!s.isOnToolbar), () => undefined);
      chrome.extension.isAllowedIncognitoAccess().then(setIncognito, () => undefined);
    };
    check();
    const timer = setInterval(check, 1500);
    window.addEventListener('focus', check);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', check);
    };
  }, []);
  const named = tabs != null && tabs >= WORTH_NAMING;
  return (
    <>
      <h1 className="wel__title">{named ? `Now for your real ${tabs} tabs.` : 'Now for your real tabs.'}</h1>
      <p className="wel__hint">
        {named && windows ? `All ${windows} ${windows === 1 ? 'window' : 'windows'} are waiting on your board. ` : 'Your board is ready. '}
        The rest is optional.
      </p>
      <div className="opts">
        <div className="opt">
          <div className="opt__text">
            <span className="opt__name">Pin the icon to your toolbar</span>
            <span className="opt__help">It counts your open tabs and turns red past 20. Click the puzzle piece next to the address bar, then the pin.</span>
          </div>
          {pinned ? <Check /> : <span className="opt__idle">Not pinned yet</span>}
        </div>
        <div className="opt">
          <div className="opt__text">
            <span className="opt__name">Allow it in incognito (if you want)</span>
            <span className="opt__help">
              Puts incognito windows on the board too. Only you can see them, and they stay hidden from AI. Ask your favorite AI to review{' '}
              <a href={SOURCE_URL} target="_blank" rel="noopener">
                our code
              </a>
              !
            </span>
          </div>
          {incognito ? (
            <Check />
          ) : (
            <button className="textbtn opt__btn" onClick={() => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` })}>
              Open extension settings
            </button>
          )}
        </div>
        <div className="opt">
          <div className="opt__text">
            <span className="opt__name">Connect Claude (optional)</span>
            <span className="opt__help">Then ask it things like “copy my top five prospects into a new folder”.</span>
          </div>
          <a className="textbtn opt__btn" href={MCPB_URL} onClick={aiLinkWanted}>
            Download for Claude Desktop
          </a>
        </div>
      </div>
    </>
  );
}

const STEPS = ['Try it', 'New tab', 'Your tabs'];

export function Welcome() {
  const [step, setStep] = useState(0);
  const [live, setLive] = useState<{ tabs: number; windows: number } | null>(null);
  const [progress, setProgress] = useState<DemoProgress>({ left: 1, total: 1, selected: 0, saved: 0, folders: 0, touched: false });
  const onProgress = useCallback((p: DemoProgress) => setProgress(p), []);

  useEffect(() => {
    // The welcome page covers the incognito question, so the board doesn't have to bring it up.
    void chrome.storage.local.set({ incognitoHintDismissed: true });
    const count = async () => {
      const [all, me] = await Promise.all([chrome.tabs.query({}), chrome.tabs.getCurrent()]);
      const board = chrome.runtime.getURL('board.html');
      const real = all.filter((t) => t.id !== me?.id && !isNewTabUrl(t.url || t.pendingUrl) && !(t.url ?? '').startsWith(board));
      setLive({ tabs: real.length, windows: new Set(real.map((t) => t.windowId)).size });
    };
    void count();
    document.addEventListener('visibilitychange', count);
    return () => document.removeEventListener('visibilitychange', count);
  }, []);

  const finish = async () => {
    const [{ newTab }, me] = await Promise.all([getSettings(), chrome.tabs.getCurrent()]);
    if (me?.id != null) await chrome.tabs.update(me.id, { url: newTab ? 'chrome://newtab/' : chrome.runtime.getURL('board.html') });
  };

  // The headline's number is theirs when it's worth naming, and it falls as the practice board clears.
  const start = live && live.tabs >= WORTH_NAMING ? live.tabs : 50;
  const target = live ? Math.round((start * progress.left) / progress.total) : null;
  const count = useTween(target);
  // At zero the number has made its point: a beat later the headline becomes the finish line.
  const [clean, setClean] = useState(false);
  useEffect(() => {
    if (progress.left !== 0 || count !== 0) return setClean(false);
    const timer = setTimeout(() => setClean(true), 700);
    return () => clearTimeout(timer);
  }, [progress.left, count]);

  // The first drop is the lesson: once the number has fallen, fade straight on to the next step.
  // Undo cancels it, and someone who comes back to practice is left to practice.
  const [leaving, setLeaving] = useState(false);
  const movedOn = useRef(false);
  useEffect(() => {
    if (step !== 0 || movedOn.current || progress.saved === 0 || count !== target) return;
    const fade = setTimeout(() => setLeaving(true), HOLD_AFTER_DROP);
    const next = setTimeout(() => {
      movedOn.current = true;
      setLeaving(false);
      setStep(1);
    }, HOLD_AFTER_DROP + FADE_TO_NEXT);
    return () => {
      clearTimeout(fade);
      clearTimeout(next);
      setLeaving(false);
    };
  }, [step, progress.saved, count, target]);

  const hint =
    progress.left === 0
      ? `Everything else is saved: ${plural(progress.saved, 'tab')} in ${plural(progress.folders, 'folder')}. Your real tabs are next.`
      : progress.selected > 0
        ? `Now drag ${progress.selected === 1 ? 'it' : 'them'} onto a folder.`
        : progress.saved > 0
          ? `Saved, checked, then closed. Press ${MOD}Z and they’re back.`
          : 'Drag across empty space to lasso a few tabs.';

  return (
    <div className="wel" data-step={step}>
      <header className="wel__top">
        <img className="wel__mark" src="/icons/icon-48.png" width={24} height={24} alt="" />
        <span className="brand">FreeTabs</span>
        <nav className="wel__dots" aria-label="Steps">
          {STEPS.map((name, i) => (
            <button key={name} className="wel__dot" aria-current={i === step ? 'step' : undefined} aria-label={name} onClick={() => setStep(i)} />
          ))}
        </nav>
        {step < STEPS.length - 1 && (
          <button className="textbtn wel__skip" onClick={finish}>
            Skip to my board
          </button>
        )}
      </header>

      <main className="wel__main" key={step} data-leaving={leaving || undefined}>
        {step === 0 && (
          <>
            <h1 className="wel__title" style={live ? undefined : { visibility: 'hidden' }}>
              {clean ? 'One clean window.' : `Free your mind from ${count} open ${count === 1 ? 'tab' : 'tabs'}.`}
            </h1>
            <p className="wel__hint">{hint}</p>
            <Demo onProgress={onProgress} />
          </>
        )}
        {step === 1 && <NewTabStep />}
        {step === 2 && <ReadyStep tabs={live?.tabs ?? null} windows={live?.windows ?? null} />}
      </main>

      <footer className="wel__foot">
        <p className="wel__aside" key={step} data-leaving={leaving || undefined}>
          {step === 0 && 'This is a practice board. Your real tabs stay open.'}
          {step === 1 && 'You can change this any time in Settings.'}
          {step === 2 && (
            <>
              Free forever and{' '}
              <a href={SOURCE_URL} target="_blank" rel="noopener">
                open source
              </a>
              , with no signup. Made by{' '}
              <a href={STUDIO_URL} target="_blank" rel="noopener">
                Experiment Empire
              </a>
              .
            </>
          )}
        </p>
        {step > 0 && (
          <button className="textbtn" onClick={() => setStep(step - 1)}>
            Back
          </button>
        )}
        <button className="btn wel__next" onClick={() => (step === STEPS.length - 1 ? finish() : setStep(step + 1))}>
          {step === STEPS.length - 1 ? 'Open my board' : 'Next'}
        </button>
      </footer>
    </div>
  );
}
