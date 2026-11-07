// js/sources/tasker/taskerXml.js — TaskerData XML -> AutoPort IR.
//
// Faithful browser port of scripts/tasker_xml_ir.py (the reference oracle).
// The golden IRs under tests/golden/tasker/ are reproduced byte-for-byte
// (as parsed objects) by tests/js/run_tasker_tests.mjs.
//
// Design notes:
//  * The core walker consumes a minimal, DOM-free tree shape:
//        { tagName, attributes: {name: value}, children: [...], text: string|null }
//    In Node (no DOMParser) tests inject tests/js/xmlShim.mjs; in the browser
//    the DOMParser DOM is adapted to the same shape by domToTree().
//  * `<code>` values are carried, never routed on for plugins; identity is
//    arg1 (package) + arg2 (config activity class).
//  * Errors never throw out of parseTaskerXml(): malformed/truncated/doctyped
//    input yields { source, error, macros: [] } (sniff/error taxonomy, DESIGN
//    §5.0).
//  * Embedded Tasker StringArray values are *escaped XML inside a Str value*;
//    decodeStringArray() re-parses them with the same tree parser.

import { CodeTable, loadCodeTables } from './actionCodes.js';

const VAR_RE = /%([a-zA-Z][a-zA-Z0-9_]+)/g;
// Tasker convention: %lowercase = local (incl. %par1), %UPPER = global/builtin.

const NUMERIC_TAGS = new Set(['Int', 'Long', 'Float']);
const CONTEXT_TAGS = { Event: 'event', State: 'state' };
const SHARE_KEY_MAP = { d: 'description', g: 'tags', p: 'public', t: 'title', b: 'button' };
const PROFILE_META_TAGS = new Set(['cdate', 'edate', 'limit', 'enabled', 'pri', 'flags', 'clp']);
const INDEX_DESCEND_TAGS = new Set(['Task', 'Project', 'Profile', 'Data', 'Scene']);
const SCENE_TAGS = new Set(['Scene', 'SceneElement']);

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

/** Strip a Clark-notation namespace (`{uri}Tag` -> `Tag`), like the oracle. */
export function stripNs(tag) {
  const s = tag === null || tag === undefined ? '' : String(tag);
  const brace = s.lastIndexOf('}');
  return brace >= 0 ? s.slice(brace + 1) : s;
}

/** Python local_text(): (el.text or "").strip(). */
function localText(el) {
  const t = el && el.text;
  return (t === null || t === undefined ? '' : String(t)).trim();
}

/** ElementTree .get(): missing attribute -> null (JSON null, not undefined). */
function getAttr(el, name) {
  const attrs = el && el.attributes;
  if (!attrs) return null;
  const v = attrs[name];
  return v === undefined ? null : v;
}

/** Python %s of a possibly-None value. */
function pyNoneStr(v) {
  return v === null || v === undefined ? 'None' : String(v);
}

/** Python repr() for the values we interpolate into diagnostics (ints/strings/None). */
function pyRepr(v) {
  if (v === null || v === undefined) return 'None';
  if (typeof v === 'number') return String(v);
  const s = String(v);
  let out = "'";
  for (const ch of s) {
    if (ch === '\\') out += '\\\\';
    else if (ch === "'") out += "\\'";
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else out += ch;
  }
  return out + "'";
}

/** Python int(str) for a literal; returns undefined on ValueError (not null). */
function pyInt(raw) {
  const s = String(raw).trim();
  return /^[+-]?\d+$/.test(s) ? Number(s) : undefined;
}

/** Python float(str); undefined on ValueError. */
function pyFloat(raw) {
  const s = String(raw).trim();
  if (/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s)) return Number(s);
  return undefined;
}

/** Python `int(text)` guarded by try/except ValueError -> null. */
function codeFromText(text) {
  const s = String(text === null || text === undefined ? '' : text).trim();
  return /^[+-]?\d+$/.test(s) ? Number(s) : null;
}

/** Find the first direct child whose namespace-stripped tag matches. */
function findChild(el, tag) {
  for (const c of el.children) {
    if (stripNs(c.tagName) === tag) return c;
  }
  return null;
}

/** Depth-first pre-order iteration (ElementTree .iter()). */
function* iterAll(el) {
  yield el;
  for (const c of el.children) yield* iterAll(c);
}

function basename(p) {
  const s = p === null || p === undefined ? '' : String(p);
  const parts = s.split(/[\\/]/);
  return parts[parts.length - 1];
}

function typedError(kind, message) {
  const e = new Error(message);
  e.kind = kind;
  return e;
}

function messageOf(e) {
  if (e && e.message) return String(e.message);
  return String(e);
}

/* ------------------------------------------------------------------ */
/* DOM adaptation (browser path)                                       */
/* ------------------------------------------------------------------ */

/**
 * Adapt a DOMParser Element to the simple tree shape consumed by the walker.
 * `.text` is the character data *before the first element child* (comments and
 * processing instructions do not end the run), matching ElementTree.
 *
 * @param {Element} el
 */
export function domToTree(el) {
  const node = {
    tagName: el.localName || el.tagName,
    attributes: Object.create(null),
    children: [],
    text: null,
  };
  if (el.attributes) {
    for (const a of el.attributes) node.attributes[a.name] = a.value;
  }
  let buf = '';
  let beforeFirstChild = true;
  const kids = el.childNodes || [];
  for (let i = 0; i < kids.length; i += 1) {
    const cn = kids[i];
    if (cn.nodeType === 1) {
      beforeFirstChild = false;
      node.children.push(domToTree(cn));
    } else if (cn.nodeType === 3 || cn.nodeType === 4) {
      // text / CDATA
      if (beforeFirstChild) buf += cn.nodeValue || '';
    }
    // nodeType 7 (PI) and 8 (comment): ignored, do not end the text run
  }
  if (buf.length) node.text = buf;
  return node;
}

/** Default tree parser: DOMParser when present, otherwise a typed error. */
function defaultXmlTree(text) {
  const DP = typeof globalThis !== 'undefined' ? globalThis.DOMParser : undefined;
  if (typeof DP === 'undefined') {
    throw typedError('parse', 'no XML parser available (no DOMParser; inject parseXml)');
  }
  let doc;
  try {
    doc = new DP().parseFromString(String(text), 'application/xml');
  } catch (e) {
    throw typedError('parse', `XML parse error: ${messageOf(e)}`);
  }
  const errors = doc.getElementsByTagName ? doc.getElementsByTagName('parsererror') : null;
  if (errors && errors.length) {
    const detail = errors[0] && errors[0].textContent ? String(errors[0].textContent).trim() : 'invalid XML';
    throw typedError('parse', `XML parse error: ${detail}`);
  }
  const root = doc.documentElement;
  if (!root || (root.localName || root.nodeName) === 'parsererror') {
    throw typedError('parse', 'XML parse error: empty or invalid document');
  }
  return domToTree(root);
}

/* ------------------------------------------------------------------ */
/* Typed value decoding (ports parse_arg / parse_bundle)               */
/* ------------------------------------------------------------------ */

function decodeStringArray(text, parseXmlText) {
  if (!text || !String(text).trimStart().startsWith('<StringArray')) return null;
  let root;
  try {
    root = parseXmlText(String(text));
  } catch {
    return null; // Python: ET.ParseError -> None (keep the raw string)
  }
  // NB: the oracle does not re-check the parsed root tag after the prefix test.
  return root.children.map((c) => (c.text === null || c.text === undefined ? '' : c.text));
}

function parseBundle(el, parseXmlText) {
  const out = {};
  for (const vals of el.children) {
    const valsTag = stripNs(vals.tagName);
    if (valsTag !== 'Vals') {
      out[`$nonVals:${valsTag}`] = parseArg(vals, parseXmlText);
      continue;
    }
    for (const item of vals.children) {
      const key = stripNs(item.tagName);
      if (item.children.length) {
        // nested container inside a Vals entry
        out[key] = item.children.map((c) => parseArg(c, parseXmlText));
      } else {
        const txt = item.text === null || item.text === undefined ? '' : item.text;
        const arr = decodeStringArray(txt, parseXmlText);
        out[key] = arr !== null ? { $array: arr } : txt;
      }
    }
  }
  return { $bundle: out };
}

/** Convert one typed arg element into a JSON-native value (parse_arg). */
function parseArg(el, parseXmlText) {
  const tag = stripNs(el.tagName);

  if (NUMERIC_TAGS.has(tag)) {
    const raw = getAttr(el, 'val');
    if (raw === null) {
      // e.g. <Int sr="arg1"><var>%priority+1</var></Int> — expression, not literal
      const varEl = findChild(el, 'var');
      if (varEl) return { $var: localText(varEl) };
      return null;
    }
    const num = tag === 'Float' ? pyFloat(raw) : pyInt(raw);
    return num === undefined ? raw : num;
  }

  if (tag === 'Str') {
    const txt = el.text === null || el.text === undefined ? '' : el.text;
    const arr = decodeStringArray(txt, parseXmlText);
    if (arr !== null) return { $array: arr };
    return txt;
  }

  if (tag === 'Bundle') return parseBundle(el, parseXmlText);

  if (tag === 'App') {
    const out = {};
    for (const c of el.children) out[stripNs(c.tagName)] = localText(c);
    return { $app: out };
  }

  if (tag === 'StringArray') return { $array: el.children.map(localText) };

  // scalar metadata-style elements (<mon>true</mon>, <fh>-1</fh>) -> plain value
  if (el.children.length === 0 && getAttr(el, 'val') === null) return localText(el);

  // generic fallback: keep everything so nothing is silently lost
  const out = { $tag: tag };
  const val = getAttr(el, 'val');
  if (val !== null) out.val = val;
  if (el.text && el.text.trim()) out.text = el.text.trim();
  const kids = el.children.map((c) => parseArg(c, parseXmlText));
  if (kids.length) out.children = kids;
  return out;
}

/**
 * Collect positional args (collect_args).
 * Action-shaped elements pass extra_named=true so bare named children
 * (<on>, <se>, <fh>, <mon>…) become positional bag entries.
 */
function collectArgs(parent, skipTags = ['code'], extraNamed = false, parseXmlText) {
  const skip = new Set(skipTags);
  const args = {};
  for (const child of parent.children) {
    const tag = stripNs(child.tagName);
    if (skip.has(tag)) continue;
    const sr = getAttr(child, 'sr') || '';
    if (sr.startsWith('arg') || tag === 'Bundle' || tag === 'App' || tag === 'Str' || NUMERIC_TAGS.has(tag)) {
      args[sr || tag.toLowerCase()] = parseArg(child, parseXmlText);
    } else if (extraNamed) {
      args[sr || tag.toLowerCase()] = parseArg(child, parseXmlText);
    }
  }
  return args;
}

function parseConditionList(el, srKey, parseXmlText) {
  const conds = [];
  for (const c of el.children) {
    const tag = stripNs(c.tagName);
    if (tag !== 'Condition') continue;
    const item = { tag, sr: getAttr(c, 'sr'), ve: getAttr(c, 've') };
    for (const part of c.children) {
      const pt = stripNs(part.tagName);
      if (pt === 'lhs' || pt === 'rhs' || pt === 'op') item[pt] = localText(part);
      else item[pt] = parseArg(part, parseXmlText);
    }
    conds.push(item);
  }
  const sr = srKey || getAttr(el, 'sr');
  return { sr: sr === undefined ? null : sr, conditions: conds };
}

/* ------------------------------------------------------------------ */
/* Variables                                                           */
/* ------------------------------------------------------------------ */

/** All %var refs anywhere in an element subtree (text + val attrs). */
function varsOfElement(el, skipTags = new Set(['Share'])) {
  const found = new Set();
  const scan = (text) => {
    if (!text) return;
    const re = new RegExp(VAR_RE.source, 'g');
    let m;
    while ((m = re.exec(text)) !== null) found.add(m[1]);
  };
  const walk = (e) => {
    scan(e.text === null || e.text === undefined ? '' : e.text);
    scan(getAttr(e, 'val') || '');
    for (const ch of e.children) {
      if (skipTags.has(stripNs(ch.tagName))) continue;
      walk(ch);
    }
  };
  walk(el);
  return found;
}

/** All %var refs in an already-decoded argument value. */
function walkStrings(value, found) {
  if (typeof value === 'string') {
    const re = new RegExp(VAR_RE.source, 'g');
    let m;
    while ((m = re.exec(value)) !== null) found.add(m[1]);
  } else if (Array.isArray(value)) {
    for (const v of value) walkStrings(v, found);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) walkStrings(v, found);
  }
}

function isLocalVarName(name) {
  const first = name.charAt(0);
  return (first >= 'a' && first <= 'z') || name.startsWith('par');
}

function classifyVars(names) {
  const local = [];
  const global = [];
  for (const n of names) (isLocalVarName(n) ? local : global).push(n);
  local.sort();
  global.sort();
  return { local: local.map((n) => `%${n}`), global: global.map((n) => `%${n}`) };
}

/* ------------------------------------------------------------------ */
/* Parser                                                              */
/* ------------------------------------------------------------------ */

/** TaskerData tree -> IR walker. Port of class Parser in the oracle. */
export class TaskerParser {
  /**
   * @param {object} [opts]
   * @param {CodeTable|object} [opts.codes] CodeTable or raw taskerCodes.json
   * @param {string} [opts.file] source file name (basename is reported)
   * @param {(text: string) => object} [opts.parseXml] tree parser for documents
   *        and escaped StringArray fragments (tests inject xmlShim)
   */
  constructor({ codes, file = '', parseXml } = {}) {
    this.codes = codes instanceof CodeTable ? codes : new CodeTable(codes || {});
    this.file = file === null || file === undefined ? '' : String(file);
    this.parseXmlText = typeof parseXml === 'function' ? parseXml : defaultXmlTree;
    this.stats = {
      actionsTotal: 0,
      actionsDecoded: 0,
      actionsPlugin: 0,
      actionsUnknown: 0,
      contextsTotal: 0,
      contextsDecoded: 0,
      contextsUnknown: 0,
      unrepresentable: [],
    };
    this._parsedTasks = new WeakMap(); // element -> task dict (parse each once)
    this._consumedElements = new WeakSet(); // inline <Task>s already emitted
    this._consumedTaskIds = new Set(); // task ids already folded into profiles
    this._taskIndex = new Map(); // taskId -> task dict (for <midK> refs)
  }

  /* ---- actions ------------------------------------------------------- */

  parseAction(el, index) {
    this.stats.actionsTotal += 1;
    let codeTxt = null;
    for (const c of el.children) {
      if (stripNs(c.tagName) === 'code') {
        codeTxt = localText(c);
        break;
      }
    }
    const code = codeTxt !== null ? codeFromText(codeTxt) : null;
    const args = collectArgs(el, ['code', 'ConditionList'], true, this.parseXmlText);

    const action = {
      kind: 'unknown',
      code,
      codeName: `unknown (code ${pyNoneStr(codeTxt)})`,
      args,
      sr: getAttr(el, 'sr'),
      ve: getAttr(el, 've'),
    };

    const conds = [];
    for (const c of el.children) {
      if (stripNs(c.tagName) === 'ConditionList') {
        conds.push(parseConditionList(c, getAttr(c, 'sr'), this.parseXmlText));
      }
    }
    if (conds.length) action.condition = conds.length === 1 ? conds[0] : conds;

    action._refs = [...varsOfElement(el)].sort();

    const name = code !== null ? this.codes.lookup('actions', code) : null;
    const firstPlugin = this.codes.firstPluginCode
      ? this.codes.firstPluginCode('actions')
      : this.codes.firstPlugin.actions || 1000;

    if (name) {
      action.kind = 'builtin';
      action.codeName = name;
      this.stats.actionsDecoded += 1;
    } else if (code !== null && code >= firstPlugin) {
      // plugin identity lives in arg1/arg2, not in the numeric code
      const pkg = args.arg1;
      const cls = args.arg2;
      action.kind = 'plugin';
      action.package = typeof pkg === 'string' ? pkg : null;
      action.pluginClass = typeof cls === 'string' ? cls : null;
      action.codeName = `PLUGIN(${action.package || 'unknown'})`;
      this.stats.actionsPlugin += 1;
      this.stats.unrepresentable.push(
        `plugin bundle action code=${code} package=${pyNoneStr(action.package)}: inner extras kept raw, ` +
          'no semantic op decode (AutoInput decoder is a separate workstream)'
      );
    } else {
      this.stats.actionsUnknown += 1;
      this.stats.unrepresentable.push(
        `unknown action code ${pyRepr(codeTxt)} at ${pyNoneStr(getAttr(el, 'sr'))}/${index}`
      );
    }
    return action;
  }

  /* ---- tasks / contexts --------------------------------------------- */

  parseTask(el) {
    if (this._parsedTasks.has(el)) return this._parsedTasks.get(el);
    const idEl = findChild(el, 'id');
    const nmeEl = findChild(el, 'nme');
    const priEl = findChild(el, 'pri');
    const task = {
      taskId: idEl ? localText(idEl) : null,
      name: nmeEl ? localText(nmeEl) : null,
      priority: priEl ? localText(priEl) : null,
      sr: getAttr(el, 'sr'),
      actions: [],
    };
    const img = findChild(el, 'Img');
    if (img) {
      const icon = {};
      for (const c of img.children) icon[stripNs(c.tagName)] = localText(c);
      task.icon = icon;
    }
    const share = findChild(el, 'Share');
    if (share) {
      const sh = {};
      for (const c of share.children) sh[stripNs(c.tagName)] = localText(c);
      task.share = sh;
    }
    let idx = 0;
    for (const child of el.children) {
      if (stripNs(child.tagName) === 'Action') {
        task.actions.push(this.parseAction(child, idx));
        idx += 1;
      }
    }
    this._parsedTasks.set(el, task);
    return task;
  }

  parseContext(el) {
    const tag = stripNs(el.tagName);
    const family = CONTEXT_TAGS[tag] || tag.toLowerCase();
    this.stats.contextsTotal += 1;

    let code = null;
    const codeEl = findChild(el, 'code');
    if (codeEl) code = codeFromText(localText(codeEl));

    const ctx = {
      family,
      code,
      codeName: null,
      args: collectArgs(el, ['code'], true, this.parseXmlText),
      sr: getAttr(el, 'sr'),
      ve: getAttr(el, 've'),
      _refs: [...varsOfElement(el)].sort(),
    };

    const name = code !== null ? this.codes.lookup(family, code) : null;
    if (name === null && family !== 'event' && family !== 'state' && code === null) {
      // Time/Day/Location contexts have no numeric code table entry
      ctx.codeName = family.toUpperCase();
      this.stats.contextsDecoded += 1;
      return ctx;
    }
    if (name) {
      ctx.codeName = name;
      this.stats.contextsDecoded += 1;
      return ctx;
    }
    ctx.codeName = `unknown (code ${pyNoneStr(code)})`;
    this.stats.contextsUnknown += 1;
    this.stats.unrepresentable.push(
      `unknown ${family} context code ${pyRepr(code)} (agent may be a plugin context)`
    );
    return ctx;
  }

  buildMacro(name, triggers, actions, taskIds = null, extra = null) {
    const names = new Set();
    for (const a of actions) {
      walkStrings(a.args, names);
      if (a._refs) for (const r of a._refs) names.add(r); // refs incl. ConditionList / <var> exprs
      delete a._refs;
    }
    for (const t of triggers) {
      walkStrings(t.args, names);
      if (t._refs) for (const r of t._refs) names.add(r);
      delete t._refs;
    }
    const macro = { name, triggers, actions, variables: classifyVars(names) };
    if (taskIds && taskIds.length) macro.taskIds = taskIds;
    if (extra) Object.assign(macro, extra);
    return macro;
  }

  /* ---- root --------------------------------------------------------- */

  /** @param {object} root simple tree node for <TaskerData> */
  parseTree(root) {
    const rootTag = stripNs(root.tagName);
    if (rootTag !== 'TaskerData') {
      throw typedError('not-tasker', `not a TaskerData document: ${rootTag}`);
    }
    const version = getAttr(root, 'tv');
    const macros = [];
    const projects = [];

    const indexTasks = (el) => {
      for (const child of el.children) {
        const tag = stripNs(child.tagName);
        if (tag === 'Task') {
          const t = this.parseTask(child);
          if (t.taskId !== null) this._taskIndex.set(String(t.taskId), t);
        }
        if (INDEX_DESCEND_TAGS.has(tag)) indexTasks(child);
      }
    };
    indexTasks(root);

    const profileMacro = (el) => {
      const triggers = [];
      for (const child of el.children) {
        const sr = getAttr(child, 'sr') || '';
        if (/^con\d+$/.test(sr)) triggers.push(this.parseContext(child));
      }

      const inlineTask = findChild(el, 'Task');
      let actions = [];
      const taskIds = [];
      if (inlineTask) {
        this._consumedElements.add(inlineTask);
        const t = this.parseTask(inlineTask);
        actions = t.actions;
        if (t.taskId) taskIds.push(t.taskId);
      }
      const refs = [];
      for (const c of el.children) {
        if (stripNs(c.tagName).startsWith('mid')) refs.push(localText(c));
      }
      for (const r of refs) {
        if (!taskIds.includes(r)) taskIds.push(r);
      }
      for (const ref of refs) {
        const t = this._taskIndex.get(String(ref));
        this._consumedTaskIds.add(String(ref));
        if (t && actions.length === 0) actions = t.actions;
      }

      const nameEl = findChild(el, 'nme');
      const name = nameEl ? localText(nameEl) : `Profile ${pyNoneStr(getAttr(el, 'sr'))}`;

      const meta = {};
      const share = findChild(el, 'Share');
      if (share) {
        for (const part of share.children) {
          const pt = stripNs(part.tagName);
          meta[SHARE_KEY_MAP[pt] || pt] = localText(part);
        }
      }
      for (const part of el.children) {
        const pt = stripNs(part.tagName);
        if (PROFILE_META_TAGS.has(pt)) meta[pt] = localText(part);
      }

      const profileIdEl = findChild(el, 'id');
      const enabledEl = findChild(el, 'enabled');
      return this.buildMacro(name, triggers, actions, taskIds, {
        kind: 'profile',
        meta,
        profileId: profileIdEl ? localText(profileIdEl) : null,
        enabled: enabledEl ? localText(enabledEl) || 'true' : null,
        sr: getAttr(el, 'sr'),
      });
    };

    const emitTasks = (el) => {
      for (const child of el.children) {
        const tag = stripNs(child.tagName);
        if (tag === 'Task') {
          const idEl = findChild(child, 'id');
          const tid = idEl ? localText(idEl) : null;
          if (this._consumedElements.has(child)) continue;
          if (tid !== null && this._consumedTaskIds.has(String(tid))) continue;
          let t = tid !== null ? this._taskIndex.get(String(tid)) : null;
          t = t || this.parseTask(child);

          const extra = { kind: 'task', sr: t.sr };
          const meta = {};
          if (t.icon) meta.icon = t.icon;
          const sh = t.share || {};
          for (const [k, v] of Object.entries(sh)) meta[SHARE_KEY_MAP[k] || k] = v;
          if (Object.keys(meta).length) extra.meta = meta;

          macros.push(
            this.buildMacro(
              t.name || `Task ${pyNoneStr(t.taskId)}`,
              [],
              t.actions,
              t.taskId ? [t.taskId] : [],
              extra
            )
          );
        } else if (tag === 'Profile') {
          macros.push(profileMacro(child));
          emitTasks(child);
        } else if (tag === 'Project') {
          const pidEl = findChild(child, 'id');
          const pnameEl = findChild(child, 'nme');
          const tidsEl = findChild(child, 'tids');
          const pidsEl = findChild(child, 'pids');
          const pid = pidEl ? localText(pidEl) : null;
          const pname = pnameEl ? localText(pnameEl) : null;
          const tids = tidsEl ? localText(tidsEl).split(',') : [];
          const proj = {
            id: pid,
            name: pname,
            taskIds: tids.filter((x) => x),
            profileIds: (pidsEl ? localText(pidsEl).split(',') : []).filter((x) => x),
          };
          const displayNameEl = findChild(child, 'name');
          if (displayNameEl) proj.displayName = localText(displayNameEl);
          const img = findChild(child, 'Img');
          if (img) {
            const icon = {};
            for (const c of img.children) icon[stripNs(c.tagName)] = localText(c);
            proj.icon = icon;
          }
          projects.push(proj);
          const scenesEl = findChild(child, 'scenesEnabled');
          Object.assign(projects[projects.length - 1], {
            taskIds: tids.filter((x) => x),
            scenesEnabled: scenesEl ? localText(scenesEl) : null,
            sr: getAttr(child, 'sr'),
          });
          emitTasks(child);
        } else if (tag === 'Data') {
          // full-backup exports wrap everything in <Data>
          emitTasks(child);
        } else if (SCENE_TAGS.has(tag)) {
          this.stats.unrepresentable.push(
            `scene element <${tag}> not represented in IR (no scene target in Phase 1)`
          );
          emitTasks(child);
        }
      }
    };

    // pre-pass: profiles reference their action task via <midK>; suppress the
    // standalone task macro so one automation appears exactly once in the IR.
    for (const el of iterAll(root)) {
      if (stripNs(el.tagName) === 'Profile') {
        for (const c of el.children) {
          if (stripNs(c.tagName).startsWith('mid')) this._consumedTaskIds.add(localText(c));
        }
      }
    }

    emitTasks(root);

    const ir = {
      source: { app: 'tasker', file: basename(this.file), taskerVersion: version },
      macros,
    };
    if (projects.length) ir.projects = projects;
    return ir;
  }
}

/* ------------------------------------------------------------------ */
/* Byte/string handling + error contract                               */
/* ------------------------------------------------------------------ */

function stripBomString(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** Accept string | Uint8Array | ArrayBuffer | typed-array view -> XML text. */
export function toXmlText(input) {
  if (typeof input === 'string') return stripBomString(input);
  let bytes = null;
  if (input instanceof Uint8Array) bytes = input;
  else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
  else if (ArrayBuffer.isView(input)) bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (!bytes) throw new Error('unsupported input: expected string, Uint8Array or ArrayBuffer');
  let start = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(start));
}

function errorIR(file, kind, message) {
  return {
    source: { app: 'tasker', file: basename(file), taskerVersion: null },
    error: { kind: kind || 'parse', message: String(message) },
    macros: [],
  };
}

function xmlTreeParser(options) {
  return typeof options.parseXml === 'function' ? options.parseXml : defaultXmlTree;
}

async function resolveCodeTable(options) {
  const source = options.codes !== undefined ? options.codes : options.tables;
  if (source instanceof CodeTable) return source;
  if (source && typeof source === 'object') return new CodeTable(source);
  if (typeof source === 'string') return loadCodeTables(source);
  return loadCodeTables(options.codesUrl);
}

/* ------------------------------------------------------------------ */
/* Public entry points                                                 */
/* ------------------------------------------------------------------ */

/**
 * Parse TaskerData XML into the AutoPort IR. Never throws.
 *
 * @param {string|Uint8Array|ArrayBuffer} input XML text or bytes
 * @param {object} [options]
 * @param {string} [options.file] source file name (reported as basename)
 * @param {CodeTable|object} [options.codes] code table (or raw taskerCodes.json)
 * @param {object} [options.tables] alias for options.codes (test injection)
 * @param {(text:string)=>object} [options.parseXml] tree parser (tests inject xmlShim)
 * @param {string} [options.codesUrl] override for the data/taskerCodes.json URL
 * @param {object} [options.stats] filled with parse statistics
 * @returns {Promise<object>} IR (or {source, error, macros: []})
 */
export async function parseTaskerXml(input, options = {}) {
  const file = options.file !== undefined ? options.file : options.filename !== undefined ? options.filename : options.name;

  let text;
  try {
    text = toXmlText(input);
  } catch (e) {
    return errorIR(file, 'parse', messageOf(e));
  }

  // Entity-expansion safety: real Tasker exports never declare entities.
  const head = text.slice(0, 8192);
  if (/<!doctype/i.test(head) || /<!entity/i.test(head)) {
    return errorIR(file, 'doctype', `refusing XML with DOCTYPE/ENTITY declaration: ${basename(file)}`);
  }

  let codes;
  try {
    codes = await resolveCodeTable(options);
  } catch (e) {
    return errorIR(file, 'unknown', `failed to load Tasker code tables: ${messageOf(e)}`);
  }

  const parseXmlText = xmlTreeParser(options);
  let root;
  try {
    root = parseXmlText(text);
  } catch (e) {
    return errorIR(file, (e && e.kind) || 'parse', messageOf(e));
  }

  const parser = new TaskerParser({ codes, file, parseXml: parseXmlText });
  try {
    return parser.parseTree(root);
  } catch (e) {
    return errorIR(file, (e && e.kind) || 'parse', messageOf(e));
  } finally {
    if (options.stats && typeof options.stats === 'object') Object.assign(options.stats, parser.stats);
  }
}

/**
 * Synchronous parse entry point. Requires the code tables to be supplied
 * (a `CodeTable` or the raw taskerCodes.json as `codes`/`tables`) — useful
 * after one async load, and for tests. Never throws; same error contract as
 * parseTaskerXml().
 *
 * @param {string|Uint8Array|ArrayBuffer} input
 * @param {object} [options] { file, codes|tables, parseXml, stats }
 * @returns {object} IR (or {source, error, macros: []})
 */
export function parseTaskerXmlSync(input, options = {}) {
  const file = options.file !== undefined ? options.file : options.filename !== undefined ? options.filename : options.name;

  let text;
  try {
    text = toXmlText(input);
  } catch (e) {
    return errorIR(file, 'parse', messageOf(e));
  }
  const head = text.slice(0, 8192);
  if (/<!doctype/i.test(head) || /<!entity/i.test(head)) {
    return errorIR(file, 'doctype', `refusing XML with DOCTYPE/ENTITY declaration: ${basename(file)}`);
  }

  const source = options.codes !== undefined ? options.codes : options.tables;
  let codes;
  if (source instanceof CodeTable) codes = source;
  else if (source && typeof source === 'object') codes = new CodeTable(source);
  else return errorIR(file, 'unknown', 'parseTaskerXmlSync requires options.codes or options.tables');

  const parseXmlText = xmlTreeParser(options);
  let root;
  try {
    root = parseXmlText(text);
  } catch (e) {
    return errorIR(file, (e && e.kind) || 'parse', messageOf(e));
  }

  const parser = new TaskerParser({ codes, file, parseXml: parseXmlText });
  try {
    return parser.parseTree(root);
  } catch (e) {
    return errorIR(file, (e && e.kind) || 'parse', messageOf(e));
  } finally {
    if (options.stats && typeof options.stats === 'object') Object.assign(options.stats, parser.stats);
  }
}

/**
 * Synchronous core: walk an already-parsed simple tree. Throws typed errors
 * ({kind:'not-tasker'}) — callers that need the graceful contract use
 * parseTaskerXml().
 *
 * @param {object} root simple tree node
 * @param {object} [options] { codes|tables, file, parseXml, stats }
 */
export function parseTaskerTree(root, options = {}) {
  const parser = new TaskerParser({
    codes: options.codes !== undefined ? options.codes : options.tables,
    file: options.file,
    parseXml: options.parseXml,
  });
  try {
    return parser.parseTree(root);
  } finally {
    if (options.stats && typeof options.stats === 'object') Object.assign(options.stats, parser.stats);
  }
}

export default parseTaskerXml;
