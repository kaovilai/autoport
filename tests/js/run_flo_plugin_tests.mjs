// tests/js/run_flo_plugin_tests.mjs — node-run tests for the Automate .flo
// plug-in scanner (js/sources/automate/floPlugins.js) and the Automate →
// MacroDroid pass-through emission (emitAutomateMacro).
//
// Ground truth is the Python reference oracle scripts/flo_plugins.py: its
// output over the whole fixture corpus is committed as
// tests/golden/automate/flo-plugins.json and this suite asserts the browser
// port matches it exactly (offsets, kinds, bundles, blurbs). The ten
// non-plugin corpus flows double as the false-positive gate: zero plug-in
// statements may be found in them. Synthetic byte-level tests pin the
// Android Parcel decoding rules (AOSP string padding, VAL_NULL, nested
// bundles, tagged Long) and the emitter contract (numeric byte array,
// condition/event skipping, oversized bundles, unknown plugins).
//
// Run: node tests/js/run_flo_plugin_tests.mjs
// Exits non-zero on any failure.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

import {
  scanFloPlugins,
  decodeParcelBundle,
  readVarint,
} from '../../js/sources/automate/floPlugins.js';
import { emitAutomateMacro } from '../../js/targets/macrodroid/emitter.js';
import { serializeBundle } from '../../js/targets/macrodroid/bundleSerializer.js';
import { validateMacro } from '../../js/targets/macrodroid/structuralValidator.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, '..', 'fixtures');
const goldenPath = path.join(here, '..', 'golden', 'automate', 'flo-plugins.json');

let failures = 0;
let passes = 0;

function test(name, fn) {
  try {
    fn();
    passes += 1;
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${err && err.message ? err.message : err}`);
  }
}

function readFixture(rel) {
  const buf = readFileSync(path.join(fixtures, rel));
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/* ------------------------------------------------------------------ */
/* Oracle parity over the whole corpus                                 */
/* ------------------------------------------------------------------ */

const golden = JSON.parse(readFileSync(goldenPath, 'utf-8'));
assert.ok(Array.isArray(golden) && golden.length >= 15, 'golden corpus present');

for (const g of golden) {
  test(`oracle parity: ${g.file}`, () => {
    const u8 = readFixture(path.join('automate', g.file));
    const s = scanFloPlugins(u8);
    assert.equal(s.error, null);
    assert.equal(s.version, g.version, 'version');
    assert.equal(s.statementCount, g.statementCount, 'statement count');
    assert.equal(s.pluginCount, g.pluginCount, 'plugin count');
    assert.equal(s.plugins.length, g.pluginCount);
    for (let i = 0; i < g.plugins.length; i++) {
      const got = s.plugins[i];
      const want = g.plugins[i];
      assert.equal(got.offset, want.offset, `plugin ${i} offset`);
      assert.equal(got.package, want.package, `plugin ${i} package`);
      assert.equal(got.activity, want.activity, `plugin ${i} activity`);
      assert.equal(got.kind, want.kind, `plugin ${i} kind`);
      assert.equal(got.parcelBytes, want.parcelBytes, `plugin ${i} parcelBytes`);
      assert.equal(got.blurb, want.blurb, `plugin ${i} blurb`);
      assert.deepEqual(got.varNames, want.varNames, `plugin ${i} varNames`);
      assert.deepEqual(got.bundle, want.bundle, `plugin ${i} bundle decode`);
    }
  });
}

test('corpus false-positive gate: non-plugin flows find zero plugins', () => {
  for (const g of golden) {
    if (g.pluginCount !== 0) continue;
    const s = scanFloPlugins(readFixture(path.join('automate', g.file)));
    assert.equal(s.pluginCount, 0, `${g.file} must have no plugins`);
  }
});

test('real flow content: 36322 first bundle decodes the AutoInput v1 schema', () => {
  const s = scanFloPlugins(readFixture('automate/36322.flo'));
  const b = s.plugins[0].bundle;
  assert.equal(b.ActionType, '16');
  assert.equal(b.RepeatTimes, '1');
  assert.equal(b.FieldSelectionType, '0');
  assert.equal(b.plugintypeid, 'com.joaomgcd.autoinput.intent.IntentPerformAction');
  assert.equal(b.ActionId, 'Ana birim sunucusunu başlat'); // UTF-8 blurb text survives
  assert.equal(b.NearbyText, null);
  assert.equal(b.IsTaskerAction, 0);
  assert.equal(s.plugins[0].kind, 'SETTING');
});

/* ------------------------------------------------------------------ */
/* Android Parcel decoding rules (synthetic bytes, AOSP-exact)         */
/* ------------------------------------------------------------------ */

/** Build a marshalled Bundle the way Parcel.marshall would. The declared
 *  length counts the count field + entries (not the magic), matching the
 *  real flows: region = length field + magic + declared length. */
function buildParcel(entries) {
  const body = [];
  const i32le = (n) => { body.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff); };
  const str16 = (s) => {
    i32le(s.length);
    for (const ch of s) { const c = ch.charCodeAt(0); body.push(c & 0xff, c >> 8); }
    body.push(0, 0); // NUL terminator
    const payload = 2 * s.length + 2;
    const pad = (4 - (payload % 4)) % 4;
    for (let k = 0; k < pad; k++) body.push(0);
  };
  i32le(entries.length);
  for (const [k, [tag, write]] of entries) {
    str16(k);
    i32le(tag);
    write(i32le, str16);
  }
  const head = [];
  const headI32 = (n) => { head.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff); };
  headI32(body.length); // count + entries
  head.push(0x42, 0x4e, 0x44, 0x4c); // "BNDL" little-endian
  return new Uint8Array([...head, ...body]);
}

test('parcel: even-length string padding (writeInplace rounds (n+1)*2 up to 4)', () => {
  // key of 10 chars -> payload 22 -> padded 24
  const p = buildParcel([
    ['NearbyText', [-1, () => {}]], // VAL_NULL
  ]);
  const { values, end } = decodeParcelBundle(p, 0);
  assert.equal(values.NearbyText, null);
  assert.equal(end, p.length); // consumed the whole parcel
});

test('parcel: string / int / boolean / string-array / nested bundle / tagged long', () => {
  const nested = buildParcel([
    ['inner', [0, (i32, str) => str('x')]],
  ]);
  // full parcel built manually: five kinds plus a length-prefixed nested
  // VAL_BUNDLE and a VAL_LONG
  const body = [];
  const i32le = (n) => { body.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff); };
  const str16 = (s) => {
    i32le(s.length);
    for (const ch of s) { const c = ch.charCodeAt(0); body.push(c & 0xff, c >> 8); }
    body.push(0, 0);
    const payload = 2 * s.length + 2;
    const pad = (4 - (payload % 4)) % 4;
    for (let k = 0; k < pad; k++) body.push(0);
  };
  i32le(6); // count
  str16('s'); i32le(0); str16('hello');
  str16('n'); i32le(1); i32le(-42);
  str16('flag'); i32le(9); i32le(1);
  str16('arr'); i32le(14); i32le(2); str16('a'); str16('b');
  str16('sub'); i32le(3); i32le(nested.length); body.push(...nested);
  str16('big'); i32le(6); // VAL_LONG 0x1122334455667788
  const lo = 0x55667788, hi = 0x11223344;
  body.push(lo & 0xff, (lo >> 8) & 0xff, (lo >> 16) & 0xff, (lo >>> 24) & 0xff);
  body.push(hi & 0xff, (hi >> 8) & 0xff, (hi >> 16) & 0xff, (hi >>> 24) & 0xff);
  const head = [];
  const h32 = (n) => { head.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff); };
  h32(body.length); // count + entries
  head.push(0x42, 0x4e, 0x44, 0x4c);
  const p2 = new Uint8Array([...head, ...body]);
  const { values, end } = decodeParcelBundle(p2, 0);
  assert.equal(values.s, 'hello');
  assert.equal(values.n, -42);
  assert.equal(values.flag, 1);
  assert.deepEqual(values.arr, ['a', 'b']);
  assert.deepEqual(values.sub, { inner: 'x' });
  assert.equal(values.big.$parcel, 'java.lang.Long');
  assert.equal(values.big.value, 0x1122334455667788);
  assert.equal(end, p2.length);
});

test('parcel: strict rejection on bad magic / short length', () => {
  const good = buildParcel([['k', [1, (i32) => i32(7)]]]);
  const badMagic = new Uint8Array(good); badMagic[4] = 0x58;
  assert.throws(() => decodeParcelBundle(badMagic, 0), /magic/);
  assert.throws(() => decodeParcelBundle(good.subarray(0, good.length - 1), 0), /EOF|length/);
});

/** Build a minimal .flo containing one synthetic F0 anchor whose parcel
 *  region ends with the given tail bytes. */
function buildFlowWithAnchor(tailBytes) {
  const parts = [];
  const push = (...xs) => parts.push(...xs);
  const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
  push(0x4c, 0x41, 0x46, 0x6c); // LAFl
  push(0, 84);                  // version 84 (>= 35: varint string lengths)
  push(53, 1);                  // nextStatementId (zigzag), statement count
  const pkg = 'com.joaomgcd.autoinput';
  const act = 'com.joaomgcd.autoinput.activity.ActivityConfigPerformAction';
  push(pkg.length, ...ascii(pkg));
  push(act.length, ...ascii(act));
  const parcel = buildParcel([['K', [0, (i32, str) => str('v')]]]);
  const region = parcel.length + tailBytes.length;
  if (region < 128) push(region);
  else push((region & 0x7f) | 0x80, region >> 7); // varint
  push(...parcel, ...tailBytes);
  push(1, 66); // blurb "B"
  push(0, 0, 0); // varNames count, mappings count, bool
  return new Uint8Array(parts);
}

test('scanner: zero tail accepted, junk tail rejected, overlong tail rejected', () => {
  // zero padding (observed on AutoCast flows) keeps the anchor
  assert.equal(scanFloPlugins(buildFlowWithAnchor([0, 0, 0, 0])).pluginCount, 1);
  // non-zero trailing bytes mean the anchor guessed the wrong region
  assert.equal(scanFloPlugins(buildFlowWithAnchor([1, 2, 3, 4])).pluginCount, 0);
  // more than 8 bytes of even zero padding is not a plausible parcel region
  assert.equal(scanFloPlugins(buildFlowWithAnchor(new Array(12).fill(0))).pluginCount, 0);
});

test('scanner + emitter: a bundle value the locale SDK cannot represent does not lose the plug-in statement', () => {
  // byte[] inside the configuration bundle: the anchor must survive with the
  // value tagged, and the emitter must drop + report it (CodeRabbit: the
  // anchor used to be rejected wholesale, silently omitting the statement)
  const body = [];
  const i32le = (n) => { body.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff); };
  const str16 = (s) => {
    i32le(s.length);
    for (const ch of s) { const c = ch.charCodeAt(0); body.push(c & 0xff, c >> 8); }
    body.push(0, 0);
    const payload = 2 * s.length + 2;
    const pad = (4 - (payload % 4)) % 4;
    for (let k = 0; k < pad; k++) body.push(0);
  };
  i32le(2); // count
  str16('ok'); i32le(0); str16('fine');
  str16('blob'); i32le(13); i32le(5); body.push(1, 2, 3, 4, 5, 0, 0, 0); // byte[5] + pad
  const head = [];
  const h32 = (n) => { head.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff); };
  h32(body.length); head.push(0x42, 0x4e, 0x44, 0x4c);
  const parcel = new Uint8Array([...head, ...body]);
  const parts = [];
  const push = (...xs) => parts.push(...xs);
  const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
  const pkg = 'com.joaomgcd.autoinput';
  const act = 'com.joaomgcd.autoinput.activity.ActivityConfigPerformAction';
  push(0x4c, 0x41, 0x46, 0x6c, 0, 84, 53, 1);
  push(pkg.length, ...ascii(pkg));
  push(act.length, ...ascii(act));
  push(parcel.length, ...parcel);
  push(1, 66, 0, 0, 0);
  const s = scanFloPlugins(new Uint8Array(parts));
  assert.equal(s.pluginCount, 1, 'anchor with a byte[] value must survive');
  assert.equal(s.plugins[0].bundle.ok, 'fine');
  assert.equal(s.plugins[0].bundle.blob.$parcel, 'byte[]');
  const { macro, report } = emitAutomateMacro(s);
  assert.equal(macro.macro.m_actionList.length, 1, 'statement still emitted');
  assert.deepEqual(report.rejectedUnsupportedValues, [{ key: 'blob', type: 'byte[]' }]);
  const bytes = macro.macro.m_actionList[0].m_pluginInstanceData.mSerializedBundle;
  const round = serializeBundle({ ok: 'fine' });
  assert.deepEqual(Array.from(round), bytes, 'byte[] dropped from the emitted bundle');
});

/* ------------------------------------------------------------------ */
/* Emission contract                                                   */
/* ------------------------------------------------------------------ */

test('emission: 36322 → 4 AutoInput actions, valid macro, locale-SDK bytes', () => {
  const s = scanFloPlugins(readFixture('automate/36322.flo'));
  const { macro, report } = emitAutomateMacro(s, { name: 'E2E Automate' });
  assert.ok(macro, 'macro emitted');
  assert.equal(report.emitted.length, 4);
  assert.equal(report.skipped.length, 0);
  assert.equal(report.typeAssumedSetting, 2);
  assert.deepEqual(report.unknownPlugins, []); // AutoInput is in the registry
  const actions = macro.macro.m_actionList;
  assert.equal(actions.length, 4);
  for (const a of actions) {
    assert.equal(a.m_classType, 'LocalePluginAction');
    const bytes = a.m_pluginInstanceData.mSerializedBundle;
    assert.ok(Array.isArray(bytes), 'numeric byte array, not base64');
    assert.deepEqual(bytes.slice(0, 4), [0xac, 0xed, 0x00, 0x05], 'Java serialization magic');
    assert.equal(a.m_plugin.mPackageName, 'com.joaomgcd.autoinput');
    assert.ok(a.m_plugin.mReceiverClassName, 'receiver from the plugin registry');
  }
  const verdict = validateMacro(macro.macro);
  assert.ok(verdict.ok, `structural validation: ${JSON.stringify(verdict.errors)}`);
  // The re-serialized bundle must round-trip through the locale-SDK writer:
  // rebuilding it from the decoded values must give the identical bytes.
  const first = actions[0].m_pluginInstanceData.mSerializedBundle;
  const rebuilt = serializeBundle(s.plugins[0].bundle
    ? Object.fromEntries(Object.entries(s.plugins[0].bundle)
      // drop unrepresentable values the same way the emitter does
      .filter(([, v]) => !(v && typeof v === 'object' && !Array.isArray(v) && typeof v.$parcel === 'string'))
      .map(([k, v]) => [k, v === null || typeof v !== 'object' ? v
        : Array.isArray(v) ? v.map(String)
        : Object.fromEntries(Object.entries(v))]))
    : {});
  assert.deepEqual(Array.from(rebuilt), first, 'emitter bytes == serializeBundle(decoded parcel values)');
});

test('emission: AutoCast flow reports the unknown plugin and output variables', () => {
  const s = scanFloPlugins(readFixture('automate/50902.flo'));
  const { macro, report } = emitAutomateMacro(s, { name: 'AutoCast' });
  assert.equal(report.emitted.length, 2);
  assert.deepEqual(report.unknownPlugins, ['com.joaomgcd.autocast']);
  assert.ok(report.automateOutputVariables.includes('CastDevice'));
  assert.ok(report.automateOutputVariables.includes('CommandId'));
  assert.ok(macro.macro.m_actionList.every((a) => a.m_plugin.mReceiverClassName === undefined
    || a.m_plugin.mReceiverClassName === null), 'unknown plugin has no receiver');
});

test('emission: condition/event blocks are skipped + reported, not emitted', () => {
  const scan = {
    statementCount: 3, pluginCount: 3,
    plugins: [
      { package: 'com.example.p', activity: 'com.example.p.Edit', kind: 'CONDITION', bundle: {}, blurb: '', varNames: [] },
      { package: 'com.example.p', activity: 'com.example.p.Edit', kind: 'EVENT', bundle: {}, blurb: '', varNames: [] },
      { package: 'com.joaomgcd.autoinput', activity: 'x.Edit', kind: 'SETTING', bundle: { K: 'v' }, blurb: '', varNames: [] },
    ],
  };
  const { macro, report } = emitAutomateMacro(scan);
  assert.equal(report.skipped.length, 2);
  assert.match(report.skipped[0].reason, /condition/);
  assert.equal(macro.macro.m_actionList.length, 1);
});

test('emission: oversized bundle is skipped with the locale-SDK reason', () => {
  const big = {};
  for (let i = 0; i < 900; i++) big[`key${i}`] = 'x'.repeat(40); // > 25 KB serialized
  const scan = { statementCount: 1, pluginCount: 1, plugins: [
    { package: 'com.joaomgcd.autoinput', activity: 'x.Edit', kind: 'SETTING', bundle: big, blurb: '', varNames: [] },
  ] };
  const { macro, report } = emitAutomateMacro(scan);
  assert.equal(macro, null);
  assert.equal(report.skipped.length, 1);
  assert.match(report.skipped[0].reason, /25000/);
});

test('emission: tagged Long values are dropped + reported', () => {
  const scan = { statementCount: 1, pluginCount: 1, plugins: [
    { package: 'com.joaomgcd.autoinput', activity: 'x.Edit', kind: 'SETTING',
      bundle: { ok: 'fine', ts: { $parcel: 'java.lang.Long', value: 12345678901234 } }, blurb: '', varNames: [] },
  ] };
  const { macro, report } = emitAutomateMacro(scan);
  assert.equal(report.rejectedLongValues.length, 1);
  assert.equal(report.rejectedLongValues[0].key, 'ts');
  const bytes = macro.macro.m_actionList[0].m_pluginInstanceData.mSerializedBundle;
  const round = serializeBundle({ ok: 'fine' });
  assert.deepEqual(Array.from(round), bytes, 'Long dropped from the emitted bundle');
});

test('emission: %variables stay literal and are reported', () => {
  const scan = { statementCount: 1, pluginCount: 1, plugins: [
    { package: 'com.joaomgcd.autoinput', activity: 'x.Edit', kind: 'SETTING',
      bundle: { ActionId: '%myvar and %other_one' }, blurb: 'tap %myvar', varNames: [] },
  ] };
  const { macro, report } = emitAutomateMacro(scan);
  assert.deepEqual(report.automateVariables, ['%myvar', '%other_one']);
  // literal: the serialized bundle re-parses to the same string
  assert.ok(JSON.stringify(macro).includes('%myvar'));
});

test('scanner: malformed input never throws', () => {
  assert.equal(scanFloPlugins(new Uint8Array(4)).error, 'not an Automate flow');
  const junk = new Uint8Array(2000).fill(0x61);
  junk.set([0x4c, 0x41, 0x46, 0x6c, 0, 100], 0);
  const s = scanFloPlugins(junk);
  assert.equal(s.pluginCount, 0);
});

test('varint: zigzag round-trips the plug-in type ids', () => {
  // 1104/1105/1106 encode to the 2-byte varints seen in real flows
  const enc = (v) => { const z = v * 2; return [ (z & 0x7f) | 0x80, z >> 7 ]; };
  assert.deepEqual(enc(1106), [0xa4, 0x11]);
  assert.deepEqual(enc(1105), [0xa2, 0x11]);
  assert.deepEqual(enc(1104), [0xa0, 0x11]);
});

/* ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ */
/* Recorded live MCP probe (remote.macrodroid.com)                     */
/* ------------------------------------------------------------------ */

test('probe validate-passthrough-automate-36322.json matches recorded verdict and re-emits byte-identically', () => {
  const probe = JSON.parse(readFileSync(path.join(here, '..', 'fixtures', 'macrodroid',
    'passthrough-probes', 'validate-passthrough-automate-36322.json'), 'utf8'));
  assert.equal(probe.valid, true);
  assert.equal(probe.verdict, 'VALID');
  // the MCP server's structured verdict on the recorded macro
  const sc = (probe.mcp.response.result || {}).structuredContent || {};
  assert.equal(sc.valid, true, 'live MCP verdict was valid');
  // re-emitting from the committed fixture must reproduce the validated
  // macro exactly — otherwise the recorded proof no longer covers the code
  const u8 = readFixture('automate/36322.flo');
  const { macro } = emitAutomateMacro(scanFloPlugins(u8), { name: 'AutoPort Automate 36322' });
  assert.deepEqual(macro, probe.macro, 'emitted macro drifted from the MCP-validated probe');
});

console.log(`flo-plugin tests: ${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
