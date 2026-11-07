// js/share.js — the post-share landing page (share_target 303 target).
// Reads IndexedDB written by sw.js and shows a file card.

import { classify, humanSize, hexHead } from './sniff.js';
import * as idb from './idb.js';

const listEl = $('#cards');
const bannerEl = $('#banner');
const emptyEl = $('#empty');

const params = new URLSearchParams(location.search);
const incoming = Number(params.get('n') || '0');
const err = params.get('err');

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function card(rec) {
  const el = document.createElement('article');
  el.className = 'card';

  const buf = rec.buf || (rec.text ? new TextEncoder().encode(rec.text).buffer : new ArrayBuffer(0));
  const oversized = rec.kind === 'too-large';
  const info = oversized
    ? { kind: 'too-large', label: 'Too large — not imported', vendorMime: rec.type || '', detail: { head: '' } }
    : classify(buf);
  const textPreview = rec.text
    ? rec.text.slice(0, 600)
    : (info.detail.head && /xml|json|text/.test(info.kind) ? info.detail.head.slice(0, 600) : '');

  el.innerHTML = `
    <header>
      <span class="pill">${escapeHtml(info.kind)}</span>
      <h2>${escapeHtml(rec.name || rec.title || '(shared text)')}</h2>
    </header>
    <dl class="facts">
      <dt>Reported MIME</dt><dd>${escapeHtml(rec.type || '(empty string)')}</dd>
      <dt>Sniffed</dt><dd>${escapeHtml(info.label)}</dd>
      <dt>Implied MIME</dt><dd><code>${escapeHtml(info.vendorMime)}</code></dd>
      <dt>Size</dt><dd>${humanSize(rec.size)}</dd>
      <dt>Magic</dt><dd><code>${escapeHtml(rec.magic || hexHead(new Uint8Array(buf).slice(0, 16)))}</code></dd>
      <dt>Received</dt><dd>${new Date(rec.createdAt || Date.now()).toLocaleString()}</dd>
      <dt>Source</dt><dd>${escapeHtml(rec.source || 'share')}</dd>
    </dl>
    ${textPreview ? `<pre class="preview">${escapeHtml(textPreview)}</pre>` : ''}
    <footer>
      ${oversized ? '' : `<a class="btn primary" href="/?from=${rec.id}">Open in converter</a>`}
      <button class="btn" data-del="${rec.id}" type="button">Delete</button>
    </footer>`;
  el.querySelector('[data-del]').addEventListener('click', async () => {
    await idb.remove(rec.id);
    el.remove();
    if (!listEl.children.length) emptyEl.hidden = false;
  });
  return el;
}

async function render() {
  let items = [];
  try { items = await idb.getAll(); } catch (e) { console.warn(e); }

  if (err === 'empty') {
    bannerEl.textContent = 'The share arrived with no file or text attached. The sending app reported an empty payload — try "share as file" from the file manager instead.';
    bannerEl.hidden = false;
  } else if (err === 'too-large') {
    bannerEl.textContent = 'That file is over the 25 MiB limit and was not imported. AutoPort only accepts automation exports — nothing that large can be one.';
    bannerEl.hidden = false;
  } else if (err === 'read') {
    bannerEl.textContent = 'The shared payload could not be read as a form body. See the console for details.';
    bannerEl.hidden = false;
  } else if (incoming > 0) {
    bannerEl.textContent = `Received ${incoming} item${incoming === 1 ? '' : 's'} from the share sheet.`;
    bannerEl.hidden = false;
  } else if (!items.length) {
    bannerEl.hidden = true;
  }

  listEl.replaceChildren(...items.map(card));
  emptyEl.hidden = items.length > 0;
}

$('#clear-all')?.addEventListener('click', async () => {
  await idb.clear();
  render();
});

render();
