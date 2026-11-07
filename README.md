# AutoPort

Convert Android automations between apps. Runs entirely in your browser; no
server, no account, no telemetry.

## Conversion directions

Legend: ☑ done · ◐ partial · ☐ not started

### Tasker → MacroDroid (Phase 1)
- [x] Parse `.tsk.xml` / `.prf.xml` / `.prj.xml` / full backup → IR (golden-tested, full fidelity)
- [x] Decode AutoInput plugin actions → touch ops (click / swipe / scroll / gestures / UI query)
- [x] Action mapping table: 19 exact · 6 partial · 3 manual of the 28 corpus codes (410 candidate suggestions)
- [x] Offline MacroDroid structural validation (MCP-parity rules)
- [ ] Emit MacroDroid macro JSON from IR (M3)
- [ ] One-tap delivery: clipboard / connector handoff (M3)
- [x] End-to-end delivery proof: MCP share link → MacroDroid macro editor on device ([emulator CI](.github/workflows/emulator-test.yml))

### Automate → MacroDroid
- [x] `.flo` T0 inventory: magic / version / statement count / strings
- [x] Graceful rejection of truncated / malformed flows
- [ ] `.flo` T1 full parse (block registry specced; spike in `scripts/t1probe.py`)
- [ ] PDF/PNG flow export → vision/manual mapping (demoted — unproven)
- [ ] Conversion to MacroDroid

### Other directions (roadmap — drop-in adapters)
- [ ] MacroDroid → Tasker (reverse)
- [ ] Tasker → Tasker (reformat / version upgrade round-trip)
- [ ] MacroDroid / Easer / n8n / Home Assistant as sources
- [ ] Tasker XML / n8n workflow JSON / Home Assistant YAML as targets

## Functionality

- [x] PWA installable to home screen (`manifest.webmanifest` + service worker)
- [x] Android share-sheet intake for installed PWA (files: XML / `.flo` vendor MIME / octet-stream / PDF / PNG)
- [x] Content sniffing — never trusts the reported MIME type
- [x] Desktop: drag-and-drop, file picker, paste-XML
- [x] Shared-inbox (IndexedDB) with re-open handoff
- [x] Fully offline after first load (SW precaches modules + data)
- [x] TaskerNet link detection (fetch is CORS-blocked; paste-XML fallback)
- [x] Privacy: parsing is 100% client-side, zero outbound requests, no analytics
- [ ] BYO LLM assist for unmapped actions (optional, OpenAI-compatible endpoint — M4)
- [ ] Browser-direct MCP validation (blocked by CORS; connector handoff is the path)

## Quality gates (CI on every push)
- [x] Python fixture tests: Tasker corpus, `.flo` corpus + negatives, code tables
- [x] Golden IR regression vs the Python reference oracle
- [x] JS suites: Tasker parser **golden parity with the Python oracle**, AutoInput decoder, `.flo` T0, MacroDroid validator
- [x] Upstream drift gate on `tasker.joaoapps.com` code tables
- [x] Emulator device test on KVM runners (manual dispatch): Chrome + MacroDroid from Play, PWA load, V15 share-link import

See `docs/DESIGN.md` (§11) for the V1–V21 verification matrix and
`docs/VERIFICATION.md` for current status.

## Development
No build step. Serve the repo root over HTTP and open it:

    python3 -m http.server 8080

Tests (stdlib only):

    python3 -I scripts/fixture_tests.py --out /tmp/report.json
    for t in tests/js/run_*.mjs; do node "$t"; done

Regenerate the Tasker code snapshot:

    python3 -I scripts/gen_tasker_codes.py --fetch --out data/taskerCodes.json

The python scripts under `scripts/` are the reference oracles; the browser
modules under `js/` are the product (golden-parity tested against them).

## Privacy
Parsing is local. Optional BYO LLM endpoint and the MacroDroid connector
handoff are the only outbound paths, both explicit per action. No analytics.

## License
MIT. Not affiliated with Tasker, Automate/LlamaLab, or MacroDroid. Tasker,
Automate and MacroDroid are trademarks of their respective owners.
