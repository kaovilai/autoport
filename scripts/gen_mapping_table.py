#!/usr/bin/env python3
"""Generate data/macrodroid/mappingTable.json: Tasker action code -> MacroDroid class.

Two layers (docs/DESIGN.md 7.1):
  * a curated seed for the 28 builtin Tasker action codes that occur in the
    golden corpus (status exact | partial | manual);
  * automated name-similarity candidates for every remaining Tasker action
    code (status candidate -- suggestions only, never used for emission).

Row shape: {"classType": str | null, "status": str, "notes": str}.
Manual rows carry no classType (the notes name the closest class and why it
cannot be emitted automatically).

Every exact/partial classType must exist verbatim in the ACTIONS section of
data/macrodroid/catalog.json; a violation exits non-zero.

Usage (repo layout):
  python3 -I scripts/gen_mapping_table.py            # write the table
  python3 -I scripts/gen_mapping_table.py --check    # validate, write nothing
  python3 -I scripts/gen_mapping_table.py --catalog C --codes T --golden G --out O
"""
import argparse
import difflib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CATALOG = ROOT / "data" / "macrodroid" / "catalog.json"
DEFAULT_CODES = ROOT / "data" / "taskerCodes.json"
DEFAULT_GOLDEN = ROOT / "tests" / "golden" / "tasker"
DEFAULT_OUT = ROOT / "data" / "macrodroid" / "mappingTable.json"

SECTION_RE = re.compile(r"^##\s+(TRIGGERS|ACTIONS|CONSTRAINTS)\s*$")
ITEM_RE = re.compile(r"^-\s+([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$")
FAMILY_OF_HEADER = {"TRIGGERS": "triggers", "ACTIONS": "actions", "CONSTRAINTS": "constraints"}
CURATED_STATUSES = ("exact", "partial", "manual")
ALL_STATUSES = CURATED_STATUSES + ("candidate",)
CANDIDATE_THRESHOLD = 0.55
CANDIDATE_WEIGHT_SEQ = 0.5          # character-level similarity
CANDIDATE_WEIGHT_DICE = 0.5         # token-set overlap
CLASS_SUFFIX_RE = re.compile(r"(Action|Trigger|Constraint)$")
CLASS_WORD_RE = re.compile(r"[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+")

# The 28 builtin action codes measured in tests/golden/tasker/*.ir.json.
# Pinned so a corpus change fails loudly instead of silently shrinking the seed.
CORPUS_CODES = frozenset({
    16, 20, 25, 30, 37, 38, 39, 40, 43, 104, 129, 130, 176, 245,
    248, 328, 339, 410, 421, 511, 547, 548, 590, 592, 664, 806, 815, 877,
})

# Hand-authored seed: code -> (classType | None, status, notes).
# classType must appear verbatim in the catalog's ACTIONS section.
SEED = {
    16: ("SetKeyguardAction", "partial",
         "Tasker System Lock uses Device Admin lockNow(); MacroDroid has no admin lockNow - "
         "SetKeyguardAction only enables/disables the keyguard, so pair it with ScreenOnAction "
         "(screen off) to approximate a lock."),
    20: ("LaunchActivityAction", "exact",
         "Tasker Load App launches an app; LaunchActivityAction launches an app (or a specific "
         "activity) directly."),
    25: ("LaunchHomeScreenAction", "exact",
         "Go Home -> LaunchHomeScreenAction."),
    30: ("PauseAction", "exact",
         "Tasker Wait pauses execution; MacroDroid PauseAction is the Wait action (duration argument)."),
    37: ("IfConditionAction", "exact",
         "Tasker IF -> IfConditionAction; the condition goes into the action's m_constraintList "
         "(DESIGN 7.1)."),
    38: ("EndIfAction", "exact",
         "Tasker ENDIF closes the block; flat EndIfAction marker in m_actionList."),
    39: ("LoopAction", "exact",
         "Tasker FOR (repeat N times) -> LoopAction."),
    40: ("EndLoopAction", "exact",
         "Tasker ENDFOR -> EndLoopAction marker."),
    43: ("ElseAction", "exact",
         "Tasker ELSE -> ElseAction marker."),
    104: ("OpenWebPageAction", "exact",
          "Tasker Browse URL -> OpenWebPageAction (opens the URL in the browser / HTTP GET)."),
    129: ("JavaScriptAction", "exact",
          "Tasker JavaScriptlet -> JavaScriptAction; the JS source is carried as the code argument. "
          "Tasker-specific JS globals (global(), setGlobal()) have no MacroDroid equivalent."),
    130: (None, "manual",
          "Tasker Perform Task invokes another task with %parN arguments; MacroDroid has no "
          "parameterized task call - inline the callee (recommended, DESIGN 7.1) or hand-author "
          "ActionBlockAction; user decision per instance."),
    176: ("TakeScreenshotAction", "exact",
          "Tasker Take Screenshot -> TakeScreenshotAction (screenshot can be saved/shared)."),
    245: ("PressBackAction", "exact",
          "Tasker Back Button -> PressBackAction."),
    248: ("AndroidShortcutsAction", "partial",
          "Tasker accessibility Lock Screen maps to Android's GLOBAL_ACTION_LOCK_SCREEN; "
          "AndroidShortcutsAction performs system global actions via the accessibility service - "
          "verify the flavor exposes the lock-screen global action before emitting."),
    328: ("SetKeyboardAction", "partial",
          "Tasker Keyboard selects an input method directly; MacroDroid SetKeyboardAction only "
          "shows the keyboard picker - the user still has to choose."),
    339: ("HttpRequestAction", "exact",
          "HTTP Request -> HttpRequestAction; method/url/headers/body/timeout map onto requestConfig."),
    410: ("WriteToFileAction", "exact",
          "Tasker Write File -> WriteToFileAction."),
    421: (None, "manual",
          "Tasker Get Assistant Info reads assistant launcher details; MacroDroid has no read "
          "action for this - SetDigitalAssistantAction only changes the default assistant."),
    511: ("CameraFlashLightAction", "exact",
          "Tasker Torch -> CameraFlashLightAction."),
    547: ("SetVariableAction", "exact",
          "Tasker Set Variable -> SetVariableAction (the catalog's Set Variable action)."),
    548: ("ToastAction", "exact",
          "Tasker Flash shows a transient toast; MacroDroid ToastAction displays a toast popup."),
    590: ("TextManipulationAction", "partial",
          "Tasker Variable Split splits a string into an array; MacroDroid has no dedicated split "
          "action - use the text-manipulation split variant (verify the textManipulation kind/enum)."),
    592: ("TextManipulationAction", "partial",
          "Tasker Variable Join joins an array into a string; MacroDroid has no dedicated join "
          "action - use the text-manipulation join variant (verify the textManipulation kind/enum)."),
    664: (None, "manual",
          "Tasker Java Function calls a reflected Java method with typed args; MacroDroid JavaAction "
          "runs a BeanShell snippet - semantics and argument marshalling differ, so the body must "
          "be re-authored by hand."),
    806: ("ScreenOnAction", "exact",
          "Tasker Poke Display wakes the display -> ScreenOnAction (turn screen on)."),
    815: ("GetInstalledAppsAction", "partial",
          "Both enumerate installed apps, but Tasker fills the %app_packages/%app_labels array pair "
          "while GetInstalledAppsAction writes a single list variable - output-shape conversion "
          "needed."),
    877: ("SendIntentAction", "exact",
          "Tasker Send Intent -> SendIntentAction."),
}


def fail(msg):
    raise SystemExit("gen_mapping_table: " + msg)


def parse_catalog(path):
    """Extract every classType with label and family from the MCP catalog snapshot."""
    try:
        doc = json.loads(Path(path).read_text(encoding="utf-8"))
        text = doc["response"]["body_parsed"]["result"]["content"][0]["text"]
    except (OSError, ValueError, KeyError, IndexError, TypeError) as exc:
        fail("cannot read catalog markdown from %s: %r" % (path, exc))
    if not isinstance(text, str):
        fail("catalog content[0].text is not a string")

    families = {"triggers": {}, "actions": {}, "constraints": {}}
    family_of = {}
    section = None
    for line in text.splitlines():
        stripped = line.strip()
        header = SECTION_RE.match(stripped)
        if header:
            section = FAMILY_OF_HEADER[header.group(1)]
            continue
        item = ITEM_RE.match(stripped)
        if not item or section is None:
            continue
        class_type, label = item.group(1), item.group(2).strip()
        if class_type in family_of:
            fail("duplicate classType %r in catalog sections %s and %s"
                 % (class_type, family_of[class_type], section))
        family_of[class_type] = section
        families[section][class_type] = label

    for family, rows in families.items():
        if not rows:
            fail("catalog section %s is missing or empty" % family)
    return {"families": families, "family_of": family_of,
            "counts": {family: len(rows) for family, rows in families.items()}}


def load_tasker_codes(path):
    try:
        doc = json.loads(Path(path).read_text(encoding="utf-8"))
        by_code = doc["byCode"]["actions"]
    except (OSError, ValueError, KeyError, TypeError) as exc:
        fail("cannot read Tasker action codes from %s: %r" % (path, exc))
    if not isinstance(by_code, dict) or not by_code:
        fail("byCode.actions is empty in %s" % path)
    names = {}
    for raw_code, name in by_code.items():
        if not isinstance(raw_code, str) or not re.fullmatch(r"\d+", raw_code):
            fail("non-numeric Tasker action code %r" % (raw_code,))
        if not isinstance(name, str) or not name:
            fail("empty Tasker action name for code %r" % (raw_code,))
        names[int(raw_code)] = name
    return names


def corpus_action_codes(golden_dir):
    paths = sorted(Path(golden_dir).glob("*.ir.json"))
    if not paths:
        fail("no golden IR files under %s" % golden_dir)
    codes = set()
    for path in paths:
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            fail("cannot read golden IR %s: %r" % (path, exc))
        for macro in doc.get("macros") or []:
            for action in macro.get("actions") or []:
                if action.get("kind") == "builtin" and isinstance(action.get("code"), int):
                    codes.add(action["code"])
    return codes


def split_class_words(class_type):
    base = CLASS_SUFFIX_RE.sub("", class_type)
    return [word.lower() for word in CLASS_WORD_RE.findall(base)]


def similarity(tasker_name, class_type):
    """Deterministic name similarity: 0.5 * char ratio + 0.5 * token Dice."""
    tasker_words = [w.lower() for w in tasker_name.split("_") if w]
    class_words = split_class_words(class_type)
    seq = difflib.SequenceMatcher(
        None, "".join(tasker_words), "".join(class_words)).ratio()
    t_set, c_set = set(tasker_words), set(class_words)
    dice = 2.0 * len(t_set & c_set) / (len(t_set) + len(c_set)) if t_set and c_set else 0.0
    return round(CANDIDATE_WEIGHT_SEQ * seq + CANDIDATE_WEIGHT_DICE * dice, 4)


def best_candidate(tasker_name, action_class_types):
    scored = [(similarity(tasker_name, class_type), class_type)
              for class_type in action_class_types]
    # Deterministic: highest score, then lexicographically smallest classType.
    return min(scored, key=lambda pair: (-pair[0], pair[1]))


def validate_seed(catalog, tasker_names, corpus_codes):
    if set(SEED) != set(corpus_codes):
        fail("seed/corpus mismatch: seed-only=%s corpus-only=%s"
             % (sorted(set(SEED) - set(corpus_codes)),
                sorted(set(corpus_codes) - set(SEED))))
    if set(corpus_codes) != set(CORPUS_CODES):
        fail("golden corpus codes drifted from the pinned 28: unexpected=%s missing=%s"
             % (sorted(set(corpus_codes) - set(CORPUS_CODES)),
                sorted(set(CORPUS_CODES) - set(corpus_codes))))
    actions = catalog["families"]["actions"]
    for code in sorted(SEED):
        class_type, status, notes = SEED[code]
        if code not in tasker_names:
            fail("seed code %d is not a known Tasker action code" % code)
        if status not in CURATED_STATUSES:
            fail("seed code %d has invalid status %r" % (code, status))
        if not isinstance(notes, str) or not notes.strip():
            fail("seed code %d has empty notes" % code)
        if status == "manual":
            if class_type is not None:
                fail("seed code %d is manual but names classType %r (manual rows must be null)"
                     % (code, class_type))
            continue
        if not isinstance(class_type, str) or not class_type:
            fail("seed code %d (%s) has no classType" % (code, tasker_names[code]))
        if class_type not in actions:
            fail("seed code %d (%s): classType %r is not verbatim in the catalog ACTIONS section"
                 % (code, tasker_names[code], class_type))


def build_table(catalog, tasker_names, corpus_codes):
    validate_seed(catalog, tasker_names, corpus_codes)
    actions = catalog["families"]["actions"]
    rows = {}
    for code in sorted(corpus_codes):
        class_type, status, notes = SEED[code]
        rows[code] = {"classType": class_type, "status": status, "notes": notes}
    for code in sorted(tasker_names):
        if code in corpus_codes:
            continue
        name = tasker_names[code]
        score, class_type = best_candidate(name, actions)
        if score >= CANDIDATE_THRESHOLD:
            rows[code] = {
                "classType": class_type,
                "status": "candidate",
                "notes": ("auto name-similarity candidate for Tasker %s (score %.4f); "
                          "suggestion only, never used for emission" % (name, score)),
            }
        else:
            rows[code] = {
                "classType": None,
                "status": "candidate",
                "notes": ("no MacroDroid action reached the %.2f name-similarity threshold for "
                          "Tasker %s (best: %s at %.4f); manual review required"
                          % (CANDIDATE_THRESHOLD, name, class_type, score)),
            }
    return {str(code): rows[code] for code in sorted(rows)}


def validate_table(table, catalog, tasker_names):
    """Final gate: schema, statuses, and classType existence."""
    actions = catalog["families"]["actions"]
    for code, row in table.items():
        if not re.fullmatch(r"\d+", code):
            fail("non-numeric code key %r" % code)
        if int(code) not in tasker_names:
            fail("code %s is not a known Tasker action code" % code)
        if set(row) != {"classType", "status", "notes"}:
            fail("row %s has keys %s, expected classType/status/notes"
                 % (code, sorted(row)))
        status, notes, class_type = row["status"], row["notes"], row["classType"]
        if status not in ALL_STATUSES:
            fail("row %s has invalid status %r" % (code, status))
        if not isinstance(notes, str) or not notes.strip():
            fail("row %s has empty notes" % code)
        if class_type is not None and (not isinstance(class_type, str) or not class_type):
            fail("row %s has invalid classType %r" % (code, class_type))
        if status in ("exact", "partial"):
            if class_type is None:
                fail("row %s (%s) has no classType" % (code, status))
            if class_type not in actions:
                fail("row %s: classType %r is not verbatim in the catalog ACTIONS section"
                     % (code, class_type))
        elif class_type is not None and class_type not in actions:
            # manual rows must be null per schema; candidates must be real names.
            fail("row %s: classType %r is not verbatim in the catalog ACTIONS section"
                 % (code, class_type))
    for code in sorted(CORPUS_CODES):
        row = table.get(str(code))
        if row is None:
            fail("corpus code %d missing from table" % code)
        if row["status"] not in CURATED_STATUSES:
            fail("corpus code %d must be curated, got status %r" % (code, row["status"]))


def summarize(table):
    counts = {status: 0 for status in ALL_STATUSES}
    suggested = 0
    for row in table.values():
        counts[row["status"]] += 1
        if row["status"] == "candidate" and row["classType"]:
            suggested += 1
    return {"rows": len(table), "curated": sum(counts[s] for s in CURATED_STATUSES),
            "exact": counts["exact"], "partial": counts["partial"],
            "manual": counts["manual"], "candidate": counts["candidate"],
            "candidatesWithSuggestion": suggested,
            "candidatesWithoutSuggestion": counts["candidate"] - suggested}


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--catalog", default=str(DEFAULT_CATALOG))
    parser.add_argument("--codes", default=str(DEFAULT_CODES))
    parser.add_argument("--golden", default=str(DEFAULT_GOLDEN))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--check", action="store_true",
                        help="build and validate without writing the table")
    args = parser.parse_args()

    catalog = parse_catalog(args.catalog)
    tasker_names = load_tasker_codes(args.codes)
    corpus_codes = corpus_action_codes(args.golden)
    table = build_table(catalog, tasker_names, corpus_codes)
    validate_table(table, catalog, tasker_names)

    if not args.check:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(table, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    report = {"catalog": catalog["counts"], "taskerActions": len(tasker_names)}
    report.update(summarize(table))
    report["out"] = None if args.check else str(Path(args.out))
    print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
