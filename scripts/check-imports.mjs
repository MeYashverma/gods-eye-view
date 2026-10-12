#!/usr/bin/env node
/**
 * Static import-graph check.
 *
 * `src/main.js` touches `document` at module scope, so no Node test can import
 * it. That leaves the entry point's entire dependency graph unexercised: a
 * mis-spelled named import, or a specifier pointing at a renamed file, only
 * surfaces in the browser as a blank boot screen — while `npm test` stays
 * green and `vite build` still succeeds, because Rollup resolves the graph at
 * build time but the *names* it fails on are exactly the ones this script
 * checks.
 *
 * This walks the graph from the entry point without executing any of it:
 *
 *   1. every relative specifier resolves to a real file
 *   2. every bare specifier resolves to an installed package
 *   3. every named import is actually exported by its target
 *      (following `export *` re-exports)
 *
 * Comments are stripped before parsing so a specifier inside a JSDoc block or
 * a prose comment is not mistaken for a real edge.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ENTRY = path.join(ROOT, 'src/main.js');

/* ------------------------------ source scanning -------------------------- */

/**
 * Blank out comments while leaving string literals byte-for-byte intact — the
 * import specifiers live inside those strings, so they have to survive.
 * Offsets and newlines are preserved so reported line numbers stay correct.
 */
export function stripComments(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (c === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  ';
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      out += c;
      i += 1;
      while (i < n && source[i] !== c) {
        if (source[i] === '\\') {
          out += source[i] + (source[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += source[i];
        i += 1;
      }
      if (i < n) {
        out += source[i];
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** `{ a, b as c, default as d }` -> ['a', 'b', 'default'] (the exported names). */
function namesFromClause(clause) {
  const inner = clause.trim().replace(/^\{/, '').replace(/\}$/, '');
  const names = [];
  for (const raw of inner.split(',')) {
    const part = raw.trim();
    if (!part) continue;
    const as = part.split(/\s+as\s+/);
    const local = as.length > 1 ? as[as.length - 1].trim() : part;
    names.push(local);
  }
  return names;
}

/** Everything a module exports, as far as static reading can tell. */
function collectExports(code) {
  const exports = new Set();
  const starExports = [];
  const reExports = [];
  let hasDefault = false;

  const declarations = code.matchAll(
    /\bexport\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  );
  for (const match of declarations) exports.add(match[1]);

  // `export const { a, b } = ...` and the array form.
  const destructured = code.matchAll(/\bexport\s+(?:const|let|var)\s+([\[{][^=]*[\]}])\s*=/g);
  for (const match of destructured) {
    for (const name of match[1].matchAll(/[A-Za-z_$][\w$]*/g)) exports.add(name[0]);
  }

  // `export { a, b as c }` and `export { x } from './y.js'`.
  const lists = code.matchAll(/\bexport\s*\{([^}]*)\}\s*(?:from\s*(['"])([^'"]+)\2)?/g);
  for (const match of lists) {
    const names = namesFromClause(match[1]);
    if (match[3]) {
      reExports.push({ spec: match[3], names });
      for (const name of names) exports.add(name);
    } else {
      for (const name of names) exports.add(name);
    }
  }

  const stars = code.matchAll(/\bexport\s*\*\s*(?:as\s+[A-Za-z_$][\w$]*\s*)?from\s*(['"])([^'"]+)\1/g);
  for (const match of stars) {
    starExports.push(match[2]);
    // `export * as ns` binds a namespace name, not the target's members.
    if (/as\s+[A-Za-z_$][\w$]*\s*from/.test(match[0])) {
      exports.add(match[0].match(/as\s+([A-Za-z_$][\w$]*)/)[1]);
    }
  }

  if (/\bexport\s+default\b/.test(code)) {
    hasDefault = true;
    exports.add('default');
  }

  return { exports, starExports, reExports, hasDefault };
}

/** Every import edge out of a module: named, default, namespace, side-effect, dynamic. */
function collectImports(code) {
  const edges = [];

  const from = code.matchAll(/\b(import|export)\b([^;]*?)\bfrom\s*(['"])([^'"]+)\3/g);
  for (const match of from) {
    const [, kind, clause, , spec] = match;
    const named = clause.includes('{') ? namesFromClause(clause.match(/\{[^}]*\}/)?.[0] ?? '{}') : [];
    const hasDefault = kind === 'import' && /^[^{*\s]/.test(clause.trim());
    edges.push({ spec, kind, named, hasDefault, dynamic: false });
  }

  const bare = code.matchAll(/\bimport\s*(['"])([^'"]+)\1/g);
  for (const match of bare) edges.push({ spec: match[2], kind: 'side-effect', named: [], hasDefault: false, dynamic: false });

  const dynamic = code.matchAll(/\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g);
  for (const match of dynamic) edges.push({ spec: match[2], kind: 'dynamic', named: [], hasDefault: false, dynamic: true });

  return edges;
}

export function parseModule(file) {
  const raw = readFileSync(file, 'utf8');
  const code = stripComments(raw);
  const { exports, starExports, reExports, hasDefault } = collectExports(code);
  return {
    file,
    code,
    exports,
    starExports,
    reExports,
    hasDefault,
    edges: collectImports(code),
  };
}

/* ------------------------------ resolution ------------------------------ */

function isFile(candidate) {
  return existsSync(candidate) && statSync(candidate).isFile();
}

function resolveLocalFile(absolute) {
  if (isFile(absolute)) return absolute;
  for (const ext of ['.js', '.mjs', '.cjs', '.json', '.css']) {
    if (isFile(absolute + ext)) return absolute + ext;
  }
  for (const index of ['index.js', 'index.mjs']) {
    const candidate = path.join(absolute, index);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Bare specifiers resolve against node_modules. Package roots are accepted on
 * directory existence alone — subpath/entry resolution through the `exports`
 * map is the bundler's job, and cesium 1.146 is a barrel package whose
 * `exports` intentionally null out `./Source/*.js`.
 */
function resolveBare(spec, root = ROOT) {
  const parts = spec.split('/');
  const pkg = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const dir = path.join(root, 'node_modules', pkg);
  if (!existsSync(dir)) return { resolved: null, packageMissing: true, pkg };
  const sub = spec.slice(pkg.length);
  if (!sub) return { resolved: dir, packageMissing: false, pkg };
  const candidate = path.join(dir, sub);
  if (existsSync(candidate)) return { resolved: candidate, packageMissing: false, pkg };
  return { resolved: null, packageMissing: false, pkg };
}

export function resolveSpecifier(spec, fromFile, root = ROOT) {
  if (spec.startsWith('.')) {
    return { resolved: resolveLocalFile(path.resolve(path.dirname(fromFile), spec)), local: true };
  }
  if (spec.startsWith('/')) {
    return { resolved: resolveLocalFile(path.join(root, spec)), local: true };
  }
  return { ...resolveBare(spec, root), local: false };
}

/* -------------------------------- graph walk ---------------------------- */

/**
 * Walk every module reachable from `entry` and verify each edge.
 * Returns `{ modules, errors, warnings, order }`; `errors` is what a caller
 * should fail on.
 */
export function buildImportGraph({ entry = ENTRY, root = ROOT } = {}) {
  const modules = new Map();
  const errors = [];
  const warnings = [];
  const order = [];

  function load(file) {
    if (modules.has(file)) return modules.get(file);
    const mod = parseModule(file);
    modules.set(file, mod);
    order.push(file);
    for (const edge of mod.edges) {
      const { resolved, local, packageMissing, pkg } = resolveSpecifier(edge.spec, file, root);
      const where = `${path.relative(root, file)}`;
      if (!resolved) {
        errors.push(
          packageMissing
            ? `${where}: package '${pkg}' is not installed (imported as '${edge.spec}')`
            : `${where}: cannot resolve '${edge.spec}'`,
        );
        continue;
      }
      edge.resolved = resolved;
      // Never walk into node_modules: for a bare specifier we only need to
      // know the package (or subpath file) exists — the bundler, not this
      // script, owns `exports`-map and entry resolution.
      if (!local) continue;
      const isCode = /\.(js|mjs|cjs)$/.test(resolved);
      // CSS and JSON are leaves: nothing to traverse, nothing to verify.
      if (!isCode) continue;
      // Traverse first, so a module reached only through a side-effect import
      // still has its own imports checked.
      const target = load(resolved);
      // A side-effect or namespace import binds no names, so there is nothing
      // to verify against the target's export set.
      if (edge.named.length === 0) continue;
      const available = effectiveExports(target, modules, root, new Set());
      for (const name of edge.named) {
        if (!available.has(name)) {
          errors.push(
            `${where}: '${edge.spec}' does not export '${name}' ` +
              `(it exports: ${[...available].slice(0, 12).join(', ') || 'nothing'})`,
          );
        }
      }
    }
    return mod;
  }

  load(entry);

  // Informational: an unreachable file under src/ is either dead code or an
  // entry point this script does not know about.
  const reachable = new Set(order.map((file) => path.relative(root, file)));
  const srcDir = path.join(root, 'src');
  if (existsSync(srcDir)) {
    for (const file of walk(srcDir)) {
      if (!/\.(js|mjs)$/.test(file)) continue;
      if (!reachable.has(path.relative(root, file))) {
        warnings.push(`${path.relative(root, file)} is not reachable from ${path.relative(root, entry)}`);
      }
    }
  }

  return { modules, errors, warnings, order };
}

/** Exports of a module including everything it re-exports with `export *`. */
export function effectiveExports(mod, modules, root = ROOT, seen = new Set()) {
  if (seen.has(mod.file)) return mod.exports;
  seen.add(mod.file);
  const set = new Set(mod.exports);
  for (const spec of mod.starExports) {
    const { resolved } = resolveSpecifier(spec, mod.file, root);
    if (!resolved) continue;
    let target = modules.get(resolved);
    if (!target) {
      target = parseModule(resolved);
      modules.set(resolved, target);
    }
    for (const name of effectiveExports(target, modules, root, seen)) set.add(name);
  }
  seen.delete(mod.file);
  return set;
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/* ---------------------------------- CLI --------------------------------- */

export function formatReport({ modules, errors, warnings, order }, root = ROOT) {
  const lines = [];
  lines.push(`\nImport graph from ${path.relative(root, ENTRY)}`);
  lines.push(`  ${order.length} modules traversed, ${modules.size} parsed`);
  if (warnings.length) {
    lines.push(`\n${warnings.length} warning(s)`);
    for (const warning of warnings) lines.push(`  warn  ${warning}`);
  }
  if (errors.length) {
    lines.push(`\n${errors.length} error(s)`);
    for (const error of errors) lines.push(`  FAIL  ${error}`);
  } else {
    lines.push('\n  ok    every specifier resolves and every named import is exported');
  }
  return lines.join('\n');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const graph = buildImportGraph();
  console.log(formatReport(graph));
  if (graph.errors.length) {
    console.error(`\n${graph.errors.length} import error(s).\n`);
    process.exit(1);
  }
  console.log('\nimport graph is consistent.\n');
}
