# Verification status

Live status of the V-criteria in `docs/DESIGN.md` §11. Updated as tests land.

| # | Criterion | Status | Evidence |
|---|---|---|---|
| V1 | Tasker XML shared in → parsed task | ✅ browser e2e (every push) · 🔬 device (emulator CI) | `tests/e2e/run-e2e.mjs` share POST → inbox → converter handoff; emulator asserts on-device parse via CDP |
| V2 | Automate `.flo` shared in → T0 inventory | ✅ browser e2e · 🔬 device (emulator CI, launch smoke) | e2e: `.flo` via picker, drop and share POST; emulator: Automate installs + launches |
| V3 | TaskerNet link → graceful card, never blank | ✅ browser e2e | paste + text-only share both covered (`taskernet-link` card + CORS warning) |
| V4 | Golden equality across drag-drop / picker / paste | ✅ browser e2e + unit goldens | e2e: the **full parsed IR** deep-compared (key-order-insensitive) across all three paths AND against the committed python-oracle golden — file paths assert the basename against the golden, paste asserts its own `pasted.xml` value, cross-path equality normalizes just that field, plus rendered cards, status string and normalized results log, same fixture; the parser behind all three is golden-tested against the python oracle (full IR deep-compare) in the unit suite |
| V5 | Offline after first load: parse + review works | ✅ browser e2e · 🔬 device (emulator CI) | e2e: offline reload + offline parse + offline deep-link fallback; emulator: server killed on runner, page reloaded + parsed on device from SW cache |
| V6 | Tasker corpus parses, 100% builtin code decode | ✅ CI (`fixture-tests-report.json`) | 10 fixtures, 124 actions, 93 builtin all named |
| V7 | Code tables present, counts sane | ✅ CI | `data/taskerCodes.json` (438/91/56 + sentinels) |
| V8 | Variables collected (%par local, %UPPER global) | ✅ CI spot-check | EnMaaS fixture: `%EnMaasKey` global, `%prompt` local |
| V9/V10 | AutoInput decode round-trip | ✅ corpus decoded (70 exports); unit tests in CI fixture run | `data/autoInputCorpus.json` |
| V11 | `.flo` magic/version detected; negatives rejected gracefully | ✅ CI | 13 real flows + 3 negative fixtures |
| V13 | Generated macro JSON passes MCP validate | ✅ proven offline (recorded probes) | `tests/fixtures/macrodroid/validator-probes/validate-ok.json` |
| V14 | Structural validator rejects adversarial shapes | ✅ probe evidence recorded | `validate-probe-*.json` (bad classtype, unbalanced If rejected) |
| V15 | End-to-end macro import into MacroDroid on device | ✅ emulator CI (manual dispatch) | MCP share link → MacroDroid macro editor (run 42341971557) |
| M3.1 | Emit MacroDroid macro JSON from IR (plugin pass-through) | ✅ unit + e2e (every push) · MCP-validated live · 🔬 device import (emulator CI) | emitter suite (23 tests): Java-ObjectSerialization writer **byte-for-byte vs a JVM reference** (real AutoInput v1/v2 bundles included) + CI drift gate regenerating the reference; emitted LaunchInstagram macro `VALID` on the live MacroDroid MCP (recorded probe, parity-tested); browser e2e renders the macro card + copy button in both scopes; emulator CI imports the emitted pass-through macro via share link |
| V12 | PDF/PNG block count vs T0 | ❌ unproven (path demoted) | design §5.4 |

## Test layers (what runs where)

1. **Unit / fixture (every push, `ci.yml` `test` job — python3 + node stdlib,
   zero installs):** Tasker XML→IR goldens (python oracle + JS parity),
   AutoInput decoder, `.flo` T0 + negatives, MacroDroid structural validator,
   mapping-table check, content sniffer (`run_sniff_tests.mjs` — every
   `classify()` route), PWA site integrity (`run_manifest_tests.mjs` —
   manifest contract, PNG icons, SW precache exists **and** covers every
   imported module + runtime data file), upstream code-table drift gate.
2. **Browser e2e (every push, `ci.yml` `e2e` job — Playwright + pinned
   Chromium):** the full user surface of the PWA in a real browser, run at
   both the server root and a `/autoport/` subpath (GitHub Pages layout):
   SW registration/activation/precache, picker + drag-drop + paste-box +
   page-paste ingest, V4 equality (status + rendered cards) across paths, sniffer routes
   (Tasker / `.flo` / PNG / unknown / empty / TaskerNet), share-target POST
   (navigational multipart form, exactly what Chrome's Android share sheet
   sends) → 303 → `share.html` inbox card → "Open in converter" `?from=`
   handoff, text-only / empty / >25 MiB share handling, `GET /share`
   redirect, IndexedDB inbox persistence + clear, offline reload / offline
   parse / offline deep-link `<base>` fallback.
3. **Emulator device test (manual dispatch, `emulator-test.yml`, KVM
   runner):** real Chrome + MacroDroid + Automate + Tasker APKs from their
   original sources, version matrix + launch smoke, PWA load with **CDP
   content assertions and on-device parse (online + offline via killed
   server)**, V15 MCP share-link import into the MacroDroid editor.

## Bugs found by the e2e suite (kept here as regression notes)

- `js/share.js` referenced an undefined `$` helper (only `app.js` defined
  one), so the entire share landing page threw `ReferenceError: $ is not
  defined` on load — no inbox cards, no banner, no empty state. The share
  sheet itself (SW side) worked, which is why the inbox data was intact but
  invisible. Fixed + SW cache version bumped (`v4`); the e2e share tests
  now fail loudly if the landing page ever breaks again.
- The Tasker status line always read "0 identified" and the
  not-representable card never rendered: `parseTaskerXml()` fills
  `options.stats` (test injection) but never attaches stats to the returned
  IR, while `app.js` read `ir.stats || {}`. Surfaced by the emulator run's
  on-device parse ("5 action(s), 0 identified" vs the python oracle's
  3 decoded + 2 plugin). Fixed by passing `{ stats }` from `app.js`; the
  browser e2e and the device check now pin the exact status string
  ("5 identified"), which also makes the offline test prove the code tables
  came from the precache. SW cache version bumped (`v5`).

## Emulator test plan history

Local blockers (measured 2026-11-07): this WSL2 box exposes no `/dev/kvm`
(no nested virt), the modern emulator (37.x) refuses ARM images on x86_64
hosts, and the WSL2 kernel has `CONFIG_ANDROID_BINDER_IPC` unset (no redroid).
Plan (shipped): GitHub Actions `ubuntu-latest` runners provide KVM —
`.github/workflows/emulator-test.yml` boots a headless x86_64 API 34
google_apis image, serves the repo over `adb reverse`, drives Chrome via
`am start` + CDP (`scripts/device_cdp.py`, `scripts/device_pwa_check.py`),
installs the apps via the gplay-apk-downloader (original signatures), and
exercises the MCP share-link import.
- The root-scope service worker's activate-time cache cleanup matched names
  with `endsWith(BASE)`; for the root scope (`BASE === '/'`) a sibling
  `/autoport/` deployment's cache names also end with `/`, so a root worker
  activating on the same origin deleted the subpath deployment's caches.
  Found by CodeRabbit review (the e2e scopes ran on separate origins/ports,
  so it never triggered in CI). Fixed with a complete-scope-suffix match and
  a same-origin cross-scope regression test in the e2e suite.

- The converter's AutoInput branch read `act.plugin?.package` /
  `act.plugin?.pluginTypeId` / `act.plugin?.configClass`, but the IR carries
  flat `act.package` / `act.pluginClass` (and the decoder takes the action
  node itself) — so every plugin action rendered as `plugin: unknown` and the
  AutoInput decoder was never invoked from the UI. Surfaced while building
  M3.1 (the earlier e2e `/AutoInput/` assertion had passed vacuously off the
  unrepresentable-note text, which contains the literal string "AutoInput").
  Fixed; the e2e now pins the chip markup and the decoded `click` op, and
  fails on `plugin: unknown`.
