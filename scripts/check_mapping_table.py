#!/usr/bin/env python3
"""Validate the committed data/macrodroid/mappingTable.json.

Checks:
  * top level is a JSON object of numeric Tasker action codes -> rows;
  * no duplicate code keys (detected on the raw JSON pairs);
  * every row is exactly {classType, status, notes} with a known status;
  * classType is a string (or null); exact/partial rows must name a class
    verbatim present in the MacroDroid catalog ACTIONS section, candidate
    suggestions must be real catalog classes, manual rows carry no classType;
  * every code is a known Tasker action code;
  * all 28 golden-corpus codes are curated (not candidate).

Usage: python3 -I scripts/check_mapping_table.py [--table PATH] [--catalog PATH]
Exits non-zero on any violation.
"""
import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import gen_mapping_table as gen  # noqa: E402 - repo-local parser, no side effects

REQUIRED_KEYS = {"classType", "status", "notes"}


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--table", default=str(gen.DEFAULT_OUT))
    parser.add_argument("--catalog", default=str(gen.DEFAULT_CATALOG))
    parser.add_argument("--codes", default=str(gen.DEFAULT_CODES))
    args = parser.parse_args()

    errors = []
    table_path = Path(args.table)
    if not table_path.is_file():
        print("FAIL: mapping table not found: %s" % table_path, file=sys.stderr)
        return 1
    try:
        table = json.loads(table_path.read_text(encoding="utf-8"),
                           object_pairs_hook=_unique_pairs)
    except SystemExit:
        raise
    except (OSError, ValueError) as exc:
        print("FAIL: cannot parse %s: %r" % (table_path, exc), file=sys.stderr)
        return 1
    if not isinstance(table, dict):
        print("FAIL: top level must be a JSON object", file=sys.stderr)
        return 1

    catalog = gen.parse_catalog(args.catalog)
    actions = catalog["families"]["actions"]
    tasker_names = gen.load_tasker_codes(args.codes)

    counts = {status: 0 for status in gen.ALL_STATUSES}
    for code, row in table.items():
        label = "code %s" % code
        if not isinstance(code, str) or not re.fullmatch(r"\d+", code):
            errors.append("%s: key is not a numeric string" % label)
            continue
        if int(code) not in tasker_names:
            errors.append("%s: not a known Tasker action code" % label)
        if not isinstance(row, dict):
            errors.append("%s: row is not an object" % label)
            continue
        if set(row) != REQUIRED_KEYS:
            errors.append("%s: keys %s != %s"
                          % (label, sorted(row), sorted(REQUIRED_KEYS)))
            continue
        status, notes, class_type = row["status"], row["notes"], row["classType"]
        if status not in gen.ALL_STATUSES:
            errors.append("%s: invalid status %r" % (label, status))
            continue
        counts[status] += 1
        if not isinstance(notes, str) or not notes.strip():
            errors.append("%s: notes must be a non-empty string" % label)
        if class_type is not None and (not isinstance(class_type, str) or not class_type):
            errors.append("%s: classType must be a string or null" % label)
            continue
        if status in ("exact", "partial"):
            if class_type is None:
                errors.append("%s: %s row without a classType" % (label, status))
            elif class_type not in actions:
                errors.append("%s: classType %r not verbatim in catalog ACTIONS"
                              % (label, class_type))
        elif status == "manual":
            if class_type is not None:
                errors.append("%s: manual row must have classType null (got %r)"
                              % (label, class_type))
        elif class_type is not None and class_type not in actions:
            errors.append("%s: candidate classType %r not verbatim in catalog ACTIONS"
                          % (label, class_type))

    for code in sorted(gen.CORPUS_CODES):
        row = table.get(str(code))
        if row is None:
            errors.append("corpus code %d missing from table" % code)
        elif isinstance(row, dict) and row.get("status") not in gen.CURATED_STATUSES:
            errors.append("corpus code %d must be curated, got status %r"
                          % (code, row.get("status")))

    if errors:
        print("FAIL: %d problem(s) in %s" % (len(errors), table_path), file=sys.stderr)
        for error in errors:
            print("  - " + error, file=sys.stderr)
        return 1

    suggested = sum(1 for row in table.values()
                    if row["status"] == "candidate" and row["classType"])
    print(json.dumps({
        "table": str(table_path),
        "rows": len(table),
        "exact": counts["exact"],
        "partial": counts["partial"],
        "manual": counts["manual"],
        "candidate": counts["candidate"],
        "candidatesWithSuggestion": suggested,
        "catalog": catalog["counts"],
        "ok": True,
    }, indent=1))
    return 0


def _unique_pairs(pairs):
    seen = {}
    for key, value in pairs:
        if key in seen:
            raise SystemExit("check_mapping_table: duplicate key %r in mapping table" % key)
        seen[key] = value
    return seen


if __name__ == "__main__":
    sys.exit(main())
