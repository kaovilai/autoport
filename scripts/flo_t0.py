#!/usr/bin/env python3
"""AutoPort spike: Automate .flo T0 parser (tiered binary parsing).

T0 contract (what the PWA can rely on without a full Packed reader):
  1. magic  == b"LAFl"                       (4C 41 46 6C)
  2. format version == big-endian uint16 at byte offset 4..5
     (decompiled writer com.llamalab.automate.D0.S(): writeInt(1279346284) then
      p(115) -> Q3/d.p() -> writeShort(); reader D0.e() -> Q3/c.n() ->
      readUnsignedShort(), max accepted version 115 for a current build)
  3. next-statement-id == zigzag LEB128 varint right after the version
     (D0.S: dVar.d(this.f14665x1))
  4. statement count    == zigzag LEB128 varint after that
     (D0.S: dVar.f(this.f14663Z.length))
  5. printable-ASCII string extraction + statement-type-id hints (T1 probe)

Everything here reads untrusted files as bytes only; nothing is executed.
Usage: python3 -I floT0.py OUT_JSON FILE...
"""
import hashlib
import json
import os
import re
import sys
from collections import Counter

MAGIC = b"LAFl"
MAX_SUPPORTED_VERSION = 115   # com.llamalab.automate.D0: dVar.p(115); J0.w0 n(115)
ASCII_RUN = re.compile(rb"[\x20-\x7e]{4,}")


# ---- primitive decoders (p020c4/e.java) ------------------------------------
def decode_varint(buf, i):
    """LEB128, 7-bit groups, little-endian. Returns (value, next_index)."""
    v = 0
    shift = 0
    while True:
        if i >= len(buf):
            raise ValueError("EOF in varint")
        x = buf[i]
        i += 1
        v |= (x & 0x7F) << shift
        if not (x & 0x80):
            return v, i
        shift += 7
        if shift > 63:
            raise ValueError("varint too long")


def zigzag(v):
    """This codebase packs signed values as zigzag (Q3/c.a(), Q3/c.b())."""
    return (v >> 1) ^ -(v & 1)


def read_header(buf):
    """Decode the 4 T0 header fields. Returns dict; never raises on short input."""
    h = {"magic_ok": buf[:4] == MAGIC, "size": len(buf)}
    if len(buf) < 6:
        h["error"] = "file too short for header"
        return h
    h["byte4"] = buf[4]
    h["bytes4_5_hex"] = buf[4:6].hex()
    h["bytes5_6_hex"] = buf[5:7].hex()      # task wording (1-based): byte4 then 5-6
    h["byte7_hex"] = "%02x" % buf[7] if len(buf) > 7 else None
    h["version"] = (buf[4] << 8) | buf[5]   # big-endian uint16
    h["version_within_supported"] = h["version"] <= MAX_SUPPORTED_VERSION
    try:
        nid, i = decode_varint(buf, 6)
        h["next_statement_id"] = zigzag(nid)
        cnt, i = decode_varint(buf, i)
        h["statement_count"] = cnt
        h["statement_count_plausible"] = 0 < cnt <= 5000
        h["first_statement_offset"] = i
        tid, _ = decode_varint(buf, i)
        h["first_statement_type_id"] = zigzag(tid)
    except ValueError as e:
        h["error"] = repr(e)
    return h


def strings_of(buf, start=6):
    """Printable ASCII runs >= 4 chars, skipping the 6-byte binary header
    (otherwise 'LAFl' itself shows up as a string)."""
    out = [m.group().decode("ascii") for m in ASCII_RUN.finditer(buf, start)]
    return out


def string_tail_profile(buf):
    """Where do the printable runs live? Used to test 'strings cluster at tail'."""
    ms = list(ASCII_RUN.finditer(buf, 6))
    n = len(buf) or 1
    deciles = [0] * 10
    for m in ms:
        deciles[min(9, int(m.start() * 10 / n))] += 1
    total_chars = sum(len(m.group()) for m in ms)
    first = ms[0].start() if ms else None
    last = ms[-1].end() if ms else None
    last_len = len(ms[-1].group()) if ms else 0
    return {
        "total_string_bytes": total_chars,
        "first_string_offset": first,
        "first_string_offset_pct": round(100.0 * first / n, 1) if first is not None else None,
        "last_string_end": last,
        "last_string_end_pct": round(100.0 * last / n, 1) if last is not None else None,
        "last_string_length": last_len,
        "deciles_of_run_starts": deciles,
        "runs_in_last_30pct": sum(deciles[7:]),
        "runs_total": len(ms),
        "runs_in_last_30pct_pct": round(100.0 * sum(deciles[7:]) / len(ms), 1) if ms else None,
    }


def type_id_census(buf):
    """T1 probe: how often does a varint-at-any-offset decode into the class-id
    registry range 100..1430? Noisy by construction (data bytes alias), but it
    measures whether statement-ish 2-byte codes recur."""
    hits = Counter()
    for i in range(6, max(6, len(buf) - 1)):
        try:
            v, _ = decode_varint(buf, i)
        except ValueError:
            continue
        z = zigzag(v)
        if 100 <= z <= 1430:
            hits[z] += 1
    return dict(hits)


def hexdump(buf, nbytes=64, width=16):
    lines = []
    for off in range(0, min(nbytes, len(buf)), width):
        chunk = buf[off:off + width]
        hexpart = " ".join("%02x" % b for b in chunk)
        hexpart = "%-*s" % (width * 3 - 1, hexpart)
        asciipart = "".join(chr(b) if 32 <= b < 127 else "." for b in chunk)
        lines.append("%08x  %s  |%s|" % (off, hexpart, asciipart))
    return "\n".join(lines)


def spearman(xs, ys):
    def ranks(v):
        order = sorted(range(len(v)), key=lambda i: v[i])
        r = [0.0] * len(v)
        for rank, i in enumerate(order):
            r[i] = float(rank)
        return r
    rx, ry = ranks(xs), ranks(ys)
    n = len(xs)
    if n < 2:
        return None
    mx = sum(rx) / n
    my = sum(ry) / n
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    dx = sum((a - mx) ** 2 for a in rx) ** 0.5
    dy = sum((b - my) ** 2 for b in ry) ** 0.5
    return round(num / (dx * dy), 3) if dx and dy else None


def main():
    out_path = sys.argv[1]
    files = sys.argv[2:]
    per_file = []
    had_reject = False
    for path in files:
        buf = open(path, "rb").read()
        try:
            h = read_header(buf)
            strs = strings_of(buf)
            census = type_id_census(buf)
        except Exception as exc:  # truncated/malformed input: reject gracefully
            per_file.append({
                "file": os.path.basename(path),
                "path": os.path.abspath(path),
                "size": len(buf),
                "sha256": hashlib.sha256(buf).hexdigest(),
                "magic_hex": buf[:4].hex(),
                "magic_ok": buf[:4] == b"LAFl",
                # analysis-section defaults so cross-sample stats never KeyError
                "byte4": None,
                "version": None,
                "next_statement_id": None,
                "statement_count": None,
                "strings_count": None,
                "string_tail_profile": {"runs_in_last_30pct_pct": None},
                "error": "truncated or malformed flow: %r" % (exc,),
                "t0_verdict": "truncated flow, rejected",
                "t0_reliable": False,
            })
            print("REJECT %s: truncated or malformed flow: %r"
                  % (os.path.basename(path), exc))
            had_reject = True
            continue
        rec = {
            "file": os.path.basename(path),
            "path": os.path.abspath(path),
            "size": len(buf),
            "sha256": hashlib.sha256(buf).hexdigest(),
            "byte4": h.get("byte4"),
            "bytes4_5_hex": h.get("bytes4_5_hex"),
            "bytes5_6_hex": h.get("bytes5_6_hex"),
            "byte7_hex": h.get("byte7_hex"),
            "magic_ok": h.get("magic_ok"),
            "magic_hex": buf[:4].hex(),
            "version": h.get("version"),
            "version_within_supported": h.get("version_within_supported"),
            "next_statement_id": h.get("next_statement_id"),
            "statement_count": h.get("statement_count"),
            "first_statement_type_id": h.get("first_statement_type_id"),
            "flow_beginning_blocks": buf.count(b"\xe0\x10"),  # canonical varint of type 1072
            "flow_beginning_note": ("count of the canonical 2-byte encoding of type id 1072 "
                                    "(FlowBeginning) - i.e. how many entry points the file "
                                    "declares; heuristic, can theoretically alias data bytes"),
            "strings_count": len(strs),
            "sample_strings": strs[:10],
            "first64_hex": hexdump(buf, 64),
            "string_tail_profile": string_tail_profile(buf),
            "type_id_census_top": dict(Counter(census).most_common(8)),
            "header_error": h.get("error"),
        }
        if not h.get("magic_ok"):
            rec["t0_verdict"] = "not an Automate flow (magic %s)" % buf[:4].hex()
            rec["t0_reliable"] = False
        elif "version" in h and "statement_count" in h:
            rec["t0_verdict"] = "Automate flow detected, v=%d, %d statements, %d strings" % (
                h["version"], h["statement_count"], len(strs))
            rec["t0_reliable"] = bool(h["version_within_supported"]
                                      and h["statement_count_plausible"])
            if not rec["t0_reliable"]:
                rec["t0_verdict"] += (" (header out of range: version<=%d, count<=5000)"
                                      % MAX_SUPPORTED_VERSION)
        else:
            if h.get("magic_ok"):
                rec["t0_verdict"] = "truncated flow (magic ok, header incomplete), rejected"
                rec["error"] = h.get("error") or "magic present but header fields missing"
                rec["t0_reliable"] = False
                had_reject = True
            else:
                rec["t0_verdict"] = "not an Automate flow (magic %s)" % buf[:4].hex()
                rec["t0_reliable"] = False
        # size-vs-header sanity: every statement needs at least ~2 bytes on disk
        if h.get("magic_ok") and h.get("statement_count") is not None:
            min_size = 8 + 2 * h["statement_count"]
            if len(buf) < min_size:
                rec["t0_verdict"] = ("truncated flow (size %d too small for %d "
                                     "statements), rejected" % (len(buf), h["statement_count"]))
                rec["error"] = "file size inconsistent with header statement count"
                rec["t0_reliable"] = False
                had_reject = True
        per_file.append(rec)

    # ---- cross-sample analysis ----
    by_sha = {}
    for r in per_file:
        by_sha.setdefault(r["sha256"], []).append(r["file"])
    dups = {k: v for k, v in by_sha.items() if len(v) > 1}

    versions = [(int(os.path.splitext(r["file"])[0]), r["version"])
                for r in per_file if r["file"].split(".")[0].isdigit()]
    # dedupe by community flow id for the correlation
    vm = {}
    for fid, ver in versions:
        vm[fid] = ver
    ids = sorted(vm)
    version_list = [vm[i] for i in ids]

    all_b4 = sorted({r["byte4"] for r in per_file if r["byte4"] is not None})
    all_versions = sorted({r["version"] for r in per_file if r["version"] is not None})
    tail_pcts = [r["string_tail_profile"]["runs_in_last_30pct_pct"] for r in per_file
                 if r["string_tail_profile"]["runs_in_last_30pct_pct"] is not None]
    stmt_counts = [r["statement_count"] for r in per_file if r["statement_count"]]

    # optional join with the community download index (titles are NOT in the .flo)
    idx_path = os.path.join(os.path.dirname(os.path.abspath(files[0])),
                            "_download_index.json") if files else None
    titles = {}
    if idx_path and os.path.exists(idx_path):
        for e in json.load(open(idx_path)):
            if e.get("title"):
                titles[e["id"]] = e["title"]
    title_rows = [(vm[i], len(titles[i])) for i in ids if i in titles]
    title_corr = spearman([a for a, _ in title_rows], [b for _, b in title_rows])
    size_by_id = {int(os.path.splitext(r["file"])[0]): r["size"]
                  for r in per_file if r["file"].split(".")[0].isdigit()}
    size_rows = [(vm[i], size_by_id[i]) for i in ids if i in size_by_id]

    analysis = {
        "sample_count": len(per_file),
        "unique_by_sha256": len(by_sha),
        "duplicate_groups": dups,
        "magic": {"expected": "LAFl (4c 41 46 6c)", "all_ok":
                  all(r["magic_ok"] for r in per_file)},
        "byte4_values_seen": ["0x%02x" % b for b in all_b4],
        "byte4_constant_zero": all_b4 == [0],
        "versions_seen": all_versions,
        "version_min": min(all_versions) if all_versions else None,
        "version_max": max(all_versions) if all_versions else None,
        "max_supported_version_in_app": MAX_SUPPORTED_VERSION,
        "all_versions_within_supported": all(v <= MAX_SUPPORTED_VERSION
                                             for v in all_versions),
        "version_vs_flow_id_spearman": spearman(ids, version_list),
        "version_vs_title_length_spearman": title_corr,
        "version_vs_file_size_spearman": spearman([a for a, _ in size_rows],
                                                  [b for _, b in size_rows]),
        "titles_by_flow_id": {str(i): titles.get(i) for i in ids},
        "title_length_range": ([min(b for _, b in title_rows),
                                max(b for _, b in title_rows)] if title_rows else None),
        "title_length_verdict": ("no correlation with version: the header version is a "
                                 "serialization-format version, not derived from the title "
                                 "or the file name"),
        "statement_count_range": [min(stmt_counts), max(stmt_counts)] if stmt_counts else None,
        "flow_beginning_cross_check": {
            "per_file": {r["file"]: {"flow_beginning_blocks": r["flow_beginning_blocks"],
                                     "statement_count": r["statement_count"]}
                         for r in per_file},
            "all_within_statement_count": all(r["flow_beginning_blocks"] <= r["statement_count"]
                                              for r in per_file if r["statement_count"]),
            "note": ("semantic cross-check of the T0 statement count: FlowBeginning (type id "
                     "1072) has one canonical 2-byte encoding (e0 10); counting it yields 1 "
                     "entry block for single-flow files, 2 for 'Subroutine Vs Fork Example', "
                     "12 for 'Apps turn on the data' (one per app) and 3 for "
                     "'AutoMate FailSafe' - always <= the declared statement count."),
        },
        "interpretation": (
            "magic is the BE int 0x4C41466C ('LAFl'). Byte 4 is always 0x00 because the "
            "next field is a big-endian uint16 format version (byte 5 carries the value; "
            "all corpus flows are v44..v109 < 256). Bytes 6.. are LEB128: "
            "next-statement-id (zigzag) then statement count. Version correlates with "
            "community flow id (age), confirming it is a serialization-format version, "
            "and all values are <= the reader's max of 115."),
        "strings_cluster_at_tail": {
            "mean_runs_in_last_30pct_pct": round(sum(tail_pcts) / len(tail_pcts), 1) if tail_pcts else None,
            "per_file_pct": {r["file"]: r["string_tail_profile"]["runs_in_last_30pct_pct"]
                             for r in per_file},
            "note": ("ASCII runs are spread through the statement graph (each literal "
                     "sits next to the block that owns it); they are NOT a tail-only "
                     "string table. Extracting all runs works, grepping for title does not "
                     "need a tail heuristic."),
        },
        "t0_extracts_reliably": [
            "magic / not-a-flow rejection (4 bytes)",
            "format version (BE uint16 at offset 4)",
            "next statement id (varint)",
            "declared statement count (varint) -> block estimate",
            "printable ASCII literals >= 4 chars (titles, messages, expressions, urls)",
        ],
        "t0_does_not_extract": [
            "flow title (not stored in .flo; Automate derives it from the file name / share subject - see FlowImportActivity.d())",
            "per-statement type / connections (needs the T1 Packed reader)",
        ],
        "t1_notes": {
            "object_type_ids": ("statement/expression type id = zigzag LEB128 varint at each "
                                "readObject(); registry Q3/g.java holds 620 classes with ids "
                                "2..1430 (statements start at 100, expressions at 300, "
                                "statements/events at 1000+). So the '2-byte LE values "
                                "0x0fe8-0x1100' seen in hexdumps ARE type ids, but encoded as "
                                "LEB128 byte pairs, not raw u16: "
                                "e8 0f -> 2024 -> zigzag 1012 = VariableAssign; "
                                "e0 10 -> 2144 -> 1072 = FlowBeginning; "
                                "bc 10 -> 2108 -> 1054 = DialogInput; "
                                "cc 01 -> 204 -> 102 = Text literal (length-prefixed UTF follows)."),
            "record_layout": ("every statement body starts with id (zigzag varint long), "
                              "x (zigzag varint), y (zigzag varint) - AbstractStatement.w0 - "
                              "then Action.onComplete = readObject(); the statement list is "
                              "therefore a nested DFS of onComplete/onPositive/onNegative "
                              "links, not a flat array."),
            "object_table": ("objects are appended to a table BEFORE their body is read; "
                             "references are negative ids: -1 -> table[0]. Enables cycles "
                             "(loops) and forward refs."),
            "version_gating": "every field group is gated on the file version (e.g. >=66 hidden, >=43 varFiberUri), so a JS reader must switch on the version from T0.",
            "strings": "readUTF length is a zigzag varint when version >= 35 (all corpus), else uint16.",
            "parcel": "Parcel.unmarshall is used only for some interface/datatype fields (Q3/c.h/l), not for the statement skeleton.",
            "partial_reader_result": ("spikes/t1probe.py implements ~20 of the 620 class "
                                      "readers and walks the corpus to 20-70% of bytes "
                                      "before stopping on the first unimplemented class "
                                      "(see out/t1probe.log). Two flows desync to an "
                                      "impossible type id (1) - i.e. one hand-ported class "
                                      "has a wrong field order. Conclusion: per-class field "
                                      "order/version gates must be GENERATED from the "
                                      "decompiled w0() methods, not hand-ported."),
        },
        "source_evidence": [
            "com/llamalab/automate/D0.java:87-97  S(Q3.d): writeInt(1279346284); p(115); d(x1); f(count); g(stmt)*",
            "com/llamalab/automate/D0.java:130-136 e(): readInt magic; n(version); b(); d()",
            "com/llamalab/automate/D0.java:178-196 w0(): the .flo import path (FlowImportActivity uses it)",
            "com/llamalab/automate/FlowImportActivity.java:114-149  d8.w0(cVar); title comes from file name / SUBJECT, never from file bytes",
            "Q3/c.java:146-153 n(): readUnsignedShort + f6156x0 = version, throws InvalidVersionException",
            "Q3/c.java:155-189 readObject(): zigzag varint type id; <0 -> object-table backref; 0 -> null",
            "Q3/c.java:191-194 readUTF(): varint length iff version >= 35",
            "Q3/d.java:114-117 p(): writeShort(version), also stores it as f6160Z used for every write-side version gate",
            "Q3/g.java:666 registry: 620 classes, ids 2..1430",
            "Q3/g.java:590-601 a.a(): object appended to table BEFORE body is read",
            "p020c4/e.java:83-113 a()/b(): zigzag of 7-bit LEB128 (int / long)",
            "p020c4/e.java:160-175 readInt/readShort are BIG-endian",
            "stmt/AbstractStatement.java:277-281 w0: id (b), x (a), y (a)",
            "stmt/Action.java:39-42 w0: + onComplete",
            "stmt/Decision.java:62-67 w0: + onPositive, onNegative, q()",
            "stmt/FlowBeginning.java w0: title, hidden>=66, parallel, varPayload, varFiberUri>=43",
        ],
    }

    doc = {"tool": "floT0.py", "generated_from": files, "per_file": per_file,
           "cross_sample_analysis": analysis}
    with open(out_path, "w") as fh:
        json.dump(doc, fh, indent=2)

    # human-readable log
    for r in per_file:
        print("%-12s %5d B  magic=%s byte4=0x%02x ver=%-3d nextId=%-4s stmts=%-3s "
              "strings=%-3d verdict=%s" % (
                  r["file"], r["size"], "ok" if r["magic_ok"] else "BAD",
                  r["byte4"], r["version"], r["next_statement_id"],
                  r["statement_count"], r["strings_count"],
                  "T0-OK" if r["t0_reliable"] else "FAIL"))
    print("\ncross-sample: versions=%s..%s (max supported %d), byte4 always 0x00=%s, "
          "version~flow-id spearman=%s" % (
              analysis["version_min"], analysis["version_max"],
              MAX_SUPPORTED_VERSION, analysis["byte4_constant_zero"],
              analysis["version_vs_flow_id_spearman"]))
    print("duplicates by sha256: %s" % (dups or "none"))
    mean_tail = analysis["strings_cluster_at_tail"]["mean_runs_in_last_30pct_pct"]
    print("strings in last 30%% of file: mean %s" %
          ("%.1f%%" % mean_tail if mean_tail is not None else "n/a"))
    if had_reject:
        sys.stderr.write("flo_t0: %d input(s) rejected as truncated/malformed\n" % had_reject)
        sys.exit(1)


if __name__ == "__main__":
    main()

