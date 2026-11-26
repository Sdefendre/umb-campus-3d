import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const STATIC_PRECACHE_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './data/umb-campus.geojson',
  './data/demo-schedule.ics',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

/**
 * Injects a deterministic build hash and the Vite-emitted app-shell assets into dist/sw.js
 * so: (1) sw.js bytes change on every build that updates assets, and (2) first-visit
 * offline loads have all hashed CSS/JS chunks precached immediately.
 */
function swBuildManifestPlugin(): Plugin {
  let outDir = 'dist';
  return {
    name: 'sw-build-manifest',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      const swPath = path.join(outDir, 'sw.js');
      const assetsDir = path.join(outDir, 'assets');
      const precacheSet = new Set<string>(STATIC_PRECACHE_ASSETS);

      try {
        const assetFiles = (await fs.readdir(assetsDir)).sort();
        for (const file of assetFiles) {
          // Keep lazy pdfjs / pdf.worker chunks out of initial precache (cached on first use);
          // precache all core app shell JS & CSS so offline works after visit #1.
          if (/^pdf(js|\.worker)/i.test(file)) continue;
          if (file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.css')) {
            precacheSet.add(`./assets/${file}`);
          }
        }
      } catch {
        // No assets directory emitted
      }

      const precacheList = [...precacheSet].sort();
      const hash = crypto.createHash('sha256');
      for (const rel of precacheList) {
        hash.update(rel);
        const diskRel = rel === './' ? 'index.html' : rel.replace(/^\.\//, '');
        try {
          const content = await fs.readFile(path.join(outDir, diskRel));
          hash.update(content);
        } catch {
          // Ignore missing optional paths
        }
      }
      const buildHash = hash.digest('hex').slice(0, 12);

      let swCode = await fs.readFile(swPath, 'utf8');
      swCode = swCode
        .replace(/__BUILD_HASH__/g, buildHash)
        .replace(
          /\/\*__PRECACHE_ASSETS__\*\/\[[\s\S]*?\]/,
          JSON.stringify(precacheList, null, 2)
        );
      await fs.writeFile(swPath, swCode, 'utf8');
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [swBuildManifestPlugin()],
  build: {
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          pdfjs: ['pdfjs-dist'],
        },
      },
    },
  },
});
