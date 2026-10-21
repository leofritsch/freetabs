import { useEffect, useRef, useState, type ReactNode } from 'react';
import { aiLinkWanted, MCPB_URL } from '../lib/ailink';

/** Line drawings in the brand's ink: windows, a lasso, a folder, a chat, a pulsing count. */
function ArtBoard() {
  const win = (x: number, inked: number[]) => (
    <g key={x}>
      <rect x={x} y="14" width="96" height="122" rx="12" className="art-line" />
      <rect x={x + 10} y="24" width="34" height="6" rx="3" className="art-fill-soft" />
      {[0, 1, 2, 3, 4].map((i) => (
        <g key={i}>
          {inked.includes(i) && <rect x={x + 5} y={38 + i * 19} width="86" height="17" rx="5" className="art-ink" />}
          <rect x={x + 11} y={43 + i * 19} width="7" height="7" rx="2" className={inked.includes(i) ? 'art-paper' : 'art-fill-soft'} />
          <rect x={x + 24} y={44 + i * 19} width={44 - ((i * 13) % 20)} height="5" rx="2.5" className={inked.includes(i) ? 'art-paper' : 'art-fill-soft'} />
        </g>
      ))}
    </g>
  );
  return (
    <svg viewBox="0 0 360 150" className="art" aria-hidden="true">
      {win(14, [1, 2])}
      {win(132, [1])}
      {win(250, [])}
      <rect x="10" y="54" width="214" height="44" rx="6" className="art-lasso" />
    </svg>
  );
}

function ArtDrop() {
  return (
    <svg viewBox="0 0 360 150" className="art" aria-hidden="true">
      <g transform="translate(34 40) rotate(-4)">
        <rect x="8" y="8" width="120" height="22" rx="6" className="art-ink" opacity="0.35" />
        <rect x="4" y="4" width="120" height="22" rx="6" className="art-ink" opacity="0.6" />
        <rect x="0" y="0" width="120" height="22" rx="6" className="art-ink" />
        <rect x="8" y="8" width="7" height="7" rx="2" className="art-paper" />
        <rect x="22" y="9" width="70" height="5" rx="2.5" className="art-paper" />
      </g>
      <path d="M 176 60 C 210 40, 236 46, 250 70" className="art-arrow" />
      <path d="M 243 64 L 251 71 L 253 61" className="art-arrow" />
      <rect x="236" y="80" width="110" height="46" rx="12" className="art-ink" />
      <circle cx="254" cy="97" r="4" className="art-paper" />
      <rect x="264" y="94" width="52" height="6" rx="3" className="art-paper" />
      {[0, 1, 2, 3].map((i) => (
        <rect key={i} x={250 + i * 13} y="108" width="9" height="9" rx="2" className="art-paper" opacity={0.85 - i * 0.15} />
      ))}
    </svg>
  );
}

function ArtAI() {
  return (
    <svg viewBox="0 0 360 150" className="art" aria-hidden="true">
      <rect x="16" y="40" width="112" height="70" rx="12" className="art-line" />
      <circle cx="34" cy="58" r="4" className="art-fill" />
      <rect x="44" y="55" width="54" height="6" rx="3" className="art-fill" />
      {[0, 1, 2].map((i) => (
        <rect key={i} x="30" y={72 + i * 11} width={80 - i * 14} height="5" rx="2.5" className="art-fill-soft" />
      ))}
      <path d="M 140 75 L 196 75" className="art-arrow" strokeDasharray="3 5" />
      <path d="M 210 30 h 120 a 12 12 0 0 1 12 12 v 56 a 12 12 0 0 1 -12 12 h -86 l -18 14 v -14 h -16 a 12 12 0 0 1 -12 -12 v -56 a 12 12 0 0 1 12 -12 z" className="art-line" />
      {[0, 1, 2].map((i) => (
        <rect key={i} x="222" y={46 + i * 13} width={100 - i * 18} height="6" rx="3" className="art-fill-soft" />
      ))}
      <rect x="222" y="86" width="74" height="13" rx="4" className="art-chip" />
      <text x="259" y="95.5" textAnchor="middle" className="art-chip-text">
        {'<incognito link>'}
      </text>
    </svg>
  );
}

function ArtCount() {
  return (
    <svg viewBox="0 0 360 150" className="art" aria-hidden="true">
      <rect x="70" y="52" width="220" height="46" rx="23" className="art-line" />
      {[0, 1, 2].map((i) => (
        <rect key={i} x={92 + i * 26} y="69" width="14" height="12" rx="3" className="art-fill-soft" />
      ))}
      <g transform="translate(216 59)">
        <circle cx="16" cy="16" r="16" className="art-pulse" />
        <circle cx="16" cy="16" r="16" className="art-pulse art-pulse--late" />
        <rect x="0" y="0" width="32" height="32" rx="8" className="art-red" />
        <path d="M5 23 H9 L11 13 C11.5 10.5 13 9.5 15 9.5 H17 C19 9.5 20.5 10.5 21 13 L23 23 H27" className="art-tab" />
        <rect x="18" y="-8" width="26" height="16" rx="8" className="art-red" />
        <text x="31" y="3.5" textAnchor="middle" className="art-badge-text">
          23
        </text>
      </g>
    </svg>
  );
}

interface Step {
  title: string;
  body: ReactNode;
  art: ReactNode;
  extra?: ReactNode;
}

export function Onboarding({ onDone }: { onDone: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState(0);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  const steps: Step[] = [
    {
      title: 'Every tab, on one board.',
      body: (
        <>
          All your windows, side by side. Click a tab, <kbd>⌘</kbd>-click to add more, or drag a lasso across empty space. It works across
          windows.
        </>
      ),
      art: <ArtBoard />,
    },
    {
      title: 'Drop them in a folder. They close themselves.',
      body: (
        <>
          FreeTabs saves first, checks the save, and only then closes the tabs. <kbd>⌘Z</kbd> brings them back where they were. Hold a
          window’s name to pick up the whole window.
        </>
      ),
      art: <ArtDrop />,
    },
    {
      title: 'Saved tabs your AI can use.',
      body: (
        <>
          Open any folder and press Ask Claude or Ask ChatGPT. Or connect FreeTabs to Claude, then just ask: “copy my top five prospects into
          a new folder”. Tabs from incognito windows stay hidden from AI.
        </>
      ),
      art: <ArtAI />,
      extra: (
        <div className="intro__connect">
          <a className="connect__btn" href={MCPB_URL} onClick={aiLinkWanted}>
            Download for Claude Desktop
          </a>
          <span className="intro__hint">Open the file, then click Install in Claude.</span>
        </div>
      ),
    },
    {
      title: 'A count that keeps you honest.',
      body: (
        <>
          The icon shows how many tabs are open and turns red past 20. Change the limit in Settings, or set it to 0 to turn it off. Want
          incognito windows on the board too? Allow FreeTabs in incognito.
        </>
      ),
      art: <ArtCount />,
      extra: (
        <button className="textbtn intro__link" onClick={() => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` })}>
          Open FreeTabs’ extension settings
        </button>
      ),
    },
  ];
  const last = step === steps.length - 1;
  const current = steps[step];

  return (
    <dialog
      ref={ref}
      className="intro"
      aria-labelledby="intro-title"
      onCancel={(e) => {
        e.preventDefault();
        onDone();
      }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' && !last) setStep(step + 1);
        if (e.key === 'ArrowLeft' && step > 0) setStep(step - 1);
      }}
    >
      <div className="intro__art">{current.art}</div>
      <div className="intro__text" key={step}>
        <h2 id="intro-title" className="intro__title">
          {current.title}
        </h2>
        <p className="intro__body">{current.body}</p>
        {current.extra}
      </div>
      <footer className="intro__foot">
        <div className="intro__dots" aria-label={`Step ${step + 1} of ${steps.length}`}>
          {steps.map((_, i) => (
            <button key={i} className="intro__dot" aria-current={i === step || undefined} aria-label={`Step ${i + 1}`} onClick={() => setStep(i)} />
          ))}
        </div>
        {!last && (
          <button className="textbtn" onClick={onDone}>
            Skip
          </button>
        )}
        {step > 0 && (
          <button className="textbtn" onClick={() => setStep(step - 1)}>
            Back
          </button>
        )}
        <button className="btn" autoFocus onClick={() => (last ? onDone() : setStep(step + 1))}>
          {last ? 'Start cleaning' : 'Next'}
        </button>
      </footer>
    </dialog>
  );
}
