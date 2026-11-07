// js/app.js — main page: file picker, drag-drop, paste-XML, and the shared-inbox handoff.
// Vanilla ES module. No framework, no build step.
//
// M2: real source adapters wired in —
//   Tasker XML -> js/sources/tasker/taskerXml.js (full-fidelity IR, golden-tested)
//   AutoInput  -> js/sources/tasker/pluginAutoInput.js (plugin bundle -> touch ops)
//   Automate   -> js/sources/automate/floParser.js (T0 header inventory)
//   MacroDroid -> data/macrodroid/mappingTable.json (per-action conversion status)

import { classify, humanSize } from './sniff.js';
import * as idb from './idb.js';
import { parseTaskerXml } from './sources/tasker/taskerXml.js';
import { decodeAutoInput } from './sources/tasker/pluginAutoInput.js';
import { parseFloT0 } from './sources/automate/floParser.js';
import { emitMacros } from './targets/macrodroid/emitter.js';
import { validateMacro } from './targets/macrodroid/structuralValidator.js';

const $ = (sel) => document.querySelector(sel);
const out = $('#results');
const statusEl = $('#status');
const inboxEl = $('#inbox');
const fileInput = $('#file-input');
const drop = $('#drop');
const pasteBox = $('#paste');
const analyzeBtn = $('#analyze');

function log(line) {
  out.insertAdjacentText('beforeend', (out.textContent ? '\n' : '') + line);
}

function clearResults() { out.textContent = ''; }

function setStatus(msg, kind = '') {
  statusEl.textContent = msg;
  statusEl.dataset.kind = kind;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ------------------------------------------------------------------ */
/* MacroDroid mapping table (conversion status per Tasker action code) */
/* ------------------------------------------------------------------ */

let mappingTable = null;

/* Last Tasker IR parsed by renderTasker — exposed on window.autoport.lastIr
 * for the e2e suite (V4: golden equality across ingest paths). Test hook
 * only; nothing in the product reads it. */
let lastTaskerIr = null;
/* Last MacroDroid emission for that IR (e2e hook: {macros, reports}). */
let lastTaskerEmission = null;
async function loadMappingTable() {
  if (mappingTable) return mappingTable;
  try {
    const r = await fetch(new URL('../data/macrodroid/mappingTable.json', import.meta.url), { cache: 'force-cache' });
    mappingTable = await r.json();
  } catch (e) {
    console.warn('[autoport] mapping table unavailable', e);
    mappingTable = {};
  }
  return mappingTable;
}

function chip(kind, label) {
  return `<span class="chip ${escapeHtml(kind)}">${escapeHtml(label)}</span>`;
}

function mappingChip(code) {
  const m = mappingTable?.[String(code)];
  if (!m) return chip('unmapped', 'unmapped');
  if (m.status === 'exact') return chip('exact', `→ ${m.classType}`);
  if (m.status === 'partial') return chip('partial', `~ ${m.classType}`);
  if (m.status === 'manual') return chip('unmapped', 'manual');
  return chip('unmapped', 'unmapped');
}

/* ------------------------------------------------------------------ */
/* Tasker: full IR render                                             */
/* ------------------------------------------------------------------ */

async function renderTasker(name, buffer) {
  const text = new TextDecoder().decode(buffer);
  await loadMappingTable();
  // parseTaskerXml fills options.stats (it is never attached to the IR itself);
  // without this the status line reports "0 identified" and the
  // not-representable card never renders.
  const parseStats = {};
  // Pass the ingest name so the IR records the source basename (picker/drop/
  // share carry the real filename; the paste box reports 'pasted.xml').
  const ir = await parseTaskerXml(text, { stats: parseStats, file: name }); // never throws; errors come back in IR
  lastTaskerIr = ir;

  if (ir.error) {
    log(`   ✗ ${ir.error.kind}: ${ir.error.message}`);
    setStatus('Tasker XML rejected — see details above', 'warn');
    return;
  }

  const stats = parseStats;
  const cards = [];
  for (const macro of ir.macros || []) {
    const rows = [];
    for (const trig of macro.triggers || []) {
      rows.push(`<div class="row"><span class="pill">trigger</span> <code>${escapeHtml(trig.codeName || `code ${trig.code}`)}</code></div>`);
    }
    for (const act of macro.actions || []) {
      let main, extra = '';
      if (act.kind === 'builtin') {
        main = `<code>${escapeHtml(act.codeName || `code ${act.code}`)}</code> ${mappingChip(act.code)}`;
      } else if (act.kind === 'plugin') {
        // IR plugin actions carry flat fields (act.package / act.pluginClass);
        // decodeAutoInput accepts the action node itself (normalizeInput case 1).
        const pkg = act.package || '';
        if (pkg.toLowerCase().includes('autoinput')) {
          const d = decodeAutoInput(act);
          const sel = d.selector ? ` ${escapeHtml(JSON.stringify(d.selector))}` : '';
          extra = ` <code>${escapeHtml(d.op)}</code>${sel}`;
          main = chip('plugin', 'AutoInput') + extra;
        } else {
          main = chip('plugin', `plugin: ${escapeHtml(pkg || 'unknown')}`);
        }
      } else {
        main = chip('unmapped', `unknown (code ${escapeHtml(String(act.code ?? '?'))})`);
      }
      rows.push(`<div class="row"><span class="pill">action</span> ${main}</div>`);
    }
    const vars = macro.variables || {};
    const varNote = [
      vars.local?.length ? `${vars.local.length} local` : '',
      vars.global?.length ? `${vars.global.length} global` : '',
    ].filter(Boolean).join(', ');
    cards.push(`<article class="card">
      <h3>${escapeHtml(macro.name || '(unnamed)')}</h3>
      <p class="muted">${macro.triggers?.length || 0} trigger(s) · ${macro.actions?.length || 0} action(s)${varNote ? ` · ${escapeHtml(varNote)} vars` : ''}</p>
      ${rows.join('')}
    </article>`);
  }

  if (stats.unrepresentable?.length) {
    cards.push(`<article class="card"><h3>Not representable</h3><p class="muted">${stats.unrepresentable.map(escapeHtml).join('<br>')}</p></article>`);
  }

  // M3.1: emit MacroDroid macro JSON via plugin pass-through and render it.
  let lastEmission = null;
  try {
    lastEmission = emitMacros(ir);
    for (const { macro, report } of lastEmission.emissions || []) {
      if (report.error) {
        cards.push(`<article class="card"><h3>MacroDroid macro — plugin pass-through</h3>
          <p class="muted">⚠️ Macro emission failed: ${escapeHtml(report.error)}</p></article>`);
        continue;
      }
      if (!macro) {
        // Nothing emittable (e.g. every plugin action carries a Tasker
        // If-guard, or only builtin actions) — still surface WHY, with the
        // skipped list, instead of silently dropping the macro.
        if (report.skipped.length) {
          cards.push(`<article class="card">
            <h3>MacroDroid macro — plugin pass-through</h3>
            <p class="muted">0 plugin action(s) delegated — this macro produced no MacroDroid export yet.</p>
            <p class="muted small">Not converted yet (${report.skipped.length}): ${report.skipped.map((s) => escapeHtml(s.codeName || `code ${s.code}`)).join(', ')}</p>
          </article>`);
        }
        continue;
      }
      const verdict = validateMacro(macro);
      const skipped = report.skipped.length
        ? `<p class="muted small">Not converted yet (${report.skipped.length}): ${report.skipped.map((s) => escapeHtml(s.codeName || `code ${s.code}`)).join(', ')}</p>` : '';
      const unresolved = report.unresolvedVariables.length
        ? `<p class="muted small">⚠️ Tasker variables left literal (no MacroDroid equivalent declared): ${report.unresolvedVariables.map(escapeHtml).join(', ')}</p>` : '';
      const unknownPlugins = report.unknownPlugins.length
        ? `<p class="muted small">⚠️ Plugin not in the registry (receiver unknown — MacroDroid shows the action but cannot fire it until the plugin is picked there): ${report.unknownPlugins.map(escapeHtml).join(', ')}</p>` : '';
      const globalsNeeded = report.globalVariablesRequired.length
        ? `<p class="muted small">⚠️ Tasker global variable(s) referenced (${report.globalVariablesRequired.map(escapeHtml).join(', ')}) — MacroDroid does not create globals on import; create them in MacroDroid → Variables, otherwise the magic-text references stay unexpanded.</p>` : '';
      const rejectedLong = report.rejectedLongValues.length
        ? `<p class="muted small">⚠️ Plugin value(s) dropped (java.lang.Long is not representable in the locale-SDK bundle): ${report.rejectedLongValues.map((r) => escapeHtml(r.key)).join(', ')}</p>` : '';
      const rejectedUnsupported = report.rejectedUnsupportedValues.length
        ? `<p class="muted small">⚠️ Plugin value(s) dropped (type not representable in the locale-SDK bundle): ${report.rejectedUnsupportedValues.map((r) => `${escapeHtml(r.key)} (${escapeHtml(r.type)})`).join(', ')}</p>` : '';
      const jsonRisk = report.jsonEncodedTranslations.length
        ? `<p class="muted small">⚠️ JSON-encoded plugin value(s) contain translated variables (${report.jsonEncodedTranslations.map((k) => escapeHtml(k)).join(', ')}): Tasker JSON-escapes values here at runtime, MacroDroid does not — a value containing quotes, backslashes or newlines can break the plugin's JSON.</p>` : '';
      cards.push(`<article class="card">
        <h3>MacroDroid macro — plugin pass-through</h3>
        <p class="muted">${report.emitted.length} plugin action(s) delegated to their plugin apps · structural check: ${verdict.ok ? '<strong>valid</strong>' : `<strong>${verdict.errors.length} issue(s)</strong>`}</p>
        ${skipped}${unresolved}${unknownPlugins}${globalsNeeded}${rejectedLong}${rejectedUnsupported}${jsonRisk}
        <details><summary>Macro JSON (share into MacroDroid)</summary>
          <pre class="preview" tabindex="0">${escapeHtml(JSON.stringify(macro, null, 1))}</pre>
          <button class="btn primary" type="button" data-copy-macro>Copy macro JSON</button>
        </details>
      </article>`);
    }
  } catch (e) {
    console.warn('[autoport] macro emission failed', e);
  }
  lastTaskerEmission = lastEmission;

  out.insertAdjacentHTML('beforeend', cards.join('\n'));
  // wire the macro copy buttons (the cards were just inserted above)
  for (const btn of out.querySelectorAll('[data-copy-macro]')) {
    btn.addEventListener('click', async () => {
      try {
        const json = btn.parentElement.querySelector('pre').textContent;
        await navigator.clipboard.writeText(json);
        setStatus('Macro JSON copied — paste into MacroDroid (Add Macro → Import/Clipboard)', 'ok');
      } catch (e) {
        setStatus('Clipboard write failed — select the JSON and copy manually', 'warn');
      }
    });
  }
  const totalActions = (ir.macros || []).reduce((n, m) => n + (m.actions?.length || 0), 0);
  const decoded = (stats.actionsDecoded ?? 0) + (stats.actionsPlugin ?? 0);
  setStatus(`Tasker parsed: ${(ir.macros || []).length} macro(s), ${totalActions} action(s), ${decoded} identified${stats.actionsUnknown ? `, ${stats.actionsUnknown} unknown` : ''}`, 'ok');
}

/* ------------------------------------------------------------------ */
/* Automate .flo: T0 inventory                                        */
/* ------------------------------------------------------------------ */

function renderFlo(name, buffer) {
  const u8 = buffer instanceof Uint8Array ? u8 : new Uint8Array(buffer);
  const t0 = parseFloT0(u8); // never throws
  if (t0.error) {
    log(`   ✗ ${t0.error}`);
    setStatus('Automate flow rejected (truncated/malformed)', 'warn');
    return;
  }
  const strs = (t0.strings || []).slice(0, 8).map(escapeHtml);
  out.insertAdjacentHTML('beforeend', `<article class="card">
    <h3>${escapeHtml(name)}</h3>
    <p class="muted">Automate flow · v${t0.version} · ${t0.statementCount} statement(s) · ${t0.strings?.length || 0} strings</p>
    ${strs.length ? `<p class="muted">${strs.join('<br>')}</p>` : ''}
  </article>`);
  setStatus(`Automate flow: v${t0.version}, ${t0.statementCount} statements (T0 inventory)`, 'ok');
}

/* ------------------------------------------------------------------ */
/* One shared ingest path for picker + drop + paste                   */
/* ------------------------------------------------------------------ */

async function ingest(name, type, buffer, opts = {}) {
  const info = classify(buffer);
  const doomed = info.kind === 'empty';
  log('');
  log(`── ${name || '(pasted text)'}  [${humanSize(buffer.byteLength)}]`);
  log(`   reported MIME : ${type || '(empty string)'}   ← NEVER trust this`);
  log(`   sniffed       : ${info.kind} — ${info.label}`);
  log(`   implied MIME  : ${info.vendorMime}`);
  log(`   magic bytes   : ${info.detail.magic}`);
  if (info.detail.printableRatio != null) log(`   printable     : ${info.detail.printableRatio}`);

  if (doomed) {
    log('   ✗ empty payload — nothing to parse');
    setStatus('Empty file — did the share arrive without a body?', 'warn');
    return;
  }

  if (info.parser === 'tasker') {
    await renderTasker(name, buffer);
  } else if (info.kind === 'automate-flow') {
    renderFlo(name, buffer);
  } else if (info.kind === 'automate-pdf' || info.kind === 'png') {
    log('   i Image/PDF export: route to vision/manual mapping (not parsed here).');
    setStatus('Flow export image/PDF detected — manual/vision mapping', '');
  } else if (info.kind === 'taskernet-link') {
    log('   i TaskerNet link. Fetching it from the page will hit CORS; use the paste box.');
    setStatus('TaskerNet link detected — paste the XML instead', 'warn');
  } else {
    log(`   i No parser wired for "${info.kind}" yet.`);
    setStatus(`Recognized as ${info.label}, no adapter yet`, '');
  }

  if (opts.persist) {
    await idb.add({
      createdAt: Date.now(),
      source: opts.source || 'picker',
      name, type: type || '', size: buffer.byteLength,
      kind: info.kind, magic: info.magic, buf: buffer, title: '', text: ''
    });
    await refreshInbox();
  }
}

async function handleFiles(fileList) {
  clearResults();
  const files = [...fileList];
  if (!files.length) return;
  setStatus(`Reading ${files.length} file(s)…`);
  for (const f of files) {
    const buf = await f.arrayBuffer();
    await ingest(f.name, f.type, buf, { persist: true, source: 'picker' });
  }
}

/* ------------------------------------------------------------------ */
/* Wire-up                                                            */
/* ------------------------------------------------------------------ */

fileInput?.addEventListener('change', (e) => {
  handleFiles(e.target.files);
  e.target.value = ''; // allow re-picking the same file
});

if (drop) {
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => {
    stop(e); drop.classList.add('over');
  }));
  ['dragleave', 'dragend'].forEach((ev) => drop.addEventListener(ev, (e) => {
    stop(e); drop.classList.remove('over');
  }));
  drop.addEventListener('drop', (e) => {
    stop(e); drop.classList.remove('over');
    handleFiles(e.dataTransfer.files);
  });
  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
}

analyzeBtn?.addEventListener('click', async () => {
  const text = pasteBox.value;
  if (!text.trim()) { setStatus('Paste some XML first', 'warn'); return; }
  clearResults();
  const buf = new TextEncoder().encode(text).buffer;
  await ingest('pasted.xml', 'text/plain', buf, { persist: false });
});

// Paste directly onto the page (Ctrl/Cmd+V) also works when nothing is focused.
window.addEventListener('paste', (e) => {
  if (document.activeElement === pasteBox) return;
  const text = e.clipboardData?.getData('text');
  if (text && /<TaskerData|^\s*<\?xml/.test(text)) {
    pasteBox.value = text;
    setStatus('Clipboard XML dropped into the paste box — hit Analyze', '');
  }
});

/* ------------------------------------------------------------------ */
/* Shared inbox (populated by sw.js from the share sheet)             */
/* ------------------------------------------------------------------ */

async function refreshInbox() {
  if (!inboxEl) return;
  let items = [];
  try { items = await idb.getAll(); } catch (e) { console.warn(e); }
  inboxEl.replaceChildren();
  if (!items.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'Nothing shared yet. Share a .tsk.xml or .flo from another app and it lands here.';
    inboxEl.append(p);
    return;
  }
  for (const it of items.slice(0, 20)) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'inbox-row';
    card.innerHTML = `<span class="pill">${it.kind || '?'}</span>
      <span class="nm">${escapeHtml(it.name || it.title || '(shared text)')}</span>
      <span class="muted">${humanSize(it.size)}</span>`;
    card.addEventListener('click', async () => {
      clearResults();
      const buf = it.buf || (it.text ? new TextEncoder().encode(it.text).buffer : new ArrayBuffer(0));
      await ingest(it.name || '(shared item)', it.type, buf, { persist: false });
    });
    inboxEl.append(card);
  }
}

/* ------------------------------------------------------------------ */
/* Service worker + install plumbing                                  */
/* ------------------------------------------------------------------ */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register(new URL('../sw.js', import.meta.url));
      console.log('[autoport] SW registered', reg.scope);
      if (reg.waiting) setStatus('New version ready — reopen the app to update', '');
    } catch (e) {
      console.warn('[autoport] SW registration failed (needs https: or http://localhost)', e);
      setStatus('Service worker unavailable — file picker still works, share sheet will not', 'warn');
    }
  });
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'autoport:inbox-changed') refreshInbox();
    if (e.data?.type === 'autoport:sw-activated') refreshInbox();
  });
}

window.addEventListener('appinstalled', () => {
  setStatus('Installed. Share a file to AutoPort from any app to test the share sheet.', 'ok');
});

refreshInbox();

// ?from=<id> — "open in converter" handoff from share.html
const fromId = new URLSearchParams(location.search).get('from');
if (fromId) {
  idb.get(Number(fromId)).then(async (rec) => {
    if (!rec) return;
    const buf = rec.buf || (rec.text ? new TextEncoder().encode(rec.text).buffer : new ArrayBuffer(0));
    await ingest(rec.name || '(shared item)', rec.type, buf, { persist: false });
  });
}

// expose for manual console poking during the spike; lastIr/lastEmission are
// e2e hooks (V4 / M3.1)
window.autoport = {
  idb, ingest, classify, parseTaskerXml, parseFloT0, decodeAutoInput,
  emitMacros, validateMacro,
  get lastIr() { return lastTaskerIr; },
  get lastEmission() { return lastTaskerEmission; },
};
