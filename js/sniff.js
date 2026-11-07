// js/sniff.js — classify a shared file by CONTENT, never by the reported MIME type.
//
// Why: Chrome matches share_target `accept` on the MIME type the *sharing app* reports,
// and that value is routinely '' (empty) or 'application/octet-stream' on Android.
// See share-target-facts.md. Everything downstream (parser dispatch) keys off this module.

const enc = new TextDecoder('utf-8', { fatal: false });

function asciiAt(u8, offset, s) {
  if (u8.length < offset + s.length) return false;
  for (let i = 0; i < s.length; i++) if (u8[offset + i] !== s.charCodeAt(i)) return false;
  return true;
}

export function hexHead(u8, n = 16) {
  const out = [];
  for (let i = 0; i < Math.min(n, u8.length); i++) out.push(u8[i].toString(16).padStart(2, '0'));
  return out.join(' ');
}

/**
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {{kind:string, label:string, vendorMime:string, parser:string|null, detail:object}}
 */
export function classify(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  const detail = { size: u8.length, magic: hexHead(u8, 16) };
  const mk = (kind, label, vendorMime, parser) => ({ kind, label, vendorMime, parser, detail });

  if (u8.length === 0) return mk('empty', 'Empty file', 'application/x-empty', null);

  // Automate (llamalab) binary flow: magic "LAFl" then a zlib/deflate body.
  if (asciiAt(u8, 0, 'LAFl')) {
    return mk('automate-flow', 'Automate flow (.flo)', 'application/vnd.com.llamalab.automate.flow', 'automate');
  }
  if (asciiAt(u8, 0, '%PDF')) return mk('pdf', 'PDF export (Automate flow print)', 'application/pdf', 'automate-pdf');
  if (u8[0] === 0x89 && asciiAt(u8, 1, 'PNG')) {
    return mk('png', 'PNG image (flow screenshot or flowchart)', 'image/png', 'automate-png');
  }
  if (asciiAt(u8, 0, 'PK\x03\x04')) return mk('zip', 'ZIP/JAR archive — not a flow', 'application/zip', null);
  if (u8[0] === 0x1f && u8[1] === 0x8b) return mk('gzip', 'gzip archive — not a flow', 'application/gzip', null);

  // Text-ish: skip BOM + whitespace, then look at the first significant byte.
  let i = 0;
  if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) i = 3;
  while (i < u8.length && (u8[i] === 0x20 || u8[i] === 0x09 || u8[i] === 0x0a || u8[i] === 0x0d)) i++;

  const textHead = enc.decode(u8.slice(0, Math.min(u8.length, 8192)));
  detail.head = textHead.slice(0, 400);

  if (u8[i] === 0x3c /* '<' */) {
    if (/<TaskerData\b/.test(textHead)) {
      const root = /<TaskerData[^>]*>/.exec(textHead);
      detail.rootTag = root ? root[0] : '';
      return mk('tasker-xml', 'Tasker export (.xml)', 'application/xml', 'tasker');
    }
    if (/<[\w:.-]+\s+xmlns=["']http:\/\/tasker/i.test(textHead)) {
      return mk('tasker-xml', 'Tasker export (.xml)', 'application/xml', 'tasker');
    }
    if (/^\s*<\?xml/.test(textHead)) return mk('xml', 'XML (unrecognized root element)', 'application/xml', null);
    if (/<html|<!doctype html/i.test(textHead)) return mk('html', 'HTML document', 'text/html', null);
    return mk('xml', 'XML-ish text', 'application/xml', null);
  }

  if (u8[i] === 0x7b /* '{' */ || u8[i] === 0x5b /* '[' */) {
    try {
      const parsed = JSON.parse(textHead.length === u8.length ? textHead : enc.decode(u8));
      detail.jsonKeys = parsed && typeof parsed === 'object' ? Object.keys(parsed).slice(0, 20) : [];
      if (detail.jsonKeys.includes('macros') || detail.jsonKeys.includes('macro')) {
        return mk('macrodroid-json', 'MacroDroid macro JSON', 'application/json', 'macrodroid');
      }
      return mk('json', 'JSON document', 'application/json', null);
    } catch {
      return mk('json-invalid', 'JSON-ish text (does not parse)', 'application/json', null);
    }
  }

  if (/taskernet\.com\/shares\//i.test(textHead)) return mk('taskernet-link', 'TaskerNet share link', 'text/plain', 'taskernet');

  // Last resort: printable-ratio heuristic.
  let printable = 0;
  const sample = u8.slice(0, 1024);
  for (const b of sample) if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127)) printable++;
  const ratio = sample.length ? printable / sample.length : 0;
  detail.printableRatio = Number(ratio.toFixed(3));
  if (ratio > 0.95) return mk('text', 'Plain text', 'text/plain', null);
  return mk('binary', 'Unknown binary', 'application/octet-stream', null);
}

export function humanSize(n) {
  if (n == null) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1048576).toFixed(2)} MiB`;
}
