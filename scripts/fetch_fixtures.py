#!/usr/bin/env python3
"""Fetch 10 real Automate community flows into an isolated fixtures dir.

Untrusted downloads: they land only in autoproof/fixtures/automate/ and are
never imported/executed. Script itself lives in autoproof/spikes/.
"""
import json
import os
import sys
import urllib.parse
import urllib.request

BASE = "https://llamalab.com/automate/community/api/v1"
OUT = sys.argv[1] if len(sys.argv) > 1 else "fixtures/automate"
UA = "AutoPort-spike/0.1 (research; python-urllib)"


def get(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def main():
    os.makedirs(OUT, exist_ok=True)
    meta = json.loads(get(BASE + "/flows?limit=10"))
    index = []
    for f in meta:
        fid = f["id"]
        title = f["title"]
        url = "%s/flows/%d/data/%s.flo" % (BASE, fid, urllib.parse.quote(title))
        try:
            data = get(url)
        except Exception as e:  # network/404 - record and continue
            index.append({"id": fid, "title": title, "url": url, "error": repr(e)})
            print("FAIL", fid, e)
            continue
        path = os.path.join(OUT, "%d.flo" % fid)
        with open(path, "wb") as fh:
            fh.write(data)
        index.append({
            "id": fid,
            "title": title,
            "url": url,
            "file": os.path.abspath(path),
            "size": len(data),
            "magic": data[:4].decode("latin-1"),
            "mime_type": f.get("mime_type"),
            "flow_version": f.get("version"),
            "modified": f.get("modified"),
        })
        print("OK", fid, len(data), title)
    with open(os.path.join(OUT, "_download_index.json"), "w") as fh:
        json.dump(index, fh, indent=2)


if __name__ == "__main__":
    main()
