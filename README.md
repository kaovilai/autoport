# AutoPort

Convert Android automations between apps. Phase 1: **Tasker** (`.tsk.xml`,
`.prf.xml`, `.prj.xml`, full backup) and **Automate** (`.flo`, PDF/PNG export)
→ **MacroDroid** macro JSON. Runs entirely in your browser; no server, no
account, no telemetry.

## Use it
1. Open the deployed site (or install it: Chrome menu → "Add to Home screen").
2. Share an export to AutoPort from the Android share sheet, or drag/drop the
   file in a desktop browser, or paste Tasker XML.
3. Review the parsed triggers/actions, convert, and import the generated
   MacroDroid macro (clipboard → MacroDroid connector, or direct JSON).

## What works (status)
| Area | Status |
|---|---|
| Tasker XML → IR inventory | ✅ proven (10-fixture corpus, full-fidelity parser + golden tests) |
| MacroDroid macro JSON emission | ✅ schema-proven, minimal macro passes MCP `validate_macrodroid_macro` |
| AutoInput / touch ops | ✅ schema recovered from APK + 70 real exports |
| Automate `.flo` (T0 inventory) | ✅ proven (magic/version, 13-flow corpus) |
| Automate `.flo` T1 (full parse) | 🔬 specced (620-entry block registry), spike code in `scripts/t1probe.py` |
| Automate PDF/PNG | ❌ unproven, demoted |
| Device end-to-end (share in → macro imported) | 🔬 emulator CI in progress |

See `docs/DESIGN.md` (§11) for the full V1–V21 verification matrix and
`docs/VERIFICATION.md` for current status.

## Development
No build step. Serve the repo root over HTTP and open it:

    python3 -m http.server 8080

Tests (stdlib only):

    python3 -I scripts/fixture_tests.py --out /tmp/report.json

Regenerate the Tasker code snapshot:

    python3 -I scripts/gen_tasker_codes.py --fetch --out data/taskerCodes.json

The python scripts under `scripts/` are the reference oracles; the browser
modules under `js/` are the product (port of the same logic).

## Privacy
Parsing is local. Optional BYO LLM endpoint and the MacroDroid connector
handoff are the only outbound paths, both explicit per action. No analytics.

## License
MIT. Not affiliated with Tasker, Automate/LlamaLab, or MacroDroid. Tasker,
Automate and MacroDroid are trademarks of their respective owners.
