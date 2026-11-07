# AutoPort

[![ci](https://github.com/kaovilai/autoport/actions/workflows/ci.yml/badge.svg)](https://github.com/kaovilai/autoport/actions/workflows/ci.yml)
[![emulator-test](https://github.com/kaovilai/autoport/actions/workflows/emulator-test.yml/badge.svg)](https://github.com/kaovilai/autoport/actions/workflows/emulator-test.yml)

Convert Android automations between apps. Runs entirely in your browser; no
server, no account, no telemetry.

## CI-tested app versions

Device tests run on KVM emulator runners ([emulator-test.yml](.github/workflows/emulator-test.yml) — automatic on device-relevant changes, nightly, and on demand) with the real apps installed from their original sources; versions below are what the last run verified.

| App | Version (last run) | Install source | Verified |
|---|---|---|---|
| Tasker | 6.6.3-beta | official trial server (pinned build) | installs + launches |
| Automate | 1.54.0-play | Google Play (latest) | installs + launches |
| MacroDroid | 6.1.5 | Google Play (latest) | installs, launches, **imports AutoPort macro via MCP share link** |

_Last verified: [run 42384344731](https://github.com/kaovilai/autoport/actions/runs/42384344731) (versions are re-measured by every run; `device-matrix.txt` in the run artifacts is the source of truth). That run also asserts live page content via CDP — title, service-worker state, precache, an on-device Tasker parse (online **and** offline with the dev server killed), the V15 MacroDroid import, and the M3.1 pass-through import (macro editor shows the emitted macro with 2 action rows). Note: the `.flo` format reference and fixtures come from Automate build 267 (v1.43) via decompilation; the CI-tested Play build is 1.54.0 — the T1 registry work targets the decompiled build and must be spot-checked against newer builds._

## Conversion directions

Legend: ☑ done · ◐ partial · ☐ not started

### Tasker → MacroDroid (Phase 1)
- [x] Parse `.tsk.xml` / `.prf.xml` / `.prj.xml` / full backup → IR (golden-tested, full fidelity)
- [x] Decode AutoInput plugin actions → touch ops (click / swipe / scroll / gestures / UI query)
- [x] Action mapping table: 19 exact · 6 partial · 3 manual of the 28 corpus codes (410 candidate suggestions)
- [x] Offline MacroDroid structural validation (MCP-parity rules)
- [x] Emit MacroDroid macro JSON from IR — **plugin pass-through (M3.1)**: Tasker plugin actions become MacroDroid Tasker/Locale Plugin actions (`LocalePluginAction`) carrying the plugin's configuration bundle in the byte-exact locale-SDK format (JVM-verified), with `%var` → magic-text translation — top-level bundle strings and the blurb only; Tasker array references (`%arr()`), Tasker built-ins and references inside nested bundles stay literal and are reported, and Tasker globals must be created in MacroDroid (see `docs/DESIGN.md` §7.7). Bundle values the locale SDK cannot represent (`java.lang.Long`/`Float`/`Double` and other unsupported types) are dropped and listed in the conversion warnings, so the passed-through configuration can be incomplete. AutoInput v1/v2 emit fully (receiver + version from the real APK); **other Locale plugins are best-effort**: the node is emitted but MacroDroid cannot fire it until the plugin is re-picked in the MacroDroid editor (fire-receiver identity lives in the plugin's own manifest, which AutoPort cannot read from a Tasker export). Exclusions — listed in the conversion report on every run — are plugin actions with a Tasker If-guard, inside a Tasker `IF`/`FOR` block (control-flow mapping is M3.2), disabled in the source task (`<on>false</on>`), or with a bundle over the locale SDK's 25 KB limit. Validated against the live MacroDroid MCP server and imported on device
- [ ] Native emission for exact-mapped builtin actions + trigger mapping (M3.2)
- [ ] One-tap delivery: clipboard / connector handoff (M3) — clipboard copy of the emitted macro JSON is live
- [x] Import proof: MCP share link → MacroDroid macro editor on device ([emulator CI](.github/workflows/emulator-test.yml)) — the imported macro's actions are asserted; running the macro on device is not automated yet (V15 partial)

### Automate → MacroDroid
- [x] `.flo` T0 inventory: magic / version / statement count / strings
- [x] Graceful rejection of truncated / malformed flows
- [x] **Plug-in pass-through (M3.1)**: Tasker/Locale plug-in statements in the flow (Automate's PlugInSetting/Condition/Event blocks — AutoInput, AutoCast, …) become MacroDroid Tasker/Locale Plugin actions carrying the plugin's configuration bundle, decoded from the flow's marshalled Android Parcel and re-serialized in the byte-exact locale-SDK format (oracle-parity tested on 33 plug-in statements across 5 community flows, zero false positives on the rest of the corpus). AutoInput emits fully (receiver from the real APK); other plugins are best-effort (node emitted, plugin re-picked in MacroDroid). Validated against the live MacroDroid MCP server and imported on device. Honest limits — listed in the conversion report on every run: the flow's **other** statements (control flow, native Automate blocks) are not converted (that needs the T1 statement registry), plug-in blocks whose statement kind can't be proven are emitted as actions, Automate `%vars` stay literal and are reported, and the flow's output variables are reported as unmapped
- [ ] `.flo` T1 full parse — format is fully structured (typed object graph; probe walks FlowBeginning → blocks until unregistered type ids); needs the ~620-entry block-type registry generated from the decompiled statement classes (spike: `scripts/t1probe.py`)
- [ ] Conversion of the flow's native blocks to MacroDroid (via T1; PNG/PDF export path dropped — unnecessary given the structured format)

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
- [x] JS suites: Tasker parser **golden parity with the Python oracle**, AutoInput decoder, `.flo` T0, **`.flo` plug-in scanner (oracle parity + Parcel decode + Automate emission)**, MacroDroid validator
- [x] Content-sniffer unit suite (every `classify()` route pinned)
- [x] **Plugin pass-through emission suite (40 tests)**: Java-ObjectSerialization writer byte-for-byte against a committed JVM reference (incl. real AutoInput v1/v2 bundles), typed-bundle reconstruction, `%var` translation, emitter contract, MCP-probe parity — plus a CI drift gate that regenerates the JVM reference
- [x] PWA site-integrity suite (manifest contract, real PNG icons, SW precache list exists **and** covers every module/data file — the offline gate)
- [x] **Browser e2e** ([ci.yml](.github/workflows/ci.yml) `e2e` job, Playwright + pinned Chromium): SW registration + precache, every ingest path (picker / drag-drop / paste box / page paste), V4 equality across paths (status + rendered cards; parser oracle-golden-tested), share-target POST → 303 → inbox card → "Open in converter" handoff, text-only / empty / >25 MiB shares, IndexedDB persistence + clear, offline reload + **offline parse** + offline deep-link fallback — run twice: at the server root **and** under `/autoport/` (GitHub Pages layout)
- [x] Upstream drift gate on `tasker.joaoapps.com` code tables
- [x] Emulator device test on KVM runners (**automatic on device-relevant paths**, nightly, and on demand; system image + APKs cached): Chrome + MacroDroid from Play, PWA load + **CDP content assertions + on-device parse (online and offline)**, V15 share-link import, M3.1 pass-through import asserted in the MacroDroid editor (Tasker **and** Automate flows)

See `docs/DESIGN.md` (§11) for the V1–V21 verification matrix and
`docs/VERIFICATION.md` for current status.

## Development
No build step. Serve the repo root over HTTP and open it:

    python3 -m http.server 8080

Unit + fixture tests (python3 / node stdlib only — no install needed).
Note: `npm test` runs only the JS suites; the Python fixture run is separate:

    python3 -I scripts/fixture_tests.py --out /tmp/report.json
    npm test

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
