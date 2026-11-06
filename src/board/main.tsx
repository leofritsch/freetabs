import '@fontsource-variable/host-grotesk';
import './styles.css';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { getSettings } from '../lib/settings';
import { isNewTabUrl } from '../lib/url';
import { ensureSystemFolders } from '../lib/vault';

async function start() {
  // A manifest can't switch its new tab page off, so this page steps aside instead.
  try {
    const [{ newTab }, tab] = await Promise.all([getSettings(), chrome.tabs.getCurrent()]);
    if (!newTab && tab?.id != null && isNewTabUrl(tab.url || tab.pendingUrl)) {
      await chrome.tabs.update(tab.id, { url: 'chrome://new-tab-page/' });
      return;
    }
  } catch {
    // Whatever went wrong, the board still opens.
  }
  await ensureSystemFolders().catch(() => undefined);
  createRoot(document.getElementById('root')!).render(<App />);
}
void start();
