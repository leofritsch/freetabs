import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Three entries: the board, the welcome page and the service worker. The worker
// keeps a fixed name because manifest.json points at it.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome116',
    sourcemap: mode === 'development',
    minify: mode !== 'development',
    rolldownOptions: {
      input: {
        board: 'board.html',
        welcome: 'welcome.html',
        background: 'src/background.ts',
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
}));
