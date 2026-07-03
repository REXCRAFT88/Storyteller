#!/usr/bin/env node
/**
 * Guards against the "reference to a DOM element that doesn't exist" class of
 * bug (ANALYSIS.md B4). Parses every getElementById('X') target in the JS and
 * fails if X is neither a static id in the markup nor an id produced by a
 * template literal / createElement in the JS.
 *
 * Zero dependencies so it runs anywhere (CI, pre-commit, plain `node`).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const js = readFileSync(join(root, 'js/app.js'), 'utf8');

const idAttr = /id\s*=\s*["'`]([^"'`]+)["'`]/g;
const staticIds = new Set();
for (const m of html.matchAll(idAttr)) staticIds.add(m[1]);

// ids created dynamically in JS (template literals or attribute strings).
// Anything containing ${...} is treated as a wildcard prefix/suffix match.
const dynamicLiterals = [];
for (const m of js.matchAll(idAttr)) dynamicLiterals.push(m[1]);
// ids assigned via `.id = 'foo'` / `.id = \`foo\``
for (const m of js.matchAll(/\.id\s*=\s*["'`]([^"'`$]+)["'`]/g)) dynamicLiterals.push(m[1]);

function isDynamicallyProvided(id) {
  return dynamicLiterals.some((lit) => {
    if (!lit.includes('${')) return lit === id;
    // turn a template literal like `page-${x}-row` into a regex
    const re = new RegExp('^' + lit.replace(/[.*+?^${}()|[\]\\]/g, (c) =>
      c === '$' ? '$' : '\\' + c).replace(/\\\$\\\{[^}]*\\\}/g, '.*') + '$');
    return re.test(id);
  });
}

const getters = new Set();
for (const m of js.matchAll(/getElementById\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) getters.add(m[1]);

const missing = [...getters]
  .filter((id) => !staticIds.has(id) && !isDynamicallyProvided(id))
  .sort();

if (missing.length) {
  console.error(`✗ ${missing.length} getElementById target(s) not found in markup or JS-created ids:\n`);
  for (const id of missing) console.error('  - ' + id);
  console.error('\nEither add the element, remove the dead reference, or (if built dynamically) ensure the id literal appears in js/app.js.');
  process.exit(1);
}
console.log(`✓ All ${getters.size} getElementById targets resolve.`);
