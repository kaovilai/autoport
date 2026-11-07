// js/sources/tasker/pluginAutoInput.js — AutoInput (com.joaomgcd.autoinput) plugin
// bundle decoder: flattened Tasker plugin `Vals` -> {op, selector, gesture, options}.
//
// Ground truth:
//   data/autoInputSchema.json   (APK-grounded bundle schema; ops + localized-key footgun)
//   data/autoInputEnums.json    (APK res/values arrays; ActionType, FieldSelectionType, ...)
//   data/autoInputCorpus.json   (357 real AutoInput actions; pluginTypeId -> config activity)
//   tests/golden/tasker/*.ir.json (31 real AutoInput plugin actions the test drives)
//
// Facts baked in from those files (see comments per table):
//   * Plugin identity is arg1 (package) + arg2 (config activity class) / `plugintypeid`.
//     NEVER route on the numeric <code> (it drifts between AutoInput versions).
//   * Bundle keys are LOCALIZED display names. English defaults from the schema are
//     matched first; aliases, then a BLURB-description fallback cover other locales.
//   * v2 `Actions To Perform` is a mini-DSL: `Name(arg1,arg2,...)` calls, args separated
//     by the Additional Options separator (default ","), literal separators escaped as
//     `\,`. Multiple calls are separated by the same separator and/or newlines.
//   * 26 fabricated/garbage bundles in the corpus must decode as `unknown` WITH a
//     reason — never guessed.
//
// Vanilla ES module, no dependencies, no build step.

/** Package that owns the plugin protocol we decode. */
export const AUTOINPUT_PACKAGE = 'com.joaomgcd.autoinput';

// ---------------------------------------------------------------------------
// pluginTypeId table (from data/autoInputCorpus.json, plus schema §ops / APK
// config activities). `kind` selects the decode strategy; `opHint` is the op
// emitted when the bundle carries no more specific information.
// ---------------------------------------------------------------------------
export const PLUGIN_TYPES = Object.freeze({
  'com.joaomgcd.autoinput.intent.IntentActionv2': {
    kind: 'uiAction', opHint: 'uiAction',
    configClass: 'com.joaomgcd.autoinput.activity.ActivityConfigActionv2',
  },
  'com.joaomgcd.autoinput.intent.IntentPerformAction': {
    kind: 'performAction', opHint: 'click',
    configClass: 'com.joaomgcd.autoinput.activity.ActivityConfigPerformAction',
  },
  'com.joaomgcd.autoinput.intent.IntentUIQuery': {
    kind: 'uiQuery', opHint: 'uiQuery',
    configClass: 'com.joaomgcd.autoinput.activity.ActivityConfigUIQuery',
  },
  'com.joaomgcd.autoinput.intent.IntentGestures': {
    kind: 'gesture', opHint: 'swipe',
    configClass: 'com.joaomgcd.autoinput.activity.ActivityConfigGestures',
  },
  'com.joaomgcd.autoinput.intent.IntentPerformGlobalAction': {
    kind: 'globalAction', opHint: 'globalAction',
    configClass: 'com.joaomgcd.autoinput.activity.ActivityConfigPerformGlobalAction',
  },
  'com.joaomgcd.autoinput.intent.IntentTurnOffScreen': {
    kind: 'screenOnOff', opHint: 'turnOffScreen',
    configClass: 'com.joaomgcd.autoinput.activity.ActivityConfigTurnOffScreen',
  },
  'com.joaomgcd.autoinput.intent.IntentUnlockScreen': {
    kind: 'unlockScreen', opHint: 'unlockScreen',
    configClass: 'com.joaomgcd.autoinput.activity.ActivityConfigUnlockScreen',
  },
  'com.joaomgcd.autoinput.intent.IntentModes': {
    kind: 'modes', opHint: 'modes',
    configClass: 'com.joaomgcd.autoinput.activity.ActivityConfigModes',
  },
  // From data/autoInputSchema.json §ops (config activities exist in the APK; no
  // corpus exports observed, but Tasker exports can carry them).
  'com.joaomgcd.autoinput.intent.IntentKeyEvent': {
    kind: 'keyEvent', opHint: 'keyEvent',
    configClass: 'com.joaomgcd.autoinput.activity.ActivityConfigKeyEvent',
  },
  'com.joaomgcd.autoinput.intent.IntentScreenCapture': {
    kind: 'screenCapture', opHint: 'screenCapture',
    configClass: 'com.joaomgcd.autoinput.activity.ActivityConfigScreenCapture',
  },
  'com.joaomgcd.autoinput.intent.IntentInputActionEvent': {
    kind: 'inputActionEvent', opHint: 'inputActionEvent',
    configClass: 'com.joaomgcd.autoinput.activity.ActivityConfigInputActionEvent',
  },
  'com.joaomgcd.autoinput.intent.IntentUIUpdateEvent': {
    kind: 'uiUpdateEvent', opHint: 'uiUpdateEvent',
    configClass: 'com.joaomgcd.autoinput.activity.ActivityConfigUIUpdateEvent',
  },
  'com.joaomgcd.autoinput.intent.IntentGestureEvent': {
    kind: 'gestureEvent', opHint: 'gestureEvent',
    configClass: 'com.joaomgcd.autoinput.activity.ActivityConfigGestureEvent',
  },
});

// Alternate config labels observed in data/autoInputCorpus.json (older exports).
const CONFIG_ALIASES = Object.freeze({
  'AutoInput Action': 'com.joaomgcd.autoinput.intent.IntentPerformAction',
  'AutoInput UI Query': 'com.joaomgcd.autoinput.intent.IntentUIQuery',
});

// ---------------------------------------------------------------------------
// Enum mirrors of data/autoInputEnums.json (APK res/values arrays, sha256
// fe5a6cfe2769b17d6c179faf65ef154823b518262ab4f8e76cdaacf26a6bdffe).
// Callers may override with {enums} loaded from that JSON file; the embedded
// copy keeps the browser module dependency-free.
// ---------------------------------------------------------------------------
export const ENUMS = Object.freeze({
  ActionType: Object.freeze([
    { value: 16, name: 'Click' },
    { value: 32, name: 'Long Click' },
    { value: 32768, name: 'Paste' },
    { value: 131072, name: 'Select Text' },
    { value: 65536, name: 'Cut' },
    { value: 1, name: 'Focus' },
    { value: 4096, name: 'Scroll Forward' },
    { value: 8192, name: 'Scroll Backward' },
    { value: -1, name: 'Write' },
    { value: -2, name: 'Replace' },
  ]),
  FieldSelectionType: Object.freeze([
    { value: 0, name: 'Text' },
    { value: 1, name: 'Id' },
    { value: 2, name: 'Focus' },
    { value: 3, name: 'List' },
    { value: 5, name: 'Point' },
  ]),
  GestureType: Object.freeze([
    { value: 0, name: 'Swipe' },
    { value: 1, name: 'Pinch' },
    { value: 2, name: 'Multiple' },
  ]),
  GlobalAction: Object.freeze([
    { value: 1, name: 'Back' },
    { value: 2, name: 'Home' },
    { value: 3, name: 'Recent Apps' },
    { value: 4, name: 'Open Notifications' },
    { value: 5, name: 'Quick Settings' },
    { value: 6, name: 'Power Dialog' },
  ]),
  ActionTypeUIAction: Object.freeze([
    { value: 1, name: 'Clicks' },
    { value: 2, name: 'Long Clicks' },
    { value: -8, name: 'Input Element Focused' },
    { value: -9, name: 'Input Element Focus Lost' },
  ]),
  KeyAction: Object.freeze([
    { value: -1, name: 'All' },
    { value: 0, name: 'Key Down' },
    { value: 1, name: 'Key Up' },
  ]),
  EnableGestureMode: Object.freeze([
    { value: 0, name: "Don't Change" },
    { value: 1, name: 'Enable' },
    { value: 2, name: 'Disable' },
    { value: 3, name: 'Toggle' },
  ]),
});

// ---------------------------------------------------------------------------
// v2 DSL verbs -> stable op names. Covers the touch-op vocabulary from
// docs/DESIGN.md §6 (click, longClick, paste, cut, selectText, focus,
// scrollForward/Backward, write, replace, swipe, pinch, multiple, globalAction,
// uiQuery) plus the non-touch DSL verbs real exports use.
// ---------------------------------------------------------------------------
const DSL_OPS = Object.freeze({
  click: 'click',
  tap: 'click',
  doubleclick: 'doubleClick',
  longclick: 'longClick',
  longpress: 'longClick',
  swipe: 'swipe',
  fling: 'swipe',
  pinch: 'pinch',
  scroll: 'scroll',
  scrollup: 'scrollForward',
  scrolldown: 'scrollBackward',
  scrollforward: 'scrollForward',
  scrollbackward: 'scrollBackward',
  scrollleft: 'scrollLeft',
  scrollright: 'scrollRight',
  globalaction: 'globalAction',
  uiquery: 'uiQuery',
  keyevent: 'keyEvent',
  key: 'keyEvent',
  presskey: 'keyEvent',
  screencapture: 'screenCapture',
  screenshot: 'screenCapture',
  turnoffscreen: 'turnOffScreen',
  screenoff: 'turnOffScreen',
  turnonscreen: 'turnOnScreen',
  screenon: 'turnOnScreen',
  settext: 'write',
  writetext: 'write',
  inputtext: 'write',
  write: 'write',
  type: 'write',
  pastetext: 'paste',
  paste: 'paste',
  cut: 'cut',
  copy: 'copy',
  selecttext: 'selectText',
  focus: 'focus',
  replace: 'replace',
  openapp: 'openApp',
  launchapp: 'openApp',
  wait: 'wait',
  sleep: 'wait',
  waitforelement: 'waitForElement',
  waitelement: 'waitForElement',
  submitinput: 'submitInput',
  submit: 'submitInput',
  back: 'back',
  home: 'home',
  recents: 'recents',
  cleartext: 'clearText',
});

// Selector nouns that can follow a verb (`click point(540,420)`).
const SELECTOR_NOUNS = Object.freeze([
  'text', 'id', 'regex', 'point', 'xy', 'focus', 'list', 'path', 'app', 'element', 'button',
]);

// ActionType name -> op.
const ACTION_TYPE_OP = Object.freeze({
  Click: 'click',
  'Long Click': 'longClick',
  Paste: 'paste',
  'Select Text': 'selectText',
  Cut: 'cut',
  Focus: 'focus',
  'Scroll Forward': 'scrollForward',
  'Scroll Backward': 'scrollBackward',
  Write: 'write',
  Replace: 'replace',
});

const FIELD_TYPE_NAME = Object.freeze({
  0: 'text', 1: 'id', 2: 'focus', 3: 'list', 5: 'point',
});

const GLOBAL_ACTION_OP = Object.freeze({
  Back: 'back',
  Home: 'home',
  'Recent Apps': 'recents',
  'Open Notifications': 'notifications',
  'Quick Settings': 'quickSettings',
  'Power Dialog': 'powerDialog',
});

const GESTURE_OP = Object.freeze({ Swipe: 'swipe', Pinch: 'pinch', Multiple: 'multiple' });

// English default keys from data/autoInputSchema.json (the localization footgun:
// these are display names and differ on non-English installs). Aliases cover the
// JSON `parameters` camelCase form and the d-map form used by older exports.
const KEYS = Object.freeze({
  blurb: ['com.twofortyfouram.locale.intent.extra.BLURB', 'blurb', 'description'],
  actionsToPerform: ['Actions To Perform', 'ActionsToPerform', 'actions_to_perform', 'parameters', 'action'],
  actionId: ['Element To Perform Action On', 'ActionId', 'actionId', 'Element To Perform Action On'],
  textToClick: ['Text To Click', 'TextToClick', 'textToClick'],
  specialPath: ['Special Path', 'SpecialPath', 'path'],
  nearbyText: ['Nearby Text', 'NearbyText', 'nearbyText'],
  mustBePresent: ['Text That Must Be Present', 'TextThatMustBePresent'],
  separator: ['Separator', 'separator'],
  preActionDelay: ['Pre-Action Delay', 'PreActionDelay', 'preActionDelay'],
  checkMillis: ['Check Millis', 'CheckMillis', 'checkMs'],
  withCoordinates: ['With Coordinates', 'WithCoordinates', 'withCoordinates'],
  appToActIn: ['App To Act In', 'AppToActIn', 'appToActIn', 'AppPackage', 'appPackage'],
  notInAutoInput: ['Not In AutoInput', 'NotInAutoInput', 'notInAutoInput'],
  notInTasker: ['Not In Tasker', 'NotInTasker', 'notInTasker'],
  actionType: ['ActionType', 'Action Type', 'actionType'],
  fieldSelectionType: ['FieldSelectionType', 'Field Selection Type', 'fieldSelectionType'],
  textToWrite: ['TextToWrite', 'Text To Write', 'textToWrite'],
  gestureType: ['Gesture Type', 'GestureType', 'gestureType', 'type'],
  startPoint: ['Start Point', 'StartPoint', 'startPoint', 'initialPoint'],
  endPoint: ['End Point', 'EndPoint', 'endPoint'],
  duration: ['Duration', 'duration', 'durationMs'],
  centerPoint: ['Center Point', 'CenterPoint', 'centerPoint'],
  startSpacing: ['Start Spacing', 'StartSpacing', 'startSpacing'],
  endSpacing: ['End Spacing', 'EndSpacing', 'endSpacing'],
  orientation: ['Orientation', 'orientation'],
  globalAction: ['GlobalAction', 'Global Action', 'globalAction'],
  screenOffOrOn: ['Screen Off Or On', 'ScreenOffOrOn', 'screenAction', 'screenOffOrOn'],
  keyCode: ['KeyCode', 'Key Code', 'keyCode'],
  keyAction: ['KeyAction', 'Key Action', 'keyAction'],
  keyPress: ['KeyCodePress', 'Key Code Press', 'keyCodePress'],
  manualKeyCodes: ['ManualKeyCodes', 'Manual Key Codes', 'manualKeyCodes'],
  keySuppressMode: ['EnableKeySurpressMode', 'Enable Key Suppress Mode', 'enableKeySurpressMode'],
  uiUpdateFields: ['UIUpdateFields', 'Fields To Get', 'fieldsToGet', 'fields'],
  uiUpdateText: ['UIUpdateText', 'Text', 'text'],
  onlyVisible: ['OnlyVisible', 'Only Visible', 'onlyVisible'],
  onlyClickable: ['OnlyClickable', 'Only Clickable', 'onlyClickable'],
  regex: ['Regex', 'regex'],
  isFirstAction: ['IsFirstAction', 'Is First Action', 'isFirstAction'],
  isTaskerAction: ['IsTaskerAction', 'Is Tasker Action', 'isTaskerAction'],
  repeatInterval: ['RepeatInterval', 'repeatInterval'],
  repeatTimes: ['RepeatTimes', 'repeatTimes'],
  password: ['Password', 'password'],
  pluginTypeId: ['plugintypeid', 'pluginTypeId', 'pluginTypeID', 'PluginTypeId'],
  pluginName: ['pluginName', 'pluginPackage', 'package'],
  captureMode: ['CaptureMode', 'captureMode'],
  crop: ['Crop', 'crop'],
  resolution: ['Resolution', 'resolution'],
  file: ['File', 'file'],
});

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function toStr(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    const parts = v.map(toStr).filter((x) => x !== null);
    return parts.length ? parts.join('\n') : null;
  }
  if (isPlainObject(v)) {
    if (Array.isArray(v.$array)) return toStr(v.$array);
    return null;
  }
  return null;
}

function clean(v) {
  const s = toStr(v);
  if (s === null) return null;
  const t = s.trim();
  if (t === '' || t === '<null>' || t === 'null' || t === 'NULL') return null;
  return s;
}

function firstClean(list) {
  for (const v of list) {
    const s = clean(v);
    if (s !== null) return s;
  }
  return null;
}

function normKey(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normVerb(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function toInt(v) {
  const s = clean(v);
  if (s === null) return null;
  const t = s.trim();
  if (!/^[-+]?\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

function toBool(v) {
  const s = clean(v);
  if (s === null) return null;
  const t = s.trim().toLowerCase();
  if (t === 'true' || t === '1' || t === 'yes') return true;
  if (t === 'false' || t === '0' || t === 'no') return false;
  return s;
}

function parseNumOrRaw(v) {
  const s = clean(v);
  if (s === null) return null;
  const t = s.trim();
  if (/^[-+]?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t;
}

/** "540,1500" -> {x:540, y:1500}; "%x,%y" keeps raw strings. */
export function parsePoint(v) {
  const s = clean(v);
  if (s === null) return null;
  const parts = s.split(',');
  if (parts.length < 2) return null;
  const x = parseNumOrRaw(parts[0]);
  const y = parseNumOrRaw(parts[1]);
  if (x === null || y === null) return null;
  return { x, y };
}

function enumName(enumKey, value, enums) {
  const table = (enums && enums[enumKey]) || ENUMS[enumKey] || [];
  const n = toInt(value);
  if (n === null) return null;
  const hit = table.find((e) => e.value === n);
  return hit ? hit.name : null;
}

// ---------------------------------------------------------------------------
// Input normalization: accept an IR Action node, its args object, a {$bundle}
// wrapper, or the plain flattened `Vals` map. `bundleVals` is the common case.
// ---------------------------------------------------------------------------

function unwrapBundle(v) {
  if (!isPlainObject(v)) return null;
  if (isPlainObject(v.$bundle)) return v.$bundle;
  if (isPlainObject(v.bundle) && Object.keys(v).length <= 2) return v.bundle;
  return v;
}

function normalizeInput(input) {
  const out = { bundle: null, packageName: null, pluginConfig: null, pluginTypeId: null };

  if (!isPlainObject(input)) return out;

  // 1. IR Action node: {kind:'plugin', args:{arg0:{$bundle},arg1,arg2}, package, pluginClass}
  if (isPlainObject(input.args)) {
    out.packageName = firstClean([input.package, input.pluginPackage, input.args.arg1]);
    out.pluginConfig = firstClean([input.pluginClass, input.configActivity, input.args.arg2]);
    out.bundle = unwrapBundle(input.args.arg0) || {};
    return out;
  }

  // 2. Raw args object: {arg0:{$bundle}, arg1: package, arg2: class}
  if (input.arg0 !== undefined || input.arg1 !== undefined) {
    out.packageName = firstClean([input.package, input.pluginPackage, input.arg1]);
    out.pluginConfig = firstClean([input.pluginClass, input.configActivity, input.arg2]);
    out.bundle = unwrapBundle(input.arg0) || {};
    return out;
  }

  // 3. Corpus record / explicit envelope.
  if (
    input.pluginTypeId !== undefined || input.pluginConfig !== undefined ||
    input.extras !== undefined || isPlainObject(input.$bundle) || isPlainObject(input.bundle)
  ) {
    out.packageName = firstClean([input.pluginPackage, input.package]);
    out.pluginConfig = firstClean([input.pluginConfig, input.configActivity]);
    out.pluginTypeId = firstClean([input.pluginTypeId, input.plugintypeid]);
    out.bundle = unwrapBundle(input.extras) || unwrapBundle(input.bundle) ||
      unwrapBundle(input.params) || unwrapBundle(input.$bundle) || {};
    return out;
  }

  // 4. Plain flattened bundle map.
  out.bundle = input;
  return out;
}

/** Split raw Vals into values (no `-type` companions) and their java types. */
function indexBundle(bundle) {
  const values = {};
  const types = {};
  if (!isPlainObject(bundle)) return { values, types };
  for (const [k, v] of Object.entries(bundle)) {
    if (k.endsWith('-type')) {
      types[k.slice(0, -5)] = v;
      continue;
    }
    values[k] = v;
  }
  return { values, types };
}

/**
 * Localized-key-proof lookup: exact key, then case/punctuation-insensitive,
 * then suffix/prefix fuzzy match. Returns {key, value} or null.
 */
function pick(values, aliases) {
  if (!isPlainObject(values)) return null;
  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(values, alias)) {
      const v = clean(values[alias]);
      if (v !== null) return { key: alias, value: v };
    }
  }
  const wanted = aliases.map(normKey);
  const entries = Object.keys(values).map((k) => ({ k, n: normKey(k) }));
  for (const w of wanted) {
    const hit = entries.find((e) => e.n === w);
    if (hit) {
      const v = clean(values[hit.k]);
      if (v !== null) return { key: hit.k, value: v };
    }
  }
  // Localized / renamed keys: fuzzy containment on normalized names. Only for
  // long aliases and only when the bundle key EXTENDS the alias — the reverse
  // direction makes short generic keys ("action") match unrelated long aliases
  // ("globalAction") and silently mis-routes the bundle.
  for (const w of wanted) {
    if (w.length < 8) continue;
    const hit = entries.find((e) => e.n.length > w.length && e.n.endsWith(w));
    if (hit) {
      const v = clean(values[hit.k]);
      if (v !== null) return { key: hit.k, value: v };
    }
  }
  return null;
}

function pickValue(values, aliases) {
  const hit = pick(values, aliases);
  return hit ? hit.value : null;
}

/** Fallback extraction from the human-readable BLURB (English, always present). */
function parseBlurb(blurb) {
  const s = blurb || '';
  const grab = (re) => {
    const m = s.match(re);
    return m ? m[1].trim() : null;
  };
  return {
    raw: s,
    type: grab(/^Type:\s*([^\n]+)/m),
    value: grab(/^Value:\s*([^\n]*)/m),
    action: grab(/^Action\s*:\s*([^\n]+)/m),
    actionsToPerform: grab(/^Actions To Perform:\s*([^\n]+)/m),
    gestureType: grab(/Gesture Type:\s*([A-Za-z ]+)/),
    startPoint: grab(/Start Point:\s*([^\n]+)/),
    endPoint: grab(/End Point:\s*([^\n]+)/),
    duration: grab(/Duration:\s*(\d+)/),
    screenOffOrOn: grab(/Screen Off Or On:\s*([^\n]+)/),
    separator: grab(/^Separator:\s*(.+)$/m),
    checkMillis: grab(/^Check Millis:\s*(\d+)/m),
  };
}

// ---------------------------------------------------------------------------
// v2 action DSL parser
// ---------------------------------------------------------------------------

/**
 * Split an `Actions To Perform` value into calls. The separator is escaped as
 * `\,` inside an argument (real corpus: `click(point,540\,420)`), so splitting
 * honors backslash escapes. Parenthesized argument lists are scanned balanced.
 *
 * @returns {Array<{name:string,args:string[]|null,raw:string,bare:boolean}>}
 */
export function splitActionCalls(raw, separator = ',') {
  const s = String(raw == null ? '' : raw);
  const sep = separator && String(separator).length ? String(separator) : ',';
  const calls = [];
  const sepAt = (i) => s.startsWith(sep, i);
  let i = 0;

  const skipTrivia = () => {
    while (i < s.length) {
      if (/\s/.test(s[i])) { i += 1; continue; }
      if (sepAt(i)) { i += sep.length; continue; }
      break;
    }
  };

  while (i < s.length) {
    skipTrivia();
    if (i >= s.length) break;

    const start = i;
    let j = i;
    while (j < s.length && s[j] !== '(' && s[j] !== '\n' && !sepAt(j)) j += 1;

    if (j < s.length && s[j] === '(') {
      let depth = 1;
      let k = j + 1;
      let buf = '';
      while (k < s.length && depth > 0) {
        const ch = s[k];
        if (ch === '\\' && k + 1 < s.length) {
          buf += ch + s[k + 1];
          k += 2;
          continue;
        }
        if (ch === '(') { depth += 1; buf += ch; k += 1; continue; }
        if (ch === ')') {
          depth -= 1;
          if (depth === 0) { k += 1; break; }
          buf += ch; k += 1; continue;
        }
        buf += ch;
        k += 1;
      }
      const name = s.slice(start, j).trim();
      const args = splitEscaped(buf, sep).map((a) => unescapeArg(a).trim());
      calls.push({ name, args, raw: s.slice(start, k).trim(), bare: false });
      i = k;
    } else {
      const token = s.slice(start, Math.max(j, start + 1)).trim();
      i = Math.max(j, start + 1);
      if (token) calls.push({ name: token, args: null, raw: token, bare: true });
    }
  }
  return calls;
}

function splitEscaped(text, sep) {
  const out = [];
  let cur = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length) {
      cur += ch + text[i + 1];
      i += 1;
      continue;
    }
    if (text.startsWith(sep, i)) {
      out.push(cur);
      cur = '';
      i += sep.length - 1;
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function unescapeArg(s) {
  return String(s).replace(/\\(.)/gs, '$1');
}

/** Resolve a DSL verb (possibly with a trailing selector noun) to an op. */
function resolveDslVerb(name) {
  const n = normVerb(name);
  if (!n) return null;
  if (DSL_OPS[n]) return { op: DSL_OPS[n], noun: null };
  // Longest-first prefix match: `clickpoint` -> click + noun `point`.
  const verbs = Object.keys(DSL_OPS).sort((a, b) => b.length - a.length);
  for (const v of verbs) {
    if (n.length > v.length && n.startsWith(v)) {
      const rest = n.slice(v.length);
      if (SELECTOR_NOUNS.includes(rest)) return { op: DSL_OPS[v], noun: rest };
    }
  }
  return null;
}

/**
 * Consume a point from the front of `args`. The DSL always escapes the comma
 * between x and y (`click(point,540\,420)`), but a trailing-noun form
 * (`click point(540,420)`) arrives as two args. Handle both.
 */
function takePoint(args) {
  const A = Array.isArray(args) ? args : [];
  if (A.length === 0) return { point: null, rest: A };
  if (String(A[0]).includes(',')) return { point: parsePoint(A[0]), rest: A.slice(1) };
  if (A.length >= 2) return { point: parsePoint(`${A[0]},${A[1]}`), rest: A.slice(2) };
  return { point: null, rest: A };
}

function selectorFromNoun(noun, args) {
  if (!noun) return null;
  // Callers shift the selector noun off the front, so the value is A[0].
  const A = Array.isArray(args) ? args : [];
  switch (noun) {
    case 'id':
      return A[0] ? { type: 'id', value: A[0], matchMode: A[1] || null } : null;
    case 'text':
      return A[0] ? { type: 'text', value: splitMatchMode(A[0]).value, matchMode: splitMatchMode(A[0]).matchMode || A[1] || null } : null;
    case 'regex':
      return A[0] ? { type: 'regex', value: A[0], matchMode: A[1] || null } : null;
    case 'point':
    case 'xy': {
      const { point } = takePoint(A);
      return point ? { type: noun, value: `${point.x},${point.y}`, point } : null;
    }
    case 'focus':
      return { type: 'focus', value: null };
    case 'list':
      return { type: 'list', value: A[0] != null ? A[0] : null };
    case 'path':
      return A[0] ? { type: 'path', value: A[0] } : null;
    case 'app':
      return A[0] ? { type: 'app', value: A[0] } : null;
    default:
      return null;
  }
}

/** `value=:=MatchText` marker from the v2 DSL. */
function splitMatchMode(v) {
  const s = String(v);
  const idx = s.indexOf('=:=');
  if (idx < 0) return { value: s, matchMode: null };
  return { value: s.slice(0, idx), matchMode: s.slice(idx + 3) || null };
}

function describeCall(call) {
  const verb = resolveDslVerb(call.name);
  const bare = Boolean(call.bare);
  if (!verb) {
    return {
      name: call.name,
      op: 'unknown',
      selector: null,
      args: call.args,
      raw: call.raw,
      reason: bare
        ? `DSL value "${truncate(call.name, 80)}" is a variable/expression, not a Name(...) action call`
        : `unrecognized DSL action "${truncate(call.name, 80)}"`,
    };
  }

  const A = Array.isArray(call.args) ? [...call.args] : [];
  let noun = verb.noun;
  if (!noun && A.length && SELECTOR_NOUNS.includes(String(A[0]).trim().toLowerCase())) {
    noun = String(A[0]).trim().toLowerCase();
    A.shift();
  }

  let selector = null;
  let gesture = null;
  const options = {};

  if (verb.op === 'swipe' || verb.op === 'pinch' || verb.op === 'scroll') {
    const { point: start, rest } = takePoint(A);
    const direction = rest.find((a) => /^(up|down|left|right)$/i.test(String(a).trim()));
    const duration = rest.map(toInt).find((n) => n !== null && n >= 0 && n <= 60000);
    gesture = {
      type: verb.op,
      start,
      end: null,
      direction: direction ? String(direction).trim().toLowerCase() : null,
      durationMs: duration === undefined ? null : duration,
      fingers: [],
      center: null,
      startSpacing: null,
      endSpacing: null,
      orientation: null,
    };
  } else {
    selector = selectorFromNoun(noun, A);
    if ((verb.op === 'write' || verb.op === 'paste' || verb.op === 'replace') && noun) {
      const textIdx = noun === 'point' || noun === 'xy' ? 2 : 1;
      if (A[textIdx] !== undefined && A[textIdx] !== '') options.text = A[textIdx];
    }
  }

  if (verb.op === 'write' || verb.op === 'replace' || verb.op === 'paste') {
    // setText(id,selector,text) keeps the text in the third positional slot.
    if (options.text === undefined && noun && A.length > 2) options.text = A[2];
  }

  return {
    name: call.name,
    op: verb.op,
    selector,
    gesture,
    args: call.args,
    raw: call.raw,
    options: Object.keys(options).length ? options : undefined,
  };
}

function truncate(s, n) {
  const t = String(s);
  return t.length > n ? `${t.slice(0, n)}...` : t;
}

// ---------------------------------------------------------------------------
// Per-kind decoders
// ---------------------------------------------------------------------------

function decodeUiAction(ctx) {
  const { values, blurb, enums } = ctx;
  let rawActions = pickValue(values, KEYS.actionsToPerform);
  let parsed = null;
  let rawSource = 'bundle';

  // `parameters` / `action` may be a JSON envelope (real v2 exports use this).
  if (rawActions !== null) {
    const trimmed = rawActions.trim();
    if (trimmed.startsWith('{')) {
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return unknown('v2 parameters JSON did not parse', ctx);
      }
    }
  }

  let dsl = null;
  let additionalOptions = {};
  let whenToPerform = {};
  if (parsed && typeof parsed === 'object') {
    if (typeof parsed._action === 'string') dsl = parsed._action;
    else if (typeof parsed.action === 'string') dsl = parsed.action;
    if (parsed._additionalOptions && typeof parsed._additionalOptions === 'object') {
      additionalOptions = parsed._additionalOptions;
    }
    if (parsed._whenToPerformAction && typeof parsed._whenToPerformAction === 'object') {
      whenToPerform = parsed._whenToPerformAction;
      rawSource = 'parameters-json';
    } else {
      rawSource = 'parameters-json';
    }
  } else if (rawActions !== null) {
    dsl = rawActions;
  }

  // Localized-key fallback: BLURB carries the English rendering of the DSL.
  if (dsl === null && blurb.actionsToPerform) {
    dsl = blurb.actionsToPerform;
    rawSource = 'blurb';
  }

  if (dsl === null) {
    return unknown('no Actions To Perform value in bundle (and no BLURB fallback)', ctx);
  }

  const separator = firstClean([
    additionalOptions.separator,
    pickValue(values, KEYS.separator),
    blurb.separator,
  ]) || ',';

  const calls = splitActionCalls(dsl, separator);
  const described = calls.map(describeCall);

  if (described.length === 0) {
    return unknown('Actions To Perform contained no action calls', ctx);
  }

  const options = {
    actions: described,
    separator,
    raw: dsl,
    rawSource,
    checkMillis: firstInt([additionalOptions.checkMs, pickValue(values, KEYS.checkMillis), blurb.checkMillis]),
    preActionDelay: firstInt([additionalOptions.preActionDelay, pickValue(values, KEYS.preActionDelay)]),
    withCoordinates: firstBool([additionalOptions.withCoordinates, pickValue(values, KEYS.withCoordinates)]),
    appToActIn: pickValue(values, KEYS.appToActIn),
    notInAutoInput: firstBool([whenToPerform.notInAutoInput, pickValue(values, KEYS.notInAutoInput)]),
    notInTasker: firstBool([whenToPerform.notInTasker, pickValue(values, KEYS.notInTasker)]),
    isFirstAction: firstBool([pickValue(values, KEYS.isFirstAction)]),
  };

  const known = described.filter((d) => d.op !== 'unknown');
  if (known.length === 0) {
    return unknown(
      `all ${described.length} DSL call(s) unresolved: ${described[0].reason}`,
      ctx,
      { dslActions: described, separator },
    );
  }

  const primary = known[0];
  const allSame = known.length === described.length && known.every((d) => d.op === primary.op);
  const op = described.length === 1 ? primary.op : (allSame ? primary.op : 'uiAction');

  // Aggregate selector/gesture from the first call that has one.
  const selector = known.find((d) => d.selector)?.selector || null;
  const gesture = known.find((d) => d.gesture)?.gesture || null;
  options.primaryOp = primary.op;
  // Surface text written by a setText/paste call.
  for (const d of described) {
    if (d.options && d.options.text !== undefined && options.text === undefined) {
      options.text = d.options.text;
    }
  }
  if (described.some((d) => d.op === 'unknown')) {
    options.unresolved = described.filter((d) => d.op === 'unknown').map((d) => d.reason);
  }
  return result(op, selector, gesture, options);
}

function decodePerformAction(ctx) {
  const { values, blurb, enums } = ctx;
  const actionTypeRaw = pickValue(values, KEYS.actionType);
  let actionTypeName = enumName('ActionType', actionTypeRaw, enums);
  if (!actionTypeName && blurb.action) {
    const lowered = normVerb(blurb.action);
    actionTypeName = Object.keys(ACTION_TYPE_OP).find((n) => normVerb(n) === lowered) || null;
  }
  let op;
  if (actionTypeName && ACTION_TYPE_OP[actionTypeName]) {
    op = ACTION_TYPE_OP[actionTypeName];
  } else if (actionTypeName) {
    op = normVerb(actionTypeName) || 'unknown';
  } else {
    return unknown(
      actionTypeRaw === null
        ? 'IntentPerformAction bundle has no ActionType'
        : `unknown ActionType ${JSON.stringify(actionTypeRaw)}`,
      ctx,
    );
  }

  // Selector: FieldSelectionType (0 Text, 1 Id, 2 Focus, 3 List, 5 Point) + ActionId.
  const fieldRaw = pickValue(values, KEYS.fieldSelectionType);
  let fieldNum = toInt(fieldRaw);
  let type = fieldNum !== null ? FIELD_TYPE_NAME[fieldNum] || null : null;
  if (!type && blurb.type) {
    const bt = normVerb(blurb.type);
    type = ['text', 'id', 'focus', 'list', 'point'].find((t) => normVerb(t) === bt) || null;
  }
  const actionId = pickValue(values, KEYS.actionId) ?? blurb.value;
  let selector = null;
  if (type) {
    selector = { type, value: actionId };
    if (type === 'point' && actionId) {
      const p = parsePoint(actionId);
      if (p) {
        selector.point = p;
        selector.value = `${p.x},${p.y}`;
      }
    }
    if (type === 'focus') selector.value = actionId || null;
  } else if (actionId) {
    // No field-selection metadata: keep the id and mark the selector untyped
    // rather than guessing text-vs-id.
    selector = { type: null, value: actionId };
  }

  const options = {
    actionType: actionTypeRaw,
    actionTypeName,
    fieldSelectionType: fieldRaw,
    isFirstAction: firstBool([pickValue(values, KEYS.isFirstAction)]),
    isTaskerAction: firstBool([pickValue(values, KEYS.isTaskerAction)]),
    nearbyText: pickValue(values, KEYS.nearbyText),
    textToWrite: pickValue(values, KEYS.textToWrite),
    repeatInterval: pickValue(values, KEYS.repeatInterval),
    repeatTimes: pickValue(values, KEYS.repeatTimes),
    password: firstBool([pickValue(values, KEYS.password)]),
    enableDisableAccessibilityService: pickValue(values, ['EnableDisableAccessibilityService']),
  };
  if (op === 'write' || op === 'paste' || op === 'replace') {
    options.text = options.textToWrite;
  }
  return result(op, selector, null, dropNullish(options));
}

function decodeUiQuery(ctx) {
  const { values, blurb } = ctx;
  const appPackage = pickValue(values, KEYS.appToActIn);
  const selector = appPackage ? { type: 'app', value: appPackage } : null;
  const options = {
    appPackage,
    fields: pickValue(values, KEYS.uiUpdateFields),
    text: pickValue(values, KEYS.uiUpdateText),
    onlyVisible: firstBool([pickValue(values, KEYS.onlyVisible)]),
    onlyClickable: firstBool([pickValue(values, KEYS.onlyClickable)]),
    regex: firstBool([pickValue(values, KEYS.regex)]),
    isFirstAction: firstBool([pickValue(values, KEYS.isFirstAction)]),
    enableDisableAccessibilityService: pickValue(values, ['EnableDisableAccessibilityService']),
  };
  if (!options.fields && !options.text && blurb.raw) options.blurb = blurb.raw;
  return result('uiQuery', selector, null, dropNullish(options));
}

function decodeGesture(ctx) {
  const { values, blurb, enums } = ctx;
  const params = ctx.params || {};

  const gestureTypeRaw = firstClean([
    pickValue(values, KEYS.gestureType),
    toStr(params.gestureType),
    toStr(params.type),
  ]) ?? blurb.gestureType;
  let gestureName = enumName('GestureType', gestureTypeRaw, enums);
  if (!gestureName && gestureTypeRaw) {
    const n = normVerb(gestureTypeRaw);
    gestureName = ['Swipe', 'Pinch', 'Multiple'].find((g) => normVerb(g) === n) || null;
  }
  const op = GESTURE_OP[gestureName] || null;
  if (!op) {
    return unknown(
      gestureTypeRaw === null
        ? 'IntentGestures bundle has no GestureType'
        : `unknown GestureType ${JSON.stringify(gestureTypeRaw)}`,
      ctx,
    );
  }

  const start = parsePoint(firstClean([
    toStr(params.initialPoint), toStr(params.startPoint),
    pickValue(values, KEYS.startPoint), blurb.startPoint,
  ]));
  const end = parsePoint(firstClean([
    toStr(params.endPoint), pickValue(values, KEYS.endPoint), blurb.endPoint,
  ]));
  const duration = firstInt([
    params.duration,
    pickValue(values, KEYS.duration),
    blurb.duration,
  ]);
  const center = parsePoint(firstClean([toStr(params.centerPoint), pickValue(values, KEYS.centerPoint)]));

  const fingers = [];
  const fingerJson = Array.isArray(params.fingers) ? params.fingers : [];
  fingerJson.forEach((f, i) => {
    if (isPlainObject(f)) {
      fingers.push({
        index: i + 1,
        path: parsePoint(firstClean([toStr(f.point), toStr(f.startPoint)])),
        durationMs: firstInt([f.duration]),
      });
    }
  });
  for (let i = 1; i <= 10; i += 1) {
    const fingerVal = pickValue(values, [`Finger ${i}`, `Finger${i}`, `finger${i}`]);
    if (fingerVal) {
      fingers.push({ index: i, path: parsePoint(fingerVal), durationMs: null });
    }
  }

  const gesture = {
    type: op,
    start,
    end,
    direction: toStr(params.direction) ? String(params.direction).toLowerCase() : null,
    durationMs: duration,
    fingers,
    center,
    startSpacing: firstInt([params.startSpacing, pickValue(values, KEYS.startSpacing)]),
    endSpacing: firstInt([params.endSpacing, pickValue(values, KEYS.endSpacing)]),
    orientation: firstInt([params.orientation, pickValue(values, KEYS.orientation)]),
  };
  return result(op, null, gesture, { gestureType: gestureName, gestureTypeRaw });
}

function decodeGlobalAction(ctx) {
  const { values, blurb, enums } = ctx;
  const raw = pickValue(values, KEYS.globalAction);
  let name = enumName('GlobalAction', raw, enums);
  if (!name && blurb.action) {
    const n = normVerb(blurb.action);
    name = Object.keys(GLOBAL_ACTION_OP).find((g) => normVerb(g) === n) || null;
  }
  if (!name) {
    return unknown(
      raw === null
        ? 'IntentPerformGlobalAction bundle has no GlobalAction'
        : `unknown GlobalAction ${JSON.stringify(raw)}`,
      ctx,
    );
  }
  const action = GLOBAL_ACTION_OP[name] || normVerb(name);
  return result('globalAction', null, null, { action, actionName: name, globalAction: raw });
}

function decodeScreenOnOff(ctx) {
  const { values, blurb } = ctx;
  const params = ctx.params || {};
  const raw = firstClean([
    toStr(params.screenAction),
    pickValue(values, KEYS.screenOffOrOn),
    blurb.screenOffOrOn,
  ]);
  const textual = blurb.screenOffOrOn || raw || '';
  let screenOn = null;
  if (/turn\s*on|^on$/i.test(textual)) screenOn = true;
  else if (/turn\s*off|^off$/i.test(textual)) screenOn = false;
  else {
    const n = toInt(raw);
    if (n === 1) screenOn = true;
    else if (n === 0) screenOn = false;
  }
  const options = {
    screenAction: screenOn === null ? (raw === null ? null : 'unknown') : (screenOn ? 'on' : 'off'),
    screenActionRaw: raw,
    screenOn,
  };
  return result('turnOffScreen', null, null, dropNullish(options));
}

function decodeUnlockScreen(ctx) {
  return result('unlockScreen', null, null, { note: 'unlock screen (autoinput)' });
}

function decodeModes(ctx) {
  const { values, blurb } = ctx;
  const options = {
    enableKeySuppressMode: pickValue(values, KEYS.keySuppressMode),
    manualKeyCodes: pickValue(values, KEYS.manualKeyCodes),
    keyCodes: pickValue(values, KEYS.keyCode),
    isFirstAction: firstBool([pickValue(values, KEYS.isFirstAction)]),
  };
  if (blurb.raw && options.manualKeyCodes === null) options.blurb = blurb.raw;
  return result('modes', null, null, dropNullish(options));
}

function decodeKeyEvent(ctx) {
  const { values, enums } = ctx;
  const keyActionRaw = pickValue(values, KEYS.keyAction);
  const keyActionName = enumName('KeyAction', keyActionRaw, enums);
  const options = {
    keyCode: pickValue(values, KEYS.keyCode),
    keyAction: keyActionRaw,
    keyActionName,
  };
  return result('keyEvent', null, null, dropNullish(options));
}

function decodeScreenCapture(ctx) {
  const { values } = ctx;
  const options = {
    captureMode: pickValue(values, KEYS.captureMode),
    crop: pickValue(values, KEYS.crop),
    resolution: pickValue(values, KEYS.resolution),
    file: pickValue(values, KEYS.file),
  };
  return result('screenCapture', null, null, dropNullish(options));
}

function decodeEvent(ctx) {
  const { values, enums } = ctx;
  const options = {
    appPackage: pickValue(values, KEYS.appToActIn),
    actionType: pickValue(values, KEYS.actionType),
    actionTypeName: enumName('ActionTypeUIAction', pickValue(values, KEYS.actionType), enums),
    fields: pickValue(values, KEYS.uiUpdateFields),
    text: pickValue(values, KEYS.uiUpdateText),
  };
  return result(ctx.type.opHint, null, null, dropNullish(options));
}


// ---------------------------------------------------------------------------
// Result construction
// ---------------------------------------------------------------------------

function result(op, selector, gesture, options) {
  return {
    op: op || 'unknown',
    selector: selector || null,
    gesture: gesture || null,
    options: options || {},
  };
}

function unknown(reason, ctx, extra) {
  const options = {
    reason: reason || 'unrecognized AutoInput bundle',
    package: ctx ? ctx.packageName : null,
    pluginTypeId: ctx ? ctx.pluginTypeId : null,
    pluginClass: ctx ? ctx.pluginClass : null,
  };
  if (extra && typeof extra === 'object') Object.assign(options, extra);
  return result('unknown', null, null, options);
}

function dropNullish(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

function firstInt(list) {
  for (const v of list) {
    const n = toInt(v);
    if (n !== null) return n;
  }
  return null;
}

function firstBool(list) {
  for (const v of list) {
    const b = toBool(v);
    if (b !== null) return b;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Type resolution
// ---------------------------------------------------------------------------

function resolveType(ctx, tables) {
  const table = (tables && tables.pluginTypes) || PLUGIN_TYPES;
  const tid = ctx.pluginTypeId;
  if (tid) {
    if (table[tid]) return { id: tid, spec: table[tid] };
    const lower = tid.toLowerCase();
    const hit = Object.keys(table).find((k) => k.toLowerCase() === lower);
    if (hit) return { id: hit, spec: table[hit] };
    // Tolerate aliases that still identify the Intent class.
    const suffix = tid.split('.').pop();
    if (suffix) {
      const bySuffix = Object.keys(table).find((k) => k.endsWith(`.${suffix}`));
      if (bySuffix) return { id: bySuffix, spec: table[bySuffix] };
    }
  }

  const cfg = ctx.pluginClass;
  if (cfg) {
    if (CONFIG_ALIASES[cfg] && table[CONFIG_ALIASES[cfg]]) {
      return { id: CONFIG_ALIASES[cfg], spec: table[CONFIG_ALIASES[cfg]] };
    }
    const byConfig = Object.keys(table).find((k) => table[k].configClass === cfg);
    if (byConfig) return { id: byConfig, spec: table[byConfig] };
    if (CONFIG_ALIASES[cfg]) return { id: CONFIG_ALIASES[cfg], spec: table[CONFIG_ALIASES[cfg]] };
  }

  const v = ctx.values;
  const hasDslKey = pickValue(v, ['parameters', 'Actions To Perform', 'ActionsToPerform', 'actions_to_perform']) !== null;
  if (hasDslKey && (
    pickValue(v, ['action']) !== null || pickValue(v, ['parameters']) !== null
  )) {
    return { id: 'com.joaomgcd.autoinput.intent.IntentActionv2', spec: table['com.joaomgcd.autoinput.intent.IntentActionv2'] };
  }
  if (pickValue(v, KEYS.actionType) !== null || pickValue(v, KEYS.fieldSelectionType) !== null) {
    return { id: 'com.joaomgcd.autoinput.intent.IntentPerformAction', spec: table['com.joaomgcd.autoinput.intent.IntentPerformAction'] };
  }
  if (pickValue(v, KEYS.gestureType) !== null) {
    return { id: 'com.joaomgcd.autoinput.intent.IntentGestures', spec: table['com.joaomgcd.autoinput.intent.IntentGestures'] };
  }
  if (pickValue(v, KEYS.globalAction) !== null) {
    return { id: 'com.joaomgcd.autoinput.intent.IntentPerformGlobalAction', spec: table['com.joaomgcd.autoinput.intent.IntentPerformGlobalAction'] };
  }
  if (pickValue(v, KEYS.uiUpdateFields) !== null || pickValue(v, KEYS.onlyVisible) !== null) {
    return { id: 'com.joaomgcd.autoinput.intent.IntentUIQuery', spec: table['com.joaomgcd.autoinput.intent.IntentUIQuery'] };
  }
  if (pickValue(v, KEYS.screenOffOrOn) !== null) {
    return { id: 'com.joaomgcd.autoinput.intent.IntentTurnOffScreen', spec: table['com.joaomgcd.autoinput.intent.IntentTurnOffScreen'] };
  }
  if (pickValue(v, KEYS.keySuppressMode) !== null) {
    return { id: 'com.joaomgcd.autoinput.intent.IntentModes', spec: table['com.joaomgcd.autoinput.intent.IntentModes'] };
  }
  return null;
}

function decodeParamsJson(values) {
  const raw = pickValue(values, ['parameters']);
  if (raw === null) return null;
  const t = raw.trim();
  if (!t.startsWith('{')) return null;
  try {
    const o = JSON.parse(t);
    return isPlainObject(o) ? o : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Decode one AutoInput plugin action.
 *
 * @param {object} bundleVals A Tasker/IR plugin action. Accepted shapes:
 *   - IR Action node `{kind:'plugin', args:{arg0:{$bundle}, arg1, arg2}, pluginClass}`
 *   - args object `{arg0:{$bundle}, arg1:'com.joaomgcd.autoinput', arg2}`
 *   - corpus record `{pluginPackage, pluginConfig, pluginTypeId, extras}`
 *   - flattened `Vals` map (or `{$bundle:{...}}`) — package inferred from keys
 * @param {{enums?:object, pluginTypes?:object}} [tables] optional overrides loaded
 *   from data/autoInputEnums.json / a corpus-derived table.
 * @returns {{op:string, selector:object|null, gesture:object|null, options:object}}
 *   `op` is always a non-empty string; unresolvable bundles return
 *   `op:'unknown'` with a human-readable `options.reason` (never a guess).
 */
export function decodeAutoInput(bundleVals, tables = {}) {
  try {
    const normalized = normalizeInput(bundleVals);
    const { values } = indexBundle(normalized.bundle);

    const explicitPackage = firstClean([
      normalized.packageName,
      pickValue(values, KEYS.pluginName),
      pickValue(values, KEYS.pluginTypeId),
    ]);
    let packageName = explicitPackage;
    const explicitTypeId = normalized.pluginTypeId || pickValue(values, KEYS.pluginTypeId);

    const autoInputPackage = packageName
      ? packageName.toLowerCase().startsWith(AUTOINPUT_PACKAGE)
      : null;

    if (autoInputPackage === false) {
      return unknown(`plugin package ${JSON.stringify(packageName)} is not ${AUTOINPUT_PACKAGE}`, {
        packageName, pluginTypeId: explicitTypeId, pluginClass: normalized.pluginConfig,
      });
    }
    if (autoInputPackage === null) {
      if (!explicitTypeId) {
        const hasAutoInputKeys = ['plugintypeid', 'plugininstanceid'].some((k) =>
          Object.keys(values).some((kk) => kk.toLowerCase() === k));
        if (!hasAutoInputKeys) {
          return unknown('no plugin package and no pluginTypeId: cannot identify an AutoInput bundle', {
            packageName: null, pluginTypeId: null, pluginClass: normalized.pluginConfig,
          });
        }
        packageName = AUTOINPUT_PACKAGE;
      } else if (!String(explicitTypeId).toLowerCase().startsWith(AUTOINPUT_PACKAGE)) {
        return unknown(`pluginTypeId ${JSON.stringify(explicitTypeId)} does not belong to ${AUTOINPUT_PACKAGE}`, {
          packageName: null, pluginTypeId: explicitTypeId, pluginClass: normalized.pluginConfig,
        });
      } else {
        packageName = AUTOINPUT_PACKAGE;
      }
    }

    const blurb = parseBlurb(pickValue(values, KEYS.blurb));
    const enums = (tables && tables.enums) || ENUMS;
    const params = decodeParamsJson(values) || {};
    const ctx = {
      values,
      blurb,
      enums,
      params,
      packageName,
      pluginTypeId: explicitTypeId,
      pluginClass: normalized.pluginConfig,
      type: null,
    };

    const resolved = resolveType(ctx, tables);
    if (!resolved) {
      return unknown('unrecognized AutoInput plugin configuration (no pluginTypeId, no known keys)', ctx);
    }
    ctx.type = resolved.spec;
    ctx.pluginTypeId = explicitTypeId || resolved.id;

    switch (resolved.spec.kind) {
      case 'uiAction':
        return decodeUiAction(ctx);
      case 'performAction':
        return decodePerformAction(ctx);
      case 'uiQuery':
        return decodeUiQuery(ctx);
      case 'gesture':
        return decodeGesture(ctx);
      case 'globalAction':
        return decodeGlobalAction(ctx);
      case 'screenOnOff':
        return decodeScreenOnOff(ctx);
      case 'unlockScreen':
        return decodeUnlockScreen(ctx);
      case 'modes':
        return decodeModes(ctx);
      case 'keyEvent':
        return decodeKeyEvent(ctx);
      case 'screenCapture':
        return decodeScreenCapture(ctx);
      case 'inputActionEvent':
      case 'uiUpdateEvent':
      case 'gestureEvent':
        return decodeEvent(ctx);
      default:
        return unknown(`unhandled pluginTypeId kind ${JSON.stringify(resolved.spec.kind)}`, ctx);
    }
  } catch (err) {
    return result('unknown', null, null, {
      reason: `decoder error: ${err && err.message ? err.message : String(err)}`,
    });
  }
}
