#!/usr/bin/env python3
"""device_chrome_fre.py — get Chrome past its first-run flow on the emulator.

Fresh Chrome on a fresh emulator opens FirstRunActivity over the VIEW intent,
so the AutoPort page never loads and there is no CDP page target to assert
on. This script:
  1. checks whether the AutoPort page target already exists (CDP /json) —
     if so, exits 0 immediately;
  2. otherwise walks Chrome's first-run / sign-in / services screens by
     dumping the UI hierarchy (uiautomator) and tapping the highest-priority
     accepting button ("Accept & continue", "No thanks", "Skip", ...);
  3. re-checks the page target after every tap.

Exits 0 once a page target matching --match exists; exits 1 if the flow
cannot be cleared in --rounds rounds (dump the remaining targets to stderr).

Best paired with the command-line file trick done by the workflow before
Chrome's first launch:
  adb shell am set-debug-app --persistent com.android.chrome
  adb shell 'echo "chrome --no-first-run --disable-fre --no-default-browser-check" \
    > /data/local/tmp/chrome-command-line'
That alone often skips the FRE; this script is the fallback that works
regardless of whether public Chrome honors those flags.

Usage:
  python3 scripts/device_chrome_fre.py [--adb <adb>] [--port 9222] \
      [--match 'localhost:8090'] [--rounds 10]
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET

# Priority order: tap the earliest-matching phrase. "ok" last and
# anchored so it only matches a button whose whole text is OK-ish.
BUTTON_PATTERNS = [
    r"accept", r"continue", r"agree", r"no thanks", r"not now",
    r"skip", r"got it", r"finish", r"later", r"done", r"next", r"^[ok]+$",
]


def adb_path(explicit):
    if explicit:
        return explicit
    home = os.environ.get("ANDROID_HOME", "/usr/local/lib/android/sdk")
    return os.path.join(home, "platform-tools", "adb")


def run_adb(adb, *args):
    r = subprocess.run([adb, *args], capture_output=True, text=True, timeout=30)
    return r.stdout if r.returncode == 0 else ""


def cdp_pages(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json", timeout=5) as r:
            return json.loads(r.read().decode())
    except Exception:
        return []


def page_target_exists(port, match):
    return any(t.get("type") == "page" and match in t.get("url", "")
               for t in cdp_pages(port))


def ui_dump(adb):
    run_adb(adb, "shell", "uiautomator", "dump", "/sdcard/autoport-fre.xml")
    return run_adb(adb, "exec-out", "cat", "/sdcard/autoport-fre.xml")


def find_button(xml):
    """Return ((x, y), text) for the highest-priority clickable button, if any."""
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return None
    best, best_rank = None, len(BUTTON_PATTERNS)
    for node in root.iter("node"):
        text = (node.get("text") or "").strip()
        if not text or node.get("clickable") != "true":
            continue
        for rank, pat in enumerate(BUTTON_PATTERNS):
            if rank < best_rank and re.search(pat, text, re.I):
                best, best_rank = node, rank
    if best is None:
        return None
    m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", best.get("bounds", ""))
    if not m:
        return None
    x1, y1, x2, y2 = map(int, m.groups())
    return ((x1 + x2) // 2, (y1 + y2) // 2), best.get("text")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--adb", help="adb binary (default: $ANDROID_HOME/platform-tools/adb)")
    ap.add_argument("--port", type=int, default=9222, help="adb-forwarded CDP port")
    ap.add_argument("--match", default="localhost:8090", help="substring of the page URL to wait for")
    ap.add_argument("--rounds", type=int, default=10)
    args = ap.parse_args()
    adb = adb_path(args.adb)

    for i in range(args.rounds):
        if page_target_exists(args.port, args.match):
            print(f"[device_chrome_fre] page target ready after {i} round(s)")
            return 0
        btn = find_button(ui_dump(adb))
        if btn:
            (x, y), text = btn
            print(f"[device_chrome_fre] round {i}: tapping {text!r} at ({x},{y})", file=sys.stderr)
            run_adb(adb, "shell", "input", "tap", str(x), str(y))
            time.sleep(2.5)
        else:
            # No accepting button visible: maybe a scrollable ToS. Scroll up.
            print(f"[device_chrome_fre] round {i}: no button found, scrolling", file=sys.stderr)
            run_adb(adb, "shell", "input", "swipe", "540", "1400", "540", "500", "300")
            time.sleep(1.5)

    if page_target_exists(args.port, args.match):
        print("[device_chrome_fre] page target ready")
        return 0
    targets = [t.get("url") for t in cdp_pages(args.port)]
    print(f"[device_chrome_fre] FAILED to reach a page target matching {args.match!r}; "
          f"targets: {targets}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
