import '@fontsource-variable/host-grotesk';
import './styles.css';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ensureSystemFolders } from '../lib/vault';

ensureSystemFolders().finally(() => {
  createRoot(document.getElementById('root')!).render(<App />);
});
