// tests/e2e/run-e2e.mjs — full-PWA end-to-end tests in a real Chromium.
//
// Runs the static site from a local HTTP server (root scope AND a /autoport/
// subpath scope, the GitHub Pages project-site layout) and drives the actual
// product surface a user touches:
//
//   - page load, service worker registration + precache (V5 precondition)
//   - manifest + icons served
//   - every ingest path: file picker, drag-and-drop, paste box, page paste
//   - every sniffer route through the UI: Tasker XML, .flo, PNG, unknown
//     binary, empty payload, TaskerNet link (V1/V2/V3 browser half)
//   - golden-equality of the rendered result across picker/drop/paste (V4)
//   - share-target POST -> 303 -> share.html inbox card -> "Open in
//     converter" handoff (the share-sheet flow, minus the Android sheet)
//   - share edge cases: text-only TaskerNet share, empty share, >25 MiB share
//   - GET /share redirect, IndexedDB inbox persistence + clear
//   - offline after first load: reload, parse, share.html, unknown deep link
//     served from the cached shell with <base> injected (V5)
//
// Usage: node tests/e2e/run-e2e.mjs [--browser <chromium|chrome>]
// Browsers: uses Playwright's bundled chromium by default; pass --browser
// chrome to use a system-installed Google Chrome (GHA runners have one).
// Exits non-zero on any failure.

import { spawn } from 'node:child_process';
import net from 'node:net';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtempSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// --------------------------------------------------------------------- //
// tiny runner
// --------------------------------------------------------------------- //

let passes = 0;
let failures = 0;
const failedNames = [];

async function t(name, fn) {
  const started = Date.now();
  try {
    await fn();
    passes += 1;
    console.log(`PASS  ${name} (${Date.now() - started}ms)`);
  } catch (err) {
    failures += 1;
    failedNames.push(name);
    console.error(`FAIL  ${name}\n      ${err && err.message ? err.message : err}`);
  }
}

// --------------------------------------------------------------------- //
// fixtures
// --------------------------------------------------------------------- //

const FIX = {
  tasker: readFileSync(path.join(repoRoot, 'tests/fixtures/tasker/LaunchInstagram.tsk.xml')),
  flo: readFileSync(path.join(repoRoot, 'tests/fixtures/automate/1446.flo')),
};
const taskerXmlText = FIX.tasker.toString('utf8');
const bytesOf = (buf) => Array.from(new Uint8Array(buf));

// --------------------------------------------------------------------- //
// local static server (root + subpath, like GitHub Pages)
// --------------------------------------------------------------------- //

// Grab a free TCP port (listen on 0, read the assigned port, close again).
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function startServer(dir) {
  return freePort().then((port) => new Promise((resolve, reject) => {
    // Python >=3.14 no longer prints a "Serving HTTP on ..." announcement, so
    // the port is pre-picked above and readiness is polled via waitServer().
    const proc = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', dir], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('exit', (code) => reject(new Error(`http.server exited early (${code}): ${err}`)));
    resolve({ proc, port });
  }));
}

async function waitServer(url) {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server never came up: ${url}`);
}

// --------------------------------------------------------------------- //
// per-scope suite
// --------------------------------------------------------------------- //

async function runScope(scopeName, base, context) {
  const shareUrl = base + 'share';
  const shareHtmlUrl = base + 'share.html';
  console.log(`\n========== scope: ${scopeName} (${base}) ==========`);

  const newPage = async () => {
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    return page;
  };

  // ---- load + service worker ---------------------------------------- //

  await t(`${scopeName}: index loads with converter chrome`, async () => {
    const page = await newPage();
    await page.goto(base);
    assert.match(await page.title(), /AutoPort/);
    await page.locator('#status').filter({ hasText: 'Waiting for a file' }).waitFor();
    await page.locator('#drop').waitFor();
    await page.close();
  });

  let swReady = null;
  await t(`${scopeName}: service worker registers, activates and controls the page`, async () => {
    const page = await newPage();
    await page.goto(base);
    // First registration on a cold browser can be slow; 30s headroom.
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 30000 });
    const state = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      const keys = await caches.keys();
      const shellName = keys.find((k) => k.startsWith('autoport-shell-'));
      const shell = shellName ? await caches.open(shellName) : null;
      return {
        scope: reg?.scope,
        state: reg?.active?.state,
        shellName,
        shellHasIndex: shell ? !!(await shell.match(new URL('index.html', location.href))) : false,
        shellHasCodes: shell ? !!(await shell.match(new URL('data/taskerCodes.json', location.href))) : false,
      };
    });
    assert.equal(state.state, 'activated');
    assert.equal(new URL(state.scope).pathname, new URL(base).pathname, 'SW scope must equal the serving scope');
    assert.ok(state.shellName, 'no autoport-shell-* cache after activation');
    assert.ok(state.shellHasIndex, 'precache missing index.html');
    assert.ok(state.shellHasCodes, 'precache missing data/taskerCodes.json (offline parse would break)');
    swReady = true;
    await page.close();
  });
  if (!swReady) {
    console.error(`\n!! SW never activated in ${scopeName}; remaining browser tests would all fail. Aborting this scope.`);
    return;
  }

  await t(`${scopeName}: manifest + icons are served`, async () => {
    const page = await newPage();
    await page.goto(base);
    const m = await (await page.request.get(base + 'manifest.webmanifest')).json();
    assert.equal(m.share_target.method, 'POST');
    // Pin the form field names too: the synthetic share tests below submit
    // these names, so a silent manifest rename must fail here, not in the
    // field.
    assert.equal(m.share_target.params.title, 'title', 'manifest renamed the title field');
    assert.equal(m.share_target.params.text, 'text', 'manifest renamed the text field');
    for (const icon of m.icons) {
      const r = await page.request.get(new URL(icon.src, base).href);
      assert.equal(r.status(), 200, `icon not served: ${icon.src}`);
      const sig = new Uint8Array((await r.body()).subarray(0, 4));
      assert.deepEqual([...sig], [0x89, 0x50, 0x4e, 0x47], `icon not a PNG: ${icon.src}`);
    }
    await page.close();
  });

  // ---- ingest paths -------------------------------------------------- //

  const statusText = (page) => page.locator('#status').textContent();
  const openPasteBox = async (page) => {
    await page.evaluate(() => { document.querySelector('details.paste-wrap').open = true; });
  };

  // The python-oracle golden for LaunchInstagram.tsk.xml: 5 actions = 3 decoded
  // + 2 plugin, 0 unknown. Pinning the full status string catches stats-plumbing
  // regressions (e.g. "0 identified" when the IR stats never reach the UI).
  const EXPECT_TASKER_STATUS = 'Tasker parsed: 1 macro(s), 5 action(s), 5 identified';
  // V4 equality per DESIGN.md: normalized golden equality across the ingest
  // paths. Three layers, all compared key-order-insensitively:
  //   1. the full parsed IR (window.autoport.lastIr, set by renderTasker) —
  //      deep-compared across picker/drop/paste AND against the committed
  //      python-oracle golden for this fixture;
  //   2. the rendered cards;
  //   3. the status string and the normalized results log (byte-derived
  //      sniff fields: kind, implied MIME, magic bytes).
  const cardsHtml = (page) => page.evaluate(() => [...document.querySelectorAll('#results .card')].map((c) => c.outerHTML).join('\n'));
  const normalizedResults = (page) => page.evaluate(() =>
    document.querySelector('#results').textContent.split('\n')
      .map((l) => l.replace(/^── .*/, '── <file>').replace(/^(   reported MIME :).*$/, '$1 <mime>'))
      .join('\n'));
  const canonicalize = (v) => {
    if (Array.isArray(v)) return v.map(canonicalize);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonicalize(v[k])]));
    }
    return v;
  };
  // V4 (DESIGN.md §11): source.file is basename-only. File-based ingest paths
  // carry the real filename (must match the golden EXACTLY, field included);
  // the paste box reports 'pasted.xml' (own expected value). Cross-path IR
  // equality is asserted with just that field normalized away.
  const irOf = (page) => page.evaluate(() => JSON.stringify(window.autoport?.lastIr ?? null));
  const goldenIr = canonicalize(JSON.parse(readFileSync(path.join(repoRoot, 'tests/golden/tasker/tasker-LaunchInstagram.tsk.ir.json'), 'utf8')));
  const expectedPasteIr = structuredClone(goldenIr);
  expectedPasteIr.source.file = 'pasted.xml';
  const withoutSourceFile = (ir) => {
    const c = structuredClone(ir);
    delete c.source.file;
    return c;
  };

  await t(`${scopeName}: file picker -> Tasker task parsed (V1 browser half)`, async () => {
    const page = await newPage();
    await page.goto(base);
    await page.setInputFiles('#file-input', path.join(repoRoot, 'tests/fixtures/tasker/LaunchInstagram.tsk.xml'));
    await page.locator('#status').filter({ hasText: 'Tasker parsed' }).waitFor();
    assert.equal(await statusText(page), EXPECT_TASKER_STATUS);
    // Cards must carry real decoded content, not just counts (the JS parser
    // itself is golden-tested against the python oracle in the unit suite).
    const html = await cardsHtml(page);
    // The plugin branch must actually decode: AutoInput chip + decoded op,
    // never the 'plugin: unknown' fallback (regression: act.plugin?.package
    // vs the IR's flat act.package made every plugin render as unknown while
    // this assertion passed vacuously off the unrepresentable-note text).
    // cardsHtml is outerHTML — the chip renders as <span class="chip plugin">AutoInput</span>.
    assert.match(html, /chip plugin">AutoInput</, 'no AutoInput chip in rendered cards');
    assert.match(html, /<code>click<\/code>/, 'AutoInput action did not decode to a click op');
    assert.doesNotMatch(html, /plugin: unknown/, 'plugin action rendered as unknown');
    assert.match(html, /WAIT/, 'no decoded builtin action name in rendered cards (code tables not applied?)');
    await page.close();
  });

  await t(`${scopeName}: drag-and-drop -> identical cards and status (V4 equality with picker)`, async () => {
    const page = await newPage();
    await page.goto(base);
    await page.setInputFiles('#file-input', path.join(repoRoot, 'tests/fixtures/tasker/LaunchInstagram.tsk.xml'));
    await page.locator('#status').filter({ hasText: 'Tasker parsed' }).waitFor();
    const pickerStatus = await statusText(page);
    const pickerCards = await cardsHtml(page);
    const pickerResults = await normalizedResults(page);
    const pickerIr = canonicalize(JSON.parse(await irOf(page)));
    assert.equal(pickerIr.source.file, 'LaunchInstagram.tsk.xml', 'picker IR lost the source basename');
    assert.deepEqual(pickerIr, goldenIr, 'picker IR does not match the python-oracle golden');
    await page.close();

    const page2 = await newPage();
    await page2.goto(base);
    await page2.evaluate((bytes) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(bytes)], 'LaunchInstagram.tsk.xml', { type: '' }));
      const drop = document.querySelector('#drop');
      drop.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true }));
      drop.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, bytesOf(FIX.tasker));
    await page2.locator('#status').filter({ hasText: 'Tasker parsed' }).waitFor();
    assert.equal(await statusText(page2), pickerStatus, 'picker and drop must produce identical status (V4)');
    assert.equal(await cardsHtml(page2), pickerCards, 'picker and drop must render identical cards (V4)');
    assert.equal(await normalizedResults(page2), pickerResults, 'picker and drop must log identical normalized results (V4)');
    const dropIr = canonicalize(JSON.parse(await irOf(page2)));
    assert.equal(dropIr.source.file, 'LaunchInstagram.tsk.xml', 'drop IR lost the source basename');
    assert.deepEqual(dropIr, pickerIr, 'picker and drop must produce identical IRs (V4)');
    await page2.close();
  });

  await t(`${scopeName}: paste box + Analyze -> identical cards and status (V4 equality)`, async () => {
    const page = await newPage();
    await page.goto(base);
    await openPasteBox(page);
    await page.fill('#paste', taskerXmlText);
    await page.click('#analyze');
    await page.locator('#status').filter({ hasText: 'Tasker parsed' }).waitFor();
    const pasteStatus = await statusText(page);
    const pasteCards = await cardsHtml(page);
    const pasteResults = await normalizedResults(page);
    const pasteIr = canonicalize(JSON.parse(await irOf(page)));
    assert.equal(pasteStatus, EXPECT_TASKER_STATUS);
    assert.equal(pasteIr.source.file, 'pasted.xml', 'paste IR has an unexpected source basename');
    assert.deepEqual(pasteIr, expectedPasteIr, 'paste IR does not match the golden (pasted.xml basename)');
    await page.close();
    // Re-run the same fixture through the picker on a clean page and compare.
    const page2 = await newPage();
    await page2.goto(base);
    await page2.setInputFiles('#file-input', path.join(repoRoot, 'tests/fixtures/tasker/LaunchInstagram.tsk.xml'));
    await page2.locator('#status').filter({ hasText: 'Tasker parsed' }).waitFor();
    assert.equal(await statusText(page2), pasteStatus, 'paste and picker must produce identical status (V4)');
    assert.equal(await cardsHtml(page2), pasteCards, 'paste and picker must render identical cards (V4)');
    assert.equal(await normalizedResults(page2), pasteResults, 'paste and picker must log identical normalized results (V4)');
    const pickerIr2 = canonicalize(JSON.parse(await irOf(page2)));
    assert.deepEqual(pickerIr2, goldenIr, 'picker IR does not match the python-oracle golden');
    assert.deepEqual(withoutSourceFile(pickerIr2), withoutSourceFile(pasteIr), 'paste and picker must produce identical IRs modulo the source basename (V4)');
    await page2.close();
  });

  await t(`${scopeName}: page-level paste (Ctrl+V) lands XML in the paste box`, async () => {
    const page = await newPage();
    await page.goto(base);
    await page.evaluate((xml) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', xml);
      window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, taskerXmlText);
    const v = await page.inputValue('#paste');
    assert.equal(v, taskerXmlText, 'page paste did not fill #paste');
    await page.locator('#status').filter({ hasText: 'Clipboard XML dropped' }).waitFor();
    await page.close();
  });

  await t(`${scopeName}: picker with multiple files ingests each`, async () => {
    const page = await newPage();
    await page.goto(base);
    await page.setInputFiles('#file-input', [
      path.join(repoRoot, 'tests/fixtures/tasker/LaunchInstagram.tsk.xml'),
      path.join(repoRoot, 'tests/fixtures/automate/1446.flo'),
    ]);
    await page.locator('#status').filter({ hasText: 'Automate flow' }).waitFor();
    const results = await page.locator('#results').textContent();
    assert.match(results, /LaunchInstagram/, 'Tasker results missing from multi-file ingest');
    assert.match(await statusText(page), /Automate flow: v\d+, \d+ statements/, 'flo not the (last) parsed file');
    await page.close();
  });

  // ---- sniffer routes through the UI --------------------------------- //

  await t(`${scopeName}: Automate .flo via picker -> T0 inventory (V2 browser half)`, async () => {
    const page = await newPage();
    await page.goto(base);
    await page.setInputFiles('#file-input', path.join(repoRoot, 'tests/fixtures/automate/1446.flo'));
    await page.locator('#status').filter({ hasText: 'Automate flow' }).waitFor();
    assert.match(await statusText(page), /Automate flow: v\d+, \d+ statements \(T0 inventory\)/);
    await page.close();
  });

  await t(`${scopeName}: PNG export -> recognized, routed to manual/vision (not parsed)`, async () => {
    const page = await newPage();
    await page.goto(base);
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])], 'flow.png', { type: '' }));
      document.querySelector('#drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await page.locator('#status').filter({ hasText: 'manual/vision mapping' }).waitFor();
    await page.close();
  });

  await t(`${scopeName}: unknown binary -> recognized, no adapter (graceful)`, async () => {
    const page = await newPage();
    await page.goto(base);
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0x99, 0x88, 0x77])], 'mystery.bin', { type: 'application/octet-stream' }));
      document.querySelector('#drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await page.locator('#status').filter({ hasText: 'no adapter yet' }).waitFor();
    await page.close();
  });

  await t(`${scopeName}: empty payload -> friendly empty-file warning`, async () => {
    const page = await newPage();
    await page.goto(base);
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(0)], 'empty.xml', { type: '' }));
      document.querySelector('#drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await page.locator('#status').filter({ hasText: 'Empty file' }).waitFor();
    await page.close();
  });

  await t(`${scopeName}: MacroDroid pass-through macro card renders with valid JSON (M3.1)`, async () => {
    const page = await newPage();
    await page.goto(base);
    await page.setInputFiles('#file-input', path.join(repoRoot, 'tests/fixtures/tasker/LaunchInstagram.tsk.xml'));
    await page.locator('#status').filter({ hasText: 'Tasker parsed' }).waitFor();
    const card = page.locator('#results .card', { hasText: 'MacroDroid macro — plugin pass-through' });
    await card.waitFor();
    // 2 plugin actions delegated, 3 builtins reported as not-yet-converted
    assert.match(await card.textContent(), /2 plugin action\(s\) delegated/);
    assert.match(await card.textContent(), /Not converted yet \(3\)/);
    assert.match(await card.textContent(), /structural check: valid/);
    // the macro JSON itself must carry the pass-through nodes
    const macroJson = await card.locator('pre.preview').textContent();
    const macro = JSON.parse(macroJson);
    assert.equal(macro.macro.m_actionList.length, 2);
    assert.ok(macro.macro.m_actionList.every((a) => a.m_classType === 'LocalePluginAction'));
    assert.equal(macro.macro.m_actionList[0].m_plugin.mReceiverClassName,
      'com.joaomgcd.autoinput.broadcastreceiver.BroadcastReceiverFire');
    // Gson importer contract: mSerializedBundle must be a numeric byte array
    // (MacroDroid's importer has no base64 adapter for byte[]; a base64
    // string silently drops the whole action on device import).
    const sb = macro.macro.m_actionList[0].m_pluginInstanceData.mSerializedBundle;
    assert.ok(Array.isArray(sb), 'mSerializedBundle must be a JSON array');
    assert.ok(sb.length > 100, 'bundle blob missing');
    assert.ok(sb.every((b) => Number.isInteger(b) && b >= 0 && b <= 255), 'bundle must be bytes');
    assert.deepEqual(sb.slice(0, 4), [0xac, 0xed, 0x00, 0x05], 'Java serialization stream magic missing');
    // in-page structural validation of the same JSON
    const verdict = await page.evaluate((json) => window.autoport.validateMacro(JSON.parse(json)), macroJson);
    assert.ok(verdict.ok, `in-page validation failed: ${JSON.stringify(verdict.errors)}`);
    // copy button hands the JSON to the clipboard
    await card.locator('summary').click();
    await card.getByRole('button', { name: 'Copy macro JSON' }).click();
    await page.locator('#status').filter({ hasText: 'Macro JSON copied' }).waitFor();
    await page.close();
  });

  await t(`${scopeName}: guarded-plugin macro renders a report-only card when nothing is emittable`, async () => {
    const page = await newPage();
    await page.goto(base);
    await page.setInputFiles('#file-input', path.join(repoRoot, 'tests/fixtures/tasker/plugins/CyanBridge_LocalAgent_Tasker.prj.xml'));
    await page.locator('#status').filter({ hasText: 'Tasker parsed' }).waitFor();
    const cards = page.locator('#results .card', { hasText: 'MacroDroid macro — plugin pass-through' });
    // Observe: 1 unguarded plugin action -> a real macro card (1 delegated)
    const emittedCard = cards.filter({ hasText: '1 plugin action(s) delegated' }).first();
    await emittedCard.waitFor();
    assert.match(await emittedCard.textContent(), /structural check: valid/);
    // Execute: every plugin action carries a Tasker If-guard -> NOTHING is
    // emittable, but the skipped list must still be surfaced (0 delegated)
    // instead of the macro silently disappearing.
    const reportCard = cards.filter({ hasText: '0 plugin action(s) delegated' }).first();
    await reportCard.waitFor();
    assert.match(await reportCard.textContent(), /Not converted yet \(12\)/);
    assert.equal(await reportCard.locator('pre.preview').count(), 0, 'no macro JSON to copy when nothing is emitted');
    await page.close();
  });

  await t(`${scopeName}: TaskerNet link paste -> CORS warning, never a blank screen (V3 browser half)`, async () => {
    const page = await newPage();
    await page.goto(base);
    await openPasteBox(page);
    await page.fill('#paste', 'https://taskernet.com/shares/d3a2f4a35c8eab2f8afdafa0a4f9e5848f5d0b7ab4bb4b9b');
    await page.click('#analyze');
    await page.locator('#status').filter({ hasText: 'TaskerNet link detected' }).waitFor();
    assert.match(await statusText(page), /paste the XML/i);
    await page.close();
  });

  // ---- inbox persistence ---------------------------------------------- //

  await t(`${scopeName}: picker ingest lands in the shared inbox; row re-parses on click`, async () => {
    const page = await newPage();
    await page.goto(base);
    await page.setInputFiles('#file-input', path.join(repoRoot, 'tests/fixtures/tasker/LaunchInstagram.tsk.xml'));
    await page.locator('#status').filter({ hasText: 'Tasker parsed' }).waitFor();
    const row = page.locator('#inbox .inbox-row').filter({ hasText: 'LaunchInstagram' }).first();
    await row.waitFor();
    // Clear the picker run's output first: the wait below must observe the
    // row's OWN re-parse, not the identical status text left over above.
    await page.evaluate(() => {
      document.querySelector('#status').textContent = '';
      document.querySelector('#results').textContent = '';
    });
    await row.click();
    await page.locator('#status').filter({ hasText: 'Tasker parsed' }).waitFor();
    await page.close();
  });

  await t(`${scopeName}: inbox survives a reload (IndexedDB persistence)`, async () => {
    const page = await newPage();
    await page.goto(base);
    await page.locator('#inbox .inbox-row').filter({ hasText: 'LaunchInstagram' }).first().waitFor();
    await page.reload();
    await page.locator('#inbox .inbox-row').filter({ hasText: 'LaunchInstagram' }).first().waitFor();
    await page.close();
  });

  // ---- share-target POST (the Android share-sheet flow) --------------- //
  // Chrome delivers an Android share as a *navigational* multipart POST to
  // the manifest's share_target action. Reproduce it exactly: build a form
  // with a programmatically-populated file input and submit() it. The SW must
  // intercept the POST, store the payload in IndexedDB and 303 to share.html.

  const shareViaForm = async (page, { name = '', type = '', bytes = null, bigSize = 0, title = '', text = '' }) => {
    await page.evaluate(({ action, name, type, bytes, bigSize, title, text }) => {
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = action;
      form.enctype = 'multipart/form-data';
      const add = (n, v) => {
        const i = document.createElement('input');
        i.type = 'hidden'; i.name = n; i.value = v;
        form.appendChild(i);
      };
      add('title', title);
      add('text', text);
      if (name) {
        const input = document.createElement('input');
        input.type = 'file'; input.name = 'share';
        const file = bigSize
          ? new File([new Uint8Array(bigSize)], name, { type }) // built in-page: no clone of a 26 MiB array
          : new File([new Uint8Array(bytes)], name, { type });
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        form.appendChild(input);
      }
      document.body.appendChild(form);
      form.submit();
    }, { action: shareUrl, name, type, bytes, bigSize, title, text });
    // The 303 lands on share.html?n=... — wait for the navigation to settle.
    await page.waitForURL((u) => u.pathname.endsWith('/share.html') && u.search.includes('n='));
  };

  await t(`${scopeName}: share POST with a Tasker file -> 303 -> share.html?n=1 (V1)`, async () => {
    const page = await newPage();
    await page.goto(base);
    await shareViaForm(page, { name: 'shared.tsk.xml', type: '', bytes: bytesOf(FIX.tasker), title: 'shared a task' });
    const u = new URL(page.url());
    assert.equal(u.searchParams.get('n'), '1', 'expected exactly one stored item');
    assert.equal(u.searchParams.get('err'), null, `unexpected err param: ${u.search}`);
    await page.locator('#banner').filter({ hasText: 'Received 1 item' }).waitFor();
    await page.close();
  });

  await t(`${scopeName}: shared file appears as an inbox card and hands off to the converter`, async () => {
    const page = await newPage();
    await page.goto(shareHtmlUrl);
    const card = page.locator('#cards .card').filter({ hasText: 'shared.tsk.xml' });
    await card.waitFor();
    assert.match(await card.locator('.pill').first().textContent(), /tasker-xml/);
    await card.getByRole('link', { name: 'Open in converter' }).click();
    await page.waitForURL((u) => u.href.startsWith(base) && /[?&]from=\d/.test(u.search));
    await page.locator('#status').filter({ hasText: 'Tasker parsed' }).waitFor();
    await page.close();
  });

  await t(`${scopeName}: share POST with a .flo -> automate-flow inbox card (V2)`, async () => {
    const page = await newPage();
    await page.goto(base);
    await shareViaForm(page, { name: 'flow.flo', type: '', bytes: bytesOf(FIX.flo) });
    const card = page.locator('#cards .card').filter({ hasText: 'flow.flo' });
    await card.waitFor();
    assert.match(await card.locator('.pill').first().textContent(), /automate-flow/);
    await card.getByRole('link', { name: 'Open in converter' }).click();
    await page.locator('#status').filter({ hasText: 'Automate flow' }).waitFor();
    await page.close();
  });

  await t(`${scopeName}: text-only TaskerNet share -> link card, no crash (V3)`, async () => {
    const page = await newPage();
    await page.goto(base);
    await shareViaForm(page, { text: 'https://taskernet.com/shares/abc123', title: 'cool macro' });
    const card = page.locator('#cards .card').filter({ hasText: 'cool macro' });
    await card.waitFor();
    assert.match(await card.locator('.pill').first().textContent(), /taskernet-link/);
    await page.close();
  });

  await t(`${scopeName}: empty share (no file, no text) -> err=empty banner`, async () => {
    const page = await newPage();
    await page.goto(base);
    await shareViaForm(page, {});
    const u = new URL(page.url());
    assert.equal(u.searchParams.get('err'), 'empty');
    await page.locator('#banner').filter({ hasText: 'no file or text attached' }).waitFor();
    await page.close();
  });

  await t(`${scopeName}: oversized share (>25 MiB) -> stored as too-large, not buffered`, async () => {
    const page = await newPage();
    await page.goto(base);
    await shareViaForm(page, { name: 'huge.bin', type: 'application/octet-stream', bigSize: 26 * 1024 * 1024 });
    const u = new URL(page.url());
    assert.equal(u.searchParams.get('err'), 'too-large');
    const card = page.locator('#cards .card').filter({ hasText: 'huge.bin' });
    await card.waitFor();
    assert.match(await card.locator('.pill').first().textContent(), /too-large/);
    assert.equal(await card.getByRole('link', { name: 'Open in converter' }).count(), 0, 'oversized card must not offer converter handoff');
    // The record must not carry the payload — only its metadata.
    const rec = await page.evaluate(async () => {
      // Reject on request errors AND on synchronous throws inside onsuccess
      // (e.g. InvalidStateError from transaction/objectStore) — and close
      // the connection once done so the read cannot leak or hang.
      const all = await new Promise((res, rej) => {
        const req = indexedDB.open('autoport');
        req.onerror = () => rej(req.error);
        req.onsuccess = () => {
          let rq;
          try {
            const db = req.result;
            rq = db.transaction('inbox', 'readonly').objectStore('inbox').getAll();
          } catch (e) { req.result.close(); rej(e); return; }
          rq.onerror = () => { req.result.close(); rej(rq.error); };
          rq.onsuccess = () => { req.result.close(); res(rq.result); };
        };
      });
      return all.find((r) => r.name === 'huge.bin');
    });
    assert.ok(rec, 'no stored record for huge.bin');
    assert.equal(rec.buf, null, 'oversized payload was buffered into IndexedDB');
    assert.equal(rec.kind, 'too-large');
    await page.close();
  });

  await t(`${scopeName}: GET /share redirects to the inbox UI (302, no POST replay)`, async () => {
    const page = await newPage();
    await page.goto(base);
    const kind = await page.evaluate(async (url) => {
      const r = await fetch(url, { redirect: 'manual' });
      return r.type; // 'opaqueredirect' when the SW answered with a redirect
    }, shareUrl);
    assert.equal(kind, 'opaqueredirect', 'GET /share did not produce a redirect response');
    // And the redirect must land on the inbox UI, not elsewhere.
    await page.goto(shareUrl);
    assert.equal(new URL(page.url()).pathname, new URL(shareHtmlUrl).pathname, 'GET /share did not land on share.html');
    await page.locator('#clear-all').waitFor();
    await page.close();
  });

  await t(`${scopeName}: clear inbox empties share.html and the converter list`, async () => {
    const page = await newPage();
    await page.goto(shareHtmlUrl);
    await page.locator('#cards .card').first().waitFor();
    await page.click('#clear-all');
    await page.locator('#empty').filter({ hasText: 'inbox is empty' }).waitFor();
    await page.goto(base);
    await page.locator('#inbox').filter({ hasText: 'Nothing shared yet' }).waitFor();
    await page.close();
  });

  // ---- offline (V5) --------------------------------------------------- //

  await t(`${scopeName}: offline after first load — shell reloads from the SW cache`, async () => {
    const page = await newPage();
    await page.goto(base);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await context.setOffline(true);
    try {
      await page.reload();
      assert.match(await page.title(), /AutoPort/);
      await page.locator('#status').filter({ hasText: 'Waiting for a file' }).waitFor();
    } finally {
      await context.setOffline(false);
    }
    await page.close();
  });

  await t(`${scopeName}: offline parse — paste XML with the network cut (V5)`, async () => {
    const page = await newPage();
    await page.goto(base);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await context.setOffline(true);
    try {
      await openPasteBox(page);
      await page.fill('#paste', taskerXmlText);
      await page.click('#analyze');
      await page.locator('#status').filter({ hasText: 'Tasker parsed' }).waitFor();
      // "5 identified" requires the code tables to come from the precache —
      // a plain parse without them would decode nothing (offline V5 gate).
      assert.equal(await statusText(page), EXPECT_TASKER_STATUS, 'offline parse failed or degraded — data files not precached?');
    } finally {
      await context.setOffline(false);
    }
    await page.close();
  });

  await t(`${scopeName}: offline share.html loads from cache`, async () => {
    const page = await newPage();
    await page.goto(shareHtmlUrl);
    await context.setOffline(true);
    try {
      await page.reload();
      await page.locator('#clear-all').waitFor();
    } finally {
      await context.setOffline(false);
    }
    await page.close();
  });

  await t(`${scopeName}: offline deep link -> cached shell served with <base> injected (no redirect loop)`, async () => {
    const page = await newPage();
    await page.goto(base);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await context.setOffline(true);
    try {
      await page.goto(base + 'no/such/deep/link');
      assert.match(await page.title(), /AutoPort/, 'offline deep link did not serve the app shell');
      const baseHref = await page.evaluate(() => document.querySelector('base')?.href || '');
      assert.equal(baseHref, base, `injected <base> ${baseHref} is not the serving scope`);
      await page.locator('#status').waitFor();
      // The deep-linked shell must be a working converter, not just markup:
      // parse the fixture while still offline from the deep-linked URL.
      await openPasteBox(page);
      await page.fill('#paste', taskerXmlText);
      await page.click('#analyze');
      await page.locator('#status').filter({ hasText: 'Tasker parsed' }).waitFor();
      assert.equal(await statusText(page), EXPECT_TASKER_STATUS, 'deep-linked shell failed to parse offline');
    } finally {
      await context.setOffline(false);
    }
    await page.close();
  });

  await t(`${scopeName}: back online after offline — everything still works`, async () => {
    const page = await newPage();
    await page.goto(base);
    await openPasteBox(page);
    await page.fill('#paste', taskerXmlText);
    await page.click('#analyze');
    await page.locator('#status').filter({ hasText: 'Tasker parsed' }).waitFor();
    await page.close();
  });
}

// --------------------------------------------------------------------- //
// main
// --------------------------------------------------------------------- //

const args = process.argv.slice(2);
const browserIdx = args.indexOf('--browser');
const channel = browserIdx !== -1 ? args[browserIdx + 1] : undefined;

const rootServer = await startServer(repoRoot);
const subDir = mkdtempSync(path.join(tmpdir(), 'autoport-e2e-'));
mkdirSync(subDir, { recursive: true });
symlinkSync(repoRoot, path.join(subDir, 'autoport'), 'dir');
const subServer = await startServer(subDir);
// Combined origin: the app served at BOTH / and /autoport/ on one origin, for
// the cross-scope service-worker cache-isolation test.
const comboDir = mkdtempSync(path.join(tmpdir(), 'autoport-e2e-combo-'));
for (const entry of readdirSync(repoRoot)) {
  if (entry === '.git' || entry === 'node_modules') continue;
  symlinkSync(path.join(repoRoot, entry), path.join(comboDir, entry));
}
symlinkSync(repoRoot, path.join(comboDir, 'autoport'), 'dir');
// a DEEPER sibling whose scope path ends with the same segment sequence
// ('/x/autoport/'): its cache names end with '/autoport/', so a buggy
// endsWith(BASE) cleanup in the /autoport/ worker would delete them.
mkdirSync(path.join(comboDir, 'x'), { recursive: true });
symlinkSync(repoRoot, path.join(comboDir, 'x', 'autoport'), 'dir');
const comboServer = await startServer(comboDir);

const rootBase = `http://127.0.0.1:${rootServer.port}/`;
const subBase = `http://127.0.0.1:${subServer.port}/autoport/`;
const comboRoot = `http://127.0.0.1:${comboServer.port}/`;
const comboSub = `http://127.0.0.1:${comboServer.port}/autoport/`;
const comboDeep = `http://127.0.0.1:${comboServer.port}/x/autoport/`;
await waitServer(rootBase);
await waitServer(subBase);
await waitServer(comboRoot);

console.log(`root scope : ${rootBase}`);
console.log(`subpath    : ${subBase}`);
console.log(`combined   : ${comboRoot} + /autoport/ (cross-scope test)`);
console.log(`browser    : ${channel || 'bundled chromium'}`);

// Launch inside the cleanup scope: if Chromium is missing/cannot start, the
// servers are still torn down instead of left listening.
let browser;
try {
  browser = await chromium.launch(channel ? { channel } : { headless: true });

  try {
    // Each scope gets its own context (different origins -> isolated SW/IDB state).
    // clipboard-write: the macro copy button test needs it on the app origin.
    const rootCtx = await browser.newContext({ permissions: ['clipboard-write', 'clipboard-read'] });
    const subCtx = await browser.newContext({ permissions: ['clipboard-write', 'clipboard-read'] });
    await runScope('root', rootBase, rootCtx);
    await runScope('subpath', subBase, subCtx);
    await rootCtx.close();
    await subCtx.close();

    /* ------------------------------------------------------------------- */
    /* Cross-scope cache isolation (same origin, sibling deployments)     */
    /* ------------------------------------------------------------------- */

    // Regression test for a real sw.js bug: the root worker's activate-time
    // cleanup matched cache names with endsWith(BASE), and for the root scope
    // (BASE === '/') a sibling /autoport/ deployment's cache names end with
    // '/' too — so the root worker DELETED the subpath caches on activation.
    await t('cross-scope: root worker activation must not delete /autoport/ caches', async () => {
      const ctx = await browser.newContext();
      // Register the subpath worker first, so its caches exist before the root
      // worker re-activates.
      const subPage = await ctx.newPage();
      await subPage.goto(comboSub);
      await subPage.waitForFunction(() => navigator.serviceWorker.controller !== null);
      await subPage.evaluate(async () => {
        // wait for the subpath precache to be populated
        const names = await caches.keys();
        const shell = names.find((n) => n.startsWith('autoport-shell-') && n.endsWith('/autoport/'));
        if (!shell) throw new Error(`no subpath shell cache: ${names}`);
      });
      await subPage.close();

      // Load + re-activate the ROOT worker (unregister + reload forces a
      // fresh install -> activate -> cleanup pass with subpath caches present).
      const rootPage = await ctx.newPage();
      await rootPage.goto(comboRoot);
      await rootPage.waitForFunction(() => navigator.serviceWorker.controller !== null);
      await rootPage.evaluate(async () => {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) await reg.unregister();
      });
      await rootPage.reload();
      await rootPage.waitForFunction(() => navigator.serviceWorker.controller !== null);

      const names = await rootPage.evaluate(async () => await caches.keys());
      const subCaches = names.filter((n) => n.endsWith('/autoport/'));
      assert.ok(subCaches.length >= 1, `root worker activation deleted the sibling /autoport/ caches: ${JSON.stringify(names)}`);
      await rootPage.close();
      await ctx.close();
    });

    // Deeper-sibling variant: the /autoport/ worker's own cleanup must not
    // delete a deeper deployment whose cache names merely END with
    // '/autoport/' ('autoport-shell-v9/x/autoport/'). The old endsWith(BASE)
    // check deleted exactly these.
    await t('cross-scope: /autoport/ worker activation must not delete deeper sibling (/x/autoport/) caches', async () => {
      const ctx = await browser.newContext();
      // Register the deep worker first so its caches exist before the
      // /autoport/ worker re-activates.
      const deepPage = await ctx.newPage();
      await deepPage.goto(comboDeep);
      await deepPage.waitForFunction(() => navigator.serviceWorker.controller !== null);
      await deepPage.evaluate(async () => {
        const names = await caches.keys();
        const shell = names.find((n) => n.startsWith('autoport-shell-') && n.endsWith('/x/autoport/'));
        if (!shell) throw new Error(`no deep sibling shell cache: ${names}`);
      });
      await deepPage.close();

      // Load + re-activate the /autoport/ worker with the deep caches present.
      const subPage = await ctx.newPage();
      await subPage.goto(comboSub);
      await subPage.waitForFunction(() => navigator.serviceWorker.controller !== null);
      await subPage.evaluate(async () => {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) await reg.unregister();
      });
      await subPage.reload();
      await subPage.waitForFunction(() => navigator.serviceWorker.controller !== null);

      const names = await subPage.evaluate(async () => await caches.keys());
      const deepCaches = names.filter((n) => n.endsWith('/x/autoport/'));
      assert.ok(deepCaches.length >= 1, `/autoport/ worker activation deleted the deeper sibling /x/autoport/ caches: ${JSON.stringify(names)}`);
      await subPage.close();
      await ctx.close();
    });
  } finally {
    await browser.close();
  }
} finally {
  rootServer.proc.kill('SIGTERM');
  subServer.proc.kill('SIGTERM');
  comboServer.proc.kill('SIGTERM');
}

console.log(`\ne2e: ${passes} passed, ${failures} failed${failedNames.length ? `\nfailed: ${failedNames.join(' | ')}` : ''}`);
process.exit(failures ? 1 : 0);
