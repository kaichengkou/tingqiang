import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';

const root = new URL('../dist/', import.meta.url);
const files = ['', 'lib/', 'vendor/'].flatMap(dir => readdirSync(new URL(dir, root)).filter(name => name.endsWith('.mjs')).map(name => new URL(dir + name, root)));

// Browsers key modules by their full URL, so one file imported under two query strings loads and runs twice.
test('every module, worker and asset is referenced through a single URL', () => {
  const searches = new Map();
  for (const file of files) {
    for (const [, , specifier] of readFileSync(file, 'utf8').matchAll(/(?:\bfrom\s*|\bimport\(\s*|new URL\(\s*)(['"])(\.\.?\/[^'"]*)\1/g)) {
      const url = new URL(specifier, file);
      if (!searches.has(url.pathname)) searches.set(url.pathname, new Set());
      searches.get(url.pathname).add(url.search);
    }
  }
  assert.ok(searches.size > 20);
  for (const [path, variants] of searches) assert.equal(variants.size, 1, `${path} is referenced as ${[...variants].map(v => v || '(no query)').join(' and ')}`);
});

test('workers and data load relative to the module, so the site can live under a sub-path', () => {
  for (const file of files) assert.doesNotMatch(readFileSync(file, 'utf8'), /new Worker\(\s*['"`]\/|fetch\(\s*['"`]\//, file.pathname);
});
