/**
 * Import-graph integrity for the entry point.
 *
 * `src/main.js` touches `document` at module scope, so no test can import it —
 * which means its whole dependency graph used to be unexercised. A typo'd
 * named import there does not fail `vite build` and does not fail any test; it
 * fails in the browser, as a blank boot screen. `scripts/check-imports.mjs`
 * walks the graph statically and these tests hold it to that job, including a
 * fixture that must be reported broken (a check that cannot fail proves
 * nothing).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  buildImportGraph,
  parseModule,
  stripComments,
  resolveSpecifier,
  ENTRY,
  ROOT,
} from '../scripts/check-imports.mjs';

/** Build a throwaway module tree and graph it. */
function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'gev-imports-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body, 'utf8');
  }
  const graph = buildImportGraph({ entry: path.join(root, 'entry.js'), root });
  return { root, graph, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/* ------------------------------ the real graph --------------------------- */

const graph = buildImportGraph();

test('the entry point\'s whole dependency graph resolves', () => {
  assert.deepEqual(graph.errors, [], `import graph errors:\n${graph.errors.join('\n')}`);
  assert.ok(graph.order.length > 40, `expected the full graph, traversed ${graph.order.length}`);
  assert.ok(graph.modules.has(ENTRY), 'the entry point itself was not parsed');
});

test('every module under src/ is reachable from the entry point', () => {
  const srcFiles = readdirSync(path.join(ROOT, 'src'), { recursive: true })
    .filter((rel) => /\.js$/.test(String(rel)))
    .map((rel) => `src/${String(rel).split(path.sep).join('/')}`);
  assert.ok(srcFiles.length > 40, `expected a full source tree, found ${srcFiles.length}`);
  const unreachable = srcFiles.filter((rel) => !graph.modules.has(path.join(ROOT, rel)));
  assert.deepEqual(
    unreachable,
    [],
    `these modules are not imported by anything reachable from src/main.js: ${unreachable.join(', ')}`,
  );
});

test('the graph reports no dead modules as warnings', () => {
  assert.deepEqual(graph.warnings, []);
});

/* --------------------------- scanner behaviour --------------------------- */

test('comments are stripped but string literals survive', () => {
  const source = `
    // import { fake } from './nope.js';
    /* import { alsoFake } from './nope2.js'; */
    import { real } from './yes.js';
    const spec = 'from "./kept.js"';
  `;
  const stripped = stripComments(source);
  assert.ok(!stripped.includes('./nope.js'), 'line comments must be blanked');
  assert.ok(!stripped.includes('./nope2.js'), 'block comments must be blanked');
  assert.ok(stripped.includes("'./yes.js'"), 'real specifiers must survive');
  assert.ok(stripped.includes('"./kept.js"'), 'string contents must survive');
  assert.equal(stripped.split('\n').length, source.split('\n').length, 'line offsets must be preserved');
});

test('a specifier inside a JSDoc block is not treated as an import', () => {
  // src/render/markers.js documents a Cesium type this way; it is not an edge.
  const mod = parseModule(path.join(ROOT, 'src/render/markers.js'));
  assert.ok(
    !mod.edges.some((edge) => edge.dynamic && edge.spec === 'cesium'),
    'the JSDoc import() annotation was parsed as a dynamic import',
  );
});

test('named, namespace, side-effect and re-export forms are all recognised', () => {
  const { root, graph: g, cleanup } = fixture({
    'entry.js': "import { a } from './lib.js';\nimport * as ns from './lib.js';\nimport './side.js';\nvoid ns;\n",
    'lib.js': "export const a = 1;\nexport { b } from './other.js';\nexport * from './other.js';\n",
    'other.js': 'export const b = 2;\nexport const c = 3;\n',
    'side.js': 'export const d = 4;\n',
  });
  try {
    assert.deepEqual(g.errors, [], `unexpected: ${g.errors.join(' | ')}`);

    const entry = g.modules.get(path.join(root, 'entry.js'));
    const kinds = entry.edges.map((edge) => `${edge.kind}:${edge.spec}`);
    assert.ok(kinds.includes('import:./lib.js'), `named import not recorded: ${kinds.join(', ')}`);
    assert.ok(kinds.includes('side-effect:./side.js'), `side-effect import not recorded: ${kinds.join(', ')}`);
    assert.deepEqual(entry.edges.find((edge) => edge.spec === './lib.js').named, ['a']);

    const lib = g.modules.get(path.join(root, 'lib.js'));
    assert.ok(lib.starExports.includes('./other.js'), '`export * from` was not recorded as a re-export');
    assert.ok(lib.exports.has('b'), 'a named re-export should appear in the module export set');

    // entry -> lib -> other, plus the side-effect module.
    assert.equal(g.order.length, 4, `expected 4 modules, traversed ${g.order.length}`);
  } finally {
    cleanup();
  }
});

/* --------------------------- non-vacuity proofs -------------------------- */

test('a mis-spelled named import is reported', () => {
  const { graph: g, cleanup } = fixture({
    'entry.js': "import { createOvrlay } from './lib.js';\ncreateOvrlay();\n",
    'lib.js': 'export const createOverlay = () => {};\n',
  });
  try {
    assert.equal(g.errors.length, 1, `expected exactly one error, got: ${g.errors.join(' | ')}`);
    assert.match(g.errors[0], /does not export 'createOvrlay'/);
    assert.match(g.errors[0], /createOverlay/, 'the message should suggest the real export');
  } finally {
    cleanup();
  }
});

test('a specifier pointing at a missing file is reported', () => {
  const { graph: g, cleanup } = fixture({
    'entry.js': "import { a } from './renamed-away.js';\n",
  });
  try {
    assert.equal(g.errors.length, 1);
    assert.match(g.errors[0], /cannot resolve '.\/renamed-away\.js'/);
  } finally {
    cleanup();
  }
});

test('an uninstalled package is reported', () => {
  const { graph: g, cleanup } = fixture({
    'entry.js': "import { x } from 'definitely-not-a-real-package-xyz';\n",
  });
  try {
    assert.equal(g.errors.length, 1);
    assert.match(g.errors[0], /is not installed/);
  } finally {
    cleanup();
  }
});

test('a correct re-export through `export *` is not a false positive', () => {
  const { graph: g, cleanup } = fixture({
    'entry.js': "import { deep } from './barrel.js';\ndeep();\n",
    'barrel.js': "export * from './impl.js';\n",
    'impl.js': 'export const deep = () => {};\n',
  });
  try {
    assert.deepEqual(g.errors, []);
  } finally {
    cleanup();
  }
});

test('a clean graph produces no errors', () => {
  const { graph: g, cleanup } = fixture({
    'entry.js': "import { a } from './lib.js';\nimport './side.js';\na();\n",
    'lib.js': 'export const a = 1;\n',
    'side.js': 'export const unused = 2;\n',
  });
  try {
    assert.deepEqual(g.errors, []);
    assert.equal(g.order.length, 3, 'entry, lib and the side-effect import');
  } finally {
    cleanup();
  }
});

/* ----------------------------- resolution rules -------------------------- */

test('bare specifiers resolve against node_modules, never into the graph', () => {
  const cesium = resolveSpecifier('cesium', ENTRY, ROOT);
  assert.ok(cesium.resolved, 'cesium should resolve to its package directory');
  assert.equal(cesium.local, false, 'a bare specifier is not a local edge');

  const widgets = resolveSpecifier('cesium/Build/Cesium/Widgets/widgets.css', ENTRY, ROOT);
  assert.ok(widgets.resolved, 'the widget stylesheet must resolve');

  const missing = resolveSpecifier('no-such-package-at-all', ENTRY, ROOT);
  assert.equal(missing.resolved, null);
  assert.equal(missing.packageMissing, true);
});

test('extension-less relative specifiers resolve, and bad ones do not', () => {
  const withExt = resolveSpecifier('./core/dom.js', ENTRY, ROOT);
  assert.ok(withExt.resolved && withExt.resolved.endsWith('core/dom.js'));
  assert.equal(withExt.local, true);

  const withoutExt = resolveSpecifier('./core/dom', ENTRY, ROOT);
  assert.ok(withoutExt.resolved, 'a .js extension should be inferred');

  const bad = resolveSpecifier('./core/not-a-module.js', ENTRY, ROOT);
  assert.equal(bad.resolved, null);
});
