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
//     against a JVM reference, see tests/fixtures/macrodroid/jos-reference.json)
//   - Tasker %variables -> MacroDroid magic text ({lv=} local, {v=} global)
//     in bundle string values + blurb; Tasker built-ins (%err etc.) are left
//     literal and reported
//   - builtin/unknown actions are skipped and reported (native emission for
//     the exact-mapped codes is M3.2)
//   - triggers: EmptyTrigger (manual run) — Tasker trigger mapping is M3.2
//
// The m_plugin / m_pluginInstanceData JSON field names follow MacroDroid's
// Jackson field-name serialization of the decompiled classes (see
// docs/DESIGN.md §7.7); enum mType serializes as its name ("SETTING").

import { serializeBundleB64 } from './bundleSerializer.js';
import { lookupPlugin } from './pluginRegistry.js';

const BLURB_KEY = 'com.twofortyfouram.locale.intent.extra.BLURB';

/* ------------------------------------------------------------------ */
/* Tasker Vals (flattened, with -type companions) -> typed bundle      */
/* ------------------------------------------------------------------ */

/** Reconstruct the plugin's typed Bundle from the IR's raw flattened Vals:
 *  {key: value, 'key-type': 'java.lang.String'|'java.lang.Boolean'|
 *   'java.lang.Integer', ...}, '<null>' sentinels, {$array:[...]} wrappers,
 *  {$bundle:{...}} sub-bundles. */
export function typedBundle(rawVals) {
  const out = {};
  if (!rawVals || typeof rawVals !== 'object') return out;
  for (const [k, v] of Object.entries(rawVals)) {
    if (k.endsWith('-type')) continue;
    const t = rawVals[`${k}-type`] || 'java.lang.String';
    if (v === '<null>') { out[k] = null; continue; }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (Array.isArray(v.$array)) { out[k] = v.$array.map(String); continue; }
      if (v.$bundle && typeof v.$bundle === 'object') { out[k] = typedBundle(v.$bundle); continue; }
      continue; // unrecognized shape — skip rather than guess
    }
    if (t === 'java.lang.Boolean') out[k] = String(v) === 'true';
    else if (t === 'java.lang.Integer' || t === 'java.lang.Long') {
      const n = parseInt(v, 10);
      out[k] = Number.isFinite(n) ? n : String(v);
    } else out[k] = String(v);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Tasker %variable -> MacroDroid magic text                           */
/* ------------------------------------------------------------------ */

/** Translate Tasker variable references in a string. Only variables the IR
 *  knows (macro.variables.local/global) are translated — never guessed.
 *  Tasker built-ins (%err, %errmsg, %TIME, ...) stay literal and are
 *  reported so the UI can warn. Longest names first (%msg inside %errmsg). */
export function translateVars(text, variables, report) {
  const names = [
    ...(variables?.local || []).map((n) => ({ name: n, magic: 'lv' })),
    ...(variables?.global || []).map((n) => ({ name: n, magic: 'v' })),
  ].sort((a, b) => b.name.length - a.name.length);
  let out = String(text);
  for (const { name, magic } of names) {
    const bare = name.replace(/^%+/, '');
    if (!bare) continue;
    out = out.split(name).join(`{${magic}=${bare}}`);
    report.variablesUsed.add(name);
  }
  // report remaining %references that were NOT translated (Tasker builtins
  // or unknown locals): they will not expand at runtime
  for (const m of out.matchAll(/%[A-Za-z][A-Za-z0-9_]*/g)) {
    report.unresolvedVariables.add(m[0]);
  }
  return out;
}

function translateStringValues(bundle, variables, report) {
  const out = {};
  for (const [k, v] of Object.entries(bundle)) {
    if (typeof v === 'string') out[k] = translateVars(v, variables, report);
    else if (Array.isArray(v)) out[k] = v.map((el) => translateVars(el, variables, report));
    else if (v && typeof v === 'object') out[k] = translateStringValues(v, variables, report);
    else out[k] = v;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* LocalePluginAction node                                            */
/* ------------------------------------------------------------------ */

function emitPluginAction(act, variables, report) {
  const packageName = act.package || (act.args && act.args.arg1) || null;
  const activity = act.pluginClass || (act.args && act.args.arg2) || null;
  if (!packageName) {
    report.skipped.push({ sr: act.sr, kind: act.kind, codeName: act.codeName, reason: 'plugin action without a package (arg1)' });
    return null;
  }
  const plugin = lookupPlugin(packageName);
  const rawVals = act.args && act.args.arg0 && act.args.arg0.$bundle
    ? act.args.arg0.$bundle : {};
  const bundle = typedBundle(rawVals);
  const translated = translateStringValues(bundle, variables, report);
  const blurbRaw = typeof rawVals[BLURB_KEY] === 'string' ? rawVals[BLURB_KEY] : '';
  const blurb = translateVars(blurbRaw, variables, report);

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
      mSerializedBundle: serializeBundleB64(translated),
      mBlurb: blurb,
    },
  };
  if (!plugin.known) {
    report.unknownPlugins.add(packageName);
  }
  report.emitted.push({ sr: act.sr, package: packageName, activity, known: plugin.known, blurb: blurbRaw });
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
    variablesUsed: new Set(),
    unresolvedVariables: new Set(),
    unknownPlugins: new Set(),
  };
  const actionList = [];
  for (const act of irMacro.actions || []) {
    if (act.kind === 'plugin') {
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
  const globalVars = [...report.variablesUsed]
    .filter((n) => (variables.global || []).includes(n))
    .map((n) => ({ m_name: n.replace(/^%+/, ''), m_type: 2, m_stringValue: '', isLocalVar: false }));

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
      globalVariables: globalVars,
    },
  };

  report.variablesUsed = [...report.variablesUsed];
  report.unresolvedVariables = [...report.unresolvedVariables];
  report.unknownPlugins = [...report.unknownPlugins];
  return { macro, report };
}

/** Emit every macro in an IR.
 *  @returns {{emissions: Array<{macro: object|null, report: object}>}}
 *  `macro` is null when an IR macro produced no plugin actions. */
export function emitMacros(ir, options = {}) {
  const emissions = [];
  for (const m of ir.macros || []) {
    const { macro, report } = emitMacro(m, { ...options, sourceFile: ir.source?.file });
    if ((macro.macro.m_actionList || []).length) {
      emissions.push({ macro, report });
    } else {
      emissions.push({ macro: null, report: { ...report, note: 'no plugin actions — macro not emitted' } });
    }
  }
  return { emissions };
}
