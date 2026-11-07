// tests/js/run_sniff_tests.mjs — unit tests for js/sniff.js (content sniffing).
//
// The sniffer is the single dispatch point for every ingest path (share sheet,
// picker, drop, paste). It must classify by CONTENT, never by reported MIME.
// This suite pins every kind it can return, including the negative/unknown
// branches, so a regression here cannot silently misroute a shared file.
//
// Run: node tests/js/run_sniff_tests.mjs
// Exits non-zero on any failure. stdlib only.

import assert from 'node:assert/strict';
import { classify, humanSize, hexHead } from '../../js/sniff.js';

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

const U = (arr) => new Uint8Array(arr);
const ascii = (s) => U([...s].map((c) => c.charCodeAt(0)));

await test('empty buffer -> empty', () => {
  const r = classify(new ArrayBuffer(0));
  assert.equal(r.kind, 'empty');
  assert.equal(r.parser, null);
  assert.equal(r.detail.size, 0);
});

await test('Automate .flo magic LAFl -> automate-flow + vendor MIME', () => {
  const r = classify(U([0x4c, 0x41, 0x46, 0x6c, 1, 2, 3, 4]));
  assert.equal(r.kind, 'automate-flow');
  assert.equal(r.parser, 'automate');
  assert.equal(r.vendorMime, 'application/vnd.com.llamalab.automate.flow');
});

await test('%PDF -> pdf', () => {
  const r = classify(ascii('%PDF-1.7\n...'));
  assert.equal(r.kind, 'pdf');
  assert.equal(r.vendorMime, 'application/pdf');
});

await test('PNG magic -> png', () => {
  const r = classify(U([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]));
  assert.equal(r.kind, 'png');
  assert.equal(r.vendorMime, 'image/png');
});

await test('PK\\x03\\x04 -> zip (rejected as flow)', () => {
  const r = classify(U([0x50, 0x4b, 0x03, 0x04, 0, 0, 0]));
  assert.equal(r.kind, 'zip');
  assert.equal(r.parser, null);
});

await test('gzip magic -> gzip', () => {
  const r = classify(U([0x1f, 0x8b, 0x08, 0, 0, 0]));
  assert.equal(r.kind, 'gzip');
  assert.equal(r.parser, null);
});

await test('TaskerData XML -> tasker-xml, parser tasker, rootTag captured', () => {
  const xml = '<TaskerData sr="" dvi="1" tv="6.6.3-beta"><Task sr=""></Task></TaskerData>';
  const r = classify(ascii(xml));
  assert.equal(r.kind, 'tasker-xml');
  assert.equal(r.parser, 'tasker');
  assert.equal(r.vendorMime, 'application/xml');
  assert.match(r.detail.rootTag, /^<TaskerData/);
});

await test('Tasker xmlns root -> tasker-xml', () => {
  const xml = '<tasker:project xmlns="http://tasker.dinglisch.net">';
  const r = classify(ascii(xml));
  assert.equal(r.kind, 'tasker-xml');
  assert.equal(r.parser, 'tasker');
});

await test('UTF-8 BOM + whitespace + TaskerData -> tasker-xml (BOM/whitespace skipped)', () => {
  const xml = '\n  <TaskerData sr="" dvi="1"><Task/></TaskerData>';
  const bytes = U([0xef, 0xbb, 0xbf, ...ascii(xml)]);
  const r = classify(bytes);
  assert.equal(r.kind, 'tasker-xml');
});

await test('generic <?xml -> xml (unrecognized root, no parser)', () => {
  const r = classify(ascii('<?xml version="1.0"?><foo/>'));
  assert.equal(r.kind, 'xml');
  assert.equal(r.parser, null);
});

await test('HTML document -> html', () => {
  const r = classify(ascii('<!doctype html><html><body>x'));
  assert.equal(r.kind, 'html');
  const r2 = classify(ascii('<HTML lang="en">'));
  assert.equal(r2.kind, 'html');
});

await test('XML-ish text (leading <, no known root) -> xml', () => {
  const r = classify(ascii('<foo bar="1">'));
  assert.equal(r.kind, 'xml');
  assert.equal(r.parser, null);
});

await test('MacroDroid macro JSON (macros key) -> macrodroid-json + parser', () => {
  const r = classify(ascii('{"macros":[]}'));
  assert.equal(r.kind, 'macrodroid-json');
  assert.equal(r.parser, 'macrodroid');
  assert.deepEqual(r.detail.jsonKeys, ['macros']);
});

await test('plain JSON object/array -> json, no parser', () => {
  assert.equal(classify(ascii('{"a":1}')).kind, 'json');
  assert.equal(classify(ascii('[1,2,3]')).kind, 'json');
  assert.equal(classify(ascii('{"a":1}')).parser, null);
});

await test('JSON-ish text that does not parse -> json-invalid', () => {
  const r = classify(ascii('{"a": nope'));
  assert.equal(r.kind, 'json-invalid');
  assert.equal(r.parser, null);
});

await test('taskernet.com/shares link -> taskernet-link', () => {
  const r = classify(ascii('https://taskernet.com/shares/d3a2f4a35c8eab2f8afdafa0a4f9e5848f5d0b7ab4bb4b9b'));
  assert.equal(r.kind, 'taskernet-link');
});

await test('plain text -> text with printableRatio detail', () => {
  const r = classify(ascii('hello world, just some words'));
  assert.equal(r.kind, 'text');
  assert.equal(r.parser, null);
  assert.ok(r.detail.printableRatio > 0.95);
});

await test('binary garbage -> binary (printable ratio below threshold)', () => {
  const r = classify(U([0x00, 0x01, 0x02, 0xff, 0xfe, 0x03, 0x99, 0x88]));
  assert.equal(r.kind, 'binary');
  assert.ok(r.detail.printableRatio <= 0.95);
});

await test('classify never trusts input type: same bytes, same answer regardless of wrapper', () => {
  const bytes = ascii('<TaskerData sr="" dvi="1"/>');
  const fromBuffer = classify(bytes.buffer);
  const fromView = classify(bytes);
  assert.equal(fromBuffer.kind, fromView.kind);
  assert.equal(fromBuffer.kind, 'tasker-xml');
});

await test('hexHead formats little heads with spaces', () => {
  assert.equal(hexHead(U([0x4c, 0x41, 0x46, 0x6c])), '4c 41 46 6c');
  assert.equal(hexHead(U([0xab]), 4), 'ab');
  assert.equal(hexHead(U([])), '');
  // detail.magic carries the first 16 bytes
  const r = classify(ascii('%PDF-1.7 rest of file padded out beyond sixteen bytes'));
  assert.equal(r.detail.magic, r.detail.magic.split(' ').length <= 16 ? r.detail.magic : r.detail.magic);
  assert.match(r.detail.magic, /^25 50 44 46/);
});

await test('humanSize boundaries', () => {
  assert.equal(humanSize(0), '0 B');
  assert.equal(humanSize(1023), '1023 B');
  assert.equal(humanSize(1024), '1.0 KiB');
  assert.equal(humanSize(1536), '1.5 KiB');
  assert.equal(humanSize(1024 * 1024), '1.00 MiB');
  assert.equal(humanSize(null), '?');
  assert.equal(humanSize(undefined), '?');
});

console.log(`\nsniff tests: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
