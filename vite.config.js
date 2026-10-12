import { cesiumStaticAssets } from './scripts/cesium-static.mjs';

/**
 * GitHub Pages serves this project from `https://<owner>.github.io/<repo>/`,
 * never from a domain root. The base path therefore has to survive in every
 * emitted asset URL, in `import.meta.env.BASE_URL`, and in the Cesium worker
 * bootstrap (`window.CESIUM_BASE_URL`).
 *
 * Resolution order:
 *   1. `PAGES_BASE` env var (workflow / CI override)
 *   2. `REPO_NAME` env var -> `/<repo>/`
 *   3. the `name` field of package.json -> `/<name>/`
 *
 * A user/organization site (`<owner>.github.io`) is served from the root, so
 * that shape resolves to `/`.
 */
export function resolvePagesBase(env = process.env, packageName) {
  const explicit = env.PAGES_BASE;
  if (explicit) return explicit.endsWith('/') ? explicit : `${explicit}/`;
  const repo = env.REPO_NAME || packageName;
  if (!repo) return '/';
  const name = repo.includes('/') ? repo.split('/')[1] : repo;
  if (/\.github\.io$/i.test(name)) return '/';
  return `/${name}/`;
}

const base = resolvePagesBase(process.env, process.env.npm_package_name);
if (!process.env.VITE_QUIET) {
  // eslint-disable-next-line no-console
  console.log(`[build] base path = ${base}`);
}

export default {
  base,
  plugins: [cesiumStaticAssets()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    // Cesium is one very large module; splitting it out keeps the entry chunk
    // small and lets browsers cache the globe engine separately.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/cesium')) return 'cesium';
          if (id.includes('node_modules/satellite.js')) return 'orbital';
          if (id.includes('node_modules/lucide')) return 'icons';
          return undefined;
        },
      },
    },
    chunkSizeWarningLimit: 3200,
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
  },
};
