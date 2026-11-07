# AutoPort

[![ci](https://github.com/kaovilai/autoport/actions/workflows/ci.yml/badge.svg)](https://github.com/kaovilai/autoport/actions/workflows/ci.yml)
[![emulator-test](https://github.com/kaovilai/autoport/actions/workflows/emulator-test.yml/badge.svg)](https://github.com/kaovilai/autoport/actions/workflows/emulator-test.yml)

Convert Android automations between apps. Runs entirely in your browser; no
server, no account, no telemetry.

## CI-tested app versions

Device tests run on KVM emulator runners ([emulator-test.yml](.github/workflows/emulator-test.yml), manual dispatch) with the real apps installed from their original sources; versions below are what the last run verified.

| App | Version (last run) | Install source | Verified |
|---|---|---|---|
| Tasker | 6.6.3-beta | official trial server (pinned build) | installs + launches |
| Automate | 1.54.0-play | Google Play (latest) | installs + launches |
| MacroDroid | 6.1.5 | Google Play (latest) | installs, launches, **imports AutoPort macro via MCP share link** |

_Last verified: [run 42341971557](https://github.com/kaovilai/autoport/actions/runs/42341971557) (versions are re-measured by every run; `device-matrix.txt` in the run artifacts is the source of truth). Note: the `.flo` format reference and fixtures come from Automate build 267 (v1.43) via decompilation; the CI-tested Play build is 1.54.0 — the T1 registry work targets the decompiled build and must be spot-checked against newer builds._

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
- [ ] `.flo` T1 full parse — format is fully structured (typed object graph; probe walks FlowBeginning → blocks until unregistered type ids); needs the ~620-entry block-type registry generated from the decompiled statement classes (spike: `scripts/t1probe.py`)
- [ ] Conversion to MacroDroid (via T1; PNG/PDF export path dropped — unnecessary given the structured format)

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
- [x] Content-sniffer unit suite (every `classify()` route pinned)
- [x] PWA site-integrity suite (manifest contract, real PNG icons, SW precache list exists **and** covers every module/data file — the offline gate)
- [x] **Browser e2e** ([ci.yml](.github/workflows/ci.yml) `e2e` job, Playwright + pinned Chromium): SW registration + precache, every ingest path (picker / drag-drop / paste box / page paste), V4 golden equality across paths, share-target POST → 303 → inbox card → "Open in converter" handoff, text-only / empty / >25 MiB shares, IndexedDB persistence + clear, offline reload + **offline parse** + offline deep-link fallback — run twice: at the server root **and** under `/autoport/` (GitHub Pages layout)
- [x] Upstream drift gate on `tasker.joaoapps.com` code tables
- [x] Emulator device test on KVM runners (manual dispatch): Chrome + MacroDroid from Play, PWA load + **CDP content assertions + on-device parse (online and offline)**, V15 share-link import

See `docs/DESIGN.md` (§11) for the V1–V21 verification matrix and
`docs/VERIFICATION.md` for current status.

## Development
No build step. Serve the repo root over HTTP and open it:

    python3 -m http.server 8080

Unit + fixture tests (python3 / node stdlib only — no install needed):

    npm test
    # equivalent: python3 -I scripts/fixture_tests.py --out /tmp/report.json
    #              for t in tests/js/run_*.mjs; do node "$t"; done

Browser e2e (the only place with a dependency: one pinned npm devDependency,
Playwright, plus its pinned Chromium — the browser binary is a separate,
explicit download, it is never fetched implicitly):

    npm ci
    npx playwright install chromium
    npm run test:e2e

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
