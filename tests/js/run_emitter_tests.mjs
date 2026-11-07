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

await test('typedBundle: [{$array:[...]}] single-element wrapper normalizes to String[]', () => {
  const raw = { 'arr': [{$array: ['a', 'b']}], 'arr-type': '[Ljava.lang.String;' };
  assert.deepEqual(typedBundle(raw), { arr: ['a', 'b'] });
});

await test('typedBundle: java.lang.Long values are rejected and reported, never mangled', () => {
  const report = { rejectedLongValues: [] };
  const raw = { 'ok': '1', 'ok-type': 'java.lang.Integer', 'big': '9999999999', 'big-type': 'java.lang.Long' };
  const out = typedBundle(raw, report);
  assert.deepEqual(out, { ok: 1 }, 'Long-typed key must be dropped');
  assert.deepEqual(report.rejectedLongValues, [{ key: 'big', value: '9999999999' }]);
});

await test('translateVars: whole-name boundaries, local/global magic text, builtins stay literal', () => {
  const report = { variablesUsed: new Set(), unresolvedVariables: new Set(), builtinVariables: new Set() };
  const vars = { local: ['%msg', '%errmsg'], global: ['%EnMaasKey'] };
  const out = translateVars('fail:%errmsg key:%EnMaasKey msg:%msg builtin:%err', vars, report);
  // %errmsg is a Tasker BUILTIN (last action error message) even when the
  // parser collected it as a local — it must stay literal, not become magic
  // text that would read an unrelated MacroDroid local.
  assert.equal(out, 'fail:%errmsg key:{v=EnMaasKey} msg:{lv=msg} builtin:%err');
  assert.deepEqual([...report.variablesUsed].sort(), ['%EnMaasKey', '%msg']);
  assert.deepEqual([...report.unresolvedVariables].sort(), ['%err', '%errmsg'], 'Tasker builtins must be flagged, not translated');
});

await test('translateVars: %msg must not match inside %errmsg (name boundary)', () => {
  const report = { variablesUsed: new Set(), unresolvedVariables: new Set(), builtinVariables: new Set() };
  const out = translateVars('only %msg here', { local: ['%msg', '%errmsg'], global: [] }, report);
  assert.equal(out, 'only {lv=msg} here');
  // %errmsg in the variables list but never referenced -> not "used"
  assert.deepEqual([...report.variablesUsed], ['%msg']);
  // and the prefix case: %errmsg text with only %msg known must stay literal
  const r2 = { variablesUsed: new Set(), unresolvedVariables: new Set(), builtinVariables: new Set() };
  assert.equal(translateVars('x %errmsg', { local: ['%msg'], global: [] }, r2), 'x %errmsg');
  assert.deepEqual([...r2.unresolvedVariables], ['%errmsg']);
});

await test('translateVars: single-char local %h must not match inside %http_data', () => {
  const report = { variablesUsed: new Set(), unresolvedVariables: new Set(), builtinVariables: new Set() };
  const out = translateVars('read %http_data into %h', { local: ['%h'], global: [] }, report);
  assert.equal(out, 'read %http_data into {lv=h}', '%http_data must stay literal');
  assert.deepEqual([...report.variablesUsed], ['%h']);
  assert.deepEqual([...report.unresolvedVariables], ['%http_data'], 'the unknown longer name must be reported, not silently corrupted');
});

await test('translateVars: variablesUsed only records actual replacements', () => {
  const report = { variablesUsed: new Set(), unresolvedVariables: new Set(), builtinVariables: new Set() };
  translateVars('nothing to see', { local: ['%msg'], global: [] }, report);
  assert.equal(report.variablesUsed.size, 0, 'unreferenced variable must not count as used');
});

await test('translateVars: Tasker builtins are never translated even when collected as locals', () => {
  const report = { variablesUsed: new Set(), unresolvedVariables: new Set(), builtinVariables: new Set() };
  const out = translateVars('err=%err msg=%errmsg', { local: ['%err', '%errmsg'], global: [] }, report);
  assert.equal(out, 'err=%err msg=%errmsg', 'builtins must stay literal (runtime values live in Tasker)');
  assert.equal(report.variablesUsed.size, 0);
  assert.deepEqual([...report.unresolvedVariables].sort(), ['%err', '%errmsg']);
});

await test('translateStringValues: nested bundles keep %vars literal and are reported', () => {
  const irMacro = {
    name: 'nested',
    variables: { local: ['%q'], global: [] },
    actions: [{
      kind: 'plugin', code: 2000, codeName: 'PLUGIN(com.joaomgcd.autoinput)', sr: 'act0',
      package: 'com.joaomgcd.autoinput', pluginClass: 'com.joaomgcd.autoinput.activity.ActivityConfigActionv2',
      args: { arg0: { $bundle: {
        'top': '%q', 'top-type': 'java.lang.String',
        'sub': { $bundle: { 'inner': '%q and %err' } }, 'sub-type': 'android.os.Bundle',
      } } },
    }],
  };
  const { macro, report } = emitMacro(irMacro);
  assert.ok(macro, 'macro must be emitted');
  const bytes = Buffer.from(macro.macro.m_actionList[0].m_pluginInstanceData.mSerializedBundle);
  const text = bytes.toString('latin1');
  assert.ok(text.includes('{lv=q}'), 'top-level string must be translated');
  assert.ok(text.includes('%q and %err'), 'nested bundle must keep %vars literal');
  assert.ok(report.unresolvedVariables.includes('%q'), 'nested %q reported');
  assert.ok(report.unresolvedVariables.includes('%err'), 'nested builtin %err reported');
  assert.deepEqual(report.variablesUsed, ['%q'], 'only the top-level use counts as used');
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
  // Gson importer contract: byte[] MUST be a numeric array, not base64
  const sb = a.m_pluginInstanceData.mSerializedBundle;
  assert.ok(Array.isArray(sb), 'mSerializedBundle must be a JSON array (Gson byte[])');
  assert.ok(sb.length > 100, 'bundle blob missing');
  assert.ok(sb.every((b) => Number.isInteger(b) && b >= 0 && b <= 255), 'bundle must be bytes');
  // and it must decode to the JVM-verified bundle format (magic AC ED 00 05)
  assert.deepEqual(sb.slice(0, 4), [0xac, 0xed, 0x00, 0x05], 'Java serialization stream magic missing');
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

await test('emitMacros: v2 fixture plugin nested inside If blocks is skipped, not run unconditionally', async () => {
  const xml = readFileSync(path.join(repoRoot, 'tests/fixtures/tasker/plugins/CyanBridge_ChatGPT.xml'), 'utf8');
  const stats = {};
  const ir = await parseTaskerXml(xml, { codes: tables, parseXml, stats, file: 'CyanBridge_ChatGPT.xml' });
  const { emissions } = emitMacros(ir);
  assert.equal(emissions.length, 1);
  const { macro, report } = emissions[0];
  // act7 (the AutoInput v2 action) sits inside IF(act0) > IF(act5) > IF(act6):
  // emitting it without the enclosing control flow would run it unconditionally.
  assert.equal(macro, null, 'block-enclosed plugin action must not be emitted');
  const blockSkips = report.skipped.filter((s) => /If\/For block/.test(s.reason));
  assert.equal(blockSkips.length, 1, 'the block-enclosed plugin must be reported');
  assert.equal(blockSkips[0].sr, 'act7');
});

await test('emitMacro: v2 bundle translates %vars; JSON-encoded parameters are flagged', () => {
  const irMacro = {
    name: 'v2',
    variables: { local: ['%question'], global: [] },
    actions: [{
      kind: 'plugin', code: 2000, codeName: 'PLUGIN(com.joaomgcd.autoinput)', sr: 'act0',
      package: 'com.joaomgcd.autoinput', pluginClass: 'com.joaomgcd.autoinput.activity.ActivityConfigActionv2',
      args: { arg0: { $bundle: {
        'com.twofortyfouram.locale.intent.extra.BLURB': 'Ask %question',
        'com.twofortyfouram.locale.intent.extra.BLURB-type': 'java.lang.String',
        'parameters': '{"text":"%question"}', 'parameters-type': 'java.lang.String',
        'net.dinglisch.android.tasker.JSON_ENCODED_KEYS': 'parameters',
        'net.dinglisch.android.tasker.JSON_ENCODED_KEYS-type': 'java.lang.String',
      } } },
    }],
  };
  const { macro, report } = emitMacro(irMacro);
  assert.ok(macro, 'macro must be emitted');
  assert.deepEqual(report.variablesUsed, ['%question']);
  assert.ok(macro.macro.localVariables.some((v) => v.m_name === 'question'), 'variable must be declared');
  const text = Buffer.from(macro.macro.m_actionList[0].m_pluginInstanceData.mSerializedBundle).toString('latin1');
  assert.ok(text.includes('{lv=question}'), 'bundle must carry magic text');
  assert.ok(!text.includes('%question'), 'raw %question must not remain');
  // Tasker JSON-escapes values in JSON_ENCODED_KEYS at runtime; MacroDroid
  // does plain replacement — surface the risk instead of hiding it.
  assert.deepEqual(report.jsonEncodedTranslations, ['parameters']);
});

await test('emitMacro: plugin action with a Tasker If-guard is skipped and reported', () => {
  const irMacro = {
    name: 'guarded',
    variables: { local: [], global: [] },
    actions: [{
      kind: 'plugin', code: 2000, codeName: 'PLUGIN(com.joaomgcd.autoinput)', sr: 'act0',
      package: 'com.joaomgcd.autoinput', pluginClass: 'com.joaomgcd.autoinput.activity.ActivityConfigPerformAction',
      condition: { left: '%x', op: 'eq', right: '1' },
      args: { arg0: { $bundle: { 'com.twofortyfouram.locale.intent.extra.BLURB': 'hi', 'com.twofortyfouram.locale.intent.extra.BLURB-type': 'java.lang.String' } } },
    }],
  };
  const { macro, report } = emitMacro(irMacro);
  assert.equal(report.emitted.length, 0, 'guarded plugin action must not be emitted');
  assert.equal(report.skipped.length, 1);
  assert.match(report.skipped[0].reason, /guard/i);
  assert.equal(macro.macro.m_actionList.length, 0);
});

await test('emitMacro: over-25000-byte plugin bundle is skipped and reported', () => {
  const big = 'x'.repeat(26000);
  const irMacro = {
    name: 'big',
    variables: { local: [], global: [] },
    actions: [{
      kind: 'plugin', code: 2000, codeName: 'PLUGIN(com.joaomgcd.autoinput)', sr: 'act0',
      package: 'com.joaomgcd.autoinput', pluginClass: 'com.joaomgcd.autoinput.activity.ActivityConfigPerformAction',
      args: { arg0: { $bundle: { 'big': big, 'big-type': 'java.lang.String' } } },
    }],
  };
  const { macro, report } = emitMacro(irMacro);
  assert.equal(report.emitted.length, 0, 'oversized bundle must not be emitted');
  assert.equal(report.skipped.length, 1);
  assert.match(report.skipped[0].reason, /25000/);
  assert.equal(macro.macro.m_actionList.length, 0);
});

await test('emitMacro: Tasker globals used by the macro are reported as external prerequisites', () => {
  const irMacro = {
    name: 'globals',
    variables: { local: [], global: ['%EnMaasKey'] },
    actions: [{
      kind: 'plugin', code: 2000, codeName: 'PLUGIN(com.joaomgcd.autoinput)', sr: 'act0',
      package: 'com.joaomgcd.autoinput', pluginClass: 'com.joaomgcd.autoinput.activity.ActivityConfigPerformAction',
      args: { arg0: { $bundle: {
        'key': '%EnMaasKey', 'key-type': 'java.lang.String',
        'com.twofortyfouram.locale.intent.extra.BLURB': 'key %EnMaasKey',
        'com.twofortyfouram.locale.intent.extra.BLURB-type': 'java.lang.String',
      } } },
    }],
  };
  const { macro, report } = emitMacro(irMacro);
  assert.equal(report.emitted.length, 1);
  assert.deepEqual(report.globalVariablesRequired, ['EnMaasKey']);
  assert.deepEqual(macro.macro.globalVariables.map((v) => v.m_name), ['EnMaasKey']);
  assert.deepEqual(macro.macro.localVariables, [], 'global must not be declared local');
});

await test('emitMacros: one broken macro does not take down the rest (per-macro try/catch)', () => {
  const ir = { macros: [
    Object.defineProperty({ name: 'throws' }, 'actions', {
      get() { throw new Error('bad IR'); },
    }),
    { name: 'fine', variables: { local: [], global: [] }, actions: [] },
  ] };
  const { emissions } = emitMacros(ir);
  assert.equal(emissions.length, 2);
  assert.equal(emissions[0].macro, null);
  assert.match(emissions[0].report.error, /bad IR/);
  assert.equal(emissions[1].macro, null);
  assert.equal(emissions[1].report.note, 'no plugin actions — macro not emitted');
});

await test('emitMacro: plugin action disabled in the source task (<on>false</on>) is skipped', () => {
  const irMacro = {
    name: 'disabled',
    variables: { local: [], global: [] },
    actions: [{
      kind: 'plugin', code: 2000, codeName: 'PLUGIN(com.joaomgcd.autoinput)', sr: 'act0',
      package: 'com.joaomgcd.autoinput', pluginClass: 'com.joaomgcd.autoinput.activity.ActivityConfigPerformAction',
      args: { on: 'false', arg0: { $bundle: { 'k': 'v', 'k-type': 'java.lang.String' } } },
    }],
  };
  const { macro, report } = emitMacro(irMacro);
  assert.equal(report.emitted.length, 0, 'disabled action must not be emitted');
  assert.equal(report.skipped.length, 1);
  assert.match(report.skipped[0].reason, /disabled in the source task/);
  assert.equal(macro.macro.m_actionList.length, 0);
});

await test('emitMacro: plugin actions inside Tasker If/For blocks are skipped, outside ones emitted', () => {
  const plugin = (sr) => ({
    kind: 'plugin', code: 2000, codeName: 'PLUGIN(com.joaomgcd.autoinput)', sr,
    package: 'com.joaomgcd.autoinput', pluginClass: 'com.joaomgcd.autoinput.activity.ActivityConfigPerformAction',
    args: { arg0: { $bundle: { 'k': 'v', 'k-type': 'java.lang.String' } } },
  });
  const irMacro = {
    name: 'blocks',
    variables: { local: [], global: [] },
    actions: [
      { kind: 'builtin', code: 37, codeName: 'IF', sr: 'act0' },
      plugin('act1'),                                   // inside IF -> skip
      { kind: 'builtin', code: 40, codeName: 'FOR', sr: 'act2' },
      plugin('act3'),                                   // inside IF+FOR -> skip
      { kind: 'builtin', code: 41, codeName: 'ENDFOR', sr: 'act4' },
      { kind: 'builtin', code: 39, codeName: 'ENDIF', sr: 'act5' },
      plugin('act6'),                                   // outside -> emit
    ],
  };
  const { macro, report } = emitMacro(irMacro);
  assert.equal(report.emitted.length, 1, 'only the action outside the block is emitted');
  assert.equal(report.emitted[0].sr, 'act6');
  const blockSkips = report.skipped.filter((s) => /If\/For block/.test(s.reason));
  assert.deepEqual(blockSkips.map((s) => s.sr), ['act1', 'act3']);
});

await test('emitMacro: block tracking follows numeric sr order, not document order', () => {
  // Utils' "Unlock Screen": document order is act0,act1,act10..act14,act2..
  // which would put ENDFOR(act10) before IF(act2). The parser now sorts by
  // numeric sr, so every AutoInput action in that macro is inside IF(act2)
  // and must be skipped (running them unconditionally would unlock the
  // screen / tap without its guard).
  const utilsIr = JSON.parse(readFileSync(path.join(repoRoot, 'tests/golden/tasker/tasker-Utils.prj.ir.json'), 'utf8'));
  const m = utilsIr.macros.find((x) => x.name === 'Unlock Screen');
  assert.ok(m, 'Unlock Screen macro missing from the golden');
  const { macro, report } = emitMacro(m);
  assert.equal(macro.macro.m_actionList.length, 0, 'all Unlock Screen plugin actions are inside the IF block');
  assert.equal(report.skipped.filter((s) => /If\/For block/.test(s.reason)).length, 6);
});

await test('typedBundle: unsupported type companions are rejected and reported', () => {
  const report = { rejectedLongValues: [], rejectedUnsupportedValues: [] };
  const raw = {
    'keep': 'x', 'keep-type': 'java.lang.String',
    'f': '1.5', 'f-type': 'java.lang.Float',
    'd': '2.5', 'd-type': 'java.lang.Double',
  };
  assert.deepEqual(typedBundle(raw, report), { keep: 'x' });
  assert.deepEqual(report.rejectedUnsupportedValues, [
    { key: 'f', type: 'java.lang.Float' },
    { key: 'd', type: 'java.lang.Double' },
  ]);
});

await test('translateVars: builtins match EXACT case; user %Time still translates', () => {
  const report = { variablesUsed: new Set(), unresolvedVariables: new Set(), builtinVariables: new Set() };
  const out = translateVars('now %TIME user %Time', { local: [], global: ['%TIME', '%Time'] }, report);
  assert.equal(out, 'now %TIME user {v=Time}', 'builtin %TIME literal, user %Time translated');
  assert.deepEqual([...report.variablesUsed], ['%Time']);
  assert.deepEqual([...report.builtinVariables], ['%TIME']);
  const r2 = { variablesUsed: new Set(), unresolvedVariables: new Set(), builtinVariables: new Set() };
  assert.equal(translateVars('loc %LOC wifi %WIFII', { local: [], global: ['%LOC', '%WIFII'] }, r2),
    'loc %LOC wifi %WIFII', '%LOC and %WIFII are documented builtins');
  assert.deepEqual([...r2.builtinVariables].sort(), ['%LOC', '%WIFII']);
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
