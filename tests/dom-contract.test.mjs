/**
 * DOM contract between `index.html`, `src/main.js` and `src/ui/shell.js`.
 *
 * The app's boot sequence reads several elements by id *before* the shell is
 * constructed. `index.html` is the only thing that can guarantee they exist:
 * a Node test cannot import `src/main.js` (it touches `document` at module
 * scope), and `vite build` never checks ids. A missing `#gev-overlay` shipped
 * to production as `Startup failed: Cannot read properties of null (reading
 * 'getContext')` and every test stayed green.
 *
 * These tests pin the contract from both ends — the document declares the
 * elements, and the shell adopts rather than duplicates them — plus a live
 * check that the overlay survives a missing canvas.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createOverlay, OVERLAY_MODES } from '../src/tools/overlay.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const HTML = read('index.html');
const MAIN = read('src/main.js');
const SHELL = read('src/ui/shell.js');

/** Every `id="…"` declared in index.html, mapped to its tag name. */
function declaredIds(html) {
  const ids = new Map();
  for (const match of html.matchAll(/<([a-z][\w-]*)\b[^>]*\bid="([\w-]+)"/gi)) {
    ids.set(match[2], match[1].toLowerCase());
  }
  return ids;
}

const IDS = declaredIds(HTML);

/* --------------------------- the document itself -------------------------- */

test('index.html declares the overlay canvas and the credit container', () => {
  assert.equal(
    IDS.get('gev-overlay'),
    'canvas',
    '#gev-overlay must be a <canvas>: overlay.js calls getContext("2d") on it',
  );
  assert.ok(IDS.has('gev-credits'), '#gev-credits is missing — Cesium creditContainer would be null');
});

test('both declared elements live inside the app root', () => {
  const app = HTML.match(/<div id="app"[\s\S]*?<script type="module"/);
  assert.ok(app, 'could not locate the #app root in index.html');
  assert.match(app[0], /id="gev-overlay"/);
  assert.match(app[0], /id="gev-credits"/);
});

test('index.html declares the boot screen the entry point writes into', () => {
  for (const id of ['boot', 'boot-status', 'cesium-container']) {
    assert.ok(IDS.has(id), `#${id} is read by src/main.js but not declared`);
  }
});

/* --------------------- every id main.js looks up early -------------------- */

/**
 * `src/main.js` reads elements by id before `createShell()` exists, so none of
 * them can be created by the shell. Collect exactly that window of source and
 * require every id in it to be declared statically.
 */
function idsReadBeforeShell(source) {
  const cut = source.indexOf('createShell(');
  assert.ok(cut > 0, 'src/main.js no longer calls createShell() — update this test');
  const window = source.slice(0, cut);
  return [...window.matchAll(/document\.getElementById\(\s*['"]([\w-]+)['"]\s*\)/g)].map((m) => m[1]);
}

test('every id main.js reads before building the shell is declared in index.html', () => {
  const early = idsReadBeforeShell(MAIN);
  assert.ok(early.length >= 4, `expected the boot sequence to read several ids, found ${early.length}`);
  const missing = [...new Set(early)].filter((id) => !IDS.has(id));
  assert.deepEqual(
    missing,
    [],
    `these ids are read before createShell() but are not in index.html: ${missing.join(', ')}`,
  );
});

test('the overlay canvas is looked up before the shell that used to create it', () => {
  const readsOverlay = MAIN.indexOf("getElementById('gev-overlay')");
  const buildsShell = MAIN.indexOf('createShell(');
  assert.ok(readsOverlay > 0, 'src/main.js no longer looks up #gev-overlay');
  assert.ok(
    readsOverlay < buildsShell,
    '#gev-overlay is read before createShell(), so it cannot be created by the shell',
  );
});

/* --------------------------- the shell adopts ---------------------------- */

test('the shell adopts declared elements instead of minting duplicate ids', () => {
  const created = [...SHELL.matchAll(/\bel\(\s*['"][\w-]+['"]\s*,\s*\{\s*id:\s*'([\w-]+)'/g)].map((m) => m[1]);
  assert.ok(created.length > 0, 'shell.js no longer creates any element by id — update this test');

  const unadopted = [];
  for (const id of created) {
    if (!IDS.has(id)) continue; // shell-owned id, no document contract to honour
    const adopts = new RegExp(`querySelector\\(\\s*['"]#${id}['"]\\s*\\)\\s*(?:\\?\\?|\\|\\|)`);
    if (!adopts.test(SHELL)) unadopted.push(id);
  }
  assert.deepEqual(
    unadopted,
    [],
    `shell.js creates these ids that index.html also declares, without adopting them: ${unadopted.join(', ')}`,
  );
});

test('no id is declared twice in index.html', () => {
  const all = [...HTML.matchAll(/\bid="([\w-]+)"/g)].map((m) => m[1]);
  const dupes = all.filter((id, i) => all.indexOf(id) !== i);
  assert.deepEqual(dupes, [], `duplicate ids in index.html: ${dupes.join(', ')}`);
});

/* --------------------- the overlay survives a null canvas ---------------- */

test('createOverlay degrades to an inert overlay instead of throwing', () => {
  let overlay;
  assert.doesNotThrow(() => {
    overlay = createOverlay({ canvas: null, viewer: {}, layers: () => [], selection: {} });
  }, 'a missing #gev-overlay must not blank the console');

  // The inert overlay has to satisfy the same surface main.js drives.
  assert.doesNotThrow(() => {
    overlay.start();
    overlay.setMode(OVERLAY_MODES.ALL);
    overlay.setBrackets(false);
    overlay.setAccent('#7aebc0');
    overlay.setMaxBoxes(5);
    overlay.stop();
    overlay.dispose();
  });
  assert.equal(overlay.mode, OVERLAY_MODES.ALL, 'the inert overlay still records its mode');
  assert.equal(overlay.isInert, true, 'the degraded overlay should say so');
});

test('createOverlay still drives a real canvas', () => {
  const contexts = [];
  const ctx = new Proxy({}, { get: () => () => {} });
  const canvas = {
    getContext: (kind) => {
      contexts.push(kind);
      return ctx;
    },
    clientWidth: 100,
    clientHeight: 100,
    width: 0,
    height: 0,
  };
  const viewer = { scene: { canvas: { clientWidth: 100, clientHeight: 100 } } };
  const overlay = createOverlay({ canvas, viewer, layers: () => [], selection: {} });

  assert.deepEqual(contexts, ['2d'], 'the real path must still acquire a 2d context');
  assert.notEqual(overlay.isInert, true, 'a real canvas must not produce the inert stand-in');
  assert.equal(overlay.mode, OVERLAY_MODES.SELECTED);
});
