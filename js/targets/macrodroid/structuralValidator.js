// js/targets/macrodroid/structuralValidator.js
//
// Offline MacroDroid structural validator, mcp-parity semantics.
//
// Parity is defined by the recorded probes in
// tests/fixtures/macrodroid/validator-probes/ (a shallow live validator):
//   - a bare macro (no {macroExportVersion, macro, ...} wrapper) is accepted;
//   - a missing macro.m_completed is accepted;
//   - a constraint item placed inside m_actionList is accepted (no namespace check);
//   - an m_classType that is not in the feature catalog is rejected;
//   - an IfConditionAction with no matching EndIfAction is rejected
//     (same rule for LoopAction / EndLoopAction).
//
// The catalog (data/macrodroid/catalog.json, list_macrodroid_features) is the
// only source of valid class names. Unknown names are checked against the union
// of trigger/action/constraint names, exactly as the probes require (a
// WifiConstraint inside m_actionList must NOT be rejected).
//
// API: validateMacro(input) -> { ok: boolean, errors: [{ path, message }] }
// `input` is a macro object, the full export wrapper, or a JSON string of either.

import { ALL_CLASS_TYPE_SET } from './classTypes.js';

// Flat control-flow markers used by MacroDroid (docs/DESIGN.md 7.1).
const IF_OPENERS = new Set(['IfConditionAction', 'IfConfirmedThenAction']);
const LOOP_OPENERS = new Set(['LoopAction']);
const CLOSERS = new Map([
  ['EndIfAction', { openers: IF_OPENERS, openerName: 'IfConditionAction' }],
  ['EndLoopAction', { openers: LOOP_OPENERS, openerName: 'LoopAction' }],
]);
// ElseAction / ElseIfConditionAction / ElseIfConfirmedThenAction are neutral:
// they continue the current If without changing nesting depth.

const LISTS = ['m_triggerList', 'm_actionList', 'm_constraintList'];

function parseInput(input) {
  if (typeof input === 'string') {
    try {
      return { value: JSON.parse(input) };
    } catch (err) {
      return { error: `macro_json is not valid JSON: ${err.message}` };
    }
  }
  return { value: input };
}

function classifyRoot(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'Macro JSON must be a JSON object.' };
  }
  // Wrapped export: { macroExportVersion, macro, globalVariables, userIcons }.
  if (value.macro !== undefined) {
    if (value.macro === null || typeof value.macro !== 'object' || Array.isArray(value.macro)) {
      return { error: 'macro must be an object.' };
    }
    return { macro: value.macro, prefix: 'macro.' };
  }
  // Bare macro (accepted by the live validator).
  return { macro: value, prefix: '' };
}

function checkClassTypes(macro, listName, prefix, errors) {
  const list = macro[listName];
  if (list === undefined) return;
  if (!Array.isArray(list)) {
    errors.push({ path: `${prefix}${listName}`, message: `macro.${listName} must be an array.` });
    return;
  }
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const path = `${prefix}${listName}[${i}]`;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      errors.push({ path, message: `macro.${listName}[${i}] must be an object.` });
      continue;
    }
    // Template mirrors the live message, including its quoting, verbatim.
    const classType = item.m_classType;
    if (!ALL_CLASS_TYPE_SET.has(classType)) {
      errors.push({
        path: `${path}.m_classType`,
        message: `m_classType "${classType}" does not exist in MacroDroid.`,
      });
    }
  }
}

function checkControlFlow(macro, errors) {
  const list = macro.m_actionList;
  if (!Array.isArray(list)) return;

  // Each stack entry: { name, kind } where kind is 'if' or 'loop'.
  const stack = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (item === null || typeof item !== 'object') continue;
    const classType = item.m_classType;

    if (IF_OPENERS.has(classType)) {
      stack.push({ name: classType, kind: 'if' });
    } else if (LOOP_OPENERS.has(classType)) {
      stack.push({ name: classType, kind: 'loop' });
    } else if (CLOSERS.has(classType)) {
      const closer = CLOSERS.get(classType);
      const top = stack[stack.length - 1];
      // A closer only closes an opener of its own kind. MacroDroid forbids
      // crossing If/Loop boundaries, so an opener on top of the wrong kind is
      // left unclosed rather than silently matched.
      if (top && closer.openers.has(top.name)) {
        stack.pop();
      } else {
        errors.push({
          path: `macro.m_actionList[${i}]`,
          message:
            `macro.m_actionList has a ${classType} with no matching ` +
            `${closer.openerName}.`,
        });
      }
    }
  }

  // Report leftover openers innermost-first, matching the live message shape.
  for (let i = stack.length - 1; i >= 0; i--) {
    const opener = stack[i];
    const closerName = opener.kind === 'if' ? 'EndIfAction' : 'EndLoopAction';
    errors.push({
      path: 'macro.m_actionList',
      message: `macro.m_actionList has a ${opener.name} that is never closed with ${closerName}.`,
    });
  }
}

/**
 * Validate a MacroDroid macro export.
 * @param {object|string} input macro object, export wrapper, or JSON string
 * @returns {{ok: boolean, errors: Array<{path: string, message: string}>}}
 */
export function validateMacro(input) {
  const errors = [];

  const parsed = parseInput(input);
  if (parsed.error) return { ok: false, errors: [{ path: '', message: parsed.error }] };

  const root = classifyRoot(parsed.value);
  if (root.error) return { ok: false, errors: [{ path: '', message: root.error }] };

  const { macro, prefix } = root;

  for (const listName of LISTS) {
    checkClassTypes(macro, listName, prefix, errors);
  }

  checkControlFlow(macro, errors);

  return { ok: errors.length === 0, errors };
}

export default validateMacro;
