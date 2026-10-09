import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * Los content scripts de MV3 no pueden ser módulos ES con chunks compartidos, así que cada punto
 * de entrada se empaqueta por separado como IIFE autocontenido:
 *   vite build --mode content      -> dist/content.js
 *   vite build --mode background   -> dist/serviceWorker.js
 * (sufijo "-debug" = sin minificar y con sourcemap).
 */
type Target = 'content' | 'background';

const root = fileURLToPath(new URL('.', import.meta.url));

const ENTRIES: Record<Target, { entry: string; name: string; file: string }> = {
  content: { entry: 'src/content/index.ts', name: 'HCAIContent', file: 'content.js' },
  background: { entry: 'src/background/serviceWorker.ts', name: 'HCAIBackground', file: 'serviceWorker.js' },
};

function copyManifest(outDir: string): Plugin {
  return {
    name: 'hcai-copy-manifest',
    closeBundle() {
      mkdirSync(resolve(root, outDir), { recursive: true });
      copyFileSync(resolve(root, 'manifest.json'), resolve(root, outDir, 'manifest.json'));
    },
  };
}

export default defineConfig(({ mode }) => {
  const target: Target = mode.startsWith('background') ? 'background' : 'content';
  const debug = mode.endsWith('-debug');
  const { entry, name, file } = ENTRIES[target];
  const outDir = 'dist';

  return {
    plugins: [react(), copyManifest(outDir)],
    // En modo "lib" Vite no sustituye process.env.NODE_ENV; React lo necesita resuelto.
    define: {
      'process.env.NODE_ENV': JSON.stringify(debug ? 'development' : 'production'),
    },
    build: {
      outDir,
      emptyOutDir: target === 'content',
      target: 'chrome110',
      minify: debug ? false : 'esbuild',
      sourcemap: debug ? 'inline' : false,
      cssCodeSplit: false,
      lib: {
        entry: resolve(root, entry),
        formats: ['iife'],
        name,
        fileName: () => file,
      },
    },
  };
});
