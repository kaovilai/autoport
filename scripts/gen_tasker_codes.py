#!/usr/bin/env python3
"""Generate taskerCodes.json from tasker.joaoapps.com/code/{Action,Event,State}Codes.java.

Usage (repo layout):
  python3 -I scripts/gen_tasker_codes.py --fetch --out data/taskerCodes.json
  python3 -I scripts/gen_tasker_codes.py <dir-with-java-files> <out.json>   # offline

Parses every `[public] [static] final int NAME = N;` declaration (any modifier order).
The output records a sha256 over the three upstream .java files instead of a
retrieval date, so `git diff --exit-code` in CI is a true upstream-drift gate
(no volatile fields).
"""
import argparse
import glob
import hashlib
import json
import os
import re
import sys
import tempfile
import urllib.request

URLS = [
    "https://tasker.joaoapps.com/code/ActionCodes.java",
    "https://tasker.joaoapps.com/code/EventCodes.java",
    "https://tasker.joaoapps.com/code/StateCodes.java",
]
FILENAMES = ["ActionCodes.java", "EventCodes.java", "StateCodes.java"]

DECL = re.compile(
    r"(?:public\s+|protected\s+|private\s+)?(?:static\s+)?(?:final\s+)?(?:static\s+)?"
    r"int\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(-?\d+)\s*;"
)
SPECIALS = {"NONE", "FIRST_PLUGIN_CODE"}


def parse(path):
    src = open(path, encoding="utf-8", errors="replace").read()
    entries = []  # (name, code, is_special)
    for line in src.splitlines():
        s = line.strip()
        if s.startswith("//") or s.startswith("*"):
            continue
        m = DECL.search(s)
        if not m:
            continue
        name, code = m.group(1), int(m.group(2))
        entries.append((name, code, name in SPECIALS))
    return entries


def build(entries, family):
    names = {n: c for n, c, sp in entries if not sp}
    specials = {n: c for n, c, sp in entries if sp}
    by_code = {}
    aliases = {}
    for n, c, sp in entries:
        if sp:
            continue
        k = str(c)
        if k in by_code:
            aliases.setdefault(k, [by_code[k]]).append(n)
        else:
            by_code[k] = n
    return {
        "names": names,
        "specials": specials,
        "byCode": by_code,
        "aliases": aliases,
        "count": len(names),
    }


def fetch_sources(dest, attempts=3):
    import time
    last = None
    for url in URLS:
        err = None
        for _ in range(attempts):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "autoport-ci"})
                data = urllib.request.urlopen(req, timeout=30).read()
                open(os.path.join(dest, os.path.basename(url)), "wb").write(data)
                err = None
                break
            except Exception as exc:  # noqa: BLE001 - retry then fail loudly
                err = exc
                time.sleep(2)
        if err is not None:
            raise SystemExit("failed to fetch %s after %d attempts: %r" % (url, attempts, err))


def sources_sha256(src_dir):
    h = hashlib.sha256()
    for fn in FILENAMES:
        data = open(os.path.join(src_dir, fn), "rb").read()
        h.update(fn.encode("utf-8"))
        h.update(b"\x00")
        h.update(data)
        h.update(b"\x00")
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fetch", action="store_true", help="download the 3 upstream .java files first")
    ap.add_argument("--out", help="output path (alternative to positional OUT)")
    ap.add_argument("src_dir", nargs="?", help="directory holding the *Codes.java files")
    ap.add_argument("out_pos", nargs="?", help="output path (positional form)")
    args = ap.parse_args()

    out = args.out or args.out_pos
    if not out:
        ap.error("an output path is required (--out OUT)")
    if args.fetch:
        tmp = tempfile.mkdtemp(prefix="autoport-codes-")
        fetch_sources(tmp)
        src_dir = tmp
    else:
        src_dir = args.src_dir
        if not src_dir:
            ap.error("either --fetch or SRC_DIR is required")

    fam = {family: parse(os.path.join(src_dir, fn))
           for family, fn in zip(("actions", "events", "states"), FILENAMES)}
    built = {k: build(v, k) for k, v in fam.items()}
    result = {
        "actions": built["actions"]["names"],
        "events": built["events"]["names"],
        "states": built["states"]["names"],
        "byCode": {
            # single flat namespace, keys prefixed by family for cross-family safety
            "actions": built["actions"]["byCode"],
            "events": built["events"]["byCode"],
            "states": built["states"]["byCode"],
        },
        "specials": {k: v["specials"] for k, v in built.items()},
        "aliases": {k: v["aliases"] for k, v in built.items() if v["aliases"]},
        "duplicateCodes": {k: v["aliases"] for k, v in built.items() if v["aliases"]},
        "counts": {k: v["count"] for k, v in built.items()},
        "source": {
            "urls": URLS,
            "sourcesSha256": sources_sha256(src_dir),
        },
    }
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=1, sort_keys=True)
        f.write("\n")
    print(json.dumps({
        "counts": result["counts"],
        "specials": result["specials"],
        "duplicateCodes": result["duplicateCodes"],
        "totalDeclarations": {k: len(v) for k, v in fam.items()},
        "sourcesSha256": result["source"]["sourcesSha256"],
        "out": out,
    }, indent=1))


if __name__ == "__main__":
    main()
