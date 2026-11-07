# AutoPort — universal automation converter (PWA): everything → everything

**Scope:** generic hub-and-spoke automation translation — any source automation app → common IR → any target automation app. Adding a source or target is writing one adapter; nothing else changes. **Phase 1: sources = Tasker, Automate; target = MacroDroid.**

Design doc + verification criteria. Static GitHub Pages site, no backend required for core functionality.

**rev 2 — prove-out integrated (2026-11-07).** Every risky assumption in rev 1 was spiked with runnable code (6-spike workflow + AutoInput APK decompilation); all measured facts below cite their artifact under `autoproof/` (evidence directory, frozen — do not edit). Spike results index: Appendix B.

> [!Note]
> Generated with Claude Code in T3 Code (model: GLM 5.3 via EnMaaS)

---

## 1. Goal

A PWA the user installs to their Android home screen. When they export an automation from a **source app** — Tasker (`.tsk.xml` / `.prf.xml` / `.prj.xml` / full backup `.xml`) or Automate (`.flo`, or flow PDF/PNG export) in Phase 1 — they **share it to the installed PWA** (Android share sheet) or open/drag it in any browser. The app parses it via the source adapter, shows a reviewable inventory (triggers / actions / variables), converts what it can via the selected **target adapter** (MacroDroid in Phase 1: macro JSON), flags what it can't, and hands the user validated output they can import (via the MacroDroid Claude/ChatGPT connector → share-link flow, or direct JSON — see §7.4 for the unproven-delivery caveat).

Everything runs client-side. No server, no account, no telemetry. LLM assistance optional (bring-your-own endpoint; see §7.5 for the Pages CSP constraint).

The IR is direction-neutral, so future adapters are drop-in: more sources (MacroDroid itself, Easer, n8n exports…), more targets (Tasker XML, n8n workflow JSON, Home Assistant YAML…), and reverse/round-trip directions.

## 2. User flows

| # | Flow | Mechanism |
|---|------|-----------|
| U1 | Share Tasker XML from file manager / Tasker export | Android share sheet → installed PWA `share_target` (POST, multipart) |
| U2 | Share Automate `.flo` from Automate's share/export or file manager | same, accept `application/vnd.com.llamalab.automate.flow` + `application/octet-stream` + `.flo` |
| U3 | Share Automate flow PDF/PNG export | same, accept `application/pdf`, `image/png`, `image/jpeg` (**UNPROVEN path**, §5.4) → rendered in-app for (manual or vision-LLM) mapping |
| U4 | Share a `taskernet.com/shares/...` link (text share) | share_target `text` param; app attempts `fetch` with a 5 s timeout, then falls back to a paste-XML card (fetch behavior itself unverified — Cloudflare/CORS unknown; UX must degrade gracefully either way) |
| U5 | Open in desktop browser | drag-and-drop / file picker / paste XML text — identical pipeline, no install needed |
| U6 | Review & convert | parsed tree → per-item mapping status → selected target's output (MacroDroid JSON in Phase 1) |

Browser support: `share_target` with `files[]` is **Chromium-only in practice** (Chrome/Android; Samsung Internet and Firefox behavior unverified). The file-picker/drag-drop paths (U5) are the universal fallback and must be first-class UI, not an afterthought. (autoproof/pwa/share-target-facts.md)

## 3. Architecture

```
autoport/  (GitHub Pages, project site https://kaovilai.github.io/autoport/)
├── manifest.webmanifest        # PWA + share_target — RELATIVE paths (see §4)
├── sw.js                       # service worker: app-shell precache (incl. data/), POST share handler
├── index.html / share.html / 404.html
├── css/  icons/                # styles + generated icons
├── js/
│   ├── ir.js                   # IR types + validation (direction-neutral)
│   ├── sniff.js                # NORMATIVE source detection (see §5.0)
│   ├── sources/
│   │   ├── tasker/
│   │   │   ├── taskerXml.js    # TaskerData XML → IR
│   │   │   ├── codes.js        # 10-line loader of data/taskerCodes.json (NO second table)
│   │   │   └── pluginAutoInput.js  # AutoInput plugin-bundle decoder → IR touch ops
│   │   └── automate/
│   │       ├── floParser.js    # .flo T0 (header + strings); T1 behind a flag
│   │       └── flowImage.js    # PDF/PNG → OCR/vision handoff (UNPROVEN, M4+)
│   ├── targets/
│   │   └── macrodroid/
│   │       ├── emit.js         # IR → MacroDroid macro JSON (control-flow markers, variables)
│   │       ├── validate.js     # offline structural validator (strict + mcp-parity modes)
│   │       └── mcpClient.js    # validate via BYO proxy (CORS blocks direct — §7.3)
│   └── llm.js                  # optional BYO OpenAI-compatible endpoint (via proxy, §7.5)
├── data/
│   ├── taskerCodes.json        # GENERATED (scripts/gen_tasker_codes.py) + source.sha256 gate
│   ├── autoInputSchema.json    # merged: APK enums + 70-export corpus + wire format
│   ├── taskerArgTable.json     # G1: per-code argK semantics for the 28 corpus codes (M2)
│   └── macrodroid/
│       ├── catalog.json        # trimmed {class → description}, counts fingerprint 126/211/88
│       ├── schemas/            # trimmed per-class field schemas (m_classType, fields, enums)
│       ├── triggers.json / actions.json / variables.json   # 3 mapping tables (§7.1)
├── scripts/                    # gen_tasker_codes.py, trim_mcp_snapshot.py, update_golden.py, check_manifest.py
├── tests/                      # run-tests.mjs (PWA 125 checks), test_autoinput_decoder.mjs, golden/
│   └── fixtures/               # repo-relative fixture copies (MANIFEST path=repoPath)
├── docs/FIXTURES.md            # origin/sha256/license/disposition per fixture
├── .github/workflows/ci.yml
├── package.json                # {"scripts": {"test": "node tests/run-tests.mjs && node tests/test_autoinput_decoder.mjs"}}
├── LICENSE  README.md  .gitignore
```

- **No runtime build step.** Vanilla ES modules. CI regenerates `data/taskerCodes.json` from the three published `.java` tables and gates with `git diff --exit-code`; the generator stamps `source.sha256` of the upstream files (not a retrieval date, which would fail the gate daily). (autoproof/spikes/genTaskerCodes.py, autoproof/repo-bootstrap.md §(d))
- Single source of truth for codes: `data/taskerCodes.json`. The rev-1 `actionCodes.js` baked table is deleted; `codes.js` only loads the JSON. (A hand-written table in the proven PWA UI was wrong for 9 of 14 codes — proof this must be generated. autoproof/pwa/js/app.js ACTION_HINTS)
- Full tree, `gh repo create` / Pages commands, CI draft and first-10-commits plan: **autoproof/repo-bootstrap.md** (normative for bootstrap; its conflict list is resolved by this rev).

## 4. PWA + share target specifics

**Deployment reality:** the site lives at `https://kaovilai.github.io/autoport/` — a **subpath**. Everything must be relative or scope-aware:

```json
{
  "name": "AutoPort",
  "short_name": "AutoPort",
  "id": "./",
  "start_url": "./",
  "scope": "./",
  "display": "standalone",
  "share_target": {
    "action": "./share",
    "method": "POST",
    "enctype": "multipart/form-data",
    "params": {
      "title": "title",
      "text": "text",
      "files": [{
        "name": "share",
        "accept": [
          "application/xml", "text/xml", ".xml",
          "application/vnd.com.llamalab.automate.flow", "application/octet-stream", ".flo",
          "application/pdf", "image/png", "image/jpeg"
        ]
      }]
    }
  }
}
```

- `accept` entries may be **MIME types and/or file extensions — list both** (MDN/W3C L2 recommend exactly this; autoproof/pwa/share-target-facts.md §3). `image/jpeg` added for U3.
- **Accept filtering happens in the UA before any service worker runs** — the SW cannot "accept unconditionally" for an unlisted/empty MIME (rev-1 claim removed). `application/octet-stream` is the only catch-all entry and its behavior for `file.type==''` is unverified (device test V1).
- The SW share handler matches the action **scope-resolved**, not by `pathname === '/share'`: `const shareUrl = new URL('share', reg.scope); url.href === shareUrl.href`. Icons and cache keys likewise relative. (rev-1's and the spike skeleton's absolute `/` paths are a known defect to fix before deploy — autoproof/pwa/manifest.webmanifest, autoproof/pwa/js/app.js.)
- **Precache must include the data files** (`data/taskerCodes.json`, catalog/mapping JSON) or offline parsing (V5) breaks after first load; bump the SW `CACHE` version whenever any data file changes. (autoproof/pwa/sw.js SHELL list — currently missing them.)
- File shares only work for **installed** PWAs; install requires HTTPS (or localhost) — `devserver.py` in the spike skeleton serves a local HTTPS-less dev flow; document `python3 scripts/devserver.py` + the localhost SW caveat in README.
- Starting skeleton (with the above defects to fix): **autoproof/pwa/** — manifest, sw.js, index/share/404, app.js, sniff.js, idb.js, icons, test harness (125 checks passing; autoproof/pwa/test-output.txt).
- Uninstall/reinstall is required after changing `share_target` in the manifest.

**IndexedDB contract** (shared by share.html → index.html): DB `autoport`, store `inbox`; record `{id, createdAt, name, type, size, kind, buf | text, source}`; `kind` from sniff.js; retention: keep last 20 records, explicit Clear button; quota errors surface as a toast, never a silent drop.

## 5. Parsers

### 5.0 Source detection + error taxonomy (normative: `js/sniff.js`)

Route on bytes, in order: `.flo` magic `4C 41 46 6C` → Automate; leading `<TaskerData` (after BOM/whitespace) or `<Data` containing it → Tasker; otherwise well-formed XML with no Tasker root → `{kind:'not-tasker'}` error card; anything else → unknown-format error card. **One error union for all adapters**: `{source, error: {kind: parse|doctype|not-tasker|not-flo|truncated|unknown, message}, macros: []}` — never a traceback, never a crash. (Tasker side proven: autoproof/out/edge/truncated.ir.json; .flo side currently RED — see §5.3.)

### 5.1 Tasker XML (full fidelity — proven)

Code tables (`data/taskerCodes.json`, generated; autoproof/out/taskerCodes.stats.json): **438 named actions** + 2 sentinels (`NONE=-1`, `FIRST_PLUGIN_CODE=1000`) = 440 declarations; **91 events** + 2 (`FIRST_PLUGIN_CODE=10000`); **56 states** + 2; zero duplicate codes; max real action code 999.

XML form (all proven on 10 fixtures, Tasker 5.12.24–6.6.17; autoproof/out/tasker-corpus-summary.json):

- Root `<TaskerData sr="" dvi="1" tv="6.x">`; full backups wrap everything in an extra `<Data>` element — parse identically.
- Tasks: `<nme>`, `<id>`, `<pri>`; actions `<Action sr="actN" ve="7">` with `<code>`.
- **Arg forms** (keep ALL, verbatim): `<Str sr="argK" ve="3">` (may contain an escaped `StringArray` → decode to `$array`), `<Int|Long|Float sr="argK" val="…">`, `<Int><var>%priority+1</var></Int>` (**expression, not literal** → `$var`), `<App sr="argK">` (appPkg/appClass/label → `$app`), `<Bundle sr="argK"><Vals sr="val">` (flatten one level; **keep the `<KEY>-type` companion keys** — they are the only typed-extras signal), and **bare named children** (`<on>`, `<se>`, `<fh>`, `<mon>`…) → positional bag entries.
- **Profiles link tasks by `<midK>N</midK>` id refs**, not only inline `<Task>`: a pre-pass folds linked tasks into their profile macro and suppresses the standalone copy (corpus: 27 tasks / 19 profiles → 27 macros, 19 folded).
- **Contexts are family-agnostic `conN` elements**: `<Event>`/`<State>` carry `<code>`; `<Time>` (fh/fm/th/tm/rep/repval) and `<Day>` (mon/tue…) carry **no code** — `family: time|day`, `code: null`. Dropping them produces false "no trigger" macros.
- **Action-level If guards** live in `<ConditionList sr="if"><Condition sr="c0"><lhs>%var</lhs><op>2</op><rhs>…` — carry as `action.condition` (9 corpus variable refs exist ONLY there; arg-only collection under-collects variables).
- Plugin actions: identity = **arg1 (package) + arg2 (config activity class)**; the numeric `<code>` is a per-plugin-activity large integer that is stable across exports but **NOT derivable** (not hashCode/CRC32) and **NOT stable across plugin versions** — carry it, never route on it.
- **Hardening (proven)**: strip UTF-8 BOM; refuse DOCTYPE/ENTITY (entity-expansion safety); malformed XML → `{error:{kind:'parse'}}` + exit 2, no traceback; unknown code 471 → `"unknown (code 471)"`; unknown plugin code → `kind:'plugin'` with package; scenes/SceneElements → `stats.unrepresentable` (must surface as review items, never dropped). (autoproof/out/edge/*, autoproof/fixtures/tasker-edge/backup-edge-cases.xml)
- **Audit result**: independent XML↔IR verification matched 124/124 actions, 20/20 contexts, 534/534 typed args, 832/832 bundle extras, 77/77 distinct `%vars` (autoproof/spikes/verify.py, autoproof/out/tasker-coverage.json).

**Gap G1 — arg semantics** (the big one for M2): code names are published, `argK` meanings are not. Decoded so far: HTTP_REQUEST, RegularIntervalTrigger, WifiConstraint. M2 needs an arg table for at least the **28 distinct corpus codes** (16,20,25,30,37,38,39,40,43,104,129,130,176,245,248,328,339,410,421,511,547,548,590,592,664,806,815,877). Acquisition: derive from the decompiled config classes in `analysis/tasker-src/` (locally, licensing stance = OPEN DECISION) cross-checked against community docs; record per-code evidence fixtures. `data/taskerArgTable.json` schema: `{code, args: {argK: {name, type, values?}}, evidence, confidence}`.

### 5.2 AutoInput plugin actions (touch / swipe / scroll) — proven from APK + 70 real exports

Wire format in Tasker exports (397 actions inspected; autoproof/data/autoInputSchema-seed.json `wireFormat`, autoproof/docs/autoinput-notes.md §1): **no `com.twofortyfouram.locale.intent.extra.BUNDLE` wrapper key appears** — plugin extras are flattened directly into `<Bundle sr="arg0"><Vals sr="val">` with `<key>-type` companions and `net.dinglisch.android.tasker.subbundled=true`. Args: **arg1 = plugin package** (e.g. `com.joaomgcd.autoinput`), **arg2 = config activity class**, arg3 = timeout, arg4 = continue-after-error. Outer protocol constants (from the APK's `com/joaomgcd/common/tasker/Constants.java`, merged in autoproof/data/autoInputSchema-apk.json): `FIRE_SETTING`/`EDIT_SETTING`/`QUERY_CONDITION`/`REQUEST_QUERY`, `BLURB`, `VARIABLE_REPLACE_KEYS`.

- **Routing: never on `<code>`** (same family uses different codes across AutoInput versions: 1732635924 vs 12931 for IntentPerformAction, 1040876951 vs 15355 for IntentUIQuery). Route on arg1+arg2 / `plugintypeid`.
- **8 pluginTypeIds**: IntentPerformAction, IntentActionv2, IntentUIQuery, IntentGestures, IntentPerformGlobalAction, IntentTurnOffScreen, IntentUnlockScreen, IntentModes.
- **Config keys are localized display-name strings** (`TaskerDynamicInput` stores each `@TaskerInput` property under `context.getString(resId)`) — e.g. `"Actions To Perform"`, `"Text To Click"`, `"Start Point"`. Parser matches English defaults and falls back to description matching. (autoproof/data/autoInputSchema-apk.json)
- **Enums recovered from the APK** (autoproof/data/autoInputEnums.json, apkSha256 fe5a6cf…): ActionType {Click=16, Long Click=32, Paste=32768, Select Text=131072, Cut=65536, Focus=1, Scroll Forward=4096, Scroll Backward=8192, Write=-1, Replace=-2}; FieldSelectionType {Text=0, Id=1, Focus=2, List=3, Point=5}; GestureType {Swipe=0, Pinch=1, Multiple=2}; GlobalAction {Back=1, Home=2, Recent Apps=3, Open Notifications=4, Quick Settings=5, Power Dialog=6}.
- **v2 DSL** (Actionv2, ~46% of real corpus actions): action strings with escaped commas, `=:=` marker, selector nouns text/id/regex/point/xy/focus, `%var` dynamicDsl. Decoder contract in autoproof/js/pluginAutoInput.js (`fromTaskerActionElement(DOM el)` — the decoder consumes the XML element, not the flattened IR bundle; that is the normative seam).
- **Grading corpus**: 91 GitHub code-search hits → 84 files → **70 unique Tasker exports, 357 AutoInput actions, 128/128 graded by BLURB** across 8 op families; 26 fabricated/garbage bundles decode as **unmapped-with-reason, never guessed**. Residual gaps = **12 device-capture tasks** (autoproof/docs/empirical-capture-plan.md). The rev-1 "build ~10 tasks and capture" plan is replaced by this corpus + the 12 tasks.

### 5.3 Automate `.flo` (tiered; T0 proven, T1 specced)

**Byte-exact header** (proven on 13 files / 10 unique-by-sha256; autoproof/out/flo-t0.json): big-endian magic int `0x4C41466C` ("LAFl"), **big-endian uint16 version at offset 4**, then two **zigzag LEB128 varints** (next-statement-id, statement count). Byte 4 is `0x00` only because corpus versions (44–109) are < 256; the app reader accepts up to **115**. Version correlates with flow recency (ρ=0.89 vs flow id), not with title/size — it's a serialization-format version.

- **T0 (proven outputs)**: magic/version/next-id/declared count, printable-literal extraction (strings are spread throughout the file — mean 28% in the last 30% of bytes, so scan the whole buffer; corpus ranges: counts 8–48 statements, 6–167 strings), FlowBeginning entry-point count. **There is no title in the `.flo`** — AutoInput derives it from filename / share SUBJECT; T0 inventory reports "title from filename/community metadata" instead.
- **T1 (specced, not built)**: statement type ids are zigzag LEB128 varints against a **620-entry registry (ids 2–1430)**, not u16. Object-table model: id/x/y varints, `Action.onComplete`, `Decision.onPositive/onNegative`, append-before-body, negative backrefs, version-gated fields. Plan: generate ~620 per-class readers from the decompiled `w0()` methods; add fixtures for versions 110–115 (corpus stops at 109).
- **Parcel claim narrowed**: `Parcel.unmarshall` is used only for interface/datatype fields (Q3/c.h, Q3/c.l), never the statement skeleton — the T1 ceiling is narrower than rev-1 stated.
- **Error contract (currently RED — V11 blocker)**: truncated `.flo` inputs crash the spike reader (ZeroDivisionError in spearman(), TypeError; autoproof/out/fixture-tests.json). Ship gate: truncated-header and truncated-magic-only fixtures must return `{error:{kind:'truncated'}}`, never traceback.
- `InvalidVersionException` (version > 115) is verified in the decompiled reader; corrupt-stream (`StreamCorruptedException`) handling was never exercised.

### 5.4 Automate PDF/PNG export — UNPROVEN, demoted

Rev 1 called this the "primary Automate path" with zero evidence. Status: no fixture (flow-export.png is planned-but-missing in autoproof/fixtures/MANIFEST.json), no analysis of `FlowExportActivity.Pdf/.Png` output format, no block-counting method. **M4 order is now: `.flo` T0 first; PDF/PNG behind it**, gated on: (a) one real PNG fixture, (b) a format analysis of the export, (c) a counting method whose estimate can be compared against T0's statement count. V12 is blocked until then.

### 5.5 Taskernet links

`fetch` behavior untested (Cloudflare/CORS unknown). UX spec: attempt fetch with 5 s timeout → on any failure show the link plus a paste-XML card; no server-side fetching.

## 6. Intermediate Representation (IR)

Normative schema: **autoproof/ir-schema.md** (proven against the corpus; parser autoproof/spikes/taskerXml.py). Condensed:

```ts
interface AutoPortIR {
  irVersion: 1;                          // rev2: bump on breaking IR change
  source: { app: "tasker" | "automate"; file: string; taskerVersion?: string | null;
            sha256: string };            // rev2: input digest for golden tests
  macros: Macro[];  projects?: ProjectInfo[];
  error?: { kind: "parse"|"doctype"|"not-tasker"|"not-flo"|"truncated"|"unknown"; message: string }; // macros: []
}
interface Macro { id: string;            // rev2: stable per-node id (V4/V16 need identity)
  name: string; kind: "profile" | "task";
  triggers: Trigger[];                   // AND-ed source contexts (family: event|state|time|day|location|…)
  actions: Action[];                     // document order
  variables: { local: string[]; global: string[] };   // %lowercase=local, %UPPER=global/builtin
  taskIds?: string[]; sr?: string; meta?: MacroMeta; } // meta: cdate/edate/pri/flags/clp/<Share> prose — never executable
interface Trigger { family: string; code: number | null; codeName: string; args: Args; sr?: string; }
interface Action { id: string; kind: "builtin" | "plugin" | "unknown";
  code: number | null; codeName: string; args: Args;   // positional argK bag — semantics NOT decoded (G1)
  condition?: { conditions: { lhs: string; op: string; rhs: string }[] };  // <ConditionList sr="if"> guard
  package?: string; pluginClass?: string; }             // plugin identity — NEVER route on <code>
type ArgValue = string | number | null
  | { $array: string[] } | { $var: string } | { $app: Record<string,string> }
  | { $bundle: Record<string, any> } | { $tag: string; children?: ArgValue[] };
```

Full normalization rules (8, empirically verified — bundle flattening keeps `-type` companions, StringArray decode, `$var` expressions, bare named children, unknown elements preserved as `$tag`) and the gap register (G1–G8): autoproof/ir-schema.md §2–§3.

**Conversion-status layer (separate from `kind`)** — required by V16 without overloading source kind:

```ts
interface ConversionStatus { actionId: string;
  status: "exact" | "partial" | "manual" | "unmapped" | "unknown";
  reason: string; target?: string; manualSteps?: string[]; }
```

**Adapter interface contract:**

```ts
interface SourceAdapter { id: string; sniff(bytes: Uint8Array, name: string): boolean; parse(bytes: Uint8Array, name: string): AutoPortIR; }
interface TargetAdapter { id: string; convert(ir: AutoPortIR): { outputs: OutputFile[]; statuses: ConversionStatus[]; warnings: string[] }; }
```

**Touch ops** are produced by decoding a plugin action (not a separate action kind): `click`, `longClick`, `paste`, `cut`, `selectText`, `focus`, `scrollForward`, `scrollBackward`, `write`, `replace`, `swipe`, `pinch`, `multiple`, `globalAction(back|home|recents|notifications|quickSettings|powerDialog)`, `uiQuery`. (rev-1's `kind:'touch'`/`kind:'unmapped'` removed — measured IR uses builtin|plugin|unknown + the status layer.)

## 7. Target adapter: MacroDroid (Phase 1) — generation & delivery

### 7.1 Three mapping tables (not one)

`data/macrodroid/triggers.json`, `actions.json`, `variables.json`. Row schema: `{source: {family, code}, target: {classType, argTemplates}, status: exact|partial|manual, enumMaps?, notes, evidence, schemaRef}`.

- **AND/OR rule (behavior-critical):** Tasker profile contexts are AND-ed; MacroDroid `m_triggerList` items are **OR-ed**, and continuous states belong in constraints. Rule: one Tasker profile → one MacroDroid macro; the event/time context becomes the trigger; state contexts become `m_constraintList` entries (macro- or trigger-level); a plain task (no contexts) → `EmptyTrigger` + a manual-run note.
- Exact classes already verified in the live catalog (126 triggers / 211 actions / 88 constraints): `ScreenOnOffTrigger`, `WifiConnectionTrigger`, `TimerTrigger`, `RegularIntervalTrigger`, `DayOfWeekConstraint`, `WifiConstraint`, `EmptyTrigger`, `UIInteractionAction`, `ReadScreenContentsAction`, `PressBackAction`, `HttpRequestAction`… (autoproof/mcp/features.txt)
- **Control-flow emission:** Tasker IF(37)→`IfConditionAction` (condition into `m_constraintList`), ELSE(43)→`ElseAction`, ENDIF(38)→`EndIfAction`, FOR(39)/ENDFOR(40)→`LoopAction`/`EndLoopAction` — flat marker actions in `m_actionList`. GOTO(135)/STOP(137): no equivalent → `unmapped` with manual step. RUN_TASK(130) → inline the callee or `manual` (user decision per instance).
- **Variable mapping:** Tasker `%UPPER` globals → MacroDroid globals referenced as `{v=name}`; locals → `{lv=name}` + a `localVariables` declaration (see 7.2). Builtins map to magic text: `%BATT`→`{battery}`, `%WIFII`→`{ssid}`, `%TIME`→`{datetime}`, `%LOC`→`{lat_long}`, `% fg app`→`{fg_app_package}`… (full magic-text reference: autoproof/mcp/schema-http-request-action.txt lines 226–260). **Caveat:** Tasker also has lowercase builtins (`%time`, `%loc`, `%http_data`) that the lowercase=local heuristic misclassifies — the variables table must list known builtins and exempt them. `%parN` → local variables on the callee when inlining RUN_TASK.

### 7.2 Emission contract (exact, from the validated minimal macro)

Root: `{macroExportVersion: 1, macro, globalVariables: [], userIcons: null}`. Macro: `m_name`, `m_description`, `m_enabled: true`, `m_completed: true`, `m_GUID: 0`, `m_category: "Uncategorized"`, `aiGenerated: 1`, `m_triggerList`, `m_actionList` (flat, with control-flow markers), `m_constraintList`, `localVariables`. Locals are declared WITHOUT the `m_` prefix in the variable name; each needs `m_type` (0=Boolean … 6=Color; string=2, integer=1) and an initial value. Every `m_SIGUID` is a placeholder int (spike used 112233445566771). String values require `\"` and `\\` escaping, and literal magic-text braces `\{`. Proven minimal example (passed live `validate_macrodroid_macro` with zero errors): **autoproof/mcp/minimal-macro.json** (RegularIntervalTrigger + HttpRequestAction + WifiConstraint + two locals).

### 7.3 Validation — CORS is MEASURED BLOCKED

`remote.macrodroid.com/mcp` returns **no `Access-Control-Allow-Origin`** on POST or on the OPTIONS preflight (Origins `http://localhost:8080` and `https://autoport.example` tested). **Browser-direct validation is impossible.** (autoproof/mcp/cors.txt, autoproof/mcp/cors-raw.json) The three real paths:

1. **Connector handoff** (always available): copy JSON to clipboard + open Claude/ChatGPT with the MacroDroid connector — the connector validates and mints the share link.
2. **BYO proxy** (user-hosted Cloudflare Worker / any CORS-relay): `mcpClient.js` posts through a user-configured URL.
3. **Offline structural validator** (`validate.js`) with **two modes** — required, because the live MCP validator is shallow (probe verdicts, autoproof/mcp/validate-probe-*.json): `mcp-parity` accepts a bare macro without the export wrapper, a missing `m_completed`, and a constraint inside `m_actionList`; it rejects unknown `m_classType` and an unclosed If. `strict` additionally enforces wrapper shape, required fields, list namespaces, per-feature enums. **V13 runs against mcp-parity/live; V14 against strict.** Probe verdicts are captured as test fixtures.

### 7.4 Delivery — UNPROVEN (verification task before V15)

`share_macrodroid_macro` was deliberately never called (no hosted-link artifact), direct JSON import into MacroDroid 6.0 is untested, and connector availability is untested. Task: prove direct-JSON import and share-link minting on a real device; otherwise drop "direct JSON" from the UI and require the connector/worker path.

### 7.5 Optional LLM assist — CSP-constrained

GitHub Pages serves no response headers, and a `<meta>` CSP cannot inject a user-configured endpoint into `connect-src` at runtime. Implementable policy: a static meta CSP baseline (`default-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'`) + route BYO-LLM calls through the same user-hosted proxy as §7.3 path 2 — or explicitly drop BYO-LLM on Pages. Keys in `localStorage`, masked, never logged.

### 7.6 Snapshot refresh workflow

`list_macrodroid_features` returns a 49 KB markdown catalog (126/211/88 = fingerprint); one `get_macrodroid_schema` call is ~52 KB text / ~220–232 KB JSON — **raw dumps stay out of git**. `scripts/trim_mcp_snapshot.py` produces `catalog.json` (class → description + counts) and per-class trimmed schemas under `data/macrodroid/schemas/` (m_classType, field names/types/required/enums), sharing the ~800-line protocol boilerplate once. A scheduled CI job (weekly) re-fetches and PRs on drift; counts change = schema refresh required before merging mapping-table edits.

## 8. AutoInput → MacroDroid touch mapping (proven classes)

| AutoInput op | MacroDroid class / action |
|---|---|
| Click (text/id/point/focus/list) | `UIInteractionAction` Click — selector: Text content (wildcards) / View id / X,Y |
| Long Click | `UIInteractionAction` Long click (duration ms) |
| Scroll Forward / Backward | `UIInteractionAction` Gesture (directional swipe, % or px) |
| Swipe / Pinch / Multiple (GestureType) | `UIInteractionAction` Gesture / two-finger options |
| Paste / Cut / Select Text / Write / Replace / Focus | `UIInteractionAction` text-field ops (per-arg templates in actions.json) |
| GlobalAction Back / Home / Recents | `UIInteractionAction` / `PressBackAction` (per catalog) |
| GlobalAction Quick Settings / Power Dialog | **manual** (no catalog equivalent verified) |
| Keys / Unlock / TurnOffScreen / Modes | **manual** (verify TurnOffScreen↔screen actions in catalog during M3) |
| UI Query (read screen) | `ReadScreenContentsAction` (dictionary {view id → text, optional bounds}) |
| v2 DSL actions | map per-verb through the same rows; unmapped verbs → status `manual` |

(Legacy `TouchScreenAction` no longer exists in the catalog — do not emit it. Full 15-op table with arg templates: `data/macrodroid/actions.json`, seeded from autoproof/js/pluginAutoInput.js MD_HINT.)

## 9. Privacy / security

- All parsing client-side; files never leave the device unless the user enables the proxy/LLM path (explicit opt-in per action).
- No analytics, no cookies, no backend. GitHub Pages static.
- API keys in `localStorage` only; masked in UI. CSP: static meta baseline + proxy (§7.5) — the rev-1 dynamic `connect-src` claim was unimplementable and is dropped.
- **Input budget:** full Tasker backups can be multi-MB; parsing runs in a **Web Worker** (UI-thread parse of a large backup freezes the page). Budget: 25 MiB share cap (measured platform limit) → reject above with a friendly card.
- **Naming hygiene:** MacroDroid variable charset/reserved-name rules; `%parN` → distinct local names; blank/duplicate macro names from Tasker exports get deterministic suffixes (`#2`).
- **String fidelity:** fixtures must assert round-trip equality for quotes, backslashes, newlines, embedded JSON bodies, emoji (corpus has `Pin Unlock 🔓`), and literal `{`/`}` (magic-text escape).
- Generated macros are code — diff-style review before export; never auto-import.

## 10. Milestones

- **M1 — Share-in + Tasker inventory:** fix the PWA skeleton's subpath/CACHE/ACTION_HINTS defects, wire sniff+parser (port spikes/taskerXml.py to JS or run python-validated logic), review UI with statuses. 
- **M2 — MacroDroid mapping + output:** arg tables for the **28 corpus codes** (G1), the 3 mapping tables, emitter with control-flow markers + variables, offline validator (both modes), clipboard/connector handoff.
- **M3 — AutoInput/touch:** decoder against the 70-export corpus (unit tests already exist: autoproof/scripts/test_autoinput_decoder.mjs, 13 checks), the 12 device-capture tasks for residual gaps.
- **M4 — Automate:** `.flo` T0 + error-contract fix (V11 blocker), then PDF/PNG analysis task.
- **M5 — Optional:** BYO proxy + MCP live validation, BYO-LLM assist, `.flo` T1 generator spike.
- **Beyond:** each new source/target is one adapter under `js/sources/` / `js/targets/` + its mapping tables — e.g. MacroDroid `.mdr`/JSON and Easer as sources, Tasker XML / n8n / Home Assistant YAML as targets, including reverse of Phase 1.

## 11. Verification criteria (each must pass before its milestone ships; rev-2 wording matches measured reality)

**PWA / share target**
- V1. Install on Android 13+/14 (Chrome). Share a `.tsk.xml` from Files → AutoPort in share sheet → parsed task. Repeat from a second file manager and Tasker's own share flow. Also record behavior for a file with **empty MIME** (octet-stream entry unverified) and note Chromium-only support.
- V2. Share an Automate `.flo` → app reports T0 inventory (version, statement count, "title from filename").
- V3. Share a `taskernet.com/shares/...` URL → link shown + graceful fallback card (never a blank screen), regardless of fetch outcome.
- V4. Golden equality across drag-drop / file-picker / paste paths, using **normalized goldens**: stable ids, provenance `sr`/`ve` pinned or excluded by rule, basename-only `source.file`; update via `scripts/update_golden.py`.
- V5. Offline after first load: airplane-mode share → parse + review works — **requires data/ JSONs in the SW precache** (rev-2 gate).
- V19. SW precache includes `data/taskerCodes.json` + macrodroid data; CACHE version bumps on data change (CI check).

**Tasker parser**
- V6. **≥10 real exports today** (corpus has 10; CI fails below 10) growing to 20; include the full-backup fixture (currently planned-but-missing). 100% of builtin codes name-decoded; args match goldens.
- V7. taskerCodes.json carries 438+91+56 names + sentinels + `source.sha256`; unknown-code fixture asserts code 471 → "unknown (code 471)", plugin 999999 → plugin-with-package, unknown event 231 → "unknown (code 231)" — no crash (fixture: autoproof/fixtures/tasker-edge/backup-edge-cases.xml).
- V8. Variables: every `%var` in args **and ConditionList** collected; `%parN` preserved; `<Share>` prose excluded.

**AutoInput decoder**
- V9. 8 op families decoded from the **70-export corpus**, 128/128 BLURB-graded actions correct; fabricated bundles → unmapped-with-reason; residual 12 device-capture tasks pass on a real device (autoproof/docs/empirical-capture-plan.md).
- V10. Emitted `UIInteractionAction` JSON for click/swipe/scroll passes mapping-table unit tests (selector type, coordinate units, px→% where configured).

**Automate**
- V11. 10 unique `.flo` (13 files, 3 byte-identical duplicates): magic/version/count correct, no false positive on random `.bin`; **truncated-header and truncated-magic-only fixtures return `{error:{kind:'truncated'}}`** — currently RED (spike tracebacks; autoproof/out/fixture-tests.json) and blocks M4.
- V12. **Blocked** until a real flow-export.png fixture + counting method exist (§5.4).

**MacroDroid output**
- V13. Every `exact`-mapped corpus action passes live MCP `validate_macrodroid_macro` in **mcp-parity** semantics (zero errors) — at build time via the endpoint, re-verified on snapshot refresh.
- V14. Adversarial fixtures pass the **strict** offline validator (unbalanced If/Loop fail; wrapper/namespace/enum checks).
- V15. **Delivery proof required first (§7.4):** on a real device, a share link (connector or worker path) imports into MacroDroid ≥6.0 and a smoke macro runs. Until §7.4's task passes, V15 is not startable.
- V16. Every input action — including scenes/SceneElements and unknown tags from `stats.unrepresentable` — appears as a review item with status + reason; nothing silently dropped.
- V20. CI: `node --check` all JS, manifest JSON-valid, `node tests/run-tests.mjs` (125 checks) + `node tests/test_autoinput_decoder.mjs`, repo-relative fixture manifest passes `check_manifest.py`, generated taskerCodes.json byte-stable (`git diff --exit-code`).
- V21. String-fidelity fixtures (quotes/backslashes/newlines/JSON/emoji/`\{`) round-trip through parse→emit unchanged.

**Privacy**
- V17. DevTools network tab during parse+review with no proxy/LLM configured: zero outbound requests.
- V18. With proxy/LLM configured: only requests to the configured URL; non-converted item contents never in prompts without an explicit toggle.

## 12. Risks

- **Project-Pages subpath** — absolute-path PWA bugs are already proven possible (spike skeleton shipped them); relative/scope-aware everything is a hard review item.
- **MacroDroid delivery path unproven** (§7.4) — the whole output story rests on the connector until device-tested.
- **Third-party fixture licensing** — 10 Tasker exports from 5 GitHub repos with unknown licenses; `docs/FIXTURES.md` records origin/sha256/license/disposition, and unclear ones are replaced with synthetic fixtures before any public push. APKs and jadx trees stay local-only, never committed.
- **Shallow MCP validator** — mcp-parity mode is permissive; strict mode is ours, so "validated" must always name the mode.
- **Plugin-code drift** — AutoInput `<code>` values change across plugin versions; routing is on package+class (never code), and the corpus spans both observed code generations.
- **G1 arg semantics** — the largest remaining unknown for M2 emission quality; bounded to 28 codes for launch.
- **UI-thread freeze** on multi-MB backups — Web Worker is mandatory, not optional.
- **Share-target MIME quirks** — empty-type and octet-stream behavior need one device-test pass (V1).
- Closed from rev 1: CORS (measured blocked), AutoInput extra keys (known for 8 families; 12 device tasks remain), Parcel ceiling (narrower than feared).

## 13. Repo bootstrap

Normative: **autoproof/repo-bootstrap.md** — (a) `gh repo create kaovilai/autoport --public --source . --push` (private variant included there; choice = OPEN DECISION), (b) Pages via `gh api -X POST repos/kaovilai/autoport/pages -f "source[branch]=main" -f "source[path]=/"` then enforce HTTPS, (c) the final tree (§3 above), (d) CI draft — **with rev-2 fixes**: repo-relative fixture manifest (path=repoPath), node/python checks per V20, code-table fetch as a separate scheduled job, (e) LICENSE (MIT recommended), (f) README skeleton, (g) first-10-commits mapping M1→M5.

## Appendix A — MCP wire shapes (measured)

Endpoint `https://remote.macrodroid.com/mcp`, plain JSON-RPC over POST (no session header, no SSE, unauthenticated for all four tools; server `macrodroid-macro-builder 0.1.0`, protocol `2025-03-26`):

```json
// request
{"jsonrpc":"2.0","id":1,"method":"tools/call",
 "params":{"name":"validate_macrodroid_macro","arguments":{"macroJson": <macro object> }}}
// response
{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"…verdict…"}]}}
```

Tools: `list_macrodroid_features` (49 KB catalog; 126/211/88), `get_macrodroid_schema` (per-feature JSON layout + writing rules), `validate_macrodroid_macro`, `share_macrodroid_macro` (never called — see §7.4). Full captures: autoproof/mcp/. Minimal valid macro: autoproof/mcp/minimal-macro.json (§7.2).

## Appendix B — Spike results index (all under `autoproof/`)

| Spike | Verdict | Key artifacts |
|---|---|---|
| tasker-parser | proven | data/taskerCodes.json, spikes/taskerXml.py + verify.py, ir-schema.md, out/tasker-coverage.json, fixtures/tasker* |
| flo-t0 | proven (error contract RED) | spikes/floT0.py, out/flo-t0.json, out/fixture-tests.json, out/t1probe.json |
| mcp-wire | proven | mcp/{initialize,tools-list,features,schema-*,validate-ok,minimal-macro,cors}.json/.txt |
| autoinput | proven (corpus + APK) | data/autoInputSchema-seed.json, autoInputEnums.json, autoInputCorpus.json, js/pluginAutoInput.js, docs/autoinput-notes.md, docs/empirical-capture-plan.md; + parent-thread data/autoInputSchema-apk.json |
| pwa-shell | proven (subpath defects) | pwa/ (manifest, sw.js, app.js, sniff.js, idb.js, tests, share-target-facts.md) |
| repo-bootstrap | plan | repo-bootstrap.md, fixtures/MANIFEST.json, scripts/check_manifest.py |
| AutoInput APK (parent) | proven | analysis/autoinput-src/ (local-only), data/autoInputSchema-apk.json |

Workflow run `wf_f4e24fc4-ce0`: 7 agents, 0 errors, full structured returns in autoproof/workflow-journal-results.json.

## 14. OPEN DECISIONS

1. **Repo visibility:** public from commit 1 (Pages + template-store discoverability) vs private until M2. (bootstrap doc has both command sets)
2. **G1 arg-table derivation:** mine `analysis/tasker-src/` decompiled config classes locally (fast, licensing gray for redistribution of derived tables) vs community-documented tables only (slower, cleaner). Interim: derived tables are facts about a file format — record provenance per entry.
3. **BYO-LLM on Pages:** proxy-required (keep §7.5 path 2) vs drop entirely for Phase 1.
4. **Fixture licensing:** replace all unclear-license third-party exports with synthetic equivalents before first public push, or keep with docs/FIXTURES.md dispositions?
5. **Taskernet fetch:** attempt live fetch at all (Cloudflare ToS) vs paste-only from day one.
6. **V15 device-test protocol:** who owns the real-device test pass (user's phone + MacroDroid install) and when.
