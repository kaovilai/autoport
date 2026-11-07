// tests/js/run_emitter_tests.mjs — M3.1 plugin pass-through tests.
//
// Covers the three layers of Tasker-plugin -> MacroDroid LocalePluginAction
// pass-through:
//   1. javaObjectStream/bundleSerializer: byte-for-byte parity with a
//      JVM-generated reference (scripts/josref/GenRef.java mirrors the
//      decompiled MacroDroid BundleSerializer). Reference vectors include
//      REAL AutoInput v1/v2 bundles, nested bundles, UTF-8 edge cases,
//      String[] and null values, and JVM identity dedup (Boolean singletons,
//      the Integer.valueOf cache).
//   2. typedBundle / translateVars reconstruction from the IR's raw
//      flattened Vals.
//   3. emitMacro/emitMacros: the LocalePluginAction node contract, the
//      conversion report, variable translation, structural validation, and
//      parity with the recorded MCP probe (the emitted LaunchInstagram macro
//      must equal the one the live MacroDroid MCP server validated).
//
// Run: node tests/js/run_emitter_tests.mjs
// The JVM reference is committed; regenerating it requires a JDK:
//   javac scripts/josref/GenRef.java -d /tmp/josref
//   java -cp /tmp/josref GenRef > tests/fixtures/macrodroid/jos-reference.json
// (CI regenerates and diffs it as a drift gate.)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

import { JavaObjectOutputStream, modifiedUtf8 } from '../../js/targets/macrodroid/javaObjectStream.js';
import { serializeBundle, serializeBundleB64 } from '../../js/targets/macrodroid/bundleSerializer.js';
import { typedBundle, translateVars, emitMacro, emitMacros } from '../../js/targets/macrodroid/emitter.js';
import { validateMacro } from '../../js/targets/macrodroid/structuralValidator.js';
import { parseTaskerXml } from '../../js/sources/tasker/taskerXml.js';
import { parseXml } from './xmlShim.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..');
const refPath = path.join(repoRoot, 'tests/fixtures/macrodroid/jos-reference.json');
const tables = JSON.parse(readFileSync(path.join(repoRoot, 'data/taskerCodes.json'), 'utf8'));

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
/* 1. byte-for-byte parity with the JVM reference                      */
/* ------------------------------------------------------------------ */

const REF = JSON.parse(readFileSync(refPath, 'utf8'));

const tagToValue = (t) => {
  if (t.t === 's') return t.v;
  if (t.t === 'b') return t.v;
  if (t.t === 'i') return t.v;
  if (t.t === 'n') return null;
  if (t.t === 'sa') return t.v;
  if (t.t === 'B') {
    const o = {};
    for (const [k, v] of Object.entries(t.v)) o[k] = tagToValue(v);
    return o;
  }
  throw new Error(`bad tag ${t.t}`);
};

for (const v of REF.vectors) {
  await test(`JVM byte parity: ${v.name}`, () => {
    const bundle = {};
    for (const [k, t] of Object.entries(v.bundle)) bundle[k] = tagToValue(t);
    assert.equal(serializeBundleB64(bundle), v.blob, 'serialized bytes differ from the JVM reference');
  });
}

await test('JVM reference fixture covers the real AutoInput v1+v2 bundles', () => {
  const names = REF.vectors.map((v) => v.name);
  assert.ok(names.includes('autoinput_v1_real'), 'v1 vector missing');
  assert.ok(names.includes('autoinput_v2_real'), 'v2 vector missing');
});

await test('modified UTF-8: NUL and supplementary code points', () => {
  assert.deepEqual(modifiedUtf8('a\u0000b'), [0x61, 0xc0, 0x80, 0x62]);
  // U+1F446 (pointing down) = surrogate pair -> two 3-byte sequences
  assert.deepEqual(modifiedUtf8('\u{1F446}'), [0xed, 0xa0, 0xbd, 0xed, 0xb1, 0x86]);
  assert.deepEqual(modifiedUtf8('é'), [0xc3, 0xa9]);
});

await test('emitted blobs stay under the 25 KB plugin bundle limit', () => {
  for (const v of REF.vectors) {
    assert.ok(v.blob.length * 0.75 <= 25000, `${v.name} exceeds the locale SDK MAXIMUM_BUNDLE_SIZE_BYTES`);
  }
});

/* ------------------------------------------------------------------ */
/* 2. typedBundle + translateVars                                      */
/* ------------------------------------------------------------------ */

await test('typedBundle: -type companions drive Boolean/Integer/null/array/nested', () => {
  const raw = {
    'a-string': 'x', 'a-string-type': 'java.lang.String',
    'a-bool': 'true', 'a-bool-type': 'java.lang.Boolean',
    'a-bool2': 'false', 'a-bool2-type': 'java.lang.Boolean',
    'an-int': '42', 'an-int-type': 'java.lang.Integer',
    'a-null': '<null>', 'a-null-type': 'java.lang.String',
    'an-array': { $array: ['x', 'y'] }, 'an-array-type': '[Ljava.lang.String;',
    'a-sub': { $bundle: { 'inner': 'v' } }, 'a-sub-type': 'android.os.Bundle',
  };
  assert.deepEqual(typedBundle(raw), {
    'a-string': 'x', 'a-bool': true, 'a-bool2': false, 'an-int': 42,
    'a-null': null, 'an-array': ['x', 'y'], 'a-sub': { inner: 'v' },
  });
});

await test('translateVars: longest-first, local/global magic text, unresolved flagged', () => {
  const report = { variablesUsed: new Set(), unresolvedVariables: new Set() };
  const vars = { local: ['%msg', '%errmsg'], global: ['%EnMaasKey'] };
  const out = translateVars('fail:%errmsg key:%EnMaasKey msg:%msg builtin:%err', vars, report);
  assert.equal(out, 'fail:{lv=errmsg} key:{v=EnMaasKey} msg:{lv=msg} builtin:%err');
  assert.deepEqual([...report.variablesUsed].sort(), ['%EnMaasKey', '%errmsg', '%msg']);
  assert.deepEqual([...report.unresolvedVariables], ['%err'], 'Tasker builtins must be flagged, not translated');
});

/* ------------------------------------------------------------------ */
/* 3. emission                                                         */
/* ------------------------------------------------------------------ */

const launchIr = JSON.parse(readFileSync(path.join(repoRoot, 'tests/golden/tasker/tasker-LaunchInstagram.tsk.ir.json'), 'utf8'));

await test('emitMacro: LaunchInstagram -> 2 LocalePluginAction nodes, 3 skipped builtins', () => {
  const { macro, report } = emitMacro(launchIr.macros[0], { sourceFile: 'LaunchInstagram.tsk.xml' });
  assert.equal(macro.macro.m_actionList.length, 2);
  assert.ok(macro.macro.m_actionList.every((a) => a.m_classType === 'LocalePluginAction'));
  assert.equal(report.skipped.length, 3, 'LOAD_APP + 2 WAIT are M3.2, reported');
  assert.equal(report.emitted.length, 2);
  assert.equal(report.unknownPlugins.length, 0);
  const a = macro.macro.m_actionList[0];
  assert.equal(a.m_plugin.mPackageName, 'com.joaomgcd.autoinput');
  assert.equal(a.m_plugin.mActivityClassName, 'com.joaomgcd.autoinput.activity.ActivityConfigPerformAction');
  assert.equal(a.m_plugin.mReceiverClassName, 'com.joaomgcd.autoinput.broadcastreceiver.BroadcastReceiverFire');
  assert.equal(a.m_plugin.mRegistryName, 'com.joaomgcd.autoinput:com.joaomgcd.autoinput.activity.ActivityConfigPerformAction');
  assert.equal(a.m_plugin.mVersionCode, 104);
  assert.equal(a.m_pluginInstanceData.mBlurb, 'Type: Id\nValue: com.instagram.android:id/icon_view\nAction : Click');
  assert.ok(a.m_pluginInstanceData.mSerializedBundle.length > 100, 'bundle blob missing');
  assert.equal(a.blockActions, true, 'plugin actions must block to preserve Tasker order');
});

await test('emitMacro: emitted macro passes the structural validator', () => {
  const { macro } = emitMacro(launchIr.macros[0]);
  const v = validateMacro(macro);
  assert.ok(v.ok, `structural validation failed: ${JSON.stringify(v.errors)}`);
});

await test('emitMacro: parity with the recorded MCP probe (live-validated macro)', () => {
  const probe = JSON.parse(readFileSync(
    path.join(repoRoot, 'tests/fixtures/macrodroid/passthrough-probes/validate-passthrough-launchinstagram.json'), 'utf8'));
  const { macro } = emitMacro(launchIr.macros[0], { sourceFile: 'LaunchInstagram.tsk.xml' });
  assert.deepEqual(macro, probe.macro, 'emission drifted from the macro the live MacroDroid MCP validated');
});

await test('emitMacros: v2 DSL fixture translates %variables and declares them', async () => {
  const xml = readFileSync(path.join(repoRoot, 'tests/fixtures/tasker/plugins/CyanBridge_ChatGPT.xml'), 'utf8');
  const stats = {};
  const ir = await parseTaskerXml(xml, { codes: tables, parseXml, stats, file: 'CyanBridge_ChatGPT.xml' });
  const { emissions } = emitMacros(ir);
  assert.equal(emissions.length, 1);
  const { macro, report } = emissions[0];
  assert.ok(macro, 'macro must be emitted');
  assert.ok(report.emitted.length >= 1);
  assert.ok(report.variablesUsed.includes('%question'), '%question must be translated');
  assert.deepEqual([...report.unresolvedVariables], [], 'no unresolved vars expected in this fixture');
  const declared = macro.macro.localVariables.map((v) => v.m_name);
  for (const used of report.variablesUsed) {
    assert.ok(declared.includes(used.replace(/^%+/, '')), `variable ${used} used but not declared`);
  }
  assert.ok(validateMacro(macro).ok);
  // the translated bundle must mention the magic text, not the Tasker var
  const action = macro.macro.m_actionList[0];
  const decoded = Buffer.from(action.m_pluginInstanceData.mSerializedBundle, 'base64').toString('latin1');
  assert.ok(decoded.includes('{lv=question}'), 'bundle must carry {lv=question} magic text');
  assert.ok(!decoded.includes('%question'), 'raw %question must not remain in the bundle');
});

await test('emitMacro: unknown plugin package is reported, node still emitted', () => {
  const irMacro = {
    name: 'x',
    variables: { local: [], global: [] },
    actions: [{
      kind: 'plugin', code: 2000, codeName: 'PLUGIN(com.example.other)', sr: 'act0', ve: '7',
      package: 'com.example.other', pluginClass: 'com.example.other.Edit',
      args: { arg0: { $bundle: { 'com.twofortyfouram.locale.intent.extra.BLURB': 'hi', 'com.twofortyfouram.locale.intent.extra.BLURB-type': 'java.lang.String' } } },
    }],
  };
  const { macro, report } = emitMacro(irMacro);
  assert.equal(report.unknownPlugins.length, 1);
  assert.equal(report.unknownPlugins[0], 'com.example.other');
  assert.equal(macro.macro.m_actionList[0].m_plugin.mReceiverClassName, null, 'unknown plugin has no receiver');
  assert.ok(validateMacro(macro).ok);
});

await test('emitMacros: IR macro without plugin actions emits nothing', () => {
  const { emissions } = emitMacros({ macros: [{ name: 'no plugins', variables: { local: [], global: [] }, actions: [{ kind: 'builtin', code: 30, codeName: 'WAIT', sr: 'act0' }] }] });
  assert.equal(emissions.length, 1);
  assert.equal(emissions[0].macro, null);
  assert.ok(emissions[0].report.note);
});

await test('javaObjectStream: unsupported types are rejected loudly', () => {
  const oos = new JavaObjectOutputStream();
  oos.writeInt(1);
  assert.throws(() => oos.writeObject(3.14), /unsupported value type/);
  assert.throws(() => oos.writeInt(3.5), /not a 32-bit integer/);
});

console.log(`\nemitter tests: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
