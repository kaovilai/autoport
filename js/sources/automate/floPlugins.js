// js/sources/automate/floPlugins.js — Automate .flo plug-in statement scanner.
//
// Faithful port of the Python reference oracle scripts/flo_plugins.py.
// Extracts Tasker/Locale plug-in invocations (PlugInSetting 1106 /
// PlugInCondition 1104 / PlugInEvent 1105 — decompiled
// com.llamalab.automate.stmt.F0) from a .flo WITHOUT the full T1 statement
// registry, so the pass-through emitter can delegate them to MacroDroid.
//
// F0 wire layout (Q3.c readers, proven on real community flows —
// docs/DESIGN.md §7.8):
//   [pkgLen][package]        Q3.c.i() — varint length when version >= 35
//   [actLen][activity]       Q3.c.i()
//   [parcelLen][parcel]      Q3.c.h(Bundle.CREATOR) — varint byte count +
//                            marshalled Android Parcel holding the Bundle
//   [blurbLen][blurb]        Q3.c.i()
//   [n][varName] × n         output variable names (String[])
//   [m]{[key][label][ref]}   M0 output mappings (counted, not kept)
//   [bool]
//
// An anchor is accepted only when every level validates (package regex,
// class-shaped activity, strict Bundle round-trip with AOSP string padding,
// decodable blurb/varNames), which makes false positives on arbitrary flow
// bytes essentially impossible — verified against the 10-flow non-plugin
// corpus. The statement KIND is reported only when the exact base chain
// ([typeId][id][x][y][null/backref fields]) ends at the package length
// varint; when an inline object (e.g. a nested Delay as onComplete) sits in
// between, kind is null and the emitter assumes SETTING (the dominant case)
// and says so in its report.
//
// Values the locale SDK cannot represent are decoded as tagged objects
// { $parcel: 'java.lang.Long', value } so the emitter can reject + report
// them exactly like the Tasker path does. Everything here reads untrusted
// bytes; nothing is executed, nothing throws.

export const PLUGIN_KINDS = { 1104: 'CONDITION', 1105: 'EVENT', 1106: 'SETTING' };

const MAX_PKG = 120;
const MAX_ACT = 250;
const MAX_PARCEL = 25000; // matches the locale SDK bundle cap the emitter enforces
const MAX_BLURB = 4000;
const MAX_VARNAMES = 64;

// parcel value tags (AOSP Parcel.java)
const VAL_STRING = 0;
const VAL_INTEGER = 1;
const VAL_BUNDLE = 3;
const VAL_SHORT = 5;
const VAL_LONG = 6;
const VAL_FLOAT = 7;
const VAL_DOUBLE = 8;
const VAL_BOOLEAN = 9;
const VAL_CHARSEQUENCE = 10;
const VAL_LIST = 11;
const VAL_STRINGARRAY = 14;
const VAL_CHARSEQUENCEARRAY = 24;
const LEN_PREFIXED = new Set([2, VAL_BUNDLE, 4, VAL_LIST, 12, 16, 17, 21, 25]);
// names for values the locale-SDK bundle cannot carry — the emitter reports these
const TAG_NAMES = {
  2: 'android.os.Bundle(map)', 4: 'android.os.Parcelable', 12: 'SparseBooleanArray',
  13: 'byte[]', 16: 'Parcelable[]', 17: 'Object[]', 21: 'java.io.Serializable',
  25: 'PersistableBundle',
};

/* ---- Packed primitives (p020c4/e.java, Q3/c.java) ---- */

/** LEB128 varint. @returns {{value: number, next: number}} */
export function readVarint(u8, i) {
  let v = 0;
  let s = 0;
  for (;;) {
    if (i >= u8.length) throw new Error('EOF in varint');
    const x = u8[i];
    i += 1;
    v += (x & 0x7f) * 2 ** s;
    if (!(x & 0x80)) return { value: v, next: i };
    s += 7;
    if (s > 70) throw new Error('varint too long');
  }
}

export function zigzag(v) {
  return Math.floor(v / 2) ^ -(v % 2); // (v >> 1) ^ -(v & 1) for v >= 0
}

function i32(u8, i) {
  if (i + 4 > u8.length) throw new Error('EOF in int32');
  // | 0 converts the unsigned sum to a signed int32 (0xffffffff -> -1)
  const value = ((u8[i] | (u8[i + 1] << 8) | (u8[i + 2] << 16)) + u8[i + 3] * 0x1000000) | 0;
  return { value, next: i + 4 };
}

/* ---- Android Parcel Bundle reader (AOSP Parcel.cpp rules) ---- */
//
// int32 values little-endian. A string is [int32 charLen][UTF-16LE chars]
// [2-byte NUL], the payload ((charLen+1)*2) padded to a multiple of 4
// (Parcel::writeInplace). A value is [int32 tag][payload]; length-prefixed
// tags carry an extra [int32 length]. A Bundle is [int32 length][magic
// "BNDL"][int32 count][count × (key, value)] where length counts the magic,
// count and entries.

function parcelString(u8, i) {
  const n = i32(u8, i);
  i = n.next;
  if (n.value < 0) return { value: null, next: i };
  const payload = 2 * n.value + 2; // chars + NUL terminator
  const pad = (4 - (payload % 4)) % 4; // writeInplace rounding
  if (i + payload + pad > u8.length) throw new Error('EOF in string');
  let s = '';
  for (let k = 0; k < n.value; k++) s += String.fromCharCode(u8[i + 2 * k] | (u8[i + 2 * k + 1] << 8));
  return { value: s, next: i + payload + pad };
}

function parcelValue(u8, i, depth) {
  if (depth > 8) throw new Error('bundle nesting too deep');
  const t = i32(u8, i);
  i = t.next;
  const tag = t.value;
  if (tag === -1) return { value: null, next: i };
  if (tag === VAL_STRING || tag === VAL_CHARSEQUENCE) return parcelString(u8, i);
  if (tag === VAL_INTEGER || tag === VAL_BOOLEAN) return i32(u8, i);
  if (tag === VAL_LONG) {
    if (i + 8 > u8.length) throw new Error('EOF in long');
    const lo = (u8[i] | (u8[i + 1] << 8) | (u8[i + 2] << 16)) + u8[i + 3] * 0x1000000;
    const hi = (u8[i + 4] | (u8[i + 5] << 8) | (u8[i + 6] << 16)) + u8[i + 7] * 0x1000000;
    return { value: { $parcel: 'java.lang.Long', value: hi * 0x100000000 + lo }, next: i + 8 };
  }
  if (tag === VAL_SHORT) {
    if (i + 2 > u8.length) throw new Error('EOF in short');
    return { value: { $parcel: 'java.lang.Short', value: u8[i] | (u8[i + 1] << 8) }, next: i + 2 };
  }
  if (tag === VAL_FLOAT || tag === VAL_DOUBLE) {
    const dv = new DataView(u8.buffer, u8.byteOffset + i, tag === VAL_FLOAT ? 4 : 8);
    const value = tag === VAL_FLOAT ? dv.getFloat32(0, true) : dv.getFloat64(0, true);
    return { value: { $parcel: tag === VAL_FLOAT ? 'java.lang.Float' : 'java.lang.Double', value }, next: i + (tag === VAL_FLOAT ? 4 : 8) };
  }
  if (tag === VAL_STRINGARRAY || tag === VAL_CHARSEQUENCEARRAY) {
    const n = i32(u8, i);
    i = n.next;
    if (n.value < 0 || n.value > 1000) throw new Error('bad string array length');
    const out = [];
    for (let k = 0; k < n.value; k++) {
      const s = parcelString(u8, i);
      i = s.next;
      out.push(s.value);
    }
    return { value: out, next: i };
  }
  if (LEN_PREFIXED.has(tag)) {
    const ln = i32(u8, i);
    i = ln.next;
    if (ln.value < 0) return { value: null, next: i };
    const end = i + ln.value;
    if (end > u8.length) throw new Error('EOF in length-prefixed value');
    if (tag === VAL_BUNDLE) {
      const b = decodeParcelBundle(u8, i);
      if (b.end !== end) throw new Error('nested bundle length mismatch');
      return { value: b.values, next: end };
    }
    if (tag === VAL_LIST) {
      const n = i32(u8, i);
      i = n.next;
      const out = [];
      for (let k = 0; k < n.value; k++) {
        const v = parcelValue(u8, i, depth + 1);
        i = v.next;
        out.push(v.value);
      }
      if (i !== end) throw new Error('list length mismatch');
      return { value: out, next: end };
    }
    throw new Error(`unhandled length-prefixed parcel type ${tag}`);
  }
  throw new Error(`unhandled parcel type tag ${tag}`);
}

/** Parse a Bundle from its length field at `i`. Strict: entries must consume
 *  exactly the declared length. Exported for unit tests.
 *  @returns {{values: Object, end: number}} */
export function decodeParcelBundle(u8, i) {
  const ln = i32(u8, i);
  i = ln.next;
  if (ln.value < 12) throw new Error('bundle length too small');
  const magic = i32(u8, i);
  i = magic.next;
  if (magic.value !== 0x4c444e42) throw new Error('bad BNDL magic');
  const count = i32(u8, i);
  i = count.next;
  if (count.value < 0 || count.value > 1000) throw new Error('bad bundle entry count');
  const values = {};
  for (let k = 0; k < count.value; k++) {
    const key = parcelString(u8, i);
    i = key.next;
    if (key.value === null) throw new Error('null bundle key');
    const v = parcelValue(u8, i, 0);
    i = v.next;
    values[key.value] = v.value;
  }
  const start = ln.next - 4;
  if (i !== start + 8 + ln.value) throw new Error('bundle entries do not fill the declared length');
  return { values, end: i };
}

/* ---- .flo header (D0.e — same fields as floParser.js T0) ---- */

function floVersion(u8) {
  return (u8[4] << 8) | u8[5]; // big-endian uint16
}

/** Q3.c.i()/readUTF length: varint for version >= 35, else u16 big-endian. */
function readUtfLen(u8, i, version) {
  if (version >= 35) return readVarint(u8, i);
  if (i + 2 > u8.length) throw new Error('EOF in u16 length');
  return { value: (u8[i] << 8) | u8[i + 1], next: i + 2 };
}

/* ---- anchor validation ---- */

const PACKAGE_RE = /^[a-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;
const ACTIVITY_RE = /^[A-Za-z][A-Za-z0-9_$]*(\.[A-Za-z0-9_$]+)*$/;
// package-shaped runs to try as anchors (first segment >= 2 chars, >= 2 segments)
const RUN_RE = /[a-z][a-z0-9_]{1,30}(?:\.[A-Za-z0-9_]{1,40}){1,6}/g;

function asciiSlice(u8, start, end) {
  let s = '';
  for (let i = start; i < end; i++) s += String.fromCharCode(u8[i]);
  return s;
}

/** The F0 parcel region is the varint byte count Q3.c.h reads and
 *  unmarshals. Normally exactly the Bundle; some plugins' marshalled
 *  parcels carry trailing zero padding (observed: AutoCast, 4 bytes).
 *  Allow a small zero-only tail. @returns {number|null} region end */
function bundleRegionEnd(u8, i, plen, entriesEnd) {
  const regionEnd = i + plen;
  if (entriesEnd > regionEnd || regionEnd - entriesEnd > 8) return null;
  for (let k = entriesEnd; k < regionEnd; k++) if (u8[k] !== 0) return null;
  return regionEnd;
}

/** Exact base-chain match for a plug-in statement typeId immediately before
 *  the package length varint at pkgLenPos. @returns {string|null} */
function classifyKind(u8, pkgLenPos) {
  for (const [tidStr, kind] of Object.entries(PLUGIN_KINDS)) {
    const enc = Number(tidStr) * 2; // zigzag encode of a positive typeId
    const objFields = kind === 'SETTING' ? 2 : kind === 'EVENT' ? 1 : 3;
    for (let back = 2; back < 24; back++) {
      const t = pkgLenPos - back;
      if (t < 0) break;
      let v;
      let p;
      try {
        const r = readVarint(u8, t);
        v = r.value;
        p = r.next;
      } catch (e) {
        continue;
      }
      if (v !== enc) continue;
      try {
        p = readVarint(u8, p).next; // id (slong)
        p = readVarint(u8, p).next; // x (sint)
        p = readVarint(u8, p).next; // y (sint)
        let ok = true;
        for (let k = 0; k < objFields; k++) {
          const r = readVarint(u8, p); // readObject: null / back-reference
          if (zigzag(r.value) > 0) { ok = false; break; } // inline object: chain not walkable
          p = r.next;
        }
        if (ok && p === pkgLenPos) return kind;
      } catch (e) {
        continue;
      }
    }
  }
  return null;
}

/** Try to parse an F0 body whose package length field starts at `i`.
 *  @returns {Object|null} */
function tryAnchor(u8, i, version) {
  try {
    const n = readUtfLen(u8, i, version);
    if (!(n.value >= 4 && n.value <= MAX_PKG) || n.next + n.value > u8.length) return null;
    const pkg = asciiSlice(u8, n.next, n.next + n.value);
    if (!PACKAGE_RE.test(pkg)) return null;
    let j = n.next + n.value;
    const an = readUtfLen(u8, j, version);
    if (!(an.value >= 4 && an.value <= MAX_ACT) || an.next + an.value > u8.length) return null;
    const act = asciiSlice(u8, an.next, an.next + an.value);
    if (!ACTIVITY_RE.test(act) || !act.includes('.')) return null;
    const lastSeg = act.slice(act.lastIndexOf('.') + 1);
    if (!/^[A-Z]/.test(lastSeg)) return null; // last segment must start uppercase (class name)
    j = an.next + an.value;
    const pl = readVarint(u8, j);
    j = pl.next;
    if (!(pl.value >= 12 && pl.value <= MAX_PARCEL) || j + pl.value > u8.length) return null;
    const parcelStart = j;
    const b = decodeParcelBundle(u8, parcelStart);
    const regionEnd = bundleRegionEnd(u8, parcelStart, pl.value, b.end);
    if (regionEnd === null) return null;
    let blurb = null;
    let end = regionEnd;
    const bn = readUtfLen(u8, regionEnd, version);
    if (bn.value <= MAX_BLURB && bn.next + bn.value <= u8.length) {
      try {
        blurb = decodeUtf8(u8, bn.next, bn.value);
      } catch (e) {
        blurb = asciiSlice(u8, bn.next, bn.next + bn.value);
      }
      end = bn.next + bn.value;
    }
    let varNames = [];
    let k = end;
    try {
      const vn = readVarint(u8, k);
      if (vn.value <= MAX_VARNAMES) {
        k = vn.next;
        for (let x = 0; x < vn.value; x++) {
          const sn = readUtfLen(u8, k, version);
          if (sn.value > MAX_BLURB || sn.next + sn.value > u8.length) throw new Error('bad varname');
          varNames.push(asciiSlice(u8, sn.next, sn.next + sn.value));
          k = sn.next + sn.value;
        }
      }
    } catch (e) {
      varNames = null; // mappings/tail unreadable: keep the anchor
    }
    return {
      offset: i,
      package: pkg,
      activity: act,
      kind: classifyKind(u8, i),
      bundle: b.values,
      parcelBytes: pl.value,
      blurb,
      varNames,
    };
  } catch (e) {
    return null;
  }
}

/** Minimal UTF-8 decode for blurb strings (ASCII slice is the fallback). */
function decodeUtf8(u8, start, len) {
  const bytes = u8.subarray(start, start + len);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/* ---- scanner ---- */

/** Scan a whole .flo for plug-in statements. Never throws.
 *  @param {Uint8Array} u8
 *  @returns {{version: number, statementCount: number|null, pluginCount: number,
 *            plugins: Array<Object>, error: string|null}} */
export function scanFloPlugins(u8) {
  const out = { version: null, statementCount: null, pluginCount: 0, plugins: [], error: null };
  if (!(u8 instanceof Uint8Array) || u8.length < 8
      || u8[0] !== 0x4c || u8[1] !== 0x41 || u8[2] !== 0x46 || u8[3] !== 0x6c) {
    out.error = 'not an Automate flow';
    return out;
  }
  out.version = floVersion(u8);
  try {
    let r = readVarint(u8, 6); // nextStatementId (zigzag)
    r = readVarint(u8, r.next); // statement count (plain)
    out.statementCount = r.value;
  } catch (e) {
    out.error = e && e.message ? e.message : String(e);
  }

  const latin = asciiSlice(u8, 0, u8.length);
  const seen = new Set();
  const plugins = [];
  let m;
  RUN_RE.lastIndex = 0;
  while ((m = RUN_RE.exec(latin)) !== null) {
    const start = m.index;
    // The package length varint normally ends exactly at the run start, but
    // a single-byte length in the alphanumeric range (e.g. 0x37 '7') is
    // itself a run character and shifts the anchor. Try a small window of
    // anchor starts around the run start; tryAnchor's validation rejects
    // every wrong guess.
    for (let i = Math.max(0, start - 2); i < start + 3; i++) {
      if (seen.has(i)) continue;
      const hit = tryAnchor(u8, i, out.version);
      if (hit) {
        plugins.push(hit);
        seen.add(i);
        break;
      }
    }
  }
  plugins.sort((a, b) => a.offset - b.offset);
  out.plugins = plugins;
  out.pluginCount = plugins.length;
  return out;
}
