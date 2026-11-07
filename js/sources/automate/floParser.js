// js/sources/automate/floParser.js — Automate (llamalab) .flo Tier-0 reader.
//
// Faithful port of the Python reference oracle scripts/flo_t0.py
// (read_header / strings_of / verdict logic) from bytes onto Uint8Array, so the
// PWA can inventory a shared .flo without a full Packed (T1) reader.
//
// T0 byte layout (proven on the corpus; docs/DESIGN.md §5.3):
//   offset 0..3  magic  "LAFl" (big-endian int 0x4C41466C)
//   offset 4..5  format version, big-endian uint16
//                (byte 4 is 0x00 because every corpus version, 44..109, is < 256;
//                 the app reader accepts up to 115)
//   offset 6..   next-statement-id, zigzag LEB128 varint
//                declared statement count, LEB128 varint
//                first statement type id, zigzag LEB128 varint (T1 hint)
//
// Note on the statement count: the Python oracle applies zigzag only to the
// next-statement-id (despite the designer's prose calling both fields zigzag);
// this port follows the oracle byte-for-byte so its output stays identical.
//
// Everything here reads untrusted bytes; nothing is executed. Truncated or
// malformed input yields a graceful rejection record, never a throw.

export const MAGIC = 'LAFl';
export const MAX_SUPPORTED_VERSION = 115; // com.llamalab.automate.D0 -> p(115)
export const MAX_PLAUSIBLE_STATEMENTS = 5000;
export const MIN_STRING_RUN = 4;

function isMagic(u8) {
  if (u8.length < 4) return false;
  return u8[0] === 0x4c && u8[1] === 0x41 && u8[2] === 0x46 && u8[3] === 0x6c;
}

function hexBytes(u8, start, end) {
  const out = [];
  for (let i = start; i < Math.min(end, u8.length); i++) out.push(u8[i].toString(16).padStart(2, '0'));
  return out.join('');
}

function asciiSlice(u8, start, end) {
  let s = '';
  for (let i = start; i < end; i++) s += String.fromCharCode(u8[i]);
  return s;
}

/**
 * LEB128, 7-bit groups, little-endian. Mirrors decode_varint() in flo_t0.py:
 * up to 10 groups, then "varint too long".
 * @returns {{value: bigint, next: number}}
 */
export function readVarint(u8, i) {
  let v = 0n;
  let shift = 0n;
  for (;;) {
    if (i >= u8.length) throw new Error('EOF in varint');
    const x = u8[i];
    i += 1;
    v |= BigInt(x & 0x7f) << shift;
    if (!(x & 0x80)) return { value: v, next: i };
    shift += 7n;
    if (shift > 63n) throw new Error('varint too long');
  }
}

/** zigzag: (v >> 1) ^ -(v & 1) — Q3/c.a(), Q3/c.b(). */
export function zigzag(v) {
  return (v >> 1n) ^ -(v & 1n);
}

/**
 * Decode the T0 header fields. Never throws on short/truncated input.
 * Field names follow scripts/flo_t0.py read_header().
 * @param {Uint8Array} u8
 */
export function parseFloHeader(u8) {
  const h = {
    magicOk: isMagic(u8),
    size: u8.length,
    byte4: null,
    version: null,
    versionWithinSupported: null,
    nextStatementId: null,
    statementCount: null,
    statementCountPlausible: null,
    firstStatementTypeId: null,
    firstStatementOffset: null,
    error: null,
  };
  if (u8.length < 6) {
    h.error = 'file too short for header';
    return h;
  }
  h.byte4 = u8[4];
  h.version = (u8[4] << 8) | u8[5]; // big-endian uint16
  h.versionWithinSupported = h.version <= MAX_SUPPORTED_VERSION;
  try {
    let r = readVarint(u8, 6);
    h.nextStatementId = Number(zigzag(r.value));
    r = readVarint(u8, r.next);
    h.statementCount = Number(r.value);
    h.statementCountPlausible =
      h.statementCount > 0 && h.statementCount <= MAX_PLAUSIBLE_STATEMENTS;
    h.firstStatementOffset = r.next;
    const t = readVarint(u8, r.next);
    h.firstStatementTypeId = Number(zigzag(t.value));
  } catch (e) {
    h.error = e && e.message ? e.message : String(e);
  }
  return h;
}

/**
 * Printable ASCII runs of >= 4 chars, skipping the 6-byte binary header
 * (otherwise "LAFl" itself shows up as a string). Runs are maximal and spread
 * through the whole buffer — there is no tail-only string table.
 * @param {Uint8Array} u8
 * @param {number} [start=6]
 * @returns {string[]}
 */
export function extractStrings(u8, start = 6) {
  const out = [];
  let from = -1;
  for (let i = start; i <= u8.length; i++) {
    const printable = i < u8.length && u8[i] >= 0x20 && u8[i] <= 0x7e;
    if (printable) {
      if (from < 0) from = i;
    } else if (from >= 0) {
      if (i - from >= MIN_STRING_RUN) out.push(asciiSlice(u8, from, i));
      from = -1;
    }
  }
  return out;
}

/**
 * Parse a .flo at T0 (header + printable literals). Never throws.
 *
 * @param {Uint8Array|ArrayBuffer} input
 * @returns {{
 *   magicOk: boolean,
 *   version: number|null,
 *   statementCount: number|null,
 *   strings: string[],
 *   verdict: string,
 *   reliable: boolean,
 *   error: string|null,
 *   byte4: number|null,
 *   byte4Ok: boolean,
 *   versionWithinSupported: boolean|null,
 *   statementCountPlausible: boolean|null,
 *   nextStatementId: number|null,
 *   firstStatementTypeId: number|null,
 *   firstStatementOffset: number|null,
 *   size: number,
 *   headerError: string|null
 * }}
 */
export function parseFloT0(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  const h = parseFloHeader(u8);
  const strings = extractStrings(u8);

  const rec = {
    magicOk: h.magicOk,
    version: h.version,
    statementCount: h.statementCount,
    strings,
    verdict: '',
    reliable: false,
    error: null,
    // ---- extra T0 detail beyond the minimal contract ----
    byte4: h.byte4,
    byte4Ok: h.byte4 === 0,
    versionWithinSupported: h.versionWithinSupported,
    statementCountPlausible: h.statementCountPlausible,
    nextStatementId: h.nextStatementId,
    firstStatementTypeId: h.firstStatementTypeId,
    firstStatementOffset: h.firstStatementOffset,
    size: u8.length,
    headerError: h.error,
  };

  if (!h.magicOk) {
    rec.verdict = `not an Automate flow (magic ${hexBytes(u8, 0, 4)})`;
    rec.reliable = false;
  } else if (h.version !== null && h.statementCount !== null) {
    rec.verdict = `Automate flow detected, v=${h.version}, ` +
      `${h.statementCount} statements, ${strings.length} strings`;
    // byte4 === 0x00 is implied by version <= 115, but checked explicitly:
    // the format writer emits a big-endian uint16 version, so byte 4 is only
    // nonzero for unsupported (>= 256) versions.
    rec.reliable = Boolean(
      h.versionWithinSupported && h.statementCountPlausible && rec.byte4Ok
    );
    if (!rec.reliable) {
      rec.verdict += ` (header out of range: version<=${MAX_SUPPORTED_VERSION}, ` +
        `count<=${MAX_PLAUSIBLE_STATEMENTS})`;
    }
  } else {
    // magic present but the varint header is incomplete
    rec.verdict = 'truncated flow (magic ok, header incomplete), rejected';
    rec.error = h.error || 'magic present but header fields missing';
    rec.reliable = false;
  }

  // size-vs-header sanity: every statement needs at least ~2 bytes on disk.
  if (h.magicOk && h.statementCount !== null) {
    const minSize = 8 + 2 * h.statementCount;
    if (u8.length < minSize) {
      rec.verdict = `truncated flow (size ${u8.length} too small for ` +
        `${h.statementCount} statements), rejected`;
      rec.error = 'file size inconsistent with header statement count';
      rec.reliable = false;
    }
  }

  return rec;
}
