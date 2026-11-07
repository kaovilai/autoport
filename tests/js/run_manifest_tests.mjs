// tests/js/run_manifest_tests.mjs — static-site integrity tests (stdlib only).
//
// Gates three things the browser suites cannot easily pin:
//   1. manifest.webmanifest is a valid, installable PWA manifest: required
//      fields, real PNG icons on disk, share_target POST/multipart contract.
//   2. Every entry in the sw.js SHELL precache list points at a file that
//      actually exists in the repo (a typo'd path silently degrades offline).
//   3. Precache completeness (DESIGN.md §4 / V5 gate): every module statically
//      imported by the pages, every data file fetched at runtime, and every
//      asset referenced by the HTML is IN the SHELL list — otherwise the app
//      bricks offline after first load.
//
// Run: node tests/js/run_manifest_tests.mjs
// Exits non-zero on any failure.

import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let passes = 0;
let failures = 0;

async function test(name, fn) {
  try {
    await fn();
    passes += 1;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${err && err.message ? err.message : err}`);
  }
}

/* ------------------------------------------------------------------ */
/* manifest                                                            */
/* ------------------------------------------------------------------ */

const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'manifest.webmanifest'), 'utf8'));

await test('manifest: required identity + display fields', () => {
  for (const key of ['name', 'short_name', 'start_url', 'scope', 'display', 'icons', 'share_target']) {
    assert.ok(manifest[key] != null, `missing manifest key: ${key}`);
  }
  assert.equal(manifest.display, 'standalone');
  assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/i);
});

await test('manifest: icons exist on disk and are real PNGs (192 any + 512 any + 512 maskable)', () => {
  const purposes = {};
  for (const icon of manifest.icons) {
    const p = path.join(repoRoot, icon.src);
    assert.ok(existsSync(p), `icon file missing: ${icon.src}`);
    const head = readFileSync(p).subarray(0, 8);
    assert.deepEqual([...head], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `not a PNG: ${icon.src}`);
    for (const purpose of (icon.purpose || 'any').split(/\s+/)) {
      purposes[`${icon.sizes}/${purpose}`] = true;
    }
  }
  assert.ok(purposes['192x192/any'], 'no 192x192 any-purpose icon');
  assert.ok(purposes['512x512/any'], 'no 512x512 any-purpose icon');
  assert.ok(purposes['512x512/maskable'], 'no 512x512 maskable icon');
});

await test('manifest: share_target is POST multipart with files[] (share-sheet contract)', () => {
  const st = manifest.share_target;
  assert.equal(st.method, 'POST');
  assert.equal(st.enctype, 'multipart/form-data');
  assert.ok(st.action && !st.action.includes('://'), 'action must be a same-origin relative path');
  const files = st.params?.files;
  assert.ok(Array.isArray(files) && files.length >= 1, 'files[] param required');
  const accept = files[0].accept;
  for (const mime of ['application/xml', 'text/xml', 'application/vnd.com.llamalab.automate.flow', 'application/octet-stream']) {
    assert.ok(accept.includes(mime), `accept missing ${mime} (share sheet will not list AutoPort for it)`);
  }
});

await test('manifest: share_target action resolves inside the scope', () => {
  const scopeUrl = new URL(manifest.scope, 'https://example.test/autoport/');
  const actionUrl = new URL(manifest.share_target.action, scopeUrl);
  assert.ok(actionUrl.href.startsWith(scopeUrl.href), `${actionUrl.href} escapes scope ${scopeUrl.href}`);
  // The SW routes POSTs to <scope>share — the manifest action must match that name.
  assert.equal(actionUrl.pathname.replace(scopeUrl.pathname, ''), 'share');
});

/* ------------------------------------------------------------------ */
/* sw.js precache list                                                 */
/* ------------------------------------------------------------------ */

const sw = readFileSync(path.join(repoRoot, 'sw.js'), 'utf8');
const shellMatch = /const SHELL = \[([\s\S]*?)\]/.exec(sw);
assert.ok(shellMatch, 'could not extract SHELL list from sw.js');
const shellRel = [...shellMatch[1].matchAll(/['"]([^'"]+)['"]/g)]
  .map((m) => m[1].replace(/^\//, ''))
  .filter((p) => p !== './'); // './' is the scope directory itself

await test('sw.js: every SHELL entry exists in the repo', () => {
  for (const rel of shellRel) {
    const p = path.join(repoRoot, rel);
    assert.ok(existsSync(p) && statSync(p).isFile(), `SHELL entry missing on disk: ${rel}`);
  }
});

function importsOf(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  const src = readFileSync(path.join(repoRoot, file), 'utf8');
  for (const m of src.matchAll(/(?:import[\s\S]*?from|import)\s*['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue; // bare specifiers not used in this repo
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
    if (!/\.[cm]?js$/.test(resolved)) continue;
    importsOf(resolved, seen);
  }
  return seen;
}

await test('sw.js: precache completeness — all statically imported modules are in SHELL', () => {
  const modules = new Set([...importsOf('js/app.js'), ...importsOf('js/share.js')]);
  const shellSet = new Set(shellRel);
  for (const mod of modules) {
    assert.ok(shellSet.has(mod), `${mod} is imported by a page but NOT in the SW SHELL precache — offline breaks (V5)`);
  }
});

await test('sw.js: runtime-fetched data files are in SHELL (offline parse gate)', () => {
  const shellSet = new Set(shellRel);
  for (const data of ['data/taskerCodes.json', 'data/macrodroid/mappingTable.json']) {
    assert.ok(shellSet.has(data), `${data} fetched at runtime but not precached`);
  }
});

await test('sw.js: pages, styles, manifest and icons are in SHELL', () => {
  const shellSet = new Set(shellRel);
  for (const asset of ['index.html', 'share.html', '404.html', 'styles.css', 'manifest.webmanifest',
    'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png']) {
    assert.ok(shellSet.has(asset), `${asset} missing from SW SHELL precache`);
  }
});

/* ------------------------------------------------------------------ */
/* HTML wiring                                                         */
/* ------------------------------------------------------------------ */

for (const page of ['index.html', 'share.html', '404.html']) {
  await test(`${page}: links manifest, icons and stylesheet; module scripts exist`, () => {
    const html = readFileSync(path.join(repoRoot, page), 'utf8');
    assert.match(html, /<link rel="manifest" href="manifest\.webmanifest">/);
    assert.match(html, /rel="stylesheet" href="styles\.css"/);
    for (const m of html.matchAll(/<(?:script|img|link)[^>]+(?:src|href)="([^"]+)"/g)) {
      const href = m[1];
      if (/^https?:|^#|^mailto:/.test(href)) continue;
      assert.ok(existsSync(path.join(repoRoot, href)), `${page} references missing file: ${href}`);
    }
  });
}

await test('index.html: converter controls the app module wires (ids used by app.js)', () => {
  const html = readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
  for (const id of ['file-input', 'drop', 'paste', 'analyze', 'status', 'results', 'inbox']) {
    assert.ok(html.includes(`id="${id}"`), `index.html missing #${id}`);
  }
  assert.match(html, /<script type="module" src="js\/app\.js">/);
});

await test('share.html: inbox controls the share module wires (ids used by share.js)', () => {
  const html = readFileSync(path.join(repoRoot, 'share.html'), 'utf8');
  for (const id of ['cards', 'banner', 'empty', 'clear-all']) {
    assert.ok(html.includes(`id="${id}"`), `share.html missing #${id}`);
  }
  assert.match(html, /<script type="module" src="js\/share\.js">/);
});

console.log(`\nmanifest/site tests: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
