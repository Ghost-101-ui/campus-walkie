import { execSync } from 'node:child_process';
import { defineConfig, type Plugin } from 'vite';
import { visualizer } from 'rollup-plugin-visualizer';

function gitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'dev';
  }
}

/**
 * Replaces the `"__PRECACHE__"` placeholder inside the emitted service worker with
 * the real list of hashed build assets. Keeps the SW hand-written (no Workbox)
 * while still letting it precache the exact shell that was built.
 */
function precacheManifest(): Plugin {
  return {
    name: 'cw-precache-manifest',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle)
        .filter((f) => f !== 'sw.js' && !f.endsWith('.map'))
        .map((f) => './' + f);
      const swChunk = bundle['sw.js'];
      if (swChunk && swChunk.type === 'chunk') {
        swChunk.code = swChunk.code.replace(
          '"__PRECACHE__"',
          JSON.stringify([...files, './', './manifest.webmanifest', './favicon.svg']),
        );
      }
    },
  };
}

export default defineConfig({
  // Relative base: works on user.github.io/<repo>/, on a custom domain and from a
  // sub-folder without rebuilding. Override with VITE_BASE if you need an absolute one.
  base: process.env['VITE_BASE'] ?? './',
  define: {
    __BUILD_SHA__: JSON.stringify(gitSha()),
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        main: 'index.html',
        sw: 'src/sw.ts',
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  worker: {
    format: 'es',
  },
  server: {
    host: true,
    port: 5173,
  },
  plugins: [
    precacheManifest(),
    visualizer({ filename: '.stats/bundle.html', gzipSize: true, emitFile: false }) as Plugin,
  ],
});
