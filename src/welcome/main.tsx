import '@fontsource-variable/host-grotesk';
import '../board/styles.css';
import './welcome.css';
import { createRoot } from 'react-dom/client';
import { Welcome } from './Welcome';

createRoot(document.getElementById('root')!).render(<Welcome />);
