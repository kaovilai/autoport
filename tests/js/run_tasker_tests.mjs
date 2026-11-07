// tests/js/run_tasker_tests.mjs — node-run tests for the Tasker XML -> IR port.
//
// Differential gate: for every tests/fixtures/tasker/*.xml that has a matching
// tests/golden/tasker/tasker-<stem>.ir.json, parse with the JS parser (using the
// strict xmlShim instead of DOMParser) and deep-compare key-order-insensitively
// against the Python oracle's golden output.
//
// Also asserts the graceful error contract (empty / truncated / malformed /
// DOCTYPE / ENTITY / non-Tasker input) and the xmlShim / actionCodes primitives.
//
// Run: node tests/js/run_tasker_tests.mjs
// Exits non-zero on any failure.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

import { parseTaskerXml, parseTaskerXmlSync, parseTaskerTree, toXmlText, stripNs, domToTree } from '../../js/sources/tasker/taskerXml.js';
import { CodeTable, loadCodeTables, loadActionCodes, CODES_URL } from '../../js/sources/tasker/actionCodes.js';
import { parseXml } from './xmlShim.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const testsDir = path.join(here, '..');
const repoRoot = path.join(testsDir, '..');
const fixtureDir = path.join(testsDir, 'fixtures', 'tasker');
const goldenDir = path.join(testsDir, 'golden', 'tasker');

const tables = JSON.parse(readFileSync(path.join(repoRoot, 'data', 'taskerCodes.json'), 'utf8'));

let passes = 0;
let failures = 0;

async function test(name, fn) {
  try {
    await fn();
    passes += 1;
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${err && err.message ? err.message : err}`);
  }
}

/* ------------------------------------------------------------------ */
/* Key-order-insensitive recursive equality                            */
/* ------------------------------------------------------------------ */

function diff(a, b, at = '$') {
  if (a === b) return null;
  if (a === null || b === null) return `${at}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`;
  const ta = typeof a;
  const tb = typeof b;
  if (ta !== tb) return `${at}: type ${ta} !== ${tb}`;
  if (ta !== 'object') return `${at}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return `${at}: array vs non-array`;
    if (a.length !== b.length) return `${at}: length ${a.length} !== ${b.length}`;
    for (let i = 0; i < a.length; i += 1) {
      const d = diff(a[i], b[i], `${at}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  const aset = new Set(ak);
  const bset = new Set(bk);
  for (const k of ak) if (!bset.has(k)) return `${at}: unexpected key "${k}"`;
  for (const k of bk) if (!aset.has(k)) return `${at}: missing key "${k}"`;
  for (const k of ak) {
    const d = diff(a[k], b[k], `${at}.${k}`);
    if (d) return d;
  }
  return null;
}

function assertSameIr(actual, expected, label) {
  const d = diff(actual, expected);
  assert.equal(d, null, `${label}: ${d}`);
}

function assertErrorIr(ir, expectedKind, label) {
  assert.equal(typeof ir, 'object', `${label}: result must be an object`);
  assert.deepEqual(ir.macros, [], `${label}: error IR must have macros: []`);
  assert.equal(ir.source.app, 'tasker', `${label}: source.app`);
  assert.equal(typeof ir.source.file, 'string', `${label}: source.file`);
  assert.equal(ir.source.taskerVersion, null, `${label}: fresh error IR has no version`);
  assert.ok(ir.error && typeof ir.error === 'object', `${label}: missing error object`);
  assert.equal(ir.error.kind, expectedKind, `${label}: error.kind`);
  assert.equal(typeof ir.error.message, 'string', `${label}: error.message`);
  assert.ok(ir.error.message.length > 0, `${label}: empty error.message`);
}

function readFixtureBytes(rel) {
  const buf = readFileSync(path.join(fixtureDir, rel));
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

const opts = (file) => ({ file, tables, parseXml });

/* ------------------------------------------------------------------ */
/* 1. Differential gate: fixtures with goldens                         */
/* ------------------------------------------------------------------ */

const fixtureFiles = readdirSync(fixtureDir).filter((f) => f.endsWith('.xml')).sort();
const goldenFiles = readdirSync(goldenDir).filter((f) => f.endsWith('.ir.json')).sort();
const compared = [];

for (const file of fixtureFiles) {
  const stem = file.slice(0, -'.xml'.length);
  const goldenPath = path.join(goldenDir, `tasker-${stem}.ir.json`);
  if (!existsSync(goldenPath)) continue;
  compared.push(file);

  await test(`golden IR equality: ${file}`, async () => {
    const golden = JSON.parse(readFileSync(goldenPath, 'utf8'));
    const stats = {};
    const ir = await parseTaskerXml(readFixtureBytes(file), { ...opts(file), stats });
    assert.equal(ir.error, undefined, `unexpected error IR: ${JSON.stringify(ir.error)}`);
    assertSameIr(ir, golden, file);

    // The oracle's --stats output is also golden; compare parser counters,
    // derived totals and the corpus-wide variable set.
    const statsPath = goldenPath.replace(/\.ir\.json$/, '.stats.json');
    if (existsSync(statsPath)) {
      const gs = JSON.parse(readFileSync(statsPath, 'utf8'));
      for (const k of [
        'actionsTotal',
        'actionsDecoded',
        'actionsPlugin',
        'actionsUnknown',
        'contextsTotal',
        'contextsDecoded',
        'contextsUnknown',
        'unrepresentable',
      ]) {
        assertSameIr(stats[k], gs[k], `${file} stats.${k}`);
      }
      assert.equal(gs.fixture, file, `${file} stats.fixture`);
      assert.equal(gs.macros, ir.macros.length, `${file} stats.macros`);
      assert.equal(
        gs.actions,
        ir.macros.reduce((n, m) => n + m.actions.length, 0),
        `${file} stats.actions`
      );
      assert.equal(
        gs.triggers,
        ir.macros.reduce((n, m) => n + m.triggers.length, 0),
        `${file} stats.triggers`
      );
      const locals = new Set();
      const globals = new Set();
      for (const m of ir.macros) {
        for (const v of m.variables.local) locals.add(v);
        for (const v of m.variables.global) globals.add(v);
      }
      assertSameIr(
        { local: [...locals].sort(), global: [...globals].sort() },
        gs.variableCount,
        `${file} stats.variableCount`
      );
    }
  });
}

await test('differential corpus has at least 10 golden-mapped fixtures (V6)', () => {
  assert.ok(compared.length >= 10, `only ${compared.length} fixtures compared`);
});

await test('every golden has a source fixture', () => {
  for (const g of goldenFiles) {
    const stem = g.slice('tasker-'.length, -'.ir.json'.length);
    assert.ok(
      existsSync(path.join(fixtureDir, `${stem}.xml`)),
      `golden ${g} has no tests/fixtures/tasker/${stem}.xml`
    );
  }
});

/* ------------------------------------------------------------------ */
/* 2. Input encodings: bytes, ArrayBuffer, BOM                         */
/* ------------------------------------------------------------------ */

await test('Uint8Array input + UTF-8 BOM matches the golden', async () => {
  const file = 'LaunchInstagram.tsk.xml';
  const golden = JSON.parse(readFileSync(path.join(goldenDir, 'tasker-LaunchInstagram.tsk.ir.json'), 'utf8'));
  const body = readFixtureBytes(file);
  const withBom = new Uint8Array(body.length + 3);
  withBom.set([0xef, 0xbb, 0xbf], 0);
  withBom.set(body, 3);
  const ir = await parseTaskerXml(withBom, opts(file));
  assertSameIr(ir, golden, 'BOM-prefixed bytes');
});

await test('ArrayBuffer input matches the golden', async () => {
  const file = 'LaunchInstagram.tsk.xml';
  const golden = JSON.parse(readFileSync(path.join(goldenDir, 'tasker-LaunchInstagram.tsk.ir.json'), 'utf8'));
  const body = readFixtureBytes(file);
  const ab = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
  const ir = await parseTaskerXml(ab, opts(file));
  assertSameIr(ir, golden, 'ArrayBuffer');
});

await test('BOM in string input is stripped', () => {
  assert.equal(toXmlText('﻿<TaskerData/>'), '<TaskerData/>');
});

await test('stripNs mirrors the oracle (Clark notation only)', () => {
  assert.equal(stripNs('{http://x}Action'), 'Action');
  assert.equal(stripNs('Action'), 'Action');
});

/* ------------------------------------------------------------------ */
/* 3. Graceful error contract                                          */
/* ------------------------------------------------------------------ */

await test('empty input -> parse error IR', async () => {
  assertErrorIr(await parseTaskerXml('', opts('empty.xml')), 'parse', 'empty');
});

await test('truncated root element -> parse error IR', async () => {
  assertErrorIr(await parseTaskerXml('<TaskerData sr="" dvi="1">', opts('cut.xml')), 'parse', 'truncated root');
});

await test('truncated task -> parse error IR', async () => {
  const xml = '<TaskerData tv="6.0"><Task sr="task1"><id>1</id><Action sr="act0"><code>30</code>';
  assertErrorIr(await parseTaskerXml(xml, opts('cut-task.xml')), 'parse', 'truncated task');
});

await test('mismatched closing tag -> parse error IR', async () => {
  const xml = '<TaskerData><Task></TaskerData></TaskerData>';
  assertErrorIr(await parseTaskerXml(xml, opts('bad.xml')), 'parse', 'mismatch');
});

await test('garbage input -> parse error IR', async () => {
  assertErrorIr(await parseTaskerXml('not xml at all', opts('garbage.xml')), 'parse', 'garbage');
});

await test('DOCTYPE -> doctype error IR (refused before parsing)', async () => {
  const xml = '<!DOCTYPE TaskerData [<!ELEMENT TaskerData ANY>]><TaskerData tv="1"></TaskerData>';
  assertErrorIr(await parseTaskerXml(xml, opts('doctype.xml')), 'doctype', 'doctype');
});

await test('ENTITY declaration -> doctype error IR', async () => {
  const xml = '<!ENTITY boom "boom"><TaskerData tv="1"></TaskerData>';
  assertErrorIr(await parseTaskerXml(xml, opts('entity.xml')), 'doctype', 'entity');
});

await test('well-formed non-Tasker XML -> not-tasker error IR', async () => {
  const ir = await parseTaskerXml('<SomethingElse tv="1"><x/></SomethingElse>', opts('other.xml'));
  assertErrorIr(ir, 'not-tasker', 'not-tasker');
  assert.match(ir.error.message, /not a TaskerData document: SomethingElse/);
});

await test('error IR keeps the basename of the source file', async () => {
  const ir = await parseTaskerXml('<nope/>', { file: '/some/dir/thing.tsk.xml', tables, parseXml });
  assert.equal(ir.source.file, 'thing.tsk.xml');
});

await test('truncation of every prefix never throws and degrades gracefully', async () => {
  const full = readFileSync(path.join(fixtureDir, 'enmaas-glm-ask.tsk.xml'), 'utf8');
  for (let n = 0; n <= full.length; n += 7) {
    const part = full.slice(0, n);
    let ir;
    try {
      ir = await parseTaskerXml(part, opts('prefix.tsk.xml'));
    } catch (err) {
      assert.fail(`threw at prefix length ${n}: ${err && err.message}`);
    }
    assert.equal(typeof ir, 'object', `non-object at prefix length ${n}`);
    assert.ok(Array.isArray(ir.macros), `macros not an array at prefix length ${n}`);
    if (ir.error) {
      assert.deepEqual(ir.macros, [], `error IR with macros at prefix length ${n}`);
      assert.ok(typeof ir.error.kind === 'string', `error.kind at prefix length ${n}`);
    }
  }
});

/* ------------------------------------------------------------------ */
/* 4. Oracle edge fixture (no golden file; asserted inline)            */
/* ------------------------------------------------------------------ */

const BACKUP_EDGE_EXPECTED = {
  source: { app: 'tasker', file: 'backup-edge-cases.xml', taskerVersion: '6.7.0-beta' },
  macros: [
    {
      name: 'Profile prof901',
      triggers: [
        {
          family: 'event',
          code: 231,
          codeName: 'unknown (code 231)',
          args: { arg0: 0 },
          sr: 'con0',
          ve: '2',
        },
        {
          family: 'day',
          code: null,
          codeName: 'DAY',
          args: { mon: 'true', tue: 'false' },
          sr: 'con1',
          ve: null,
        },
      ],
      actions: [
        {
          kind: 'unknown',
          code: 471,
          codeName: 'unknown (code 471)',
          args: { arg0: '%neverSeen' },
          sr: 'act0',
          ve: '7',
        },
        {
          kind: 'builtin',
          code: 30,
          codeName: 'WAIT',
          args: { arg0: 0, arg1: 3, arg2: 0, arg3: 0, arg4: 0 },
          sr: 'act1',
          ve: '7',
        },
        {
          kind: 'plugin',
          code: 999999,
          codeName: 'PLUGIN(com.example.plugin)',
          args: {
            arg1: 'com.example.plugin',
            arg2: 'com.example.plugin.Config',
            arg0: { $bundle: { flag: 'true', 'flag-type': 'java.lang.Boolean' } },
          },
          sr: 'act2',
          ve: '7',
          package: 'com.example.plugin',
          pluginClass: 'com.example.plugin.Config',
        },
      ],
      variables: { local: ['%neverSeen'], global: [] },
      taskIds: ['900'],
      kind: 'profile',
      meta: {},
      profileId: '901',
      enabled: null,
      sr: 'prof901',
    },
  ],
};

const BACKUP_EDGE_STATS = {
  actionsTotal: 3,
  actionsDecoded: 1,
  actionsPlugin: 1,
  actionsUnknown: 1,
  contextsTotal: 2,
  contextsDecoded: 1,
  contextsUnknown: 1,
  unrepresentable: [
    "unknown action code '471' at act0/0",
    'plugin bundle action code=999999 package=com.example.plugin: inner extras kept raw, no semantic op decode (AutoInput decoder is a separate workstream)',
    'unknown event context code 231 (agent may be a plugin context)',
    'scene element <Scene> not represented in IR (no scene target in Phase 1)',
    'scene element <SceneElement> not represented in IR (no scene target in Phase 1)',
  ],
};

await test('backup-edge-cases: unknown/plugin/Day/Scene/Data handling (inline oracle)', async () => {
  const stats = {};
  const ir = await parseTaskerXml(readFixtureBytes('backup-edge-cases.xml'), {
    file: 'backup-edge-cases.xml',
    tables,
    parseXml,
    stats,
  });
  assertSameIr(ir, BACKUP_EDGE_EXPECTED, 'backup-edge-cases');
  assertSameIr(stats, BACKUP_EDGE_STATS, 'backup-edge-cases stats');
});

await test('backup-edge-cases: midK folding emits the task exactly once', async () => {
  const ir = await parseTaskerXml(readFixtureBytes('backup-edge-cases.xml'), opts('backup-edge-cases.xml'));
  assert.equal(ir.macros.length, 1, 'only the profile macro (task 900 folded, scene not a macro)');
  assert.equal(ir.macros[0].taskIds[0], '900');
});

/* ------------------------------------------------------------------ */
/* 5. xmlShim correctness                                              */
/* ------------------------------------------------------------------ */

await test('xmlShim: comments/PIs do not become nodes and do not end .text', () => {
  const root = parseXml('<a sx="1"><!-- c -->pre<?pi x?>post<b>kid</b>tail</a>');
  assert.equal(root.tagName, 'a');
  assert.equal(root.attributes.sx, '1');
  assert.equal(root.children.length, 1);
  assert.equal(root.text, 'prepost');
  assert.equal(root.children[0].text, 'kid');
  assert.equal(root.children[0].children.length, 0);
});

await test('xmlShim: entities are decoded (predefined + numeric)', () => {
  const root = parseXml('<a t="&lt;x&gt; &amp; &apos;q&apos; &quot;d&quot; &#65; &#x42;">&lt;null&gt;</a>');
  assert.equal(root.attributes.t, '<x> & \'q\' "d" A B');
  assert.equal(root.text, '<null>');
});

await test('xmlShim: unknown entity is refused', () => {
  assert.throws(() => parseXml('<a>&nbsp;</a>'), /undefined entity/);
});

await test('xmlShim: CDATA is character data, not markup', () => {
  const root = parseXml('<a><![CDATA[<b>&amp;</b>]]></a>');
  assert.equal(root.text, '<b>&amp;</b>');
});

await test('xmlShim: self-closing element has null text', () => {
  const root = parseXml('<a><b/></a>');
  assert.equal(root.children[0].text, null);
});

await test('xmlShim: DOCTYPE / ENTITY declarations are refused', () => {
  assert.throws(() => parseXml('<!DOCTYPE a><a/>'), (e) => e.kind === 'doctype');
  assert.throws(() => parseXml('<!ENTITY x "y"><a/>'), (e) => e.kind === 'doctype');
});

await test('xmlShim: malformed structures are refused', () => {
  assert.throws(() => parseXml('<a><b></a>'), /mismatched closing tag/);
  assert.throws(() => parseXml('<a/><b/>'), /unexpected content after root/);
  assert.throws(() => parseXml('<a x=1/>'), /unquoted attribute/);
  assert.throws(() => parseXml('<a x="1" x="2"/>'), /duplicate attribute/);
  assert.throws(() => parseXml('<a>'), /unclosed <a>/);
  assert.throws(() => parseXml(''), /empty document/);
  assert.throws(() => parseXml('text'), /expected '<'/);
});

await test('domToTree adapts a DOM-like node to the walker shape', () => {
  // Minimal stand-in for a DOM Element (nodeType 1) with text/comment/element kids.
  const text = (v) => ({ nodeType: 3, nodeValue: v });
  const comment = (v) => ({ nodeType: 8, nodeValue: v });
  const el = (tag, attrs, kids) => ({ nodeType: 1, tagName: tag, localName: tag, attributes: attrs.map(([k, v]) => ({ name: k, value: v })), childNodes: kids });
  const node = domToTree(el('Task', [['sr', 'task1']], [text('pre'), comment('c'), el('id', [], [text('1')]), text('tail')]));
  assert.equal(node.tagName, 'Task');
  assert.deepEqual({ ...node.attributes }, { sr: 'task1' });
  assert.equal(node.text, 'pre');
  assert.equal(node.children.length, 1);
  assert.equal(node.children[0].tagName, 'id');
  assert.equal(node.children[0].text, '1');
});

await test('no parser available in Node yields a graceful parse error IR', async () => {
  const ir = await parseTaskerXml('<TaskerData tv="1"></TaskerData>', { file: 'noparser.tsk.xml', tables });
  assertErrorIr(ir, 'parse', 'no parser');
  assert.match(ir.error.message, /no XML parser available/);
});

await test('unsupported input type yields a graceful parse error IR', async () => {
  assertErrorIr(await parseTaskerXml(null, opts('bad-input.xml')), 'parse', 'null input');
  assertErrorIr(await parseTaskerXml(42, opts('bad-input.xml')), 'parse', 'numeric input');
});

/* ------------------------------------------------------------------ */
/* 6. actionCodes: injected tables > embedded fetch default            */
/* ------------------------------------------------------------------ */

await test('CodeTable resolves names through byCode', () => {
  const ct = new CodeTable(tables);
  assert.equal(ct.lookup('actions', 20), 'LOAD_APP');
  assert.equal(ct.lookup('actions', 30), 'WAIT');
  assert.equal(ct.lookup('action', 30), null, 'unknown family -> null');
  assert.equal(ct.lookup('event', 208), 'SCREEN_ON');
  assert.equal(ct.lookup('state', 160), 'WIFI_CONNECT');
  assert.equal(ct.lookup('actions', 471), null);
  assert.equal(ct.lookup('actions', null), null);
  assert.equal(ct.firstPluginCode('actions'), 1000);
  assert.equal(ct.firstPluginCode('events'), 10000);
});

await test('empty CodeTable defaults FIRST_PLUGIN_CODE to 1000', () => {
  const ct = new CodeTable({});
  assert.equal(ct.firstPluginCode('actions'), 1000);
  assert.equal(ct.lookup('actions', 20), null);
});

await test('loadCodeTables fetches the injected URL and wraps it', async () => {
  let seen = null;
  const fakeFetch = async (url) => {
    seen = url;
    return { ok: true, status: 200, json: async () => tables };
  };
  const ct = await loadCodeTables('mem://taskerCodes.json', fakeFetch);
  assert.equal(seen, 'mem://taskerCodes.json');
  assert.equal(ct.lookup('actions', 547), 'SET_VARIABLE');
});

await test('loadCodeTables defaults to the module-relative data URL', () => {
  assert.match(CODES_URL, /\/data\/taskerCodes\.json$/);
});

await test('loadCodeTables surfaces HTTP failures', async () => {
  const fakeFetch = async () => ({ ok: false, status: 404 });
  await assert.rejects(() => loadCodeTables('mem://missing.json', fakeFetch), /HTTP 404/);
});

await test('loadActionCodes accepts an injected tables object (tests) and a URL', async () => {
  const injected = await loadActionCodes(tables);
  assert.ok(injected instanceof CodeTable);
  assert.equal(injected.lookup('actions', 20), 'LOAD_APP');

  const already = new CodeTable(tables);
  assert.equal(await loadActionCodes(already), already, 'existing table passes through');

  let seen = null;
  const prev = globalThis.fetch;
  globalThis.fetch = async (url) => { seen = url; return { ok: true, status: 200, json: async () => tables }; };
  try {
    const viaUrl = await loadActionCodes('mem://codes.json');
    assert.equal(seen, 'mem://codes.json');
    assert.equal(viaUrl.lookup('event', 208), 'SCREEN_ON');
  } finally {
    globalThis.fetch = prev;
  }
});

await test('parseTaskerXml auto-loads tables via global fetch when none injected', async () => {
  const prev = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => tables });
  try {
    const xml = '<TaskerData tv="6.0"><Task sr="task1"><id>1</id><nme>N</nme>' +
      '<Action sr="act0" ve="7"><code>30</code><Int sr="arg0" val="5"/></Action></Task></TaskerData>';
    const ir = await parseTaskerXml(xml, { file: 'auto.tsk.xml', parseXml });
    assert.equal(ir.error, undefined);
    assert.equal(ir.macros.length, 1);
    assert.equal(ir.macros[0].actions[0].codeName, 'WAIT');
  } finally {
    globalThis.fetch = prev;
  }
});

/* ------------------------------------------------------------------ */
/* 7. Synchronous core + programmatic shapes                           */
/* ------------------------------------------------------------------ */

await test('parseTaskerTree walks an injected simple tree synchronously', () => {
  const root = parseXml('<TaskerData tv="6.6"><Task sr="task7"><id>7</id><nme>Hi</nme>' +
    '<Action sr="act0"><code>547</code><Str sr="arg0" ve="3">%xy</Str></Action></Task></TaskerData>');
  const ir = parseTaskerTree(root, { codes: tables, file: 'x.tsk.xml', parseXml });
  assert.equal(ir.source.taskerVersion, '6.6');
  assert.equal(ir.macros[0].name, 'Hi');
  assert.deepEqual(ir.macros[0].variables, { local: ['%xy'], global: [] });
});

await test('Int-with-var expression -> $var (not a literal)', () => {
  const root = parseXml('<TaskerData tv="6.6"><Task sr="task1"><id>1</id><nme>V</nme>' +
    '<Action sr="act0"><code>130</code><Str sr="arg0">T</Str><Int sr="arg1"><var>%priority+1</var></Int></Action>' +
    '</Task></TaskerData>');
  const ir = parseTaskerTree(root, { codes: tables, file: 'v.tsk.xml', parseXml });
  assert.deepEqual(ir.macros[0].actions[0].args.arg1, { $var: '%priority+1' });
  assert.deepEqual(ir.macros[0].variables.local, ['%priority']);
});

await test('parseTaskerXmlSync matches the golden without a Promise', () => {
  const file = 'LaunchInstagram.tsk.xml';
  const golden = JSON.parse(readFileSync(path.join(goldenDir, 'tasker-LaunchInstagram.tsk.ir.json'), 'utf8'));
  const ir = parseTaskerXmlSync(readFixtureBytes(file), opts(file));
  assert.equal(typeof ir.then, 'undefined', 'sync entry point must not return a Promise');
  assertSameIr(ir, golden, 'sync');
});

await test('parseTaskerXmlSync without tables yields an error IR, not a throw', () => {
  assertErrorIr(parseTaskerXmlSync('<TaskerData tv="1"></TaskerData>', { file: 'x.xml', parseXml }), 'unknown', 'no tables');
});

/* ------------------------------------------------------------------ */

console.log(`\nrun_tasker_tests: ${passes} passed, ${failures} failed (${compared.length} golden fixtures)`);
if (failures > 0) process.exit(2);
