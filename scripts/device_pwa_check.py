#!/usr/bin/env python3
"""device_pwa_check.py — on-device PWA assertions for the emulator CI.

Built on device_cdp.Cdp. Verifies, on the Chrome instance running in the
emulator, that the AutoPort PWA actually works as a page — not just that
Chrome is the foreground activity:

  assert-loaded : document.title, service-worker controller, precache keys
  parse         : paste a Tasker XML fixture into the converter, click
                  Analyze, return/assert the #status text (works offline too,
                  since parsing is 100% client-side and the data files are
                  precached — that is the V5 proof)

Usage:
  python3 scripts/device_pwa_check.py assert-loaded --url http://localhost:8090/
  python3 scripts/device_pwa_check.py parse --fixture tests/fixtures/tasker/LaunchInstagram.tsk.xml

Requires: python3 -m pip install websocket-client
"""

import argparse
import json
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from device_cdp import Cdp, CdpError  # noqa: E402

EXPECTED_TITLE_PREFIX = "AutoPort"


def check_loaded(cdp, url):
    title = cdp.eval("document.title")
    if not str(title).startswith(EXPECTED_TITLE_PREFIX):
        raise CdpError(f"unexpected document.title: {title!r}")
    state = cdp.eval(
        "(async () => ({"
        " controlled: !!navigator.serviceWorker.controller,"
        " regState: (await navigator.serviceWorker.getRegistration())?.active?.state,"
        " shellCaches: (await caches.keys()).filter(k => k.startsWith('autoport-shell-')).length"
        "}))()"
    )
    if not state or not state.get("controlled"):
        raise CdpError(f"service worker not controlling the page: {state}")
    if state.get("regState") != "activated":
        raise CdpError(f"service worker not activated: {state}")
    if not state.get("shellCaches"):
        raise CdpError("no autoport-shell-* cache on device — precache never ran")
    return {"title": title, **state, "url": url}


def parse_fixture(cdp, fixture_path, expect="Tasker parsed"):
    xml = pathlib.Path(fixture_path).read_text()
    status = cdp.eval(
        "(async () => {"
        " const box = document.querySelector('#paste');"
        " if (!box) throw new Error('no #paste on this page');"
        " box.closest('details').open = true;"
        " box.value = %s;"
        " document.querySelector('#analyze').click();"
        " const deadline = Date.now() + 20000;"
        " while (Date.now() < deadline) {"
        "  const t = document.querySelector('#status').textContent;"
        "  if (/parsed|rejected|detected|adapter|Empty file/.test(t)) return t;"
        "  await new Promise(r => setTimeout(r, 250));"
        " }"
        " return 'TIMEOUT: ' + document.querySelector('#status').textContent;"
        "})()" % json.dumps(xml)
    )
    if expect not in str(status):
        raise CdpError(f"parse status did not contain {expect!r}: {status!r}")
    return status


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--port", type=int, default=9222)
    ap.add_argument("--match", default="localhost", help="substring of the page URL to target")
    ap.add_argument("--url", default="http://localhost:8090/", help="expected page URL (for match/reporting)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("assert-loaded")
    p_parse = sub.add_parser("parse")
    p_parse.add_argument("--fixture", required=True)
    p_parse.add_argument("--expect", default="Tasker parsed")
    args = ap.parse_args()

    cdp = Cdp(http_port=args.port, match=args.match)
    started = time.time()
    # give the page a moment to settle after navigation/reload
    deadline = time.time() + 30
    while True:
        try:
            if cdp.eval("document.readyState") == "complete":
                break
        except CdpError:
            pass
        if time.time() > deadline:
            sys.exit("page never reached readyState=complete")
        time.sleep(1)

    if args.cmd == "assert-loaded":
        print(json.dumps(check_loaded(cdp, args.url)))
    elif args.cmd == "parse":
        print(parse_fixture(cdp, args.fixture, args.expect))
    print(f"[device_pwa_check] ok in {time.time() - started:.1f}s", file=sys.stderr)


if __name__ == "__main__":
    main()
