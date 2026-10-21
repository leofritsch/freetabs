import { useEffect, useRef, useState } from 'react';
import { db, TRASH_ID } from '../lib/db';
import { toBookmarksHtml } from '../lib/export';
import { buildMirror, importText } from '../lib/mirror';
import { DEFAULT_PROMPT, DEFAULT_SETTINGS, getSettings, setSettings, type BackupStatus, type Settings } from '../lib/settings';
import { hasTypedPermission, TYPED_ORIGINS } from '../lib/typed';
import { cleanSite, type Mark, type SiteList } from '../lib/marks';
import { aiLinkWanted, MCP_SETUP_URL, MCPB_URL, type AiLinkStatus } from '../lib/ailink';
import { ago, plural } from './components';
import type { ToastState } from './components';

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** One list: its sites as removable chips, and a field to add more. */
function SiteListEditor({ kind, list, onChange }: { kind: Mark; list: SiteList; onChange: (list: SiteList) => void }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const site = cleanSite(draft);
    if (site && !list.sites.includes(site)) onChange({ ...list, sites: [...list.sites, site] });
    setDraft('');
  };
  return (
    <div className="sitelist" data-kind={kind}>
      <div className="sitelist__head">
        <span className="sitelist__dot" aria-hidden="true" />
        <span className="sitelist__name">{kind === 'good' ? 'Good list' : 'Bad list'}</span>
      </div>
      {list.sites.length > 0 && (
        <ul className="sitelist__sites">
          {list.sites.map((site) => (
            <li key={site} className="sitelist__site">
              <span>{site}</span>
              <button aria-label={`Remove ${site}`} onClick={() => onChange({ ...list, sites: list.sites.filter((x) => x !== site) })}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="sitelist__add"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={kind === 'good' ? 'Add a site, like notion.so' : 'Add a site, like youtube.com'} aria-label={`Add a site to the ${kind} list`} />
      </form>
    </div>
  );
}

function Toggle({ label, help, checked, onChange }: { label: string; help?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle">
      <span className="toggle__text">
        <span className="toggle__label">{label}</span>
        {help && <span className="toggle__help">{help}</span>}
      </span>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

const UTM = 'utm_source=freetabs&utm_medium=extension&utm_campaign=settings';
const STUDIO_URL = `https://experimentempire.com/?${UTM}`;
const SOURCE_URL = 'https://github.com/leofritsch/freetabs';

export function SettingsDialog({
  open,
  onClose,
  say,
  onShowIntro,
}: {
  open: boolean;
  onClose: () => void;
  say: (message: string, extra?: Partial<ToastState>) => void;
  onShowIntro: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [s, setS] = useState<Settings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [importValue, setImportValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [incognitoAllowed, setIncognitoAllowed] = useState<boolean | null>(null);
  const [link, setLink] = useState<AiLinkStatus>({ connected: false, clients: [] });

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      chrome.extension.isAllowedIncognitoAccess().then(setIncognitoAllowed, () => setIncognitoAllowed(null));
      // The typed-text check only counts as on while Chrome still grants the permission.
      Promise.all([getSettings(), hasTypedPermission().catch(() => false)]).then(([settings, granted]) =>
        setS({ ...settings, checkTyped: settings.checkTyped && granted }),
      );
      chrome.storage.local.get('backupStatus').then(({ backupStatus }) => setStatus((backupStatus as BackupStatus) ?? null));
      chrome.storage.session.get('aiLink').then(({ aiLink }) => aiLink && setLink(aiLink as AiLinkStatus), () => undefined);
      dialog.showModal();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes.backupStatus) setStatus(changes.backupStatus.newValue as BackupStatus);
      if (area === 'session' && changes.aiLink) setLink((changes.aiLink.newValue as AiLinkStatus) ?? { connected: false, clients: [] });
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  const update = async (patch: Partial<Settings>) => {
    setS(await setSettings(patch));
    chrome.runtime.sendMessage({ type: 'vault-changed' }).catch(() => undefined);
  };

  const toggleTyped = async (on: boolean) => {
    if (!on) {
      await update({ checkTyped: false });
      await chrome.permissions.remove({ origins: TYPED_ORIGINS }).catch(() => undefined);
      return;
    }
    // Must run straight from the click: Chrome only shows its prompt for a user gesture.
    const granted = await chrome.permissions.request({ origins: TYPED_ORIGINS }).catch(() => false);
    if (granted) await update({ checkTyped: true });
    else say('Chrome didn’t grant the permission, so the check stays off.');
  };

  const backupNow = async () => {
    setBusy(true);
    try {
      const result = (await chrome.runtime.sendMessage({ type: 'backup-now' })) as BackupStatus | null;
      if (!result) {
        say('Bookmarks backup is off, or waiting for you to restore or set aside the backup it found.');
        return;
      }
      setStatus(result);
      say(result.ok ? `Backed up ${plural(result.tabs ?? 0, 'tab')} to bookmarks` : (result.error ?? 'Backup failed.'), result.ok ? {} : { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const runImport = async (text: string) => {
    try {
      const r = await importText(text);
      setImportValue('');
      say(`Imported ${plural(r.tabs, 'tab')}${r.folders ? ` into ${plural(r.folders, 'new folder')}` : ''}${r.skipped ? `. Skipped ${r.skipped} already saved.` : ''}`);
      chrome.runtime.sendMessage({ type: 'vault-changed' }).catch(() => undefined);
    } catch (error) {
      say(error instanceof Error ? error.message : 'That couldn’t be imported.', { tone: 'error' });
    }
  };

  const exportJson = async () => {
    const mirror = await buildMirror({ includeIncognito: true });
    download(`freetabs-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(mirror, null, 2), 'application/json');
  };

  const exportBookmarks = async () => {
    const folders = (await db.folders.orderBy('order').toArray()).filter((f) => f.id !== TRASH_ID);
    const tabs = await db.tabs.toArray();
    const groups = folders
      .map((f) => ({ name: f.name, tabs: tabs.filter((t) => t.folderId === f.id).sort((a, b) => b.savedAt - a.savedAt) }))
      .filter((g) => g.tabs.length);
    download(`freetabs-bookmarks-${new Date().toISOString().slice(0, 10)}.html`, toBookmarksHtml(groups), 'text/html');
  };

  return (
    <dialog ref={ref} className="settings" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <div className="settings__inner">
        <header className="settings__head">
          <h2>Settings</h2>
          <button className="textbtn" onClick={onClose}>
            Done
          </button>
        </header>

        <section className="studio" aria-label="Experiment Empire">
          <a className="studio__mark" href={STUDIO_URL} target="_blank" rel="noopener" aria-label="Experiment Empire">
            EE
          </a>
          <h3 className="studio__title">Made by people with 50 tabs open, too.</h3>
          <p className="studio__body">
            FreeTabs is free forever &amp; open source. It’s one of 30+ small apps, built for busy minds. If it helped, you’ll like the rest!
          </p>
          <div className="studio__actions">
            <a className="studio__btn" href={STUDIO_URL} target="_blank" rel="noopener">
              More apps
            </a>
            <a className="studio__link" href={SOURCE_URL} target="_blank" rel="noopener">
              Source code
            </a>
          </div>
        </section>

        <section className="settings__section">
          <h3>Good list and bad list</h3>
          <p className="settings__note">Tabs on these sites glow green or red, so you can tell at a glance what helps and what doesn’t.</p>
          <div className="sitelists">
            {(['good', 'bad'] as const).map((kind) => (
              <SiteListEditor
                key={kind}
                kind={kind}
                list={s.marks[kind]}
                onChange={(list) => update({ marks: { ...s.marks, [kind]: list } })}
              />
            ))}
          </div>
        </section>

        <section className="settings__section">
          <h3>Toolbar icon</h3>
          <Toggle
            label="Show how many tabs are open"
            help="Counts every open tab, including incognito ones once FreeTabs is allowed in incognito."
            checked={s.badge}
            onChange={(v) => update({ badge: v })}
          />
          <label className="toggle">
            <span className="toggle__text">
              <span className="toggle__label">Tab limit</span>
              <span className="toggle__help">Above this many open tabs, the icon turns red and pulses until you clean up. Set it to 0 to turn this off.</span>
            </span>
            <input
              className="number"
              type="number"
              inputMode="numeric"
              min={0}
              max={999}
              value={s.tabLimit}
              aria-label="Tab limit"
              onChange={(e) => setS({ ...s, tabLimit: Number(e.target.value) })}
              onBlur={(e) => {
                const n = Math.round(Number(e.target.value));
                update({ tabLimit: Number.isFinite(n) ? Math.max(0, Math.min(999, n)) : DEFAULT_SETTINGS.tabLimit });
              }}
            />
          </label>
        </section>

        <section className="settings__section">
          <h3>Incognito</h3>
          <div className="settings__row">
            <span className="settings__status">
              {incognitoAllowed
                ? 'Allowed. Incognito windows show up on the board and in the tab count.'
                : 'Not allowed yet, so incognito windows stay off the board and out of the count.'}
            </span>
            {!incognitoAllowed && (
              <button className="textbtn" onClick={() => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` })}>
                Allow in incognito
              </button>
            )}
          </div>
        </section>

        <section className="settings__section">
          <h3>Backup</h3>
          <Toggle
            label="Back up to Chrome bookmarks"
            help="Keeps a copy of your folders in Other bookmarks › FreeTabs. It survives uninstalling FreeTabs, follows Chrome Sync if you use it, and lets you find saved tabs from the address bar. Incognito tabs are never copied there. FreeTabs owns that folder, so changes made there get overwritten."
            checked={s.bookmarkBackup}
            onChange={(v) => update({ bookmarkBackup: v })}
          />
          <div className="settings__row">
            <span className="settings__status">
              {status
                ? status.ok
                  ? `Last backup ${ago(status.at) === 'now' ? 'just now' : `${ago(status.at)} ago`}, ${plural(status.tabs ?? 0, 'tab')}.`
                  : `Last backup failed: ${status.error}`
                : 'No backup yet.'}
            </span>
            <button className="textbtn" onClick={backupNow} disabled={busy || !s.bookmarkBackup}>
              {busy ? 'Backing up…' : 'Back up now'}
            </button>
          </div>
        </section>

        <section className="settings__section">
          <h3>AI</h3>
          <Toggle
            label="Let AI see incognito tabs"
            help="Off by default: “Copy for AI” and “Ask Claude” show tabs from incognito windows as <incognito link>, so the AI knows something is there but can’t read it. The MCP server only ever sees that placeholder, because incognito tabs never leave this browser."
            checked={s.aiSeesIncognito}
            onChange={(v) => update({ aiSeesIncognito: v })}
          />
          <label className="field">
            <span className="field__label">Prompt for “Copy for AI” and “Ask Claude”</span>
            <textarea
              rows={3}
              value={s.aiPrompt}
              onChange={(e) => setS({ ...s, aiPrompt: e.target.value })}
              onBlur={(e) => update({ aiPrompt: e.target.value.trim() || DEFAULT_PROMPT })}
            />
            <span className="field__help">{'{folder}'} becomes the folder name, {'{count}'} the number of tabs.</span>
          </label>
          <div className="field connect">
            <span className="field__label">Connect Claude and other AI apps</span>
            <span className="field__help">
              Ask your AI about your folders, or to organize them: “copy my top five prospects into a new folder”. It runs on this computer
              (MCP), and incognito tabs stay hidden.
            </span>
            <div className="connect__desktop">
              <a className="connect__btn" href={MCPB_URL} onClick={aiLinkWanted}>
                Download for Claude Desktop
              </a>
              <span className="field__help">Open the file, then click Install.</span>
            </div>
            <span className="field__help">
              Using Claude Code or another AI app?{' '}
              <a href={MCP_SETUP_URL} target="_blank" rel="noopener" onClick={aiLinkWanted}>
                Set it up from the source code
              </a>
              .
            </span>
          </div>
          <Toggle
            label="Let AI apps organize your folders"
            help="They can create folders, add links, and move, copy or trash tabs. Every change shows here with an Undo. Off: they can only read the bookmarks backup."
            checked={s.aiLink}
            onChange={(v) => update({ aiLink: v })}
          />
          <p className="connect__status" data-on={(s.aiLink && link.connected) || undefined}>
            {!s.aiLink
              ? 'Off'
              : link.connected
                ? `Connected to ${link.clients.join(' and ') || 'an AI app'}`
                : 'Not connected right now. It connects on its own while an AI app with FreeTabs is open.'}
          </p>
        </section>

        <section className="settings__section">
          <h3>Closing tabs</h3>
          <p className="settings__note">
            Pages that ask “Leave site?” always stay open, flagged Unsaved changes. This catches the rest: text typed into a form on a page
            that doesn’t ask.
          </p>
          <Toggle label="Check pages for typed text before closing" checked={s.checkTyped} onChange={toggleTyped} />
          <p className="settings__warning">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M8 1.8 15 14H1z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
              <path d="M8 6.2v3.6M8 11.6v.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
            <span>
              This needs Chrome’s widest permission, and Chrome will warn that FreeTabs can “read and change all your data on all websites”.
              FreeTabs only uses it to look at the form fields of the tabs you’re closing, right before closing them. Nothing is stored or
              sent anywhere, and you can read exactly what it does: FreeTabs is open source.
            </span>
          </p>
        </section>

        <section className="settings__section">
          <h3>Selection</h3>
          <Toggle
            label="Lasso picks up pinned tabs"
            help="Pinned tabs are left out of lasso selections unless this is on. You can still click them."
            checked={s.lassoPinned}
            onChange={(v) => update({ lassoPinned: v })}
          />
        </section>

        <section className="settings__section">
          <h3>Import</h3>
          <label className="field">
            <span className="field__label">Paste OneTab’s “Export URLs” text, or a FreeTabs backup</span>
            <textarea rows={4} value={importValue} onChange={(e) => setImportValue(e.target.value)} placeholder="https://example.com | Example" />
          </label>
          <div className="settings__row">
            <label className="textbtn file">
              Choose a file
              <input
                type="file"
                accept=".json,.txt,application/json,text/plain"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) await runImport(await file.text());
                }}
              />
            </label>
            <button className="btn" disabled={!importValue.trim()} onClick={() => runImport(importValue)}>
              Import
            </button>
          </div>
        </section>

        <section className="settings__section">
          <h3>Export</h3>
          <div className="settings__row settings__row--start">
            <button className="textbtn" onClick={exportJson}>
              Download backup (JSON)
            </button>
            <button className="textbtn" onClick={exportBookmarks}>
              Download as bookmarks (HTML)
            </button>
          </div>
        </section>

        <section className="settings__section settings__about">
          <p>
            FreeTabs is free and open source (MIT). No account, no server: your tabs stay on this computer. It’s a homage to tabOS, first
            known as tabExtend, which showed how good a board of tabs can feel.
          </p>
          <div className="settings__row settings__row--start">
            <button className="textbtn" onClick={onShowIntro}>
              Show the intro again
            </button>
          </div>
          <p className="settings__version">Version {chrome.runtime.getManifest().version}</p>
        </section>
      </div>
    </dialog>
  );
}
