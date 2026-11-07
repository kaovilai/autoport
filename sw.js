/* AutoPort service worker — classic (non-module) worker.
 *
 * Two jobs:
 *   1. App-shell cache so the converter works offline after first load (V5 in the design doc).
 *   2. Intercept the share_target POST to /share, pull the shared file/text out of the
 *      multipart body, stash it in IndexedDB, and 303-redirect the navigation to /share.html.
 *
 * Kept as a classic script on purpose: module service workers (import in sw.js) are Chrome 91+,
 * but classic workers have the widest Android WebView/Samsung Internet coverage, and this file
 * deliberately has zero imports so it can also be syntax-checked with `node --check`.
 *
 * GOTCHA baked in: a share POST arrives as a *navigation* request. If you don't respondWith()
 * synchronously in the fetch listener, Chrome lets the POST hit the network and the server
 * answers 405 (python3 -m http.server answers 501) — the user sees an error page, no app.
 */

const VERSION = 'v3';
/* Base path derived from the SW scope, so the app works when hosted at a subpath
 * (e.g. GitHub Pages project site https://host/autoport/). Scope always ends in '/'. */
const BASE = new URL(self.registration.scope).pathname;
const CACHE_SHELL = `autoport-shell-${VERSION}`;
const CACHE_RUNTIME = `autoport-runtime-${VERSION}`;

/* Shell entries are written relative to the scope and resolved to absolute URLs below. */
const SHELL = [
  './',
  '/index.html',
  '/share.html',
  '/404.html',
  '/styles.css',
  '/js/app.js',
  '/js/share.js',
  '/js/idb.js',
  '/js/sniff.js',
  '/js/sources/tasker/taskerXml.js',
  '/js/sources/tasker/actionCodes.js',
  '/js/sources/tasker/pluginAutoInput.js',
  '/js/sources/automate/floParser.js',
  '/js/targets/macrodroid/structuralValidator.js',
  '/js/targets/macrodroid/classTypes.js',
  '/data/taskerCodes.json',
  '/data/macrodroid/mappingTable.json',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png'
].map((p) => new URL(p.replace(/^\//, ''), self.registration.scope).href);

const DB_NAME = 'autoport';
const DB_VERSION = 1;
const STORE_INBOX = 'inbox';

// octet-stream is in `accept`, so AutoPort is a share target for ANY file the OS can't type.
// A stray 200 MB video must not be buffered into IndexedDB: cap it and reject friendly.
// Real inputs are tiny — our real Automate .flo is 1.6 KB, a Tasker task XML ~1 KB.
const MAX_SHARE_BYTES = 25 * 1024 * 1024;

/* ------------------------------------------------------------------ *
 * IndexedDB (vanilla, structured-clone values — ArrayBuffer round-trips)
 * ------------------------------------------------------------------ */

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_INBOX)) {
        const store = db.createObjectStore(STORE_INBOX, { keyPath: 'id', autoIncrement: true });
        store.createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB open blocked by another tab'));
  });
}

async function idbAdd(record) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_INBOX, 'readwrite');
      const req = tx.objectStore(STORE_INBOX).add(record);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    });
  } finally {
    db.close();
  }
}

/* ------------------------------------------------------------------ *
 * Magic-byte sniffing (deliberately minimal here — the page's js/sniff.js
 * does the richer, human-facing classification; this copy only needs
 * "is it plausible?" so we can label the inbox row before the page loads)
 * ------------------------------------------------------------------ */

function sniffKind(u8) {
  if (!u8 || u8.length < 4) return 'empty';
  const b = u8;
  const ascii = (o, s) => {
    if (b.length < o + s.length) return false;
    for (let i = 0; i < s.length; i++) if (b[o + i] !== s.charCodeAt(i)) return false;
    return true;
  };
  if (ascii(0, 'LAFl')) return 'automate-flow';             // Automate .flo
  if (ascii(0, '%PDF')) return 'pdf';                        // Automate PDF export
  if (b[0] === 0x89 && ascii(1, 'PNG')) return 'png';        // screenshot export
  if (b[0] === 0x50 && b[1] === 0x4b) return 'zip';          // jar/zip (Tasker factory backup?)
  if (b[0] === 0x1f && b[1] === 0x8b) return 'gzip';
  // XML: allow UTF-8 BOM + leading whitespace before '<'
  let i = 0;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) i = 3;
  while (i < b.length && (b[i] === 0x20 || b[i] === 0x09 || b[i] === 0x0a || b[i] === 0x0d)) i++;
  if (b[i] === 0x3c /* '<' */) {
    return ascii(i, '<TaskerData') ? 'tasker-xml' : 'xml';
  }
  if (b[i] === 0x7b /* '{' */ || b[i] === 0x5b /* '[' */) return 'json?';
  return 'unknown';
}

function hexHead(u8, n) {
  const out = [];
  for (let i = 0; i < Math.min(n, u8.length); i++) out.push(u8[i].toString(16).padStart(2, '0'));
  return out.join(' ');
}

/* ------------------------------------------------------------------ *
 * Share handler
 * ------------------------------------------------------------------ */

async function notifyClients(payload) {
  try {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) c.postMessage(payload);
  } catch (_) { /* no clients is normal */ }
}

async function readForm(req) {
  // Chrome/Android always supports Request.formData() in a SW. The text fallback keeps
  // older engines from hard-failing (they'd land on ?err=read instead of a blank page).
  if (typeof req.formData === 'function') {
    return await req.formData();
  }
  const body = await req.text();
  const fd = new FormData();
  fd.set('_raw', body);
  return fd;
}

async function handleShare(req) {
  let stored = 0;
  let err = '';
  try {
    const form = await readForm(req);
    const title = (form.get('title') || '').toString();
    const text = (form.get('text') || '').toString();

    // Walk every entry instead of only form.get('share'): Chrome assigns a shared file to the
    // FIRST files[] entry whose accept matches, and some file managers submit an unnamed/multiple
    // field. Collecting all File values is strictly more robust.
    const files = [];
    for (const [field, value] of form.entries()) {
      if (typeof File !== 'undefined' && value instanceof File) {
        files.push({ field, file: value });
      }
    }
    // Defensive: some engines hand back Blob for form parts.
    if (!files.length) {
      for (const [field, value] of form.entries()) {
        if (value && typeof value.arrayBuffer === 'function' && typeof value !== 'string') {
          files.push({ field, file: value });
        }
      }
    }

    for (const { field, file } of files) {
      // Size check BEFORE arrayBuffer(): never buffer something absurd just to reject it.
      if (file.size > MAX_SHARE_BYTES) {
        await idbAdd({
          createdAt: Date.now(), source: 'share', field,
          name: file.name || '', type: file.type || '', size: file.size,
          kind: 'too-large', magic: '', buf: null, title, text
        });
        err = 'too-large';
        stored++;
        continue;
      }
      const buf = await file.arrayBuffer();
      const head = new Uint8Array(buf.slice(0, 64));
      // GOTCHA: file.type is very often '' (empty) when shared from a file manager, and
      // 'application/octet-stream' from others. Never trust it — sniff bytes instead.
      const rec = {
        createdAt: Date.now(),
        source: 'share',
        field,
        name: file.name || '',
        type: file.type || '',
        size: file.size != null ? file.size : buf.byteLength,
        kind: sniffKind(head),
        magic: hexHead(head, 16),
        buf,
        title,
        text
      };
      await idbAdd(rec);
      stored++;
    }

    if (!stored && (text || title)) {
      await idbAdd({
        createdAt: Date.now(),
        source: 'share',
        name: '',
        type: 'text/plain',
        size: text.length,
        kind: text.includes('taskernet.com') ? 'taskernet-link' : 'text',
        magic: '',
        buf: null,
        title,
        text
      });
      stored++;
    }
    if (!stored) err = 'empty';
  } catch (e) {
    err = 'read';
    console.error('[autoport] share handling failed', e);
  }

  await notifyClients({ type: 'autoport:inbox-changed', stored });

  // 303 (not 307/308!): the POST must not be replayed on refresh or back-navigation.
  const target = new URL('share.html', self.registration.scope);
  target.searchParams.set('n', String(stored));
  if (err) target.searchParams.set('err', err);
  return Response.redirect(target.href, 303);
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_SHELL);
    // addAll() is atomic — one 404 kills the whole install and the SW never activates.
    // Cache entries individually so a missing optional asset degrades instead of bricking.
    await Promise.all(SHELL.map(async (url) => {
      try {
        const res = await fetch(new Request(url, { cache: 'reload' }));
        if (res.ok || (res.type === 'opaqueredirect')) await cache.put(url, res.clone());
        else console.warn('[autoport] precache skip', url, res.status);
      } catch (e) {
        console.warn('[autoport] precache failed', url, e && e.message);
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([CACHE_SHELL, CACHE_RUNTIME]);
    const names = await caches.keys();
    await Promise.all(names.map((n) => (keep.has(n) ? null : caches.delete(n))));
    await self.clients.claim();
    await notifyClients({ type: 'autoport:sw-activated', version: VERSION });
  })());
});

/* ------------------------------------------------------------------ *
 * Fetch routing
 * ------------------------------------------------------------------ */

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  let hit = await cache.match(req, { ignoreSearch: true });
  if (!hit) {
    // Known Chromium quirk: a navigation Request can fail to match a cache entry whose stored
    // response carries a Vary header. Retry by path so the app shell still loads offline.
    hit = await cache.match(new URL(req.url).pathname, { ignoreSearch: true }) ||
          await cache.match(req.url, { ignoreSearch: true });
  }
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE_RUNTIME);
  const hit = await cache.match(req, { ignoreSearch: true });
  const network = fetch(req).then((res) => {
    if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  return hit || (await network) || new Response('offline', { status: 503, statusText: 'Offline' });
}

const SHELL_PATHS = new Set(SHELL.map((u) => new URL(u).pathname));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // --- share target ---------------------------------------------------
  if (req.method === 'POST' && url.pathname === BASE + 'share') {
    // respondWith MUST be called synchronously here (see file header).
    event.respondWith(handleShare(req));
    return;
  }
  // A GET /share (bookmark, GET-form fallback, or a manual open) lands on the inbox UI.
  if (req.method === 'GET' && url.pathname === BASE + 'share') {
    event.respondWith(Response.redirect(new URL('share.html', self.registration.scope).href, 302));
    return;
  }

  if (req.method !== 'GET') return;                       // never cache mutations
  if (url.origin !== self.location.origin) return;        // cross-origin: straight to network

  const isNavigation = req.mode === 'navigate';
  const path = url.pathname;

  if (isNavigation) {
    event.respondWith((async () => {
      try {
        return await cacheFirst(req, CACHE_SHELL);
      } catch (e) {
        const cache = await caches.open(CACHE_SHELL);
        // Unknown deep link offline → app shell, so the SPA can route it.
        return (await cache.match(new URL('index.html', self.registration.scope).href)) ||
               (await cache.match(new URL('404.html', self.registration.scope).href)) ||
               new Response('offline', { status: 503 });
      }
    })());
    return;
  }

  if (SHELL_PATHS.has(path)) {
    event.respondWith(cacheFirst(req, CACHE_SHELL));
    return;
  }

  event.respondWith(staleWhileRevalidate(req));
});
