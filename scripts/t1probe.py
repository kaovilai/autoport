#!/usr/bin/env python3
"""T1 feasibility probe: recursive Packed reader for a SUBSET of Automate classes.

Grounded in the decompiled reader (Q3/c.java, Q3/g.java registry, per-class w0):
  readObject -> zigzag-LEB128 varint type id
      > 0  : new object; object is appended to the object table BEFORE its body
      == 0 : null
      < 0  : back-reference to object table index (-id - 1)
  every "e" object body starts with AbstractStatement.w0: id(long), x(int), y(int).

Only a handful of classes are implemented; on an unknown type id the probe
reports the exact byte offset and class id, which is what makes the T1 cost
estimate concrete. Untrusted .flo files are only read, never executed.
"""
import json
import os
import struct
import sys

# ---- primitives (p020c4/e.java) ---------------------------------------------


class Reader:
    def __init__(self, buf):
        self.b = buf
        self.i = 0
        self.objects = []        # object table, filled before bodies are read
        self.version = 0
        self.utf_varint = False  # true when version >= 35
        self.depth = 0
        self.trace = []

    def u8(self):
        v = self.b[self.i]
        self.i += 1
        return v

    def varint(self, maxbits=35):
        v = 0
        s = 0
        while True:
            x = self.u8()
            v |= (x & 0x7F) << s
            if not x & 0x80:
                return v
            s += 7
            if s > maxbits:
                raise ValueError("varint too long")

    def zz(self, v):
        return (v >> 1) ^ -(v & 1)

    def sint(self):
        return self.zz(self.varint())

    def slong(self):
        return self.zz(self.varint(63))

    def boolean(self):
        return self.u8() != 0

    def f64(self):
        v = struct.unpack(">d", self.b[self.i:self.i + 8])[0]
        self.i += 8
        return v

    def i32(self):
        v = struct.unpack(">i", self.b[self.i:self.i + 4])[0]
        self.i += 4
        return v

    def utf(self):
        n = self.varint() if self.utf_varint else (self.u8() << 8 | self.u8())
        raw = self.b[self.i:self.i + n]
        self.i += n
        return raw.decode("utf-8", "replace")

    # ---- object graph ----
    def read_object(self):
        tid = self.zz(self.varint())
        if tid == 0:
            return None
        if tid < 0:
            return self.objects[-tid - 1]
        fn = READERS.get(tid)
        if fn is None:
            raise UnknownType(tid, self.i)
        self.trace.append((self.depth, tid, self.i))
        obj = {"_type_id": tid, "_type": NAMES.get(tid, "?")}
        self.objects.append(obj)      # appended BEFORE body (Q3/g$a.a)
        self.depth += 1
        try:
            fn(self, obj)
        finally:
            self.depth -= 1
        return obj


class UnknownType(Exception):
    def __init__(self, tid, pos):
        self.tid, self.pos = tid, pos
        super().__init__("unknown type id %d at offset %d" % (tid, pos))


# ---- class readers (mirror the decompiled w0 methods) -----------------------
READERS = {}
NAMES = {}


def cls(tid, name):
    def deco(fn):
        READERS[tid] = fn
        NAMES[tid] = name
        return fn
    return deco


def base_statement(r, o):
    o["id"] = r.slong()
    o["x"] = r.sint()
    o["y"] = r.sint()


def action(r, o):
    base_statement(r, o)
    o["onComplete"] = r.read_object()


@cls(102, "Text")
def _text(r, o):
    o["text"] = r.utf()


@cls(104, "DoubleLiteral")
def _dbl(r, o):
    o["value"] = r.f64()


@cls(106, "StringLiteral")
def _str(r, o):
    o["value"] = r.utf()


@cls(1072, "FlowBeginning")
def _begin(r, o):
    action(r, o)
    o["title"] = r.utf()
    if r.version >= 66:
        o["hidden"] = r.boolean()
    o["parallel"] = r.boolean()
    o["varPayload"] = r.read_object()
    if r.version >= 43:
        o["varFiberUri"] = r.read_object()


@cls(1012, "VariableAssign")
def _assign(r, o):
    action(r, o)
    o["value"] = r.read_object()
    o["variable"] = r.read_object()


@cls(1120, "ToastShow")
def _toast(r, o):
    action(r, o)
    if 99 <= r.version:
        o["continuity"] = r.read_object()
    o["message"] = r.read_object()
    if r.version >= 46:
        o["duration"] = r.read_object()


@cls(1278, "Subroutine")
def _sub(r, o):
    action(r, o)
    o["onChildFiber"] = r.read_object()
    n = r.varint()
    o["returnVariables"] = [r.read_object() for _ in range(n)]


@cls(1060, "Fork")
def _fork(r, o):
    action(r, o)
    o["onChildFiber"] = r.read_object()
    if 9 <= r.version:
        o["stopWithParent"] = r.boolean()
    o["varChildFiberUri"] = r.read_object()
    if 23 <= r.version:
        o["varParentFiberUri"] = r.read_object()


def decision(r, o):
    """Decision.w0: Action + onPositive + onNegative + subclass q()."""
    action(r, o)
    o["onPositive"] = r.read_object()
    o["onNegative"] = r.read_object()


def activity_decision(r, o):
    """ActivityDecision.q: timeout, startActivity, notificationChannelId."""
    decision(r, o)
    o["timeout"] = r.read_object()
    if 9 <= r.version:
        o["startActivity"] = r.read_object()
    if 77 <= r.version:
        o["notificationChannelId"] = r.read_object()


@cls(1053, "DialogConfirm")
def _confirm(r, o):
    activity_decision(r, o)
    o["title"] = r.read_object()
    o["message"] = r.read_object()
    if 90 <= r.version:
        o["linkify"] = r.read_object()
    if 5 <= r.version:
        o["positive"] = r.read_object()
        o["negative"] = r.read_object()


@cls(1054, "DialogInput")
def _input(r, o):
    activity_decision(r, o)
    o["title"] = r.read_object()
    o["inputType"] = r.read_object()
    o["regex"] = r.read_object()
    if 79 <= r.version:
        o["hint"] = r.read_object()
    if 31 <= r.version:
        o["prepopulate"] = r.read_object()
    if 103 <= r.version:
        o["suggestions"] = r.read_object()
    o["varResultText"] = r.read_object()


@cls(1280, "DialogWeb")
def _web(r, o):
    activity_decision(r, o)
    o["allowed"] = r.i32() if 97 <= r.version else 51
    for k in ("url", "body", "regex", "account"):
        o[k] = r.read_object()
    if 115 <= r.version:
        o["alias"] = r.read_object()
    if 79 <= r.version:
        o["userAgent"] = r.read_object()
    if 103 <= r.version:
        o["viewport"] = r.read_object()
    o["varResultUrl"] = r.read_object()
    o["varResultTitle"] = r.read_object()


@cls(1087, "HttpRequest")
def _http(r, o):
    action(r, o)
    if 74 <= r.version:
        o["networkInterface"] = r.read_object()
    for k in ("url", "method", "account"):
        o[k] = r.read_object()
    if 82 <= r.version:
        o["timeout"] = r.read_object()
    if 109 <= r.version:
        o["alias"] = r.read_object()
    if 45 <= r.version:
        o["trust"] = r.read_object()
    if 47 <= r.version:
        o["dontRedirect"] = r.read_object()
    for k in ("contentType", "bodyPart"):
        o[k] = r.read_object()
    if 82 <= r.version:
        o["bodyPath"] = r.read_object()
    if 35 <= r.version:
        o["headers"] = r.read_object()
    for k in ("saveResponse", "responsePath", "varResponseCode", "varResponseBody"):
        o[k] = r.read_object()
    if 35 <= r.version:
        o["varResponseHeaders"] = r.read_object()


@cls(1006, "AppForeground")
def _fg(r, o):
    decision(r, o)
    o["continuity"] = r.read_object()
    o["packageName"] = r.read_object()
    o["className"] = r.read_object()
    o["varForegroundPackageName"] = r.read_object()
    o["varForegroundClassName"] = r.read_object()


# ---- literals / interpolations ---------------------------------------------
@cls(101, "BooleanLiteral")          # K3.C1048s extends K3.J -> readDouble
def _bool(r, o):
    o["value"] = r.f64()


def interpolate(r, o):               # K3.AbstractC1035e.w0 = two operands
    o["left"] = r.read_object()
    o["right"] = r.read_object()


for _tid, _name in ((110, "Add"), (119, "Interpolate"), (132, "Interpolate2"),
                    (133, "Interpolate3")):
    READERS[_tid] = interpolate
    NAMES[_tid] = _name


@cls(105, "ArrayLiteral")            # K3.V: n keys (UTF), n-1 values, then (n-1)/8+1 flag bytes
def _array(r, o):
    n = r.varint()
    o["keys"] = [r.utf() for _ in range(n)]
    o["values"] = [r.read_object() for _ in range(max(0, n - 1))]
    r.i += ((max(0, n - 1)) // 8) + 1
    return o

@cls(1046, "Delay")
def _delay(r, o):
    action(r, o)
    o["continuity"] = r.read_object()
    o["wakeup"] = r.read_object()
    o["duration"] = r.read_object()


@cls(1073, "ForEach")
def _foreach(r, o):
    action(r, o)
    o["onEachElement"] = r.read_object()
    o["container"] = r.read_object()
    if 47 <= r.version:
        o["until"] = r.read_object()
    for k in ("varEntryValue", "varEntryIndex", "varEntryKey"):
        o[k] = r.read_object()


@cls(1297, "ContentQuery")
def _query(r, o):
    action(r, o)
    for k in ("uri", "projection", "selection"):
        o[k] = r.read_object()
    if 68 <= r.version:
        o["parameters"] = r.read_object()
    for k in ("sortOrder", "offset", "limit"):
        o[k] = r.read_object()
    if 68 <= r.version:
        o["resultType"] = r.read_object()
    if 112 <= r.version:
        o["columnResultType"] = r.read_object()
    o["varResult"] = r.read_object()


@cls(1146, "WifiNetworkConnected")
def _wifi(r, o):
    decision(r, o)
    o["continuity"] = r.read_object()
    if 2 <= r.version:
        o["ssid"] = r.read_object()
        o["bssid"] = r.read_object()
    o["varConnectedSsid"] = r.read_object()
    o["varConnectedBssid"] = r.read_object()
    if 73 <= r.version:
        o["varConnectedCapabilities"] = r.read_object()
        o["varConnectedLinkSpeed"] = r.read_object()
    if 79 <= r.version:
        o["varConnectedFrequency"] = r.read_object()
    if 95 <= r.version:
        o["varConnectedIpAddress"] = r.read_object()


@cls(1052, "DialogChoice")
def _choice(r, o):
    activity_decision(r, o)
    o["title"] = r.read_object()
    o["choiceTitles"] = r.read_object()
    if 107 <= r.version:
        o["choiceDescriptions"] = r.read_object()
    o["multiselect"] = r.read_object()
    if 60 <= r.version:
        o["noselect"] = r.read_object()
    if 36 <= r.version:
        o["preselected"] = r.read_object()
    o["sort"] = r.read_object()
    o["varSelectedIndices"] = r.read_object()


@cls(1026, "CallIncoming")
def _call(r, o):
    action(r, o)
    o["continuity"] = r.read_object()
    if 31 <= r.version:
        o["phoneNumber"] = r.read_object()
    if 45 <= r.version:
        o["subscriptionId"] = r.read_object()
    o["varPhoneNumber"] = r.read_object()
    if 66 <= r.version:
        o["varSubscriptionId"] = r.read_object()


# ---- flow header (D0.e / D0.S) ---------------------------------------------
def parse_flow(buf):
    r = Reader(buf)
    if buf[:4] != b"LAFl":
        raise ValueError("bad magic: %r" % buf[:4])
    r.version = (buf[4] << 8) | buf[5]          # p(int) -> writeShort, big-endian
    r.i = 6
    r.utf_varint = r.version >= 35
    next_id = r.slong()                        # D0.f14665x1
    count = r.varint()                         # D0.S: dVar.f(this.f14663Z.length)
    statements = []
    err = None
    try:
        for _ in range(count):
            statements.append(r.read_object())
    except UnknownType as e:
        err = {"unknown_type_id": e.tid,
               "unknown_type_name": NAMES.get(e.tid, "unregistered/unknown"),
               "at_offset": e.pos,
               "recent_object_stack": [
                   {"depth": d, "type_id": t, "name": NAMES.get(t, "?"), "body_start": o}
                   for d, t, o in r.trace[-8:]]}
    return {
        "version": r.version,
        "next_statement_id": next_id,
        "declared_statement_count": count,
        "parsed_statements": len(statements),
        "bytes_consumed": r.i,
        "file_size": len(buf),
        "trailing_bytes": len(buf) - r.i,
        "parse_complete": err is None and r.i == len(buf),
        "error": err,
        "objects_created": len(r.objects),
        "statements": statements,
    }


def main():
    outdir = sys.argv[1] if len(sys.argv) > 1 else "out"
    files = sys.argv[2:]
    results = []
    for f in files:
        buf = open(f, "rb").read()
        try:
            res = parse_flow(buf)
        except Exception as e:
            res = {"error": repr(e)}
        res["file"] = os.path.basename(f)
        results.append(res)
        print("%-14s v=%-3s count=%-3s parsed=%-3s consumed=%d/%d complete=%s %s" % (
            res["file"], res.get("version"), res.get("declared_statement_count"),
            res.get("parsed_statements"), res.get("bytes_consumed", -1),
            res.get("file_size", -1), res.get("parse_complete"),
            res.get("error") or ""))
    with open(os.path.join(outdir, "t1probe.json"), "w") as fh:
        json.dump(results, fh, indent=2)


if __name__ == "__main__":
    main()
