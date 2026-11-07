// tests/js/xmlShim.mjs — minimal, strict XML parser for the Node test runner.
//
// Node has no DOMParser, so the Tasker parser is exercised against this shim.
// It produces the exact tree shape the walker consumes:
//     { tagName, attributes: {name: value}, children: [...], text: string|null }
// and mirrors the ElementTree behavior scripts/tasker_xml_ir.py relies on:
//   * comments / processing instructions are not nodes and do not end `.text`
//   * `.text` is the character data before the first element child
//   * a self-closing / empty element has text === null
//   * predefined + numeric entities are decoded; unknown entities are refused
//   * DOCTYPE / ENTITY declarations are refused (entity-expansion safety)
//   * malformed / truncated / multi-root documents throw an Error
//     with `.kind` = "parse" | "doctype".
//
// No dependencies, no build step.

const MAX_PROLOG = 8192;

function fail(message, kind = 'parse') {
  const e = new Error(message);
  e.kind = kind;
  throw e;
}

function decodeEntities(raw) {
  if (raw.indexOf('&') === -1) return raw;
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9._-]*);/g, (whole, body) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) fail(`invalid character reference ${whole}`);
      return String.fromCodePoint(cp);
    }
    switch (body) {
      case 'lt': return '<';
      case 'gt': return '>';
      case 'amp': return '&';
      case 'apos': return "'";
      case 'quot': return '"';
      default: return fail(`undefined entity &${body};`);
    }
  });
}

/**
 * @param {string} input XML text
 * @returns {{tagName: string, attributes: object, children: object[], text: string|null}}
 */
export function parseXml(input) {
  const s = String(input).replace(/^﻿/, '');
  let i = 0;
  const n = s.length;

  const head = s.slice(0, MAX_PROLOG);
  if (/<!doctype/i.test(head) || /<!entity/i.test(head)) {
    fail('refusing XML with DOCTYPE/ENTITY declaration', 'doctype');
  }

  const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
  const skipWs = () => { while (i < n && isWs(s[i])) i += 1; };

  function readName() {
    const start = i;
    while (i < n) {
      const c = s[i];
      if (isWs(c) || c === '/' || c === '>' || c === '=' || c === '<') break;
      i += 1;
    }
    if (i === start) fail(`expected a name at offset ${start}`);
    return s.slice(start, i);
  }

  function skipMisc() {
    // whitespace, comments and processing instructions outside the root
    for (;;) {
      skipWs();
      if (s.startsWith('<!--', i)) {
        const end = s.indexOf('-->', i + 4);
        if (end < 0) fail('unterminated comment');
        i = end + 3;
      } else if (s.startsWith('<?', i)) {
        const end = s.indexOf('?>', i + 2);
        if (end < 0) fail('unterminated processing instruction');
        i = end + 2;
      } else if (s.startsWith('<!', i)) {
        fail('unexpected markup declaration', 'doctype');
      } else {
        return;
      }
    }
  }

  function parseElement() {
    if (s[i] !== '<') fail(`expected '<' at offset ${i}`);
    i += 1;
    const tagName = readName();
    const attributes = Object.create(null);
    for (;;) {
      skipWs();
      if (i >= n) fail(`unexpected end of input inside <${tagName}>`);
      if (s[i] === '>') { i += 1; break; }
      if (s[i] === '/') {
        if (s[i + 1] !== '>') fail(`malformed self-closing tag <${tagName}>`);
        i += 2;
        return { tagName, attributes, children: [], text: null };
      }
      if (s[i] === '<') fail(`malformed start tag <${tagName}>`);
      const attrName = readName();
      skipWs();
      if (s[i] !== '=') fail(`expected '=' after attribute ${attrName}`);
      i += 1;
      skipWs();
      const quote = s[i];
      if (quote !== '"' && quote !== "'") fail(`unquoted attribute value for ${attrName}`);
      i += 1;
      const endQuote = s.indexOf(quote, i);
      if (endQuote < 0) fail(`unterminated attribute value for ${attrName}`);
      if (Object.prototype.hasOwnProperty.call(attributes, attrName)) fail(`duplicate attribute ${attrName}`);
      attributes[attrName] = decodeEntities(s.slice(i, endQuote));
      i = endQuote + 1;
    }

    const node = { tagName, attributes, children: [], text: null };
    let textParts = null;
    let beforeFirstChild = true;

    for (;;) {
      if (i >= n) fail(`unexpected end of input: unclosed <${tagName}>`);
      if (s[i] !== '<') {
        const start = i;
        while (i < n && s[i] !== '<') i += 1;
        if (beforeFirstChild) (textParts || (textParts = [])).push(decodeEntities(s.slice(start, i)));
        continue;
      }
      if (s.startsWith('<!--', i)) {
        const end = s.indexOf('-->', i + 4);
        if (end < 0) fail('unterminated comment');
        i = end + 3;
        continue;
      }
      if (s.startsWith('<![CDATA[', i)) {
        const end = s.indexOf(']]>', i + 9);
        if (end < 0) fail('unterminated CDATA section');
        if (beforeFirstChild) (textParts || (textParts = [])).push(s.slice(i + 9, end));
        i = end + 3;
        continue;
      }
      if (s.startsWith('<?', i)) {
        const end = s.indexOf('?>', i + 2);
        if (end < 0) fail('unterminated processing instruction');
        i = end + 2;
        continue;
      }
      if (s.startsWith('<!', i)) fail('unexpected markup declaration', 'doctype');
      if (s.startsWith('</', i)) {
        i += 2;
        const closeName = readName();
        if (closeName !== tagName) fail(`mismatched closing tag </${closeName}>, expected </${tagName}>`);
        skipWs();
        if (s[i] !== '>') fail(`malformed closing tag </${closeName}>`);
        i += 1;
        if (textParts) node.text = textParts.join('');
        return node;
      }
      node.children.push(parseElement());
      beforeFirstChild = false;
    }
  }

  skipMisc();
  if (i >= n) fail('empty document: no root element');
  const root = parseElement();
  skipMisc();
  if (i < n) fail(`unexpected content after root element at offset ${i}`);

  // XML allows leading BOM/whitespace before the declaration; the caller strips
  // the BOM, but tolerate a UTF-8 BOM here too.
  return root;
}

export default parseXml;
