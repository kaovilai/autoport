// tests/js/run_validator_tests.mjs
// Plain Node test harness for js/targets/macrodroid/structuralValidator.js.
// Run: node tests/js/run_validator_tests.mjs   (exit 0 = pass, non-zero = fail)

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { validateMacro } from '../../js/targets/macrodroid/structuralValidator.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const probeDir = path.join(repoRoot, 'tests/fixtures/macrodroid/validator-probes');

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
    console.error(`      ${err.message.split('\n').join('\n      ')}`);
  }
}

async function readJson(absPath) {
  return JSON.parse(await readFile(absPath, 'utf8'));
}

// --- 1. Recorded live probes reproduce their recorded verdicts exactly. ------
const probeFiles = [
  'validate-ok.json',
  'validate-probe-bare-macro.json',
  'validate-probe-missing-completed.json',
  'validate-probe-constraint-in-actions.json',
  'validate-probe-bad-classtype.json',
  'validate-probe-unbalanced-if.json',
];

for (const file of probeFiles) {
  await test(`probe ${file} matches recorded verdict`, async () => {
    const probe = await readJson(path.join(probeDir, file));
    const macroJson = probe.request.params.arguments.macro_json;
    const expected = probe.response.body_parsed.result.structuredContent;

    const result = validateMacro(macroJson);

    assert.equal(result.ok, expected.valid, `ok must equal recorded valid=${expected.valid}`);
    assert.deepEqual(
      result.errors.map((e) => e.message),
      expected.problems,
      'error messages must equal recorded problems, in order',
    );
    assert.equal(result.ok, result.errors.length === 0, 'ok is derived from errors');
  });
}

// --- 2. Explicit checks on the two rejection probes' exact messages/paths. ---
await test('bad m_classType carries the recorded message and a useful path', async () => {
  const probe = await readJson(path.join(probeDir, 'validate-probe-bad-classtype.json'));
  const result = validateMacro(probe.request.params.arguments.macro_json);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].message, 'm_classType "HttpAction" does not exist in MacroDroid.');
  assert.equal(result.errors[0].path, 'macro.m_actionList[0].m_classType');
});

await test('unclosed If carries the recorded message and path', async () => {
  const probe = await readJson(path.join(probeDir, 'validate-probe-unbalanced-if.json'));
  const result = validateMacro(probe.request.params.arguments.macro_json);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(
    result.errors[0].message,
    'macro.m_actionList has a IfConditionAction that is never closed with EndIfAction.',
  );
  assert.equal(result.errors[0].path, 'macro.m_actionList');
});

// --- 3. minimal-macro.json passes. ------------------------------------------
await test('data/macrodroid/minimal-macro.json passes', async () => {
  const minimal = await readJson(path.join(repoRoot, 'data/macrodroid/minimal-macro.json'));
  const result = validateMacro(minimal);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

// --- 4. Our own unbalanced-If fixture is rejected. --------------------------
await test('hand-built unbalanced If fixture is rejected', async () => {
  const minimal = await readJson(path.join(repoRoot, 'data/macrodroid/minimal-macro.json'));
  const fixture = structuredClone(minimal);
  fixture.macro.m_actionList = [
    {
      m_classType: 'IfConditionAction',
      m_SIGUID: 0,
      m_constraintList: [
        { m_classType: 'MacroDroidVariableConstraint', m_SIGUID: 0, m_variableName: 'http_code' },
      ],
    },
    { m_classType: 'HttpRequestAction', m_SIGUID: 0, requestConfig: { urlToOpen: 'https://example.com' } },
    // deliberately no EndIfAction
  ];

  const result = validateMacro(fixture);
  assert.equal(result.ok, false, 'must reject an If with no EndIfAction');
  assert.equal(result.errors.length, 1);
  assert.equal(
    result.errors[0].message,
    'macro.m_actionList has a IfConditionAction that is never closed with EndIfAction.',
  );
});

// --- 5. Balanced control flow (If/Else/EndIf, Loop/EndLoop) still passes. ----
await test('balanced If/Else/EndIf and Loop/EndLoop pass', async () => {
  const minimal = await readJson(path.join(repoRoot, 'data/macrodroid/minimal-macro.json'));
  const fixture = structuredClone(minimal);
  fixture.macro.m_actionList = [
    { m_classType: 'IfConditionAction', m_SIGUID: 0, m_constraintList: [] },
    { m_classType: 'HttpRequestAction', m_SIGUID: 0, requestConfig: { urlToOpen: 'https://example.com' } },
    { m_classType: 'ElseAction', m_SIGUID: 0 },
    { m_classType: 'LoopAction', m_SIGUID: 0 },
    { m_classType: 'HttpRequestAction', m_SIGUID: 0, requestConfig: { urlToOpen: 'https://example.com' } },
    { m_classType: 'EndLoopAction', m_SIGUID: 0 },
    { m_classType: 'EndIfAction', m_SIGUID: 0 },
  ];

  const result = validateMacro(fixture);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

// --- 6. Extra safety: bare macro without m_completed still passes. ----------
await test('bare macro without wrapper and without m_completed passes', async () => {
  const minimal = await readJson(path.join(repoRoot, 'data/macrodroid/minimal-macro.json'));
  const bare = structuredClone(minimal.macro);
  delete bare.m_completed;
  const result = validateMacro(bare);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

// --- 7. Invalid JSON is reported, not thrown. -------------------------------
await test('invalid JSON string is rejected without throwing', () => {
  const result = validateMacro('{not json');
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /not valid JSON/);
});

// --- 8. Unknown class in a trigger is rejected too. -------------------------
await test('unknown m_classType in a trigger is rejected', async () => {
  const minimal = await readJson(path.join(repoRoot, 'data/macrodroid/minimal-macro.json'));
  const fixture = structuredClone(minimal);
  fixture.macro.m_triggerList[0].m_classType = 'TotallyFakeTrigger';
  const result = validateMacro(fixture);
  assert.equal(result.ok, false);
  assert.equal(
    result.errors[0].message,
    'm_classType "TotallyFakeTrigger" does not exist in MacroDroid.',
  );
  assert.equal(result.errors[0].path, 'macro.m_triggerList[0].m_classType');
});

// --- Summary ----------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  process.exitCode = 1;
}
