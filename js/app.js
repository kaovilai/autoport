// js/app.js — main page: file picker, drag-drop, paste-XML, and the shared-inbox handoff.
// Vanilla ES module. No framework, no build step.

import { classify, humanSize } from './sniff.js';
import * as idb from './idb.js';

const $ = (sel) => document.querySelector(sel);
const out = $('#results');
const statusEl = $('#status');
const inboxEl = $('#inbox');
const fileInput = $('#file-input');
const drop = $('#drop');
const pasteBox = $('#paste');
const analyzeBtn = $('#analyze');

function log(line) {
  out.textContent += (out.textContent ? '\n' : '') + line;
}

function clearResults() { out.textContent = ''; }

function setStatus(msg, kind = '') {
  statusEl.textContent = msg;
  statusEl.dataset.kind = kind;
}

/* ------------------------------------------------------------------ */
/* Tasker inventory (spike-level: proves the parse path works)        */
/* ------------------------------------------------------------------ */

const ACTION_HINTS = {
  339: 'HTTP Request', 129: 'JavaScriptlet', 548: 'Flash', 547: 'Set Variable',
  130: 'JavaScript', 30: 'Wait', 20: 'Notify', 183: 'Say', 235: 'Send Intent',
  294: 'Perform Task', 590: 'Wait Until', 341: 'Kill App', 877: 'Else If', 879: 'End If'
};

function inventoryTasker(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const parseError = doc.querySelector('parsererror');
  if (parseError) return { ok: false, error: parseError.textContent.slice(0, 300) };

  const root = doc.documentElement;
  const tasks = [...doc.querySelectorAll('Task')];
  const profiles = [...doc.querySelectorAll('Profile')];
  const scenes = [...doc.querySelectorAll('Scene')];
  const lines = [];
  lines.push(`root: <${root.nodeName}>  attrs: ${[...root.attributes].map(a => `${a.name}=${a.value}`).join(' ')}`);
  lines.push(`containers: Task=${tasks.length} Profile=${profiles.length} Scene=${scenes.length}`);

  for (const t of tasks) {
    const name = t.querySelector(':scope > nme')?.textContent ?? '(unnamed)';
    const id = t.querySelector(':scope > id')?.textContent ?? '?';
    const pri = t.querySelector(':scope > pri')?.textContent ?? '?';
    const actions = [...t.querySelectorAll(':scope > Action')];
    lines.push('');
    lines.push(`TASK id=${id} pri=${pri} name="${name}"  actions=${actions.length}`);
    let i = 0;
    for (const a of actions) {
      const code = a.querySelector(':scope > code')?.textContent ?? '?';
      const hint = ACTION_HINTS[code] ? ` (${ACTION_HINTS[code]})` : '';
      const args = [...a.children].filter(c => c.nodeName !== 'code' && c.nodeName !== 'ConditionList');
      const argDesc = args.map(c => {
        if (c.nodeName === 'Str') return `Str ${c.getAttribute('sr')}="${(c.textContent || '').slice(0, 60)}"`;
        if (c.nodeName === 'Int') return `Int ${c.getAttribute('sr')}=${c.getAttribute('val')}`;
        if (c.nodeName === 'Bundle') return `Bundle ${c.getAttribute('sr')}(${c.querySelectorAll('Vals > *').length} vals)`;
        return `${c.nodeName} ${c.getAttribute('sr') || ''}`;
      }).join(', ');
      lines.push(`  ${String(i++).padStart(2)}. code=${code}${hint}  ${argDesc}`);
    }
    const conds = [...t.querySelectorAll(':scope > Action > ConditionList')];
    if (conds.length) lines.push(`  condition lists: ${conds.length}`);
  }
  return { ok: true, text: lines.join('\n'), stats: { tasks: tasks.length, profiles: profiles.length, scenes: scenes.length } };
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
  log(`   magic bytes   : ${info.magic}`);
  if (info.detail.printableRatio != null) log(`   printable     : ${info.detail.printableRatio}`);

  if (doomed) {
    log('   ✗ empty payload — nothing to parse');
    setStatus('Empty file — did the share arrive without a body?', 'warn');
    return;
  }

  if (info.parser === 'tasker') {
    const text = new TextDecoder().decode(buffer);
    const inv = inventoryTasker(text);
    if (inv.ok) {
      log('   ✓ Tasker inventory:');
      for (const l of inv.text.split('\n')) log(`     ${l}`);
      setStatus(`Tasker export parsed: ${inv.stats.tasks} task(s), ${inv.stats.profiles} profile(s)`, 'ok');
    } else {
      log(`   ✗ XML parse error: ${inv.error}`);
      setStatus('Tasker XML did not parse', 'warn');
    }
  } else if (info.kind === 'automate-flow') {
    log('   ✓ Automate flow magic confirmed (LAFl). Decoder is a separate spike.');
    setStatus('Automate flow detected — T0 inventory path', 'ok');
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ------------------------------------------------------------------ */
/* Service worker + install plumbing                                  */
/* ------------------------------------------------------------------ */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
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

// expose for manual console poking during the spike
window.autoport = { idb, ingest, classify };
