// tests/js/run_autoinput_tests.mjs
// Node test harness for js/sources/tasker/pluginAutoInput.js.
// Run: node tests/js/run_autoinput_tests.mjs   (exit 0 = pass, non-zero = fail)
//
// Contract under test: decodeAutoInput(bundleVals) returns
// {op, selector, gesture, options} with a non-empty op, or op:'unknown' with an
// explicit options.reason. Every real AutoInput plugin action in
// tests/golden/tasker/*.ir.json must decode without throwing.

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  decodeAutoInput,
  splitActionCalls,
  parsePoint,
  PLUGIN_TYPES,
} from '../../js/sources/tasker/pluginAutoInput.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const goldenDir = path.join(repoRoot, 'tests/golden/tasker');

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.error(`FAIL  ${name}`);
    console.error(`      ${String(err && err.message ? err.message : err).split('\n').join('\n      ')}`);
  }
}

async function readJson(absPath) {
  return JSON.parse(await readFile(absPath, 'utf8'));
}

/** Depth-first walk over an IR document, visiting every plain object. */
function walk(obj, cb) {
  if (Array.isArray(obj)) {
    for (const v of obj) walk(v, cb);
    return;
  }
  if (obj && typeof obj === 'object') {
    cb(obj);
    for (const v of Object.values(obj)) walk(v, cb);
  }
}

const AUTOINPUT = 'com.joaomgcd.autoinput';

function isAutoInputPluginAction(a) {
  if (!a || a.kind !== 'plugin') return false;
  const pkg = a.package || (a.args && a.args.arg1) || null;
  return typeof pkg === 'string' && pkg.toLowerCase().startsWith(AUTOINPUT);
}

function assertSane(result, label) {
  assert.ok(result && typeof result === 'object', `${label}: decoder returned no object`);
  assert.deepEqual(Object.keys(result).sort(), ['gesture', 'op', 'options', 'selector'],
    `${label}: result must have exactly {op, selector, gesture, options}`);
  assert.equal(typeof result.op, 'string', `${label}: op must be a string`);
  assert.ok(result.op.length > 0, `${label}: op must be non-empty`);
  assert.ok(result.options && typeof result.options === 'object', `${label}: options must be an object`);
  if (result.op === 'unknown') {
    assert.equal(typeof result.options.reason, 'string',
      `${label}: unknown op must carry options.reason`);
    assert.ok(result.options.reason.length > 0, `${label}: options.reason must be non-empty`);
  }
}

// ---------------------------------------------------------------------------
// 1. Golden IR: discover every AutoInput plugin action.
// ---------------------------------------------------------------------------
const goldenFiles = (await readdir(goldenDir)).filter((f) => f.endsWith('.ir.json')).sort();
const goldenActions = [];

for (const file of goldenFiles) {
  const ir = await readJson(path.join(goldenDir, file));
  walk(ir, (a) => {
    if (isAutoInputPluginAction(a)) {
      goldenActions.push({ file, action: a, label: `${file}#${a.sr || '?'}` });
    }
  });
}

await test('golden fixtures contain the expected 31 AutoInput plugin actions', () => {
  assert.ok(goldenFiles.length >= 10, `expected at least 10 golden IR files, saw ${goldenFiles.length}`);
  assert.equal(goldenActions.length, 31, `expected 31 AutoInput plugin actions, saw ${goldenActions.length}`);
});

// ---------------------------------------------------------------------------
// 2. Every golden AutoInput plugin action decodes sanely (the required check).
// ---------------------------------------------------------------------------
for (const { action, label } of goldenActions) {
  await test(`decode ${label} (${(action.pluginClass || '').split('.').pop()})`, () => {
    let result;
    assert.doesNotThrow(() => { result = decodeAutoInput(action); }, `${label}: decoder threw`);
    assertSane(result, label);
  });
}

// ---------------------------------------------------------------------------
// 3. Golden actions decode to the expected op family.
// ---------------------------------------------------------------------------
const ACTION_TYPE_OP = { 16: 'click', 32: 'longClick', '-1': 'write', '-2': 'replace',
  1: 'focus', 4096: 'scrollForward', 8192: 'scrollBackward', 32768: 'paste', 65536: 'cut', 131072: 'selectText' };
const GLOBAL_ACTION = { 1: 'back', 2: 'home', 3: 'recents', 4: 'notifications', 5: 'quickSettings', 6: 'powerDialog' };

function bundleOf(action) {
  const b = action.args && action.args.arg0;
  if (b && b.$bundle && typeof b.$bundle === 'object') return b.$bundle;
  return (b && typeof b === 'object') ? b : {};
}

await test('golden PerformAction ops follow the bundle ActionType', () => {
  const seen = [];
  for (const { action, label } of goldenActions) {
    if (!String(action.pluginClass || '').endsWith('ActivityConfigPerformAction')) continue;
    const bundle = bundleOf(action);
    const expected = ACTION_TYPE_OP[String(bundle.ActionType)];
    const result = decodeAutoInput(action);
    assert.ok(expected, `${label}: fixture has no mapped ActionType ${bundle.ActionType}`);
    assert.equal(result.op, expected, `${label}: ActionType ${bundle.ActionType} should decode to ${expected}`);
    if (expected === 'write') {
      assert.equal(typeof result.options.text, 'string', `${label}: write op should surface TextToWrite`);
    }
    seen.push(expected);
  }
  assert.ok(seen.length >= 13, `expected at least 13 PerformAction fixtures, saw ${seen.length}`);
});

await test('golden global actions map the GlobalAction enum to a named action', () => {
  let count = 0;
  for (const { action, label } of goldenActions) {
    if (!String(action.pluginClass || '').endsWith('ActivityConfigPerformGlobalAction')) continue;
    const bundle = bundleOf(action);
    const expected = GLOBAL_ACTION[String(bundle.GlobalAction)];
    const result = decodeAutoInput(action);
    assert.equal(result.op, 'globalAction', `${label}: expected globalAction`);
    assert.ok(expected, `${label}: fixture has no mapped GlobalAction ${bundle.GlobalAction}`);
    assert.equal(result.options.action, expected, `${label}: GlobalAction ${bundle.GlobalAction} -> ${expected}`);
    count += 1;
  }
  assert.ok(count >= 4, `expected at least 4 global-action fixtures, saw ${count}`);
});

await test('golden UIQuery / gesture / screen-off / v2 actions decode to their families', () => {
  const ops = [];
  for (const { action, label } of goldenActions) {
    const cls = String(action.pluginClass || '');
    const result = decodeAutoInput(action);
    if (cls.endsWith('ActivityConfigUIQuery')) {
      assert.equal(result.op, 'uiQuery', `${label}: UIQuery op`);
    } else if (cls.endsWith('ActivityConfigGestures')) {
      assert.equal(result.op, 'swipe', `${label}: GestureType 0 is a swipe`);
      assert.ok(result.gesture, `${label}: gesture payload required`);
      assert.ok(result.gesture.start, `${label}: gesture start point required`);
      assert.ok(result.gesture.end, `${label}: gesture end point required`);
    } else if (cls.endsWith('ActivityConfigTurnOffScreen')) {
      assert.equal(result.op, 'turnOffScreen', `${label}: screen on/off op`);
      assert.equal(result.options.screenAction, 'on', `${label}: "Screen Off Or On: Turn On" -> on`);
    } else if (cls.endsWith('ActivityConfigActionv2')) {
      assert.ok(['swipe', 'unknown'].includes(result.op), `${label}: unexpected v2 op ${result.op}`);
      if (result.op === 'unknown') {
        assert.match(result.options.reason, /variable|DSL/i,
          `${label}: dynamic %variable DSL must be unknown WITH a reason`);
      }
    }
    ops.push(result.op);
  }
  assert.ok(ops.length >= 14, `expected at least 14 actions across these families, saw ${ops.length}`);
});

// ---------------------------------------------------------------------------
// 4. Exact decodes for real fixtures (regression anchors).
// ---------------------------------------------------------------------------
function findAction(file, sr) {
  const hit = goldenActions.find((g) => g.file === file && g.action.sr === sr);
  assert.ok(hit, `missing fixture ${file}#${sr}`);
  return hit.action;
}

await test('LaunchInstagram act2: click by view id', () => {
  const r = decodeAutoInput(findAction('tasker-LaunchInstagram.tsk.ir.json', 'act2'));
  assert.equal(r.op, 'click');
  assert.deepEqual(r.selector, { type: 'id', value: 'com.instagram.android:id/icon_view' });
  assert.equal(r.gesture, null);
});

await test('Pin_Unlock act2: v2 DSL swipe with escaped comma coordinates', () => {
  const r = decodeAutoInput(findAction('tasker-Pin_Unlock___.tsk.ir.json', 'act2'));
  assert.equal(r.op, 'swipe');
  assert.ok(r.gesture, 'gesture required');
  assert.deepEqual(r.gesture.start, { x: 540, y: 2037 });
  assert.equal(r.gesture.direction, 'up');
  assert.equal(r.gesture.durationMs, 1000);
});

await test('Rho act1: click by variable point keeps raw coordinates', () => {
  const r = decodeAutoInput(findAction('tasker-Rho.prj.ir.json', 'act1'));
  assert.equal(r.op, 'click');
  assert.equal(r.selector.type, 'point');
  assert.deepEqual(r.selector.point, { x: '%xcoord', y: '%ycoord' });
});

await test('Utils act3: turnOffScreen decodes "Turn On" to screenAction on', () => {
  const r = decodeAutoInput(findAction('tasker-Utils.prj.ir.json', 'act3'));
  assert.equal(r.op, 'turnOffScreen');
  assert.equal(r.options.screenAction, 'on');
  assert.equal(r.options.screenOn, true);
});

await test('whsatapp act4: write op carries the text payload and id selector', () => {
  const r = decodeAutoInput(findAction('tasker-whsatapp_random_words_demo.tsk.ir.json', 'act4'));
  assert.equal(r.op, 'write');
  assert.equal(r.selector.type, 'id');
  assert.equal(r.selector.value, 'com.whatsapp:id/entry');
  assert.match(r.options.text, /Word: %http_data\.word/);
});

// ---------------------------------------------------------------------------
// 5. Input-shape flexibility: IR action node, args object, flattened bundle.
// ---------------------------------------------------------------------------
await test('decoder accepts the IR action, its args object, and the flat bundle', () => {
  const action = findAction('tasker-LaunchInstagram.tsk.ir.json', 'act2');
  const fromAction = decodeAutoInput(action);
  const fromArgs = decodeAutoInput(action.args);
  const fromBundle = decodeAutoInput(bundleOf(action));
  assert.equal(fromAction.op, 'click');
  assert.equal(fromArgs.op, fromAction.op);
  assert.equal(fromBundle.op, fromAction.op);
  assert.deepEqual(fromBundle.selector, fromAction.selector);
});

// ---------------------------------------------------------------------------
// 6. v2 DSL parser.
// ---------------------------------------------------------------------------
await test('splitActionCalls handles escaped separators inside arguments', () => {
  const calls = splitActionCalls('click(point,540\\,420)');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'click');
  assert.deepEqual(calls[0].args, ['point', '540,420']);
});

await test('splitActionCalls handles multiple calls separated by comma or newline', () => {
  const comma = splitActionCalls('click(id,a),wait(100),setText(id,b,hi)');
  assert.deepEqual(comma.map((c) => c.name), ['click', 'wait', 'setText']);
  const newline = splitActionCalls('openApp(x)\n\nwait(2000)\n\nclick(id,a)');
  assert.deepEqual(newline.map((c) => c.name), ['openApp', 'wait', 'click']);
});

await test('splitActionCalls honors a custom separator', () => {
  const calls = splitActionCalls('click(id,a)|wait(100)', '|');
  assert.deepEqual(calls.map((c) => c.name), ['click', 'wait']);
});

await test('v2 DSL decode: single point click and multi-action uiAction', () => {
  const single = decodeAutoInput({
    plugintypeid: 'com.joaomgcd.autoinput.intent.IntentActionv2',
    parameters: JSON.stringify({
      _action: 'click(point,540\\,420)',
      _additionalOptions: { separator: ',', checkMs: '1000', preActionDelay: '250', withCoordinates: false },
      generatedValues: {},
    }),
  });
  assert.equal(single.op, 'click');
  assert.deepEqual(single.selector, { type: 'point', value: '540,420', point: { x: 540, y: 420 } });
  assert.equal(single.options.preActionDelay, 250);

  const multi = decodeAutoInput({
    plugintypeid: 'com.joaomgcd.autoinput.intent.IntentActionv2',
    parameters: JSON.stringify({
      _action: 'openApp(com.x)\n\nwait(2000)\n\nclick(id,a)\n\nsetText(id,b,hi)',
      _additionalOptions: { separator: ',' },
      _whenToPerformAction: { notInAutoInput: true, notInTasker: true },
    }),
  });
  assert.equal(multi.op, 'uiAction');
  assert.equal(multi.options.primaryOp, 'openApp');
  assert.equal(multi.options.actions.length, 4);
  assert.equal(multi.options.actions[2].op, 'click');
  assert.deepEqual(multi.selector, { type: 'id', value: 'a', matchMode: null });
  assert.equal(multi.options.text, 'hi');
  assert.equal(multi.options.notInTasker, true);
});

await test('v2 DSL decode: text match mode and click-point name form', () => {
  const r = decodeAutoInput({
    plugintypeid: 'com.joaomgcd.autoinput.intent.IntentActionv2',
    parameters: JSON.stringify({ _action: 'click(text,Program,Contains)' }),
  });
  assert.equal(r.op, 'click');
  assert.deepEqual(r.selector, { type: 'text', value: 'Program', matchMode: 'Contains' });

  const r2 = decodeAutoInput({
    plugintypeid: 'com.joaomgcd.autoinput.intent.IntentActionv2',
    parameters: JSON.stringify({ _action: 'click point(540,%click_y)' }),
  });
  assert.equal(r2.op, 'click');
  assert.equal(r2.selector.type, 'point');
  assert.deepEqual(r2.selector.point, { x: 540, y: '%click_y' });
});

await test('v2 DSL decode: unresolvable %variable DSL is unknown with a reason', () => {
  const r = decodeAutoInput(findAction('tasker-CyanBridge_LocalAgent_Tasker.prj.ir.json', 'act1'));
  assert.equal(r.op, 'unknown');
  assert.match(r.options.reason, /%ai_command/);
  assert.equal(r.selector, null);
  assert.equal(r.gesture, null);
});

// ---------------------------------------------------------------------------
// 7. Localized bundle keys: English defaults first, BLURB fallback, no guessing.
// ---------------------------------------------------------------------------
const localizedPerformBundle = {
  plugintypeid: 'com.joaomgcd.autoinput.intent.IntentPerformAction',
  // Spanish-style localized display names, no English default keys present.
  'Tipo de accion': '16',
  'Id de accion': 'com.example:id/go',
  'Tipo de seleccion de campo': '1',
};

await test('localized keys fall back to the English BLURB description', () => {
  const r = decodeAutoInput({
    ...localizedPerformBundle,
    'com.twofortyfouram.locale.intent.extra.BLURB': 'Type: Id\nValue: com.example:id/go\nAction : Click',
  });
  assert.equal(r.op, 'click');
  assert.deepEqual(r.selector, { type: 'id', value: 'com.example:id/go' });
});

await test('localized keys with no fallback decode as unknown WITH reason (never guessed)', () => {
  const r = decodeAutoInput(localizedPerformBundle);
  assert.equal(r.op, 'unknown');
  assert.match(r.options.reason, /ActionType/i);
});

// ---------------------------------------------------------------------------
// 8. Failure modes: wrong package, null input, malformed JSON — no throws.
// ---------------------------------------------------------------------------
await test('non-AutoInput package is rejected with a reason', () => {
  const r = decodeAutoInput({ arg0: { $bundle: {} }, arg1: 'com.other.plugin', arg2: 'com.other.Config' });
  assert.equal(r.op, 'unknown');
  assert.match(r.options.reason, /not com\.joaomgcd\.autoinput/);
});

await test('null / empty / primitive input decodes to unknown without throwing', () => {
  for (const input of [null, undefined, {}, [], 42, 'nonsense']) {
    const r = decodeAutoInput(input);
    assertSane(r, `input=${JSON.stringify(input)}`);
    assert.equal(r.op, 'unknown');
  }
});

await test('malformed v2 parameters JSON is unknown with a reason', () => {
  const r = decodeAutoInput({
    plugintypeid: 'com.joaomgcd.autoinput.intent.IntentActionv2',
    parameters: '{not json',
  });
  assert.equal(r.op, 'unknown');
  assert.match(r.options.reason, /JSON/i);
});

// ---------------------------------------------------------------------------
// 9. Corpus coverage: data/autoInputCorpus.json (357 real + fabricated actions).
// ---------------------------------------------------------------------------
const corpus = await readJson(path.join(repoRoot, 'data/autoInputCorpus.json'));
const enumsFile = await readJson(path.join(repoRoot, 'data/autoInputEnums.json'));

await test('every pluginTypeId in the corpus is covered by the embedded table', () => {
  const ids = new Set(corpus.map((e) => e.pluginTypeId).filter(Boolean));
  for (const id of ids) {
    assert.ok(PLUGIN_TYPES[id], `corpus pluginTypeId ${id} missing from PLUGIN_TYPES`);
  }
  assert.ok(ids.size >= 8, `expected at least 8 corpus pluginTypeIds, saw ${ids.size}`);
});

await test('every corpus AutoInput action decodes sanely (no throw, op or reason)', () => {
  const ops = {};
  for (const entry of corpus) {
    const label = `${entry.file.split('/').pop()}#${entry.actionSr}`;
    let result;
    assert.doesNotThrow(() => { result = decodeAutoInput(entry); }, `${label}: decoder threw`);
    assertSane(result, label);
    ops[result.op] = (ops[result.op] || 0) + 1;
  }
  // Contract (DESIGN §5.2): all ~26 fabricated/garbage corpus bundles must decode
  // as unknown-with-reason, never guessed. Real ops: ~188 clicks remain.
  assert.ok((ops.unknown || 0) >= 26 && (ops.unknown || 0) <= 30,
    `expected 26-30 unknown (all fabricated bundles rejected), saw ${ops.unknown}: ${JSON.stringify(ops)}`);
  assert.ok((ops.click || 0) >= 180, `expected >=180 corpus clicks, saw ${ops.click}`);
  assert.ok((ops.uiQuery || 0) >= 30, `expected >=30 corpus UIQuery ops, saw ${ops.uiQuery}`);
  assert.ok((ops.uiAction || 0) >= 50, `expected >=50 multi-action v2 ops, saw ${ops.uiAction}`);
});

await test('decoder consumes data/autoInputEnums.json overrides identically', () => {
  const tables = { enums: enumsFile.enums };
  assert.ok(tables.enums && tables.enums.ActionType, 'enum file must expose enums.ActionType');
  for (const entry of corpus.slice(0, 80)) {
    const embedded = decodeAutoInput(entry);
    const overridden = decodeAutoInput(entry, tables);
    assert.equal(overridden.op, embedded.op, `${entry.file}#${entry.actionSr}: enum override changed op`);
  }
});

// ---------------------------------------------------------------------------
// 10. Point helper sanity.
// ---------------------------------------------------------------------------
await test('parsePoint parses numeric and variable coordinates', () => {
  assert.deepEqual(parsePoint('540,1500'), { x: 540, y: 1500 });
  assert.deepEqual(parsePoint('%x,%y'), { x: '%x', y: '%y' });
  assert.equal(parsePoint('540'), null);
  assert.equal(parsePoint(null), null);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exitCode = 1;
