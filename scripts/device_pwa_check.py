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

Conditions are polled with a deadline (SW activation can lag the first load
by tens of seconds on an emulator), so a slow page is not a false failure.

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

# Polled until every field passes: a slow first load can return a state object
# before the worker activates and controls the page, so the caller must keep
# polling rather than fail on the first (incomplete) answer.
SW_STATE_JS = (
    "(async () => {"
    " const ready = document.readyState === 'complete'"
    "  && document.title.startsWith('" + EXPECTED_TITLE_PREFIX + "')"
    "  && !!navigator.serviceWorker.controller"
    "  && (await navigator.serviceWorker.getRegistration())?.active?.state === 'activated';"
    " if (!ready) return null;"
    " const shellName = (await caches.keys()).find(k => k.startsWith('autoport-shell-'));"
    " if (!shellName) return null;"
    " const shell = await caches.open(shellName);"
    " const has = (p) => shell.match(new URL(p, location.href)).then(r => !!r);"
    " return {"
    "  title: document.title,"
    "  controlled: !!navigator.serviceWorker.controller,"
    "  regState: (await navigator.serviceWorker.getRegistration())?.active?.state,"
    "  shellCaches: (await caches.keys()).filter(k => k.startsWith('autoport-shell-')).length,"
    "  shellHasIndex: await has('index.html'),"
    "  shellHasShare: await has('share.html'),"
    "  shellHasCodes: await has('data/taskerCodes.json'),"
    " };"
    "})()"
)


def wait_for(fn, what, timeout=120, poll=2):
    """Poll fn() until truthy; raise CdpError with the last value on timeout."""
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            last = fn()
            if last:
                return last
        except CdpError as e:
            last = str(e)
        time.sleep(poll)
    raise CdpError(f"timeout waiting for {what}: last={last}")


def check_loaded(cdp):
    state = wait_for(lambda: cdp.eval(SW_STATE_JS), "page + service worker state")
    for key in ("shellHasIndex", "shellHasShare", "shellHasCodes"):
        if not state.get(key):
            raise CdpError(f"precache missing an entry ({key} falsy): {state}")
    return state


def parse_fixture(cdp, fixture_path, expect="Tasker parsed"):
    xml = pathlib.Path(fixture_path).read_text()
    status = cdp.eval(
        "(async () => {"
        " const box = document.querySelector('#paste');"
        " if (!box) throw new Error('no #paste on this page');"
        # Clear any previous run's output first: the status wait below must
        # observe THIS parse, not a stale 'Tasker parsed' from an earlier one.
        " document.querySelector('#status').textContent = '';"
        " document.querySelector('#results').textContent = '';"
        " box.closest('details').open = true;"
        " box.value = %s;"
        " document.querySelector('#analyze').click();"
        " const deadline = Date.now() + 30000;"
        " while (Date.now() < deadline) {"
        "  const t = document.querySelector('#status').textContent;"
        "  if (t && /parsed|rejected|detected|adapter|Empty file/.test(t)) return t;"
        "  await new Promise(r => setTimeout(r, 250));"
        " }"
        " return 'TIMEOUT: ' + document.querySelector('#status').textContent;"
        "})()" % json.dumps(xml)
    )
    if expect not in str(status):
        raise CdpError(f"parse status did not contain {expect!r}: {status!r}")
    return status


def main():
    # SUPPRESS defaults: with plain defaults, a subparser re-parsing the
    # remaining args would overwrite a value given BEFORE the subcommand
    # (e.g. `--port 5 parse` -> port reset to 9222). SUPPRESS leaves the
    # namespace untouched when the option is absent on either side; the
    # effective defaults are applied via getattr below.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--port", type=int, default=argparse.SUPPRESS)
    common.add_argument("--match", default=argparse.SUPPRESS)
    ap = argparse.ArgumentParser(description=__doc__, parents=[common])
    sub = ap.add_subparsers(dest="cmd", required=True)
    p_load = sub.add_parser("assert-loaded", parents=[common])
    p_load.add_argument("--url", default="http://localhost:8090/", help="expected page URL (reporting only)")
    p_parse = sub.add_parser("parse", parents=[common])
    p_parse.add_argument("--fixture", required=True)
    p_parse.add_argument("--expect", default="Tasker parsed")
    args = ap.parse_args()

    cdp = Cdp(http_port=getattr(args, "port", 9222), match=getattr(args, "match", "localhost"))
    started = time.time()
    # give the page a moment to settle after navigation/reload
    wait_for(lambda: cdp.eval("document.readyState") == "complete", "page load", timeout=60)

    if args.cmd == "assert-loaded":
        print(json.dumps(check_loaded(cdp)))
    elif args.cmd == "parse":
        print(parse_fixture(cdp, args.fixture, args.expect))
    print(f"[device_pwa_check] ok in {time.time() - started:.1f}s", file=sys.stderr)


if __name__ == "__main__":
    main()
