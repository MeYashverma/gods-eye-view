/**
 * Icon set integrity.
 *
 * Lucide's per-icon ESM files are imported by path, so a rename upstream breaks
 * the build with "cannot resolve" rather than a missing glyph. These tests check
 * every imported path exists on disk and every name the app asks for is in the
 * map — including that no emoji is used anywhere as a control.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { ICONS, ICON_NAMES, iconMarkup, iconEl } from '../src/core/icons.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ICONS_JS = readFileSync(path.join(ROOT, 'src/core/icons.js'), 'utf8');

test('every lucide import path resolves on disk', () => {
  const paths = [...ICONS_JS.matchAll(/from 'lucide\/dist\/esm\/icons\/([a-z0-9-]+)\.mjs'/g)].map((m) => m[1]);
  assert.ok(paths.length >= 60, `expected a full icon set, found ${paths.length}`);
  const missing = paths.filter((name) => !existsSync(path.join(ROOT, 'node_modules/lucide/dist/esm/icons', `${name}.mjs`)));
  assert.deepEqual(missing, [], 'these icon files no longer exist in the installed lucide version');
});

test('the default attributes module exists', () => {
  assert.ok(existsSync(path.join(ROOT, 'node_modules/lucide/dist/esm/defaultAttributes.mjs')));
});

test('every icon in the map is wired to a real Lucide definition', () => {
  assert.ok(ICON_NAMES.length >= 60);
  assert.equal(new Set(ICON_NAMES).size, ICON_NAMES.length, 'no duplicate icon names');
  for (const name of ICON_NAMES) {
    assert.ok(ICONS[name], `${name} maps to nothing`);
    assert.ok(Array.isArray(ICONS[name]), `${name} is not a Lucide [tag, attrs] list`);
    assert.ok(ICONS[name].length > 0, `${name} has no paths`);
  }
});

test('every icon name used in the app is in the map', () => {
  const used = new Set();
  const patterns = [/icon:\s*'([a-zA-Z]+)'/g, /iconMarkup\('([a-zA-Z]+)'/g, /iconHtml\('([a-zA-Z]+)'/g, /iconEl\('([a-zA-Z]+)'/g];
  for (const file of walk(path.join(ROOT, 'src'))) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) used.add(match[1]);
    }
  }
  assert.ok(used.size >= 20, `only found ${used.size} icon usages — the scan is probably broken`);
  const missing = [...used].filter((name) => !ICON_NAMES.includes(name));
  assert.deepEqual(missing, [], 'these icons are referenced but not defined');
});

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith('.js')) yield full;
  }
}

test('iconMarkup emits a real SVG element, not text or emoji', () => {
  const markup = iconMarkup('plane', { size: 20 });
  assert.ok(markup.startsWith('<svg'), markup.slice(0, 40));
  assert.ok(markup.includes('width="20"') && markup.includes('height="20"'), 'the size option is honoured');
  assert.ok(markup.includes('viewBox="0 0 24 24"'));
  assert.ok(markup.includes('</svg>'));
  assert.ok(markup.includes('aria-hidden="true"'), 'decorative icons are hidden from assistive tech');
  assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(markup), 'no emoji in generated markup');
  // Attribute values are escaped, so a hostile className cannot break out.
  const injected = iconMarkup('plane', { className: 'x" onload="alert(1)' });
  assert.ok(!injected.includes('onload="alert(1)"'), injected);
});

test('the default size is applied when no option is given', () => {
  assert.ok(iconMarkup('plane').includes('width="14"'));
  assert.equal(iconEl, iconEl, 'iconEl needs a DOM and is covered by the browser build check');
});

test('an unknown icon name renders nothing rather than throwing', () => {
  assert.equal(iconMarkup('definitely-not-an-icon'), '');
  assert.doesNotThrow(() => iconMarkup('definitely-not-an-icon'));
  assert.doesNotThrow(() => iconMarkup(undefined));
});

test('no emoji is used as a UI control anywhere in the app', () => {
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE0F}]/u;
  const offenders = [];
  for (const file of walk(path.join(ROOT, 'src'))) {
    const text = readFileSync(file, 'utf8');
    for (const [index, line] of text.split('\n').entries()) {
      if (emoji.test(line) && !line.trim().startsWith('*') && !line.trim().startsWith('//')) {
        offenders.push(`${path.relative(ROOT, file)}:${index + 1}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'controls must use licensed vector icons, not emoji');
});
