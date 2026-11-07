# Verification status

Live status of the V-criteria in `docs/DESIGN.md` §11. Updated as tests land.

| # | Criterion | Status | Evidence |
|---|---|---|---|
| V6 | Tasker corpus parses, 100% builtin code decode | ✅ CI (`fixture-tests-report.json`) | 10 fixtures, 124 actions, 93 builtin all named |
| V7 | Code tables present, counts sane | ✅ CI | `data/taskerCodes.json` (438/91/56 + sentinels) |
| V8 | Variables collected (%par local, %UPPER global) | ✅ CI spot-check | EnMaaS fixture: `%EnMaasKey` global, `%prompt` local |
| V11 | `.flo` magic/version detected; negatives rejected gracefully | ✅ CI | 13 real flows + 3 negative fixtures |
| V13 | Generated macro JSON passes MCP validate | ✅ proven offline (recorded probes) | `tests/fixtures/macrodroid/validator-probes/validate-ok.json` |
| V14 | Structural validator rejects adversarial shapes | ✅ probe evidence recorded | `validate-probe-*.json` (bad classtype, unbalanced If rejected) |
| V1–V5 | PWA share-target on-device | 🔬 emulator CI pending (local WSL2 lacks KVM) | plan: GHA ubuntu runner w/ KVM |
| V15 | End-to-end macro import into MacroDroid on device | 🔬 emulator CI pending | needs MacroDroid APK + MCP share link |
| V9/V10 | AutoInput decode round-trip | ✅ corpus decoded (70 exports); unit tests in CI fixture run | `data/autoInputCorpus.json` |
| V12 | PDF/PNG block count vs T0 | ❌ unproven (path demoted) | design §5.4 |

## Emulator test plan (V1–V5, V15)

Local blockers (measured 2026-11-07): this WSL2 box exposes no `/dev/kvm`
(no nested virt), the modern emulator (37.x) refuses ARM images on x86_64
hosts, and the WSL2 kernel has `CONFIG_ANDROID_BINDER_IPC` unset (no redroid).
Plan: GitHub Actions `ubuntu-latest` runners provide KVM — boot headless
x86_64 API 34 google_apis image, serve the repo, `adb reverse` to the runner,
drive Chrome via adb/UI automation, install MacroDroid via APK, and exercise
the MCP share-link import. Workflow: `.github/workflows/emulator.yml`
(to be added).
