// tests/js/run_flo_tests.mjs — node-run tests for js/sources/automate/floParser.js
//
// Compares the browser port against the Python reference oracle
// (scripts/flo_t0.py) on every real corpus fixture, and asserts the graceful
// rejection contract on the negative fixtures. No dependencies, no build step.
//
// Run: node tests/js/run_flo_tests.mjs
// Exits non-zero on any failure.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

import {
  parseFloT0,
  parseFloHeader,
  extractStrings,
  readVarint,
  zigzag,
  MAGIC,
  MAX_SUPPORTED_VERSION,
} from '../../js/sources/automate/floParser.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, '..', 'fixtures');

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
/* Expected values captured from `python3 -I scripts/flo_t0.py` on the */
/* same fixtures (the ground-truth oracle output).                     */
/* ------------------------------------------------------------------ */

// file -> [version, statementCount, nextStatementId, stringsCount]
const POSITIVE_EXPECTED = {
  '1446.flo': [44, 48, 80, 30],
  '23006.flo': [79, 19, 52, 25],
  '23050.flo': [74, 15, 41, 36],
  '23776.flo': [74, 8, 13, 6],
  '28537.flo': [100, 24, 90, 167],
  '32031.flo': [81, 30, 208, 95],
  '3298.flo': [53, 14, 22, 7],
  '36754.flo': [84, 9, 17, 6],
  '42490.flo': [94, 9, 22, 26],
  '51455.flo': [109, 12, 18, 66],
};

const NEGATIVE_EXPECTED = {
  'random.bin': {
    magicOk: false,
    version: 35171,
    statementCount: 2303,
    strings: 8,
    verdict: 'not an Automate flow (magic e15896f5)',
    reliable: false,
    error: null,
  },
  'truncated-header.flo': {
    magicOk: true,
    version: 74,
    statementCount: 15,
    strings: 0,
    verdict: 'truncated flow (size 16 too small for 15 statements), rejected',
    reliable: false,
    error: 'file size inconsistent with header statement count',
  },
  'truncated-magic-only.flo': {
    magicOk: true,
    version: 74,
    statementCount: null,
    strings: 0,
    verdict: 'truncated flow (magic ok, header incomplete), rejected',
    reliable: false,
    errorIncludes: 'varint',
  },
};

const REQUIRED_KEYS = ['magicOk', 'version', 'statementCount', 'strings', 'verdict', 'reliable', 'error'];

/* ------------------------------------------------------------------ */
/* Positive corpus                                                     */
/* ------------------------------------------------------------------ */

for (const [file, [version, count, nextId, stringCount]] of Object.entries(POSITIVE_EXPECTED)) {
  test(`positive fixture ${file}`, () => {
    const u8 = readFixture(path.join('automate', file));
    let rec;
    assert.doesNotThrow(() => { rec = parseFloT0(u8); }, 'parser must not throw');

    for (const key of REQUIRED_KEYS) {
      assert.ok(Object.prototype.hasOwnProperty.call(rec, key), `missing key ${key}`);
    }
    assert.equal(rec.magicOk, true, 'magicOk');
    assert.equal(rec.version, version, 'version');
    assert.equal(rec.statementCount, count, 'statementCount');
    assert.equal(rec.nextStatementId, nextId, 'nextStatementId');
    assert.equal(rec.strings.length, stringCount, 'strings count');
    assert.equal(rec.reliable, true, 'reliable');
    assert.equal(rec.error, null, 'error');
    assert.ok(rec.versionWithinSupported, 'version within 115');
    assert.ok(rec.statementCountPlausible, 'count plausible');
    assert.equal(rec.byte4, 0, 'byte4');
    assert.ok(rec.byte4Ok, 'byte4Ok');
    assert.equal(
      rec.verdict,
      `Automate flow detected, v=${version}, ${count} statements, ${stringCount} strings`,
      'verdict'
    );
    // every extracted literal is a maximal printable-ASCII run of >= 4 chars
    for (const s of rec.strings) {
      assert.ok(s.length >= 4, `string too short: ${JSON.stringify(s)}`);
      assert.match(s, /^[\x20-\x7e]+$/, `non-printable string: ${JSON.stringify(s)}`);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Negative fixtures (graceful rejection, never a throw)               */
/* ------------------------------------------------------------------ */

for (const [file, exp] of Object.entries(NEGATIVE_EXPECTED)) {
  test(`negative fixture ${file}`, () => {
    const u8 = readFixture(path.join('negative', file));
    let rec;
    assert.doesNotThrow(() => { rec = parseFloT0(u8); }, 'parser must not throw');

    assert.equal(rec.magicOk, exp.magicOk, 'magicOk');
    assert.equal(rec.version, exp.version, 'version');
    assert.equal(rec.statementCount, exp.statementCount, 'statementCount');
    assert.equal(rec.strings.length, exp.strings, 'strings count');
    assert.equal(rec.verdict, exp.verdict, 'verdict');
    assert.equal(rec.reliable, false, 'reliable must be false');
    if (exp.error === null) {
      assert.equal(rec.error, null, 'error');
    } else if (exp.errorIncludes) {
      assert.ok(
        typeof rec.error === 'string' && rec.error.includes(exp.errorIncludes),
        `error should mention ${exp.errorIncludes}, got ${rec.error}`
      );
    } else {
      assert.equal(rec.error, exp.error, 'error');
    }
  });
}

/* ------------------------------------------------------------------ */
/* Robustness: truncation at every prefix, empty and tiny inputs       */
/* ------------------------------------------------------------------ */

test('truncation of every prefix never throws', () => {
  const full = readFixture(path.join('automate', '28537.flo'));
  for (let n = 0; n <= full.length; n += 1) {
    const part = full.subarray(0, n);
    let rec;
    assert.doesNotThrow(() => { rec = parseFloT0(part); }, `threw at length ${n}`);
    assert.equal(rec.size, n);
    if (n < 4) assert.equal(rec.magicOk, false, `magicOk at length ${n}`);
    if (n > 0 && n < 6) {
      assert.equal(rec.reliable, false, `reliable at length ${n}`);
      assert.match(rec.verdict, /truncated|not an Automate flow/);
    }
  }
});

test('empty input rejects gracefully', () => {
  const rec = parseFloT0(new Uint8Array(0));
  assert.equal(rec.magicOk, false);
  assert.equal(rec.version, null);
  assert.equal(rec.statementCount, null);
  assert.deepEqual(rec.strings, []);
  assert.equal(rec.reliable, false);
  assert.match(rec.verdict, /not an Automate flow/);
});

test('magic-only input rejects gracefully', () => {
  const rec = parseFloT0(new Uint8Array([0x4c, 0x41, 0x46, 0x6c]));
  assert.equal(rec.magicOk, true);
  assert.equal(rec.version, null);
  assert.equal(rec.reliable, false);
  assert.equal(rec.verdict, 'truncated flow (magic ok, header incomplete), rejected');
  assert.equal(rec.error, 'file too short for header');
});

test('magic + byte4 + byte5 with no varints rejects gracefully', () => {
  const rec = parseFloT0(new Uint8Array([0x4c, 0x41, 0x46, 0x6c, 0x00, 0x2c]));
  assert.equal(rec.magicOk, true);
  assert.equal(rec.version, 44);
  assert.equal(rec.nextStatementId, null);
  assert.equal(rec.statementCount, null);
  assert.equal(rec.reliable, false);
  assert.ok(rec.error && rec.error.includes('varint'), `error: ${rec.error}`);
});

test('magic ok but too small for declared statements rejects', () => {
  // magic, v=44, nextId=80 (a0 01), count=48 (30) -> needs 8 + 96 = 104 bytes
  const bytes = [0x4c, 0x41, 0x46, 0x6c, 0x00, 0x2c, 0xa0, 0x01, 0x30, 0x00, 0x00];
  const rec = parseFloT0(new Uint8Array(bytes));
  assert.equal(rec.magicOk, true);
  assert.equal(rec.version, 44);
  assert.equal(rec.statementCount, 48);
  assert.equal(rec.reliable, false);
  assert.match(rec.verdict, /too small for 48 statements/);
});

test('byte4 nonzero is not reliable (version out of supported range)', () => {
  // byte4 = 0x01 -> version 0x012c = 300 > 115; body padded past the size check
  const bytes = [0x4c, 0x41, 0x46, 0x6c, 0x01, 0x2c, 0x02, 0x02, 0x02, 0x00, 0x00, 0x00];
  const rec = parseFloT0(new Uint8Array(bytes));
  assert.equal(rec.magicOk, true);
  assert.equal(rec.byte4, 1);
  assert.equal(rec.version, 300);
  assert.equal(rec.versionWithinSupported, false);
  assert.equal(rec.reliable, false);
  assert.match(rec.verdict, /header out of range/);
});

test('ArrayBuffer input is accepted', () => {
  const u8 = readFixture(path.join('automate', '1446.flo'));
  const rec = parseFloT0(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
  assert.equal(rec.magicOk, true);
  assert.equal(rec.version, 44);
});

/* ------------------------------------------------------------------ */
/* Primitives match the Python oracle                                  */
/* ------------------------------------------------------------------ */

test('readVarint / zigzag primitives', () => {
  // a0 01 -> 160 -> zigzag 80 (1446.flo next-statement-id)
  const r = readVarint(new Uint8Array([0xa0, 0x01]), 0);
  assert.equal(r.value, 160n);
  assert.equal(r.next, 2);
  assert.equal(zigzag(r.value), 80n);
  // 0x30 -> 48, zigzag 24
  assert.equal(zigzag(48n), 24n);
  // 0x03 -> 3, zigzag -2
  assert.equal(zigzag(3n), -2n);
  assert.equal(zigzag(0n), 0n);
  // EOF grace
  assert.throws(() => readVarint(new Uint8Array([0x80]), 0), /EOF in varint/);
  // over-long varint grace
  assert.throws(
    () => readVarint(new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80]), 0),
    /varint too long/
  );
});

test('extractStrings skips the header and enforces >= 4 chars', () => {
  const bytes = new Uint8Array([
    0x4c, 0x41, 0x46, 0x6c, 0x00, 0x2c, // "LAFl" header + version: not a string
    0x00, 0x01, 0x02,                   // binary
    0x68, 0x65, 0x6c, 0x6c, 0x6f,       // "hello"
    0x00,                               // break
    0x61, 0x62, 0x63,                   // "abc" (3 chars -> dropped)
    0x00,
    0x5b, 0x78, 0x5d, 0x21,             // "[x]!"
  ]);
  const strings = extractStrings(bytes);
  assert.deepEqual(strings, ['hello', '[x]!']);
  assert.equal(MAGIC, 'LAFl');
  assert.equal(MAX_SUPPORTED_VERSION, 115);
});

test('parseFloHeader exposes the oracle header fields', () => {
  const u8 = readFixture(path.join('automate', '23776.flo'));
  const h = parseFloHeader(u8);
  assert.equal(h.magicOk, true);
  assert.equal(h.byte4, 0);
  assert.equal(h.version, 74);
  assert.equal(h.nextStatementId, 13);
  assert.equal(h.statementCount, 8);
  assert.equal(h.firstStatementOffset, 8);
  assert.equal(h.firstStatementTypeId, 1072); // FlowBeginning
  assert.equal(h.error, null);
});

/* ------------------------------------------------------------------ */
/* Fixture inventory                                                   */
/* ------------------------------------------------------------------ */

test('fixture inventory is complete and parsed', () => {
  const posFiles = readdirSync(path.join(fixtures, 'automate')).filter((f) => f.endsWith('.flo')).sort();
  assert.deepEqual(posFiles, Object.keys(POSITIVE_EXPECTED).sort(), 'positive fixture set drifted');
  const negFiles = readdirSync(path.join(fixtures, 'negative')).sort();
  assert.deepEqual(negFiles, Object.keys(NEGATIVE_EXPECTED).sort(), 'negative fixture set drifted');
});

test('all .flo fixtures parse as reliable', () => {
  const dir = path.join(fixtures, 'automate');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.flo'))) {
    const rec = parseFloT0(readFixture(path.join('automate', file)));
    assert.equal(rec.magicOk, true, `${file} magic`);
    assert.equal(typeof rec.version, 'number', `${file} version`);
    assert.ok(rec.version <= MAX_SUPPORTED_VERSION, `${file} version supported`);
    assert.equal(rec.reliable, true, `${file} reliable`);
  }
});

console.log(`\nrun_flo_tests: ${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
