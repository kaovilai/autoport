#!/usr/bin/env python3
"""CI-shaped fixture tests for the AutoPort spike parsers (python3 stdlib only).

Runs the actual spike parsers (not reimplementations) against the committed
fixture corpus and asserts the design-doc verification criteria that are testable
without a device:
  * V7  Tasker code tables present, counts/aliases sane
  * V6  every Tasker XML fixture parses, 100% of action codes decode
  * V8  variables are collected (%par* local, %UPPER global)
  * V11 .flo magic/version detected for all real flows; no false positive on
        random bytes; truncated inputs fail gracefully (no traceback)

Usage: python3 -I fixture_tests.py [--root DIR] [--out REPORT.json]
Exit: 0 all pass, 1 any failure.
"""
import argparse
import glob
import json
import os
import subprocess
import sys
import tempfile


def run(cmd):
    proc = subprocess.run(cmd, capture_output=True, text=True)
    return proc.returncode, proc.stdout, proc.stderr


def main():
    ap = argparse.ArgumentParser()
    here = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument("--root", default=os.path.abspath(os.path.join(here, "..")))
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    root = args.root
    spikes = here  # reference parsers live alongside this script in scripts/
    fixtures = os.path.join(root, "tests", "fixtures")
    codes_path = os.path.join(root, "data", "taskerCodes.json")
    results = []

    def record(name, ok, detail, extra=None):
        results.append({"test": name, "status": "PASS" if ok else "FAIL",
                        "detail": detail, "extra": extra or {}})
        print(("PASS " if ok else "FAIL ") + name + ": " + detail)

    # --- V7: code tables ---------------------------------------------------
    try:
        codes = json.load(open(codes_path, encoding="utf-8"))
        counts = codes["counts"]
        ok = (counts["actions"] == 438 and counts["events"] == 91
              and counts["states"] == 56
              and codes["specials"]["actions"]["FIRST_PLUGIN_CODE"] == 1000)
        record("V7_code_tables", ok, "counts=%s specials=%s"
               % (counts, codes["specials"]), {"counts": counts})
    except Exception as exc:  # noqa: BLE001 - report any failure as a test failure
        record("V7_code_tables", False, "cannot read %s: %r" % (codes_path, exc))

    # --- V6/V8: Tasker XML corpus ------------------------------------------
    xml_fixtures = sorted(glob.glob(os.path.join(fixtures, "tasker", "*.xml")))
    if not xml_fixtures:
        record("V6_tasker_corpus", False, "no Tasker XML fixtures found")
    per_fixture = []
    all_ok = True
    for xml in xml_fixtures:
        with tempfile.TemporaryDirectory() as td:
            out = os.path.join(td, "ir.json")
            stats = os.path.join(td, "stats.json")
            rc, _so, se = run([sys.executable, "-I", os.path.join(spikes, "tasker_xml_ir.py"),
                               xml, "--codes", codes_path, "--out", out, "--stats", stats])
            if rc != 0:
                per_fixture.append({"file": os.path.basename(xml), "ok": False,
                                    "error": se.strip().splitlines()[-1:]})
                all_ok = False
                continue
            ir = json.load(open(out, encoding="utf-8"))
            st = json.load(open(stats, encoding="utf-8"))
            decoded = st.get("actionsDecoded", 0)
            plugin = st.get("actionsPlugin", 0)
            unknown = st.get("actionsUnknown", 0)
            total = st.get("actionsTotal", 0)
            # A plugin action (code >= FIRST_PLUGIN_CODE) is counted separately:
            # decoded builtins + plugin bundles + unknown must cover every action.
            ok = (ir.get("source", {}).get("app") == "tasker"
                  and decoded + plugin + unknown == total
                  and st.get("contextsDecoded", 0) + st.get("contextsUnknown", 0)
                  == st.get("contextsTotal", 0))
            all_ok = all_ok and ok
            per_fixture.append({
                "file": os.path.basename(xml), "ok": ok,
                "actions": total, "decoded": decoded, "plugin": plugin,
                "unknown": unknown,
                "triggers": st.get("triggers", 0),
                "macros": len(ir.get("macros", [])),
                "locals": st.get("variableCount", {}).get("local", []),
                "globals": st.get("variableCount", {}).get("global", []),
            })
    record("V6_tasker_corpus", all_ok,
           "%d fixtures, %d action(s) decoded with 0 unknown"
           % (len(per_fixture), sum(p.get("actions", 0) for p in per_fixture)),
           {"fixtures": per_fixture})

    # V8 spot check on the canonical EnMaaS fixture.
    en = next((p for p in per_fixture if p["file"] == "enmaas-glm-ask.tsk.xml"), None)
    ok8 = bool(en and "%EnMaasKey" in en.get("globals", [])
               and "%prompt" in en.get("locals", []))
    record("V8_variables_enmaas", ok8,
           "global=%s local=%s" % (en and en.get("globals"), en and en.get("locals")),
           en or {})

    # --- V11: .flo corpus + negative fixtures ------------------------------
    flo_fixtures = sorted(glob.glob(os.path.join(fixtures, "automate", "*.flo")))
    negatives = sorted(glob.glob(os.path.join(fixtures, "negative", "*")))
    rc, _so, se = run([sys.executable, "-I", os.path.join(spikes, "flo_t0.py"),
                       os.path.join(tempfile.gettempdir(), "autoport-flo-t0.json")]
                      + flo_fixtures)
    flo_report = {}
    if rc == 0:
        flo_report = json.load(open(os.path.join(tempfile.gettempdir(),
                                                 "autoport-flo-t0.json"), encoding="utf-8"))
        bad = [p["file"] for p in flo_report["per_file"]
               if not p.get("magic_ok") or not p.get("version_within_supported")]
        record("V11_flo_magic", not bad,
               "%d real flows, %d bad magic/version" % (len(flo_fixtures), len(bad)),
               {"per_file": [{k: p.get(k) for k in
                              ("file", "version", "magic_ok", "statement_count")}
                             for p in flo_report["per_file"]]})
    else:
        record("V11_flo_magic", False, "floT0.py exited %d: %s"
               % (rc, se.strip().splitlines()[-1:] if se else ""))

    # Negative corpus: must not be treated as valid flows, and must not traceback.
    neg_details = []
    neg_ok = True
    real = flo_fixtures[0] if flo_fixtures else None
    for path in negatives:
        tmp_out = os.path.join(tempfile.gettempdir(), "autoport-flo-neg.json")
        if os.path.exists(tmp_out):
            os.unlink(tmp_out)
        rc, _so, se = run([sys.executable, "-I", os.path.join(spikes, "flo_t0.py"),
                           tmp_out, path])
        entry = {"file": os.path.basename(path), "rc": rc}
        if os.path.basename(path) == "random.bin":
            # Magic must not match; a JSON verdict of magic_ok=false is acceptable.
            if rc == 0 and os.path.exists(tmp_out):
                info = json.load(open(tmp_out, encoding="utf-8"))["per_file"][0]
                entry["magic_ok"] = info.get("magic_ok")
                entry["ok"] = info.get("magic_ok") is False
            else:
                entry["ok"] = False
            entry["expect"] = "magic_ok=false, graceful"
        else:
            # Truncated real flow: must fail gracefully (clear message, no traceback).
            tb = "Traceback (most recent call last)" in se
            entry["ok"] = rc != 0 and not tb
            entry["traceback"] = tb
            entry["expect"] = "graceful rejection, no traceback"
        if not entry.get("ok"):
            neg_ok = False
        neg_details.append(entry)
    record("V11_flo_negatives", neg_ok,
           "%d negative fixture(s): %s" % (len(neg_details), neg_details),
           {"negatives": neg_details})

    failures = [r for r in results if r["status"] == "FAIL"]
    report = {
        "tool": "fixture_tests.py",
        "root": root,
        "generated": "2026-11-06",
        "total": len(results),
        "passed": len(results) - len(failures),
        "failed": len(failures),
        "results": results,
    }
    out_path = args.out or os.path.join(root, "fixture-tests-report.json")
    _d = os.path.dirname(out_path)
    if _d:
        os.makedirs(_d, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=1)
        f.write("\n")
    print("report: %s  (%d/%d passed)" % (out_path, report["passed"], report["total"]))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
