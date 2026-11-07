#!/usr/bin/env python3
"""device_cdp.py — minimal Chrome DevTools Protocol client for the emulator CI.

Drives the real Chrome running on the Android emulator over
`adb forward tcp:<port> localabstract:chrome_devtools_remote`, so workflow
steps can assert on live page content (document.title, service-worker state,
#status text) instead of relying on screenshots alone.

Only dependency beyond the stdlib: `websocket-client`
(`python3 -m pip install websocket-client`).

Usage:
  python3 scripts/device_cdp.py --match 'localhost:8090' wait 'document.readyState === "complete"'
  python3 scripts/device_cdp.py eval 'document.title'
  python3 scripts/device_cdp.py reload          # Page.reload, then wait for load

`eval` / `wait` expressions are evaluated with awaitPromise + returnByValue,
so `(async () => ...)()` promise expressions work. `wait` polls until the
expression returns a truthy value.
"""

import argparse
import json
import sys
import time
import urllib.request

try:
    import websocket  # websocket-client
except ImportError:  # pragma: no cover
    sys.exit("missing dependency: python3 -m pip install websocket-client")


class CdpError(RuntimeError):
    pass


class Cdp:
    def __init__(self, http_port=9222, match="localhost", timeout=60):
        self.http_port = http_port
        self.match = match
        self.timeout = timeout
        self._ws = None
        self._msgid = 0

    # -- target discovery ------------------------------------------------ #

    def _list_targets(self):
        with urllib.request.urlopen(
            f"http://127.0.0.1:{self.http_port}/json", timeout=10
        ) as r:
            return json.loads(r.read().decode())

    def _find_page(self, retries=30, delay=1.0):
        """Return the newest page target whose URL contains `match`."""
        deadline = time.time() + retries * delay
        while True:
            pages = [t for t in self._list_targets()
                     if t.get("type") == "page" and self.match in t.get("url", "")]
            if pages:
                # /json lists newest-first; prefer a fully attached page.
                return pages[0]
            if time.time() >= deadline:
                raise CdpError(f"no CDP page target matching {self.match!r}; "
                               f"targets: {[t.get('url') for t in self._list_targets()]}")
            time.sleep(delay)

    # -- connection ------------------------------------------------------ #

    def _conn(self):
        if self._ws is None:
            target = self._find_page()
            self._ws = websocket.create_connection(
                target["webSocketDebuggerUrl"], timeout=self.timeout)
        return self._ws

    def send(self, method, params=None):
        self._msgid += 1
        mid = self._msgid
        payload = json.dumps({"id": mid, "method": method, "params": params or {}})
        ws = self._conn()
        ws.send(payload)
        while True:
            msg = json.loads(ws.recv())
            if msg.get("id") == mid:
                if "error" in msg:
                    raise CdpError(f"{method}: {msg['error']}")
                return msg.get("result", {})
            # events (Page.loadEventFired etc.) are ignored

    def eval(self, expression):
        result = self.send("Runtime.evaluate", {
            "expression": expression,
            "awaitPromise": True,
            "returnByValue": True,
        })
        if result.get("exceptionDetails"):
            raise CdpError(f"evaluation threw: {result['exceptionDetails']}")
        return result.get("result", {}).get("value")

    def reload(self):
        self.send("Page.enable")
        self.send("Page.reload", {"ignoreCache": False})
        deadline = time.time() + 60
        while time.time() < deadline:
            try:
                if self.eval('document.readyState') == "complete":
                    return
            except CdpError:
                pass  # page may be mid-navigation; keep polling
            time.sleep(1)
        raise CdpError("page did not reach readyState=complete after reload")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--port", type=int, default=9222, help="local adb-forwarded CDP port")
    ap.add_argument("--match", default="localhost", help="substring of the page URL to target")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("reload", help="Page.reload + wait for load")
    p_eval = sub.add_parser("eval", help="evaluate a JS expression, print the result")
    p_eval.add_argument("expression")
    p_wait = sub.add_parser("wait", help="poll an expression until truthy")
    p_wait.add_argument("expression")
    p_wait.add_argument("--timeout", type=float, default=60)
    args = ap.parse_args()

    cdp = Cdp(http_port=args.port, match=args.match)
    if args.cmd == "reload":
        cdp.reload()
        print("reloaded")
    elif args.cmd == "eval":
        print(json.dumps(cdp.eval(args.expression)))
    elif args.cmd == "wait":
        deadline = time.time() + args.timeout
        while True:
            try:
                if cdp.eval(args.expression):
                    print("ok")
                    return
            except CdpError:
                pass
            if time.time() >= deadline:
                sys.exit(f"timeout waiting for: {args.expression}")
            time.sleep(1)


if __name__ == "__main__":
    main()
