// js/targets/macrodroid/emitter.js — M3.1: emit MacroDroid macro JSON from
// the AutoPort IR using Tasker/Locale PLUGIN PASS-THROUGH.
//
// Instead of semantically converting every Tasker action to a native
// MacroDroid action, each plugin-shaped IR action (AutoInput v1/v2, any
// Tasker plugin) is emitted as a MacroDroid LocalePluginAction node that
// carries the plugin's ORIGINAL configuration bundle. At runtime MacroDroid
// delegates to the plugin itself (AutoInput must be installed on the device),
// which preserves the plugin's full vocabulary (touch/swipe/drag/click/
// multi-click/...) without per-verb mapping.
//
// Emission contract:
//   - wrapper shape follows data/macrodroid/minimal-macro.json (MCP-validated)
//   - plugin bundle -> m_pluginInstanceData.mSerializedBundle via
//     bundleSerializer (byte-exact port of the twofortyfouram SDK; verified
//     against a JVM reference, see tests/fixtures/macrodroid/jos-reference.json),
//     emitted as a JSON NUMERIC BYTE ARRAY: MacroDroid imports macros with
//     Gson (GsonUtils.getMacroGson, no custom byte[] adapter), and Gson's
//     ArrayTypeAdapter only reads byte[] as a number array — a base64 string
//     throws and MacroDeserializer silently drops the whole action (proven on
//     device: the emulator import showed "Actions 0" with a base64 blob).
//   - Tasker %variables -> MacroDroid magic text ({lv=} local, {v=} global)
//     in top-level bundle string values + blurb; Tasker built-ins (%err etc.)
//     are left literal and reported; nested bundles keep %vars literal
//     (reported) because MacroDroid only expands magic text in the values it
//     rewrites itself
//   - plugin actions carrying a Tasker If-guard are skipped and reported
//     (guard translation is M3.2 — a guard must not be silently dropped)
//   - builtin/unknown actions are skipped and reported (native emission for
//     the exact-mapped codes is M3.2)
//   - triggers: EmptyTrigger (manual run) — Tasker trigger mapping is M3.2
//
// The m_plugin / m_pluginInstanceData JSON field names follow the decompiled
// twofortyfouram locale SDK classes (see docs/DESIGN.md §7.7); enum mType
// serializes as its name ("SETTING").

import { serializeBundle } from './bundleSerializer.js';
import { lookupPlugin } from './pluginRegistry.js';

const BLURB_KEY = 'com.twofortyfouram.locale.intent.extra.BLURB';

/** Tasker built-in variables (user guide "Variables" section), EXACT-CASE as
 *  documented — Tasker distinguishes e.g. built-in %TIME from a user global
 *  %Time, so a case-insensitive set would swallow real user variables. They
 *  carry runtime values inside Tasker and have no MacroDroid equivalent, so
 *  they must stay literal and be reported — never translated to magic text
 *  and never declared as MacroDroid variables. %parN (perform-task parameters)
 *  is matched by pattern in translateVars. */
const TASKER_BUILTINS = new Set([
  // error / HTTP
  '%err', '%errmsg', '%http_response_code', '%http_response_data',
  '%http_response_headers', '%http_files', '%http_status',
  '%http_local_response_code', '%http_local_response_data',
  '%http_local_response_headers',
  // time / date
  '%TIME', '%TIMES', '%TIMEMS', '%DATE', '%DAY', '%DAYW', '%DAYM',
  '%MONTH', '%YEAR', '%HOUR', '%MINUTE', '%SUNRISE', '%SUNSET',
  // device / sensors
  '%BATT', '%BATTHEALTH', '%TEMP', '%LIGHT', '%PRESSURE', '%HUMIDITY',
  '%PROX', '%SCREEN', '%BRIGHT', '%VOLS', '%VOLC', '%VOLM', '%VOLA',
  '%VOLB', '%VOLR', '%SILENT', '%AIR', '%AIRR', '%NFC', '%FLASH', '%UPS',
  '%UPTIME', '%UPREV', '%KEYG', '%QSC', '%MEMF', '%MEMAV', '%DISKFREE',
  '%SDVOLFREE', '%SDCARD', '%LIGHTS',
  // network / location
  '%WIFI', '%WIFII', '%NETWORK', '%NETSIG', '%CELLID', '%CELLSIG',
  '%CELLNET', '%CELLASU', '%CELLLAC', '%CELLROAM', '%ROAM', '%IP', '%SSID',
  '%BSSID', '%MAC', '%BTNAME', '%LOC', '%LOCN', '%LOCACC', '%LOCNACC',
  '%LOCSPD', '%LOCALT', '%LOCATION', '%LOCATIONS', '%BEARING', '%SPEED',
  '%NETLAT', '%NETLONG',
  // phone / identity
  '%PHONE', '%SIM', '%SIM_SERIAL', '%IMSI', '%MEID', '%DEVID',
  '%DEVIDHASH', '%CALLER', '%CALLNAME', '%CALLNUM', '%CALLTYPE', '%CALLVOL',
  // task / notification / profiles
  '%MTRACK', '%MTIME', '%QTIME', '%NTITLE', '%NTEXT', '%PACTIVE',
  '%PENABLED', '%PENABLING', '%ACTIVEAPPS', '%ICONS', '%FIELDS', '%CONTEXT',
]);

/* ------------------------------------------------------------------ */
/* Tasker Vals (flattened, with -type companions) -> typed bundle      */
/* ------------------------------------------------------------------ */

/** Reconstruct the plugin's typed Bundle from the IR's raw flattened Vals:
 *  {key: value, 'key-type': 'java.lang.String'|'java.lang.Boolean'|
 *   'java.lang.Integer', ...}, '<null>' sentinels, {$array:[...]} wrappers
 *  (sometimes wrapped in a one-element array: [{$array:[...]}]),
 *  {$bundle:{...}} sub-bundles.
 *  `report` (optional) collects unrepresentable values: java.lang.Long has
 *  no slot in the twofortyfouram BundleSerializer (String/Boolean/Integer/
 *  byte[]/String[]/Bundle only), and any OTHER type companion (Float,
 *  Double, …) is rejected + reported too — silently String()-ing it would
 *  hand the plugin a different type than the source task configured. */
export function typedBundle(rawVals, report = null) {
  const out = {};
  if (!rawVals || typeof rawVals !== 'object') return out;
  for (const [k, v] of Object.entries(rawVals)) {
    if (k.endsWith('-type')) continue;
    const t = rawVals[`${k}-type`] || 'java.lang.String';
    if (t === 'java.lang.Long') {
      if (report) report.rejectedLongValues.push({ key: k, value: String(v) });
      continue;
    }
    if (t !== 'java.lang.String' && t !== 'java.lang.Boolean' && t !== 'java.lang.Integer'
        && t !== '[Ljava.lang.String;' && t !== 'android.os.Bundle') {
      // shape below decides $array/$bundle; a scalar here with an unknown
      // companion cannot be represented faithfully
      if (report) report.rejectedUnsupportedValues.push({ key: k, type: t });
      continue;
    }
    if (v === '<null>') { out[k] = null; continue; }
    let val = v;
    // normalize the [{$array:[...]}] single-element array wrapper
    if (Array.isArray(val) && val.length === 1 && val[0] && typeof val[0] === 'object'
        && !Array.isArray(val[0]) && (val[0].$array || val[0].$bundle)) {
      val = val[0];
    }
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      if (Array.isArray(val.$array)) { out[k] = val.$array.map(String); continue; }
      if (val.$bundle && typeof val.$bundle === 'object') {
        out[k] = typedBundle(val.$bundle, report);
        continue;
      }
      continue; // unrecognized shape — skip rather than guess
    }
    if (Array.isArray(val)) { out[k] = val.map(String); continue; }
    if (t === 'java.lang.Boolean') out[k] = String(v) === 'true';
    else if (t === 'java.lang.Integer') {
      const n = parseInt(v, 10);
      out[k] = Number.isFinite(n) ? n : String(v);
    } else out[k] = String(v);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Tasker %variable -> MacroDroid magic text                           */
/* ------------------------------------------------------------------ */

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Translate Tasker variable references in a string. Only variables the IR
 *  knows (macro.variables.local/global) are translated — never guessed, and
 *  only on whole-name boundaries (%msg must not match inside %errmsg).
 *  Tasker built-ins (%err, %errmsg, %TIME, ...) stay literal and are
 *  reported so the UI can warn. A variable counts as "used" only when an
 *  actual replacement happened. */
export function translateVars(text, variables, report) {
  const names = [
    ...(variables?.local || []).map((n) => ({ name: n, magic: 'lv' })),
    ...(variables?.global || []).map((n) => ({ name: n, magic: 'v' })),
  ].sort((a, b) => b.name.length - a.name.length);
  let out = String(text);
  for (const { name, magic } of names) {
    const bare = name.replace(/^%+/, '');
    if (!bare) continue;
    if (TASKER_BUILTINS.has(name) || /^%par\d+$/.test(name)) {
      report.builtinVariables.add(name); // runtime value lives in Tasker only
      continue;
    }
    // whole-name match: the next character must not extend a Tasker var name
    // (and `(` marks Tasker ARRAY syntax, e.g. %arr() — not translatable)
    const rx = new RegExp(`${escapeRe(name)}(?![A-Za-z0-9_(])`, 'g');
    let hits = 0;
    out = out.replace(rx, () => { hits += 1; return `{${magic}=${bare}}`; });
    if (hits > 0) report.variablesUsed.add(name);
  }
  // report remaining %references that were NOT translated (Tasker builtins
  // or unknown locals): they will not expand at runtime
  for (const m of out.matchAll(/%[A-Za-z][A-Za-z0-9_]*/g)) {
    report.unresolvedVariables.add(m[0]);
  }
  return out;
}

/** Collect (without translating) Tasker %vars left inside nested bundles:
 *  MacroDroid only expands magic text in the values it rewrites itself, so
 *  nested plugin bundles keep their %vars literal — surface them instead of
 *  silently rewriting what the plugin will actually receive. */
function reportNestedBundleVars(bundle, report) {
  for (const v of Object.values(bundle)) {
    if (typeof v === 'string') {
      for (const m of v.matchAll(/%[A-Za-z][A-Za-z0-9_]*/g)) {
        report.unresolvedVariables.add(m[0]);
      }
    } else if (Array.isArray(v)) {
      for (const el of v) if (typeof el === 'string') {
        for (const m of el.matchAll(/%[A-Za-z][A-Za-z0-9_]*/g)) {
          report.unresolvedVariables.add(m[0]);
        }
      }
    } else if (v && typeof v === 'object') {
      reportNestedBundleVars(v, report);
    }
  }
}

const JSON_ENCODED_KEYS = 'net.dinglisch.android.tasker.JSON_ENCODED_KEYS';

/** Translate ONLY top-level string values (and string[] elements) of the
 *  bundle; nested bundles are passed through untouched (their %vars are
 *  reported literal by reportNestedBundleVars).
 *  `jsonEncoded` (optional) is the Tasker JSON_ENCODED_KEYS set: Tasker
 *  JSON-escapes variable substitution into those values at fire time, but
 *  MacroDroid does plain runtime string replacement — a value containing a
 *  quote, backslash or newline would break the JSON the plugin receives.
 *  We cannot escape at emission time (the runtime value is unknown), so a
 *  translated JSON-encoded value is reported for the UI to warn about. */
function translateStringValues(bundle, variables, report, jsonEncoded = new Set()) {
  const out = {};
  for (const [k, v] of Object.entries(bundle)) {
    if (typeof v === 'string') {
      const translated = translateVars(v, variables, report);
      if (jsonEncoded.has(k) && translated !== v) report.jsonEncodedTranslations.add(k);
      out[k] = translated;
    } else if (Array.isArray(v)) out[k] = v.map((el) => translateVars(el, variables, report));
    else if (v && typeof v === 'object') {
      out[k] = v;
      reportNestedBundleVars(v, report);
    } else out[k] = v;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* LocalePluginAction node                                            */
/* ------------------------------------------------------------------ */

function emitPluginAction(act, variables, report) {
  if (act.condition) {
    report.skipped.push({
      sr: act.sr, kind: act.kind, codeName: act.codeName,
      reason: 'plugin action carries a Tasker If-guard; guard translation is not implemented yet (M3.2) — the action is skipped rather than losing its condition',
    });
    return null;
  }
  const onRaw = act.args ? act.args.on : undefined;
  if (onRaw === 'false' || onRaw === false) {
    // Tasker exports a disabled action as <on>false</on>; emitting it would
    // re-enable an action the source task deliberately turned off.
    report.skipped.push({
      sr: act.sr, kind: act.kind, codeName: act.codeName,
      reason: 'action is disabled in the source task (<on>false</on>)',
    });
    return null;
  }
  const packageName = act.package || (act.args && act.args.arg1) || null;
  const activity = act.pluginClass || (act.args && act.args.arg2) || null;
  if (!packageName) {
    report.skipped.push({ sr: act.sr, kind: act.kind, codeName: act.codeName, reason: 'plugin action without a package (arg1)' });
    return null;
  }
  const plugin = lookupPlugin(packageName);
  const rawVals = act.args && act.args.arg0 && act.args.arg0.$bundle
    ? act.args.arg0.$bundle : {};
  const bundle = typedBundle(rawVals, report);
  const jsonEncoded = typeof rawVals[JSON_ENCODED_KEYS] === 'string'
    ? new Set(rawVals[JSON_ENCODED_KEYS].split(/\s+/).filter(Boolean)) : new Set();
  const translated = translateStringValues(bundle, variables, report, jsonEncoded);
  const blurbRaw = typeof rawVals[BLURB_KEY] === 'string' ? rawVals[BLURB_KEY] : '';
  const blurb = translateVars(blurbRaw, variables, report);

  const bytes = serializeBundle(translated);
  if (bytes.length > 25000) { // twofortyfouram locale SDK MAXIMUM_BUNDLE_SIZE_BYTES
    report.skipped.push({
      sr: act.sr, kind: act.kind, codeName: act.codeName,
      reason: `plugin bundle is ${bytes.length} bytes, over the locale SDK 25000-byte limit`,
    });
    return null;
  }

  const registryName = `${packageName}:${activity || ''}`;
  const node = {
    m_classType: 'LocalePluginAction',
    m_SIGUID: 0,
    blockActions: true, // plugin blocks until complete — preserves Tasker action order
    arrayHandlingOption: 0, // Use first element
    m_variableMap: {}, // no output-variable mapping (Tasker %vars handled via magic text)
    m_plugin: {
      mType: 'SETTING',
      mPackageName: packageName,
      mActivityClassName: activity,
      mReceiverClassName: plugin.settingReceiver,
      mRegistryName: registryName,
      mVersionCode: plugin.versionCode,
      mConfiguration: {
        mIsBackwardsCompatibilityEnabled: false,
        mIsRequiresConnectivity: false,
        mIsDisruptsConnectivity: false,
        mIsDrainsBattery: false,
        mIsBuggy: false,
        mIsBlacklisted: false,
        mAlternatives: [],
      },
    },
    m_pluginInstanceData: {
      mType: 'SETTING',
      mRegistryName: registryName,
      // JSON numeric byte array — MacroDroid's Gson importer has no base64
      // adapter for byte[] (com.arlosoft.macrodroid.gson.GsonUtils); a
      // base64 string makes the whole action fail to deserialize.
      mSerializedBundle: Array.from(bytes),
      mBlurb: blurb,
    },
  };
  if (!plugin.known) {
    report.unknownPlugins.add(packageName);
  }
  report.emitted.push({ sr: act.sr, package: packageName, activity, known: plugin.known, blurb: blurbRaw, bundleBytes: bytes.length });
  return node;
}

/* ------------------------------------------------------------------ */
/* Macro emission                                                     */
/* ------------------------------------------------------------------ */

/** Emit one MacroDroid macro (pass-through milestone) from an IR macro.
 *  @returns {{macro: object, report: object}} */
export function emitMacro(irMacro, options = {}) {
  const variables = irMacro.variables || {};
  const report = {
    emitted: [],
    skipped: [],
    rejectedLongValues: [],
    rejectedUnsupportedValues: [],
    variablesUsed: new Set(),
    unresolvedVariables: new Set(),
    builtinVariables: new Set(),
    unknownPlugins: new Set(),
    jsonEncodedTranslations: new Set(),
  };
  const actionList = [];
  // Tasker control-flow nesting: IF/FOR open a block, ENDIF/ENDFOR close it.
  // Emitting a plugin action that lives inside a block would run it
  // unconditionally in MacroDroid (block markers are builtins, skipped in
  // M3.1), so enclosed plugin actions are skipped + reported until
  // control-flow mapping is implemented (M3.2). Actions are in numeric-sr
  // (real task) order, which the block structure requires.
  const OPENERS = new Set(['IF', 'FOR']);
  const CLOSERS = new Set(['ENDIF', 'ENDFOR']);
  let blockDepth = 0;
  for (const act of irMacro.actions || []) {
    if (act.kind === 'builtin' && OPENERS.has(act.codeName)) blockDepth += 1;
    else if (act.kind === 'builtin' && CLOSERS.has(act.codeName)) blockDepth = Math.max(0, blockDepth - 1);
    const inBlock = blockDepth > 0;
    if (act.kind === 'plugin') {
      if (inBlock) {
        report.skipped.push({
          sr: act.sr, kind: act.kind, codeName: act.codeName,
          reason: 'plugin action is inside a Tasker If/For block; control-flow mapping is not implemented yet (M3.2) — the action is skipped rather than running unconditionally',
        });
        continue;
      }
      const node = emitPluginAction(act, variables, report);
      if (node) actionList.push(node);
    } else {
      report.skipped.push({
        sr: act.sr,
        kind: act.kind,
        code: act.code,
        codeName: act.codeName,
        reason: act.kind === 'builtin'
          ? 'native MacroDroid emission for this action is not implemented yet (M3.2); the macro runs the plugin actions only'
          : 'unknown action code',
      });
    }
  }

  const localVars = [...report.variablesUsed]
    .filter((n) => (variables.local || []).includes(n))
    .map((n) => ({ m_name: n.replace(/^%+/, ''), m_type: 2, m_stringValue: '', isLocalVar: true }));
  // Tasker globals are NOT declarable here: MacroDroid's Macro.java has
  // `localVariables` but no globalVariables field (globals are device-level
  // entities created in the Variables screen), so importing a macro cannot
  // create them — Gson ignores the field. Reported as an external
  // prerequisite instead of pretending they were declared.
  const globalsUsed = [...report.variablesUsed]
    .filter((n) => (variables.global || []).includes(n))
    .map((n) => n.replace(/^%+/, ''));

  const macro = {
    macroExportVersion: 1,
    macro: {
      m_name: options.name || irMacro.name || 'AutoPort pass-through',
      m_description: `AutoPort plugin pass-through. `
        + `${report.emitted.length} plugin action(s) delegated to their plugin apps; `
        + `${report.skipped.length} action(s) not yet converted (see conversion report).`,
      m_enabled: true,
      m_completed: true,
      m_GUID: 0,
      m_category: 'AutoPort',
      aiGenerated: 1,
      m_triggerList: [
        { m_classType: 'EmptyTrigger', m_SIGUID: 0 }, // manual run until trigger mapping (M3.2)
      ],
      m_actionList: actionList,
      m_constraintList: [],
      localVariables: localVars,
    },
  };

  report.variablesUsed = [...report.variablesUsed];
  report.unresolvedVariables = [...report.unresolvedVariables];
  report.builtinVariables = [...report.builtinVariables];
  report.unknownPlugins = [...report.unknownPlugins];
  report.jsonEncodedTranslations = [...report.jsonEncodedTranslations];
  // Tasker global variables the macro references: declared in the exported
  // macro, but their VALUES live in Tasker — the user must set them in
  // MacroDroid. Surfaced so the UI can warn about the external prerequisite.
  report.globalVariablesRequired = globalsUsed;
  return { macro, report };
}

/** Emit every macro in an IR.
 *  @returns {{emissions: Array<{macro: object|null, report: object}>}}
 *  `macro` is null when an IR macro produced no plugin actions or failed to
 *  emit; a failure is reported in `report.error` (never thrown, so one bad
 *  macro cannot take down the whole conversion). */
export function emitMacros(ir, options = {}) {
  const emissions = [];
  for (const m of ir.macros || []) {
    let out;
    try {
      out = emitMacro(m, { ...options, sourceFile: ir.source?.file });
    } catch (e) {
      out = {
        macro: null,
        report: {
          emitted: [], skipped: [], rejectedLongValues: [],
          rejectedUnsupportedValues: [],
          variablesUsed: [], unresolvedVariables: [], builtinVariables: [],
          unknownPlugins: [], globalVariablesRequired: [], jsonEncodedTranslations: [],
          error: `emission failed: ${e && e.message ? e.message : String(e)}`,
        },
      };
    }
    if (out.macro && (out.macro.macro.m_actionList || []).length) {
      emissions.push(out);
    } else if (out.report.error) {
      emissions.push({ macro: null, report: out.report });
    } else {
      emissions.push({ macro: null, report: { ...out.report, note: 'no emittable plugin actions — macro not emitted' } });
    }
  }
  return { emissions };
}

/* ------------------------------------------------------------------ */
/* Automate .flo → MacroDroid plug-in pass-through                    */
/* ------------------------------------------------------------------ */

// Automate interpolates flow variables into plugin configuration strings at
// fire time (F0.d, pattern "%name"); undefined variables stay literal. The
// flow's variable definitions are NOT recoverable without T1, so bundle
// strings are kept byte-literal (Automate's own semantics for undefined
// variables) and every %name found is reported for the user to review in the
// MacroDroid editor — never silently rewritten to magic text.
const AUTOMATE_VAR_RE = /%[A-Za-z_][A-Za-z0-9_]*/g;

/** Decoded Android-Parcel bundle value -> locale-SDK representable value.
 *  Tagged {$parcel: type} values (Long/Float/Double/Short/…) are rejected
 *  and reported exactly like the Tasker path's type companions. */
function automateValue(v, keyPath, report) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    // decodeParcelBundle only yields int32 integers for VAL_INTEGER/BOOLEAN
    // (longs/floats/doubles arrive as tagged objects), so a non-int32 number
    // cannot occur — report it defensively rather than silently dropping.
    if (Number.isInteger(v) && Math.abs(v) <= 0x7fffffff) return v;
    report.rejectedUnsupportedValues.push({ key: keyPath, type: 'number(non-int32)' });
    return undefined;
  }
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : String(x)));
  if (typeof v === 'object') {
    if (typeof v.$parcel === 'string') {
      if (v.$parcel === 'java.lang.Long') {
        report.rejectedLongValues.push({ key: keyPath, value: String(v.value) });
      } else {
        report.rejectedUnsupportedValues.push({ key: keyPath, type: v.$parcel });
      }
      return undefined; // drop
    }
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      const conv = automateValue(val, keyPath ? `${keyPath}.${k}` : k, report);
      if (conv !== undefined) out[k] = conv;
    }
    return out;
  }
  report.rejectedUnsupportedValues.push({ key: keyPath, type: typeof v });
  return undefined;
}

function collectAutomateVars(v, report) {
  if (typeof v === 'string') {
    for (const m of v.matchAll(AUTOMATE_VAR_RE)) report.automateVariables.add(m[0]);
  } else if (Array.isArray(v)) {
    for (const x of v) collectAutomateVars(x, report);
  } else if (v && typeof v === 'object' && typeof v.$parcel !== 'string') {
    for (const val of Object.values(v)) collectAutomateVars(val, report);
  }
}

/** Emit one MacroDroid macro from an Automate .flo plug-in scan
 *  (js/sources/automate/floPlugins.js scanFloPlugins). Every plug-in
 *  statement found becomes a LocalePluginAction carrying the plugin's
 *  configuration bundle, re-serialized from the decoded Android Parcel into
 *  the locale-SDK format MacroDroid expects. The flow's OTHER statements
 *  (control flow, native blocks) are not converted — that needs the T1
 *  statement registry — and the macro says so in its description.
 *  @returns {{macro: object|null, report: object}} */
export function emitAutomateMacro(scan, options = {}) {
  const report = {
    emitted: [],
    skipped: [],
    rejectedLongValues: [],
    rejectedUnsupportedValues: [],
    unknownPlugins: new Set(),
    automateVariables: new Set(),
    automateOutputVariables: new Set(),
    typeAssumedSetting: 0,
    statementsTotal: scan && scan.statementCount != null ? scan.statementCount : null,
    pluginCount: scan ? scan.pluginCount || 0 : 0,
  };
  const actionList = [];
  for (const [idx, p] of ((scan && scan.plugins) || []).entries()) {
    if (p.kind === 'CONDITION' || p.kind === 'EVENT') {
      report.skipped.push({
        index: idx + 1, package: p.package, kind: p.kind,
        reason: `Automate plug-in ${p.kind.toLowerCase()} block — MacroDroid constraint/trigger mapping needs the flow graph (T1 statement registry); reported, not emitted`,
      });
      continue;
    }
    if (p.kind === null) report.typeAssumedSetting += 1;
    if (!p.package) {
      report.skipped.push({ index: idx + 1, reason: 'plug-in block without a package' });
      continue;
    }
    const plugin = lookupPlugin(p.package);
    const bundle = automateValue(p.bundle, '', report) || {};
    const bytes = serializeBundle(bundle);
    if (bytes.length > 25000) { // twofortyfouram locale SDK MAXIMUM_BUNDLE_SIZE_BYTES
      report.skipped.push({
        index: idx + 1, package: p.package,
        reason: `plugin bundle is ${bytes.length} bytes, over the locale SDK 25000-byte limit`,
      });
      continue;
    }
    collectAutomateVars(p.bundle, report);
    if (p.blurb) collectAutomateVars(p.blurb, report);
    for (const n of p.varNames || []) report.automateOutputVariables.add(n);

    const registryName = `${p.package}:${p.activity || ''}`;
    actionList.push({
      m_classType: 'LocalePluginAction',
      m_SIGUID: 0,
      blockActions: true, // plugin blocks until complete — preserves flow order
      arrayHandlingOption: 0, // Use first element
      m_variableMap: {}, // Automate output-variable mappings are reported, not mapped (T1)
      m_plugin: {
        mType: 'SETTING',
        mPackageName: p.package,
        mActivityClassName: p.activity,
        mReceiverClassName: plugin.settingReceiver,
        mRegistryName: registryName,
        mVersionCode: plugin.versionCode,
        mConfiguration: {
          mIsBackwardsCompatibilityEnabled: false,
          mIsRequiresConnectivity: false,
          mIsDisruptsConnectivity: false,
          mIsDrainsBattery: false,
          mIsBuggy: false,
          mIsBlacklisted: false,
          mAlternatives: [],
        },
      },
      m_pluginInstanceData: {
        mType: 'SETTING',
        mRegistryName: registryName,
        // JSON numeric byte array — MacroDroid's Gson importer has no base64
        // adapter for byte[] (com.arlosoft.macrodroid.gson.GsonUtils).
        mSerializedBundle: Array.from(bytes),
        mBlurb: p.blurb || '',
      },
    });
    if (!plugin.known) report.unknownPlugins.add(p.package);
    report.emitted.push({ index: idx + 1, package: p.package, activity: p.activity, known: plugin.known, blurb: p.blurb || '', bundleBytes: bytes.length });
  }

  report.unknownPlugins = [...report.unknownPlugins];
  report.automateVariables = [...report.automateVariables].sort();
  report.automateOutputVariables = [...report.automateOutputVariables].sort();

  if (!actionList.length) {
    return { macro: null, report };
  }
  const notConverted = report.statementsTotal != null
    ? Math.max(0, report.statementsTotal - report.emitted.length) : null;
  const macro = {
    macroExportVersion: 1,
    macro: {
      m_name: options.name || 'AutoPort Automate pass-through',
      m_description: `AutoPort Automate plug-in pass-through. `
        + `${report.emitted.length} plug-in block(s) delegated to their plugin apps`
        + `${notConverted != null ? `; the flow's remaining ${notConverted} statement(s) (control flow, native blocks) are not converted yet (T1)` : ''}.`,
      m_enabled: true,
      m_completed: true,
      m_GUID: 0,
      m_category: 'AutoPort',
      aiGenerated: 1,
      m_triggerList: [
        { m_classType: 'EmptyTrigger', m_SIGUID: 0 }, // manual run — Automate triggers need T1
      ],
      m_actionList: actionList,
      m_constraintList: [],
      localVariables: [],
    },
  };
  return { macro, report };
}
