#!/usr/bin/env node
/**
 * Serves dist/ the way GitHub Pages does: from a subpath, with no SPA rewrite.
 *
 * Used to confirm that a direct load and a hard refresh both work at
 * `/<repo>/` before anything is pushed.
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const BASE = process.env.BASE || '/gods-eye-view/';
const PORT = Number(process.env.PORT || 4173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary',
  '.ktx2': 'image/ktx2',
};

const server = createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (!url.pathname.startsWith(BASE)) {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end(`404 — this site is served from ${BASE}`);
    return;
  }
  let relative = url.pathname.slice(BASE.length);
  if (relative === '') relative = 'index.html';
  const file = path.join(DIST, relative);

  // Refuse anything that escapes dist/ (mirrors what a static host would do).
  if (!file.startsWith(DIST) || !existsSync(file) || !statSync(file).isFile()) {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('404');
    return;
  }
  response.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  createReadStream(file).pipe(response);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`serving dist/ at http://0.0.0.0:${PORT}${BASE}`);
});
