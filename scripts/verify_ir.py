#!/usr/bin/env python3
"""Cross-check Tasker IR against raw XML (fidelity audit, no trust in the parser).

Usage: python3 -I verify.py <fixtures-dir> <out-dir> <coverage.json>

For every fixture:
  * raw Action elements (document order) vs IR action (code, sr) multiset
  * raw Event/State contexts vs IR triggers
  * raw typed-arg child count vs IR args count, Bundle Vals extras count vs IR
  * raw %variable occurrences vs IR variable set
  * tag census -> tags present in the file but not represented anywhere in the IR
Writes a machine-readable coverage report and prints a summary table.
"""
import collections
import glob
import json
import os
import re
import sys
import xml.etree.ElementTree as ET

VAR_RE = re.compile(r"%([a-zA-Z][a-zA-Z0-9_]+)")
METADATA_TAGS = {"TaskerData", "Task", "Profile", "Project", "Action", "code", "nme", "id",
                 "pri", "cdate", "edate", "limit", "enabled", "tids", "scenesEnabled",
                 "mid0", "mid1", "mid2", "mid3", "sr", "ve", "Vals", "val"}
ARG_TAGS = {"Str", "Int", "Long", "Float", "Bundle", "App", "StringArray"}
CONTEXT_TAGS = {"Event", "State"}


def tag(el):
    return el.tag.rsplit("}", 1)[-1]


def raw_census(root):
    c = collections.Counter()
    for e in root.iter():
        c[tag(e)] += 1
    return c


def raw_actions(root):
    out = []
    for el in root.iter():
        if tag(el) == "Action":
            code_el = el.find("code")
            code = (code_el.text or "").strip() if code_el is not None else None
            # parser rule: every child of <Action> is an arg except <code>/<ConditionList>
            nargs = sum(1 for ch in el if tag(ch) not in ("code", "ConditionList"))
            extras = 0
            for ch in el:
                if tag(ch) == "Bundle":
                    for vals in ch:
                        if tag(vals) == "Vals":
                            extras += len(list(vals))
            out.append((code, el.get("sr"), nargs, extras))
    return out


def raw_contexts(root):
    """Contexts are direct children of <Profile> with sr="conN" (Event/State/Time/Day/Location)."""
    out = []
    for pr in root.iter():
        if tag(pr) != "Profile":
            continue
        for el in pr:
            if not re.match(r"^con\d+$", el.get("sr") or ""):
                continue
            c = el.find("code")
            out.append((tag(el).lower(), (c.text or "").strip() if c is not None else None))
    return out


COVERED_CONTAINERS = {"Bundle", "Vals", "Condition", "ConditionList", "App", "Str", "Int",
                      "Long", "Float", "StringArray", "Share", "Time", "Day", "Location"}


def unrepresented_tags(root):
    """Tags neither handled at the IR level nor swallowed by a covered container."""
    handled = METADATA_TAGS | ARG_TAGS | CONTEXT_TAGS | {
        "Scene", "SceneElement", "Data", "Event", "State", "Time", "Day", "Location",
        "Share", "Condition", "ConditionList", "lhs", "op", "rhs", "var", "Package",
        "ContinueOnError", "retvar", "rty", "CollisionHandling", "StructureOutput",
        # metadata captured into macro.meta / projects[] rather than arg dictionaries
        "name", "pids", "flags", "clp", "Img", "cls", "pkg", "label", "cnm", "icn",
    }
    seen = set()

    def walk(el, covered):
        # direct children of <Action>/<conN> become IR args, so they are covered
        child_of_action = tag(el) == "Action" or bool(re.match(r"^con\d+$", el.get("sr") or ""))
        for ch in el:
            t = tag(ch)
            if child_of_action and t not in ("code", "ConditionList"):
                walk(ch, True)
                continue
            inside = covered or t in COVERED_CONTAINERS
            if not inside and t not in handled:
                seen.add(t)
            walk(ch, inside)
    walk(root, False)
    return sorted(seen)


def ir_actions(ir):
    return [(str(a["code"]) if a["code"] is not None else None, a.get("sr"),
             len(a["args"]), sum(len(v["$bundle"]) for v in a["args"].values()
                                 if isinstance(v, dict) and "$bundle" in v))
            for m in ir["macros"] for a in m["actions"]]


def ir_contexts(ir):
    return [(t["family"], str(t["code"]) if t["code"] is not None else None)
            for m in ir["macros"] for t in m["triggers"]]


def ir_vars(ir):
    return {v.lstrip("%") for m in ir["macros"]
            for k in ("local", "global") for v in m["variables"][k]}


def raw_vars(root):
    """All %vars in the document, minus <Share> prose (descriptions the app shows to
    humans; they are captured as macro.meta.description and are not references)."""
    found = set()

    def walk(el, in_share):
        in_share = in_share or tag(el) == "Share"
        if not in_share:
            for txt in (el.text or "", el.get("val") or ""):
                for m in VAR_RE.finditer(txt):
                    found.add(m.group(1))
        for ch in el:
            walk(ch, in_share)
    walk(root, False)
    return found


def main():
    fixdir, outdir, covpath = sys.argv[1], sys.argv[2], sys.argv[3]
    report = {"fixtures": [], "totals": collections.Counter()}
    printed = []
    for f in sorted(glob.glob(os.path.join(fixdir, "*.xml"))):
        stem = os.path.basename(f)[:-4]
        irp = os.path.join(outdir, "tasker-%s.ir.json" % stem)
        if not os.path.exists(irp):
            continue
        ir = json.load(open(irp, encoding="utf-8"))
        root = ET.parse(f).getroot()
        ra, rc = raw_actions(root), raw_contexts(root)
        ia, ic = ir_actions(ir), ir_contexts(ir)
        census = raw_census(root)
        unrep = unrepresented_tags(root)
        rv, iv = raw_vars(root), ir_vars(ir)
        codes = [a[0] for a in ia]
        entry = {
            "fixture": os.path.basename(f),
            "taskerVersion": ir["source"]["taskerVersion"],
            "macros": len(ir["macros"]),
            "raw": {"actions": len(ra), "contexts": len(rc), "tasks": census["Task"],
                    "profiles": census["Profile"], "projects": census["Project"],
                    "argElements": sum(a[2] for a in ra), "bundleExtras": sum(a[3] for a in ra),
                    "distinctVars": len(rv)},
            "ir": {"actions": len(ia), "contexts": len(ic), "argElements": sum(a[2] for a in ia),
                   "bundleExtras": sum(a[3] for a in ia), "distinctVars": len(iv)},
            "checks": {
                "actionMultisetMatch": collections.Counter((a[0], a[1]) for a in ra) == collections.Counter((a[0], a[1]) for a in ia),
                "actionCountMatch": len(ra) == len(ia),
                "contextMatch": collections.Counter(rc) == collections.Counter(ic),
                "argCountMatch": sum(a[2] for a in ra) == sum(a[2] for a in ia),
                "bundleExtrasMatch": sum(a[3] for a in ra) == sum(a[3] for a in ia),
                "varsSuperset": rv <= iv,
                "varsMissing": sorted(rv - iv),
            },
            "codes": {"total": len(codes),
                      "builtinDecoded": sum(1 for m in ir["macros"] for a in m["actions"] if a["kind"] == "builtin"),
                      "plugin": sum(1 for m in ir["macros"] for a in m["actions"] if a["kind"] == "plugin"),
                      "unknown": sum(1 for m in ir["macros"] for a in m["actions"] if a["kind"] == "unknown"),
                      "distinctCodes": sorted({c for c in codes if c}, key=lambda x: int(x))},
            "contexts": {"total": len(ic),
                         "decoded": sum(1 for c in ic if ir_lookup(ir, c)),
                         "unknown": sum(1 for c in ic if not ir_lookup(ir, c))},
            "unrepresentedTags": unrep,
            "pluginPackages": sorted({a.get("package") for m in ir["macros"] for a in m["actions"]
                                      if a["kind"] == "plugin"}),
        }
        report["fixtures"].append(entry)
        t = report["totals"]
        for k in ("raw", "ir"):
            for kk, vv in entry[k].items():
                if isinstance(vv, int):
                    t["%s.%s" % (k, kk)] += vv
        for kk, vv in entry["codes"].items():
            if isinstance(vv, int):
                t[kk] += vv
        printed.append(entry)

    os.makedirs(os.path.dirname(covpath) or ".", exist_ok=True)
    with open(covpath, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=1, default=dict)
        fh.write("\n")

    print("%-40s %5s %5s %6s %6s %7s %8s %8s" % ("fixture", "mac", "acts", "dec", "plug", "unk", "ctx", "checks"))
    for e in printed:
        ok = all(v for k, v in e["checks"].items() if k != "varsMissing")
        print("%-40s %5d %5d %6d %6d %7d %5d/%-4d %s" % (
            e["fixture"][:40], e["macros"], e["codes"]["total"], e["codes"]["builtinDecoded"],
            e["codes"]["plugin"], e["codes"]["unknown"], e["contexts"]["decoded"],
            e["contexts"]["total"], "OK" if ok else "MISMATCH"))
    t = report["totals"]
    print("\nTOTALS: fixtures=%d actions=%d builtin=%d plugin=%d unknown=%d contexts=%d decoded=%d" % (
        len(printed), t["raw.actions"], t["builtinDecoded"], t["plugin"], t["unknown"],
        t["raw.contexts"], t["ir.contexts"]))
    print("raw arg elements=%d ir=%d | raw bundle extras=%d ir=%d" % (
        t["raw.argElements"], t["ir.argElements"], t["raw.bundleExtras"], t["ir.bundleExtras"]))
    print("unrepresented tags:", sorted({u for e in printed for u in e["unrepresentedTags"]}))
    print("plugin packages:", sorted({p for e in printed for p in e["pluginPackages"]}))
    coded = sum(e["contexts"]["total"] for e in printed)
    coded_dec = sum(e["contexts"]["decoded"] for e in printed)
    print("coverage: actions %%decoded=%.1f%% (builtin+plugin) contexts %%named=%.1f%% (%d contexts, incl. Time/Day/Location)" % (
        100.0 * (t["builtinDecoded"] + t["plugin"]) / max(1, t["raw.actions"]),
        100.0 * coded_dec / max(1, coded), coded))


def ir_lookup(ir, pair):
    # a context is "decoded" when codeName is not an unknown marker
    for m in ir["macros"]:
        for tr in m["triggers"]:
            if (tr["family"], str(tr["code"]) if tr["code"] is not None else None) == pair \
                    and not str(tr["codeName"]).startswith("unknown"):
                return True
    return False


if __name__ == "__main__":
    main()
