#!/usr/bin/env node
/**
 * Post-build integrity checks.
 *
 * A successful `vite build` proves the modules parsed. It does not prove the
 * site works from `https://<owner>.github.io/<repo>/`. These checks inspect the
 * actual emitted files for the failure modes that only show up in production:
 *
 *   1. asset URLs that assume a domain root, so a subpath 404s
 *   2. Cesium's static assets missing, so workers fail at runtime
 *   3. credentials baked into a public bundle
 *   4. a `cesium-base.js` that disagrees with the deployed base
 *   5. Node-only imports that a browser cannot satisfy
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATIC_DIRS } from './cesium-static.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

let failures = 0;
let checks = 0;

function check(name, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`);
  }
}

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

// Imported dynamically so the config module's own startup log stays quiet.
process.env.VITE_QUIET = '1';
const { resolvePagesBase } = await import('../vite.config.js');
const base = process.env.PAGES_BASE
  ? resolvePagesBase({ PAGES_BASE: process.env.PAGES_BASE })
  : resolvePagesBase(process.env, JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).name);

console.log(`\nChecking dist/ for base path ${base}`);

if (!existsSync(DIST)) {
  console.error('dist/ does not exist — run `npm run build` first.');
  process.exit(1);
}

/* ------------------------------ 1. entry html ---------------------------- */

const html = readFileSync(path.join(DIST, 'index.html'), 'utf8');

console.log('\n[1] index.html');
check('boot screen present', html.includes('id="boot"') && html.includes('id="boot-status"'));
check('globe container present', html.includes('id="cesium-container"'));
check('noscript fallback present', html.includes('<noscript>'));

const moduleScripts = [...html.matchAll(/<script[^>]+src="([^"]+)"[^>]*>/g)].map((m) => m[1]);
check('has a module entry point', moduleScripts.some((src) => /\/assets\/index-[\w-]+\.js$/.test(src)), moduleScripts.join(', '));

// Every absolute URL in the document must carry the base prefix.
const absoluteRefs = [...html.matchAll(/(?:href|src)="(\/[^"]*)"/g)].map((m) => m[1]);
const badRooted = absoluteRefs.filter((ref) => !ref.startsWith(base));
check(
  'no asset URL assumes a domain root',
  badRooted.length === 0,
  badRooted.length ? `missing the ${base} prefix: ${badRooted.join(', ')}` : '',
);

const relativeRefs = [...html.matchAll(/(?:href|src)="(\.\/[^"]*)"/g)].map((m) => m[1]);
for (const ref of relativeRefs) {
  const file = path.join(DIST, ref.replace('./', ''));
  check(`relative reference ${ref} resolves`, existsSync(file));
}

/* ------------------------- 2. cesium static assets ------------------------ */

console.log('\n[2] Cesium static assets');
for (const dir of STATIC_DIRS) {
  const target = path.join(DIST, 'cesium', dir);
  check(`cesium/${dir}/ copied`, existsSync(target) && statSync(target).isDirectory());
}
const workers = path.join(DIST, 'cesium', 'Workers');
check(
  'Cesium workers are present (they load at runtime, not through the bundler)',
  existsSync(workers) && readdirSync(workers).length > 50,
  existsSync(workers) ? `${readdirSync(workers).length} files` : 'directory missing',
);

const baseScript = path.join(DIST, 'cesium-base.js');
check('cesium-base.js emitted', existsSync(baseScript));
if (existsSync(baseScript)) {
  const content = readFileSync(baseScript, 'utf8');
  check(
    'CESIUM_BASE_URL matches the deployed base',
    content.includes(`window.CESIUM_BASE_URL = '${base}cesium/'`),
    content.trim(),
  );
}
check(
  'the page loads cesium-base.js before the module bundle',
  html.indexOf('cesium-base.js') > -1 &&
    html.indexOf('cesium-base.js') < html.indexOf('/assets/index-'),
);

/* --------------------------- 3. no credentials --------------------------- */

console.log('\n[3] credentials');
// Anything that looks like a real key. Deliberately narrow: these patterns must
// not match the *documentation* of a setting, only an embedded value.
const SECRET_PATTERNS = [
  [/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'a JWT'],
  [/sk-[A-Za-z0-9]{20,}/, 'an OpenAI-style secret key'],
  [/AIza[0-9A-Za-z_-]{30,}/, 'a Google API key'],
  [/ghp_[A-Za-z0-9]{30,}/, 'a GitHub personal access token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
];

/**
 * Cesium ships its own public default ion token as a literal in
 * `Core/Ion.js`, so it legitimately appears in the vendor bundle. Anything that
 * also appears verbatim in Cesium's published source is library code, not a
 * credential this project introduced — everything else is a failure.
 */
function thirdPartyLiterals() {
  const literals = new Set();
  const cesiumRoot = path.join(ROOT, 'node_modules/@cesium');
  for (const file of walk(cesiumRoot)) {
    if (!file.endsWith('.js')) continue;
    const text = readFileSync(file, 'utf8');
    for (const [pattern] of SECRET_PATTERNS) {
      for (const match of text.matchAll(new RegExp(pattern.source, 'g'))) literals.add(match[0]);
    }
  }
  return literals;
}

const bundles = [...walk(path.join(DIST, 'assets'))].filter((file) => file.endsWith('.js'));
check('bundles were emitted', bundles.length > 0, `${bundles.length} files`);

const knownThirdParty = thirdPartyLiterals();
const leaked = [];
for (const file of bundles) {
  const text = readFileSync(file, 'utf8');
  for (const [pattern, label] of SECRET_PATTERNS) {
    for (const match of text.matchAll(new RegExp(pattern.source, 'g'))) {
      if (knownThirdParty.has(match[0])) continue;
      leaked.push(`${path.relative(ROOT, file)} contains ${label}`);
    }
  }
}
check(
  'no credential-shaped strings in any bundle (third-party library constants excepted)',
  leaked.length === 0,
  leaked.join('; '),
);

// And the app bundle specifically must not carry any credential shape at all.
const appBundle = bundles.find((file) => /index-[\w-]+\.js$/.test(path.basename(file)));
if (appBundle) {
  const text = readFileSync(appBundle, 'utf8');
  const inApp = SECRET_PATTERNS.filter(([pattern]) => pattern.test(text));
  check('the application bundle carries no credential shape', inApp.length === 0);
}

const envFiles = readdirSync(ROOT).filter((name) => /^\.env(\.|$)/.test(name) && name !== '.env.example');
check('no .env file is committed', envFiles.length === 0, envFiles.join(', '));

// The settings module must document the secret fields it redacts.
const settingsSource = readFileSync(path.join(ROOT, 'src/settings/store.js'), 'utf8');
check('the settings store redacts secrets on export', settingsSource.includes('[redacted]'));

/* ------------------------ 4. browser-safe imports ------------------------ */

console.log('\n[4] browser compatibility');
let nodeImports = [];
for (const file of bundles) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/require\(["'](node:[a-z_/]+)["']\)|from\s*["'](node:[a-z_/]+)["']/g)) {
    nodeImports.push(`${path.relative(ROOT, file)} -> ${match[1] || match[2]}`);
  }
}
check('no Node builtins reachable from the browser bundles', nodeImports.length === 0, nodeImports.join('; '));

/* ----------------------------- 5. size budget ---------------------------- */

console.log('\n[5] GitHub Pages size budget');
let total = 0;
for (const file of walk(DIST)) total += statSync(file).size;
const totalMb = total / 1024 / 1024;
check(`site is ${totalMb.toFixed(1)} MB (Pages soft limit 1 GB)`, totalMb < 900);
for (const file of bundles) {
  const mb = statSync(file).size / 1024 / 1024;
  check(`${path.basename(file)} is ${mb.toFixed(2)} MB`, mb < 25, 'a single file this large will not cache well');
}

/* -------------------------------- summary -------------------------------- */

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
}
console.log('dist/ is safe to publish.\n');
