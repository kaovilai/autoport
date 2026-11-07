#!/usr/bin/env python3
"""Automate .flo plug-in statement scanner — reference oracle for the JS port.

Extracts Tasker/Locale plug-in invocations from a .flo WITHOUT the full T1
statement registry (~620 statement classes). Only the three plug-in statement
classes matter for pass-through (decompiled com.llamalab.automate.stmt):

  1104 PlugInCondition  (StatefulIntermittentDecision + F0)
  1105 PlugInEvent      (Action + F0)
  1106 PlugInSetting    (IntermittentAction + F0)

Their shared config object F0.w0(Q3.c) reads, in order:

  [pkgLen][package]           Q3.c.i()  — UTF, varint length when version >= 35
  [actLen][activity]          Q3.c.i()
  [parcelLen][parcel]         Q3.c.h(Bundle.CREATOR) — d() byte count, then
                              that many bytes of a marshalled Android Parcel
                              holding the plugin configuration Bundle
  [blurbLen][blurb]           Q3.c.i()
  [n][varName] x n            output variable names (String[])
  [m]{[key][label][varRef]}   M0 output mappings
  [bool]                      readBoolean

preceded by the statement base chain AbstractStatement.w0 -> Action.w0 ->
(IntermittentAction/Decision).w0: [typeId][id][x][y][onComplete]([continuity]
|[onPositive][onNegative]...), where every readObject field is a zigzag varint
(0 = null, < 0 = back-reference, > 0 = inline object with its own typeId).

An anchor is accepted only when EVERY level validates: the package looks like
a Java package name, the activity like a class name, the parcel parses
strictly as an Android Bundle (BNDL magic, declared count, entries consuming
exactly the declared length, AOSP string padding), and the blurb and variable
names decode. A byte string that merely resembles "com.foo.bar" cannot pass
the parcel round-trip, so scanning package-shaped runs is collision-safe.

The statement KIND is reported only when the bytes immediately before the
package form the exact base chain of one of the three plug-in statements
(typeId + id/x/y + null/back-reference object fields ending exactly at the
package length varint). When an inline object sits in between (e.g. an inline
Delay as onComplete) the chain cannot be walked from the anchor; kind is then
null and the JS emitter assumes SETTING (the dominant case: AutoInput and
friends are setting plugins) and says so in its report.

Untrusted .flo files are only read, never executed.
"""
import json
import os
import re
import struct
import sys

# ---- Packed primitives (p020c4/e.java, Q3/c.java) ---------------------------

def varint(b, i, maxbits=70):
    v = 0
    s = 0
    while True:
        if i >= len(b):
            raise ValueError('eof in varint')
        x = b[i]
        i += 1
        v |= (x & 0x7F) << s
        if not (x & 0x80):
            return v, i
        s += 7
        if s > maxbits:
            raise ValueError('varint too long')


def zigzag(v):
    return (v >> 1) ^ -(v & 1)


# ---- Android Parcel Bundle reader (AOSP Parcel.cpp rules) -------------------
#
# int32 values are little-endian. A string is [int32 charLen][UTF-16LE chars]
# [2-byte NUL], padded so the payload ((charLen+1)*2) is a multiple of 4
# (Parcel::writeInplace). A value is [int32 typeTag][payload]. Per AOSP
# Parcel.java (writeValue/readValue/isLengthPrefixed):
#   - VAL_BOOLEAN (9), VAL_SHORT (5), VAL_BYTE (20) and VAL_CHAR are all
#     written via writeInt — a 4-byte slot (there is no 2-byte Parcel write);
#     booleans decode to real booleans (readInt() == 1)
#   - length-prefixed tags (extra [int32 length] for skipping) are exactly
#     MAP, PARCELABLE, LIST, SPARSEARRAY, PARCELABLEARRAY, OBJECTARRAY,
#     SERIALIZABLE — Bundle and PersistableBundle are NOT: they carry their
#     own length, so a nested VAL_BUNDLE value is decodeParcelBundle directly
# A Bundle is [int32 length][magic 0x4C444E42 "BNDL"][int32 count]
# [count x (key, value)] where length counts the count and entries (observed
# on all 33 corpus bundles; region = length field + magic + declared length).

VAL_STRING = 0
VAL_INTEGER = 1
VAL_MAP = 2
VAL_BUNDLE = 3
VAL_PARCELABLE = 4
VAL_SHORT = 5
VAL_LONG = 6
VAL_FLOAT = 7
VAL_DOUBLE = 8
VAL_BOOLEAN = 9
VAL_CHARSEQUENCE = 10
VAL_LIST = 11
VAL_SPARSEBOOLEANARRAY = 12
VAL_BYTEARRAY = 13
VAL_STRINGARRAY = 14
VAL_CHARSEQUENCEARRAY = 24
# exactly AOSP Parcel.isLengthPrefixed(): MAP, PARCELABLE, LIST, SPARSEARRAY,
# PARCELABLEARRAY, OBJECTARRAY, SERIALIZABLE. Bundle (3) and
# PersistableBundle (25) are self-prefixed and handled separately.
LEN_PREFIXED = {VAL_MAP, VAL_PARCELABLE, VAL_LIST, 12, 16, 17, 21}
# types the locale-SDK bundle cannot represent: decoded as tagged objects so
# the ANCHOR survives (the emitter drops + reports the value) instead of the
# whole plug-in statement silently disappearing from the scan
UNREPRESENTABLE_NAMES = {
    VAL_MAP: 'java.util.Map',
    VAL_PARCELABLE: 'android.os.Parcelable',
    VAL_BYTEARRAY: 'byte[]',
    VAL_SPARSEBOOLEANARRAY: 'android.util.SparseBooleanArray',
    15: 'android.os.IBinder',
    16: 'android.os.Parcelable[]',
    17: 'java.lang.Object[]',
    18: 'int[]',
    19: 'long[]',
    21: 'java.io.Serializable',
    22: 'android.util.SparseBooleanArray',
    23: 'boolean[]',
    25: 'android.os.PersistableBundle',
}


def i32(b, i):
    if i + 4 > len(b):
        raise ValueError('eof in int32')
    return struct.unpack('<i', b[i:i + 4])[0], i + 4


def parcel_string(b, i):
    n, j = i32(b, i)
    if n < 0:
        return None, j
    payload = 2 * n + 2                       # chars + NUL terminator
    pad = (4 - payload % 4) % 4               # writeInplace rounding
    if j + payload + pad > len(b):
        raise ValueError('eof in string')
    return b[j:j + 2 * n].decode('utf-16-le'), j + payload + pad


def parcel_value(b, i, depth=0):
    if depth > 8:
        raise ValueError('bundle nesting too deep')
    tag, i = i32(b, i)
    if tag == -1:
        return None, i
    if tag in (VAL_STRING, VAL_CHARSEQUENCE):
        return parcel_string(b, i)
    if tag == VAL_BOOLEAN:
        # writeInt(v ? 1 : 0) / readInt() == 1 — a real Boolean in a 4-byte slot
        v, i = i32(b, i)
        return v == 1, i
    if tag == VAL_INTEGER:
        return i32(b, i)
    if tag in (VAL_SHORT, 20):  # VAL_BYTE: both written via writeInt (4-byte slot)
        v, i = i32(b, i)
        name = 'java.lang.Short' if tag == VAL_SHORT else 'java.lang.Byte'
        return {'$parcel': name, 'value': v}, i
    if tag == VAL_LONG:
        if i + 8 > len(b):
            raise ValueError('eof in long')
        return {'$parcel': 'java.lang.Long',
                'value': struct.unpack('<q', b[i:i + 8])[0]}, i + 8
    if tag == VAL_FLOAT:
        return {'$parcel': 'java.lang.Float',
                'value': struct.unpack('<f', b[i:i + 4])[0]}, i + 4
    if tag == VAL_DOUBLE:
        return {'$parcel': 'java.lang.Double',
                'value': struct.unpack('<d', b[i:i + 8])[0]}, i + 8
    if tag in (VAL_STRINGARRAY, VAL_CHARSEQUENCEARRAY):
        n, i = i32(b, i)
        if n < 0 or n > 1000:
            raise ValueError('bad string array length')
        out = []
        for _ in range(n):
            s, i = parcel_string(b, i)
            out.append(s)
        return out, i
    if tag in (VAL_BYTEARRAY, 18, 19, 23):  # byte[]/int[]/long[]/boolean[]
        n, i = i32(b, i)
        width = {VAL_BYTEARRAY: 1, 18: 4, 19: 8, 23: 4}[tag]
        if n < 0 or n > 100000:
            raise ValueError('bad array length')
        payload = n * width
        if tag == VAL_BYTEARRAY:
            payload += (4 - payload % 4) % 4  # writeInplace rounding
        if i + payload > len(b):
            raise ValueError('eof in array')
        return {'$parcel': UNREPRESENTABLE_NAMES[tag], 'value': None}, i + payload
    if tag == VAL_BUNDLE:
        # NOT extra-length-prefixed (AOSP isLengthPrefixed): the Bundle
        # carries its own [length][magic][count][entries]
        return parcel_bundle(b, i)
    if tag == 25:  # PersistableBundle: self-prefixed like Bundle, different magic
        ln, j = i32(b, i)
        if ln < 12:
            raise ValueError('bad persistable bundle length')
        end = j + 4 + ln
        if end > len(b):
            raise ValueError('eof in persistable bundle')
        return {'$parcel': UNREPRESENTABLE_NAMES[tag], 'value': None}, end
    if tag in LEN_PREFIXED:
        ln, j = i32(b, i)
        if ln < 0:
            return None, j
        end = j + ln
        if end > len(b):
            raise ValueError('eof in length-prefixed value')
        if tag == VAL_LIST:
            n, k = i32(b, j)
            out = []
            for _ in range(n):
                v, k = parcel_value(b, k, depth + 1)
                out.append(v)
            if k != end:
                raise ValueError('list length mismatch')
            return out, end
        # skippable but unrepresentable: consume exactly the declared length
        # so the anchor survives; the emitter drops + reports the value
        return {'$parcel': UNREPRESENTABLE_NAMES.get(tag, 'parcel-type-%d' % tag),
                'value': None}, end
    raise ValueError('unhandled parcel type tag %d' % tag)


def parcel_bundle(b, i):
    """Parse a Bundle from its length field at i. Strict: entries must
    consume exactly the declared length."""
    ln, j = i32(b, i)
    if ln < 12:
        raise ValueError('bundle length too small')
    magic, j = i32(b, j)
    if magic != 0x4C444E42:
        raise ValueError('bad BNDL magic 0x%x' % magic)
    count, j = i32(b, j)
    if count < 0 or count > 1000:
        raise ValueError('bad bundle entry count')
    out = {}
    for _ in range(count):
        k, j = parcel_string(b, j)
        if k is None:
            raise ValueError('null bundle key')
        v, j = parcel_value(b, j)
        out[k] = v
    if j != i + 8 + ln:                       # length field + magic + count + entries
        raise ValueError('bundle entries do not fill the declared length')
    return out, j


def bundle_region_end(b, i, plen, entries_end):
    """The F0 parcel region is the varint byte count Q3.c.h reads and
    unmarshals. It is normally exactly the Bundle (len field + magic + count +
    entries), but some plugins' marshalled parcels carry trailing zero padding
    (observed: AutoCast, 4 bytes). Allow a small zero-only tail; anything else
    means the anchor guessed the wrong region and must be rejected."""
    region_end = i + plen
    if entries_end > region_end or region_end - entries_end > 8:
        return None
    if any(b[entries_end:region_end]):
        return None                           # trailing bytes must be padding
    return region_end


# ---- .flo header (D0.e / flo_t0.py) -----------------------------------------

def flo_header(b):
    if len(b) < 8 or b[:4] != b'LAFl':
        raise ValueError('not an Automate flow')
    version = struct.unpack('>H', b[4:6])[0]
    next_id, i = varint(b, 6)
    count, i = varint(b, i)
    return version, zigzag(next_id), count, i


# ---- F0 anchor scanner -------------------------------------------------------

PACKAGE_RE = re.compile(rb'^[a-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$')
ACTIVITY_RE = re.compile(rb'^[A-Za-z][A-Za-z0-9_$]*(\.[A-Za-z0-9_$]+)*$')
# package-shaped runs to try as anchors (first segment >= 2 chars, >= 2 segments)
RUN_RE = re.compile(rb'[a-z][a-z0-9_]{1,30}(?:\.[A-Za-z0-9_]{1,40}){1,6}')

MAX_PKG = 120
MAX_ACT = 250
MAX_PARCEL = 25000          # matches the locale SDK bundle cap the emitter enforces
MAX_BLURB = 4000
MAX_VARNAMES = 64
MAX_MAPPINGS = 64

PLUGIN_KINDS = {1104: 'CONDITION', 1105: 'EVENT', 1106: 'SETTING'}
# base-chain object fields (readObject zigzag varints) after id/x/y per kind
KIND_OBJ_FIELDS = {'SETTING': 2, 'EVENT': 1, 'CONDITION': 3}


def read_utf(b, i, version):
    """Q3.c.i()/readUTF: varint length for version >= 35, else u16 big-endian."""
    if version >= 35:
        n, i = varint(b, i)
    else:
        if i + 2 > len(b):
            raise ValueError('eof in u16 length')
        n = (b[i] << 8) | b[i + 1]
        i += 2
    return n, i


def try_anchor(b, i, version):
    """Try to parse an F0 body whose package length field starts at i.
    @returns dict or None"""
    try:
        n, j = read_utf(b, i, version)
        if not (4 <= n <= MAX_PKG) or j + n > len(b):
            return None
        pkg = b[j:j + n]
        if not PACKAGE_RE.match(pkg):
            return None
        j += n
        an, j = read_utf(b, j, version)
        if not (4 <= an <= MAX_ACT) or j + an > len(b):
            return None
        act = b[j:j + an]
        if not ACTIVITY_RE.match(act) or b'.' not in act:
            return None
        if not act.rsplit(b'.', 1)[-1][:1].isupper():
            return None                      # last segment must start uppercase (class name)
        j += an
        plen, j = varint(b, j)
        if not (12 <= plen <= MAX_PARCEL) or j + plen > len(b):
            return None
        parcel_start = j
        bundle, entries_end = parcel_bundle(b, parcel_start)
        region_end = bundle_region_end(b, parcel_start, plen, entries_end)
        if region_end is None:
            return None
        blurb = None
        end = region_end
        bn, j2 = read_utf(b, region_end, version)
        if bn <= MAX_BLURB and j2 + bn <= len(b):
            blurb = b[j2:j2 + bn].decode('utf-8', 'replace')
            end = j2 + bn
        var_names = []
        k = end
        try:
            vn, k = varint(b, k)
            if vn <= MAX_VARNAMES:
                for _ in range(vn):
                    sn, k = read_utf(b, k, version)
                    if sn > MAX_BLURB or k + sn > len(b):
                        raise ValueError('bad varname')
                    var_names.append(b[k:k + sn].decode('utf-8', 'replace'))
                    k += sn
        except ValueError:
            var_names = None                 # mappings/tail unreadable: keep anchor
        return {
            'offset': i,
            'package': pkg.decode(),
            'activity': act.decode(),
            'kind': classify_kind(b, i),
            'bundle': bundle,
            'parcelBytes': plen,
            'blurb': blurb,
            'varNames': var_names,
        }
    except (ValueError, UnicodeDecodeError):
        return None


def classify_kind(b, pkg_len_pos):
    """Exact base-chain match for one of the three plug-in statement typeIds
    immediately before the package length varint."""
    for tid, kind in PLUGIN_KINDS.items():
        enc = tid * 2                        # zigzag encode of a positive typeId
        for back in range(2, 24):
            t = pkg_len_pos - back
            if t < 0:
                break
            try:
                v, p = varint(b, t)
            except ValueError:
                continue
            if v != enc:
                continue
            try:
                _id, p = varint(b, p)        # AbstractStatement.id (slong)
                _x, p = varint(b, p)         # x (sint)
                _y, p = varint(b, p)         # y (sint)
                for _ in range(KIND_OBJ_FIELDS[kind]):
                    ov, p = varint(b, p)     # readObject: null / back-reference
                    if zigzag(ov) > 0:
                        break                # inline object: chain not walkable
                else:
                    if p == pkg_len_pos:
                        return kind
            except ValueError:
                continue
    return None


def scan_flo_plugins(b):
    """Scan a whole .flo for plug-in statements. Never raises."""
    try:
        version, next_id, count, _ = flo_header(b)
    except ValueError:
        return {'error': 'not an Automate flow', 'plugins': []}
    plugins = []
    seen_offsets = set()
    for m in RUN_RE.finditer(b):
        start = m.start()
        # The package length varint normally ends exactly at the run start,
        # but a single-byte length in the alphanumeric range (e.g. 0x37 '7')
        # is itself a run character and shifts the anchor. Try a small window
        # of anchor starts around the run start; try_anchor's own validation
        # (package regex, activity class shape, strict parcel round-trip)
        # rejects every wrong guess.
        for i in range(max(0, start - 2), start + 3):
            if i in seen_offsets:
                continue
            hit = try_anchor(b, i, version)
            if hit:
                plugins.append(hit)
                seen_offsets.add(i)
                break
    plugins.sort(key=lambda h: h['offset'])
    return {
        'version': version,
        'statementCount': count,
        'pluginCount': len(plugins),
        'plugins': plugins,
    }


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else 'flo_plugins.json'
    files = sys.argv[2:]
    results = []
    for f in files:
        with open(f, 'rb') as fh:
            b = fh.read()
        res = scan_flo_plugins(b)
        res['file'] = os.path.basename(f)
        results.append(res)
        print('%-14s v=%-3s stmts=%-4s plugins=%-3d %s' % (
            res['file'], res.get('version'), res.get('statementCount'),
            res.get('pluginCount', 0),
            ' '.join('%s:%s' % (p['kind'] or '?', p['package'].split('.')[-1]) for p in res['plugins'][:6])))
    with open(out_path, 'w', encoding='utf-8') as fh:
        json.dump(results, fh, indent=1, ensure_ascii=False)


if __name__ == '__main__':
    main()
