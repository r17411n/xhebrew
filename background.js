// Background service worker: perform translations and persist cache. Runs in MV3 background context.

let _inMemoryCache = new Map(); // key -> Promise<string>
let _persistentCache = {}; // key -> { v: string, t: timestamp }
let _saveTimer = null;
let MAX_PERSIST_ENTRIES = 1000;
let CACHE_TTL_DAYS = 30;
let USE_CLOUD = false;
let GOOGLE_API_KEY = '';

async function loadSettingsAndCache() {
  try {
    const res = await browser.storage.local.get(['translationCache','cacheMaxEntries','cacheTTLDays','useCloudTranslate','googleApiKey']);
    if (typeof res.cacheMaxEntries === 'number') MAX_PERSIST_ENTRIES = res.cacheMaxEntries;
    if (typeof res.cacheTTLDays === 'number') CACHE_TTL_DAYS = res.cacheTTLDays;
    USE_CLOUD = !!res.useCloudTranslate;
    GOOGLE_API_KEY = res.googleApiKey || '';
    const raw = res.translationCache || {};
    const now = Date.now();
    _persistentCache = {};
    _inMemoryCache = new Map();
    for (const k of Object.keys(raw)) {
      const entry = raw[k];
      if (!entry) continue;
      let value, ts;
      if (typeof entry === 'string') { value = entry; ts = now; }
      else if (entry && typeof entry === 'object' && entry.v) { value = entry.v; ts = entry.t || now; }
      else continue;
      if (CACHE_TTL_DAYS > 0) {
        const age = now - ts;
        if (age > (CACHE_TTL_DAYS * 24 * 60 * 60 * 1000)) continue; // expired
      }
      _persistentCache[k] = { v: value, t: ts };
      _inMemoryCache.set(k, Promise.resolve(value));
    }
  } catch (e) {
    _persistentCache = {};
    _inMemoryCache = new Map();
  }
}

function scheduleSavePersistentCache() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(async () => {
    _saveTimer = null;
    try {
      const obj = {};
      let count = 0;
      const now = Date.now();
      for (const [k, vPromise] of _inMemoryCache.entries()) {
        if (count >= MAX_PERSIST_ENTRIES) break;
        try {
          const val = await Promise.resolve(vPromise);
          if (val) {
            obj[k] = { v: val, t: now };
            count++;
          }
        } catch (e) {}
      }
      await browser.storage.local.set({ translationCache: obj });
      _persistentCache = obj;
    } catch (e) {
      // ignore
    }
  }, 2000);
}

async function doTranslate(text, target) {
  if (!text || !target) return '';
  // Build a key that includes current mode so cache is separate per endpoint
  const modePrefix = USE_CLOUD ? 'cloud|' : 'public|';
  const key = modePrefix + text + '||' + target;
  if (_inMemoryCache.has(key)) return _inMemoryCache.get(key);
  if (_persistentCache && _persistentCache[key] && _persistentCache[key].v) {
    const val = _persistentCache[key].v;
    _inMemoryCache.set(key, Promise.resolve(val));
    return val;
  }

  // Not cached: queue for batched translation
  return queueTranslationRequest(key, text, target);
}

// Batching setup: pendingRequests maps key -> { text, target, resolvers: [resolveFunc,...] }
const pendingRequests = new Map();
let pendingFlushTimer = null;
const BATCH_DEBOUNCE_MS = 120; // short window to aggregate requests

function queueTranslationRequest(key, text, target) {
  return new Promise((resolve) => {
    if (pendingRequests.has(key)) {
      pendingRequests.get(key).resolvers.push(resolve);
    } else {
      pendingRequests.set(key, { text, target, resolvers: [resolve] });
    }
    schedulePendingFlush();
  });
}

function schedulePendingFlush() {
  if (pendingFlushTimer) return;
  pendingFlushTimer = setTimeout(() => {
    pendingFlushTimer = null;
    flushPendingRequests();
  }, BATCH_DEBOUNCE_MS);
}

async function flushPendingRequests() {
  if (pendingRequests.size === 0) return;
  // Group pending requests by target language to allow batching per target
  const byTarget = new Map();
  for (const [key, entry] of pendingRequests.entries()) {
    const t = entry.target || 'en';
    if (!byTarget.has(t)) byTarget.set(t, []);
    byTarget.get(t).push({ key, text: entry.text, resolvers: entry.resolvers });
  }

  const now = Date.now();
  // Clear pendingRequests map now to allow new incoming requests to be queued
  pendingRequests.clear();

  for (const [target, items] of byTarget.entries()) {
    // dedupe by text/key
    const unique = [];
    const seen = new Set();
    for (const it of items) {
      if (!seen.has(it.key)) {
        seen.add(it.key);
        unique.push(it);
      }
    }

    // For any unique item, check persistent cache again (in case it was saved meanwhile)
    const toTranslate = [];
    const translateIndex = []; // maps index in toTranslate -> key
    for (const it of unique) {
      if (_inMemoryCache.has(it.key)) continue;
      if (_persistentCache && _persistentCache[it.key] && _persistentCache[it.key].v) {
        const v = _persistentCache[it.key].v;
        _inMemoryCache.set(it.key, Promise.resolve(v));
        continue;
      }
      toTranslate.push(it.text);
      translateIndex.push(it.key);
    }

    let results = [];
    if (toTranslate.length > 0) {
      try {
        if (USE_CLOUD && GOOGLE_API_KEY) {
          // Cloud Translate v2 supports multiple q parameters
          const params = new URLSearchParams();
          for (const q of toTranslate) params.append('q', q);
          params.append('target', target);
          params.append('format', 'text');
          const url = 'https://translation.googleapis.com/language/translate/v2?key=' + encodeURIComponent(GOOGLE_API_KEY) + '&' + params.toString();
          const resp = await fetch(url, { method: 'GET' });
          if (resp.ok) {
            const data = await resp.json();
            if (data && data.data && Array.isArray(data.data.translations)) {
              results = data.data.translations.map(t => t.translatedText || '');
            }
          }
        } else {
          // Public translate_a endpoint: multiple q params and single tl
          const base = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dt=t&tl=' + encodeURIComponent(target);
          const qs = toTranslate.map(t => '&q=' + encodeURIComponent(t)).join('');
          const url = base + qs;
          const resp = await fetch(url, { method: 'GET' });
          if (resp.ok) {
            const data = await resp.json();
            // data[0] should be an array of per-input arrays when multiple q provided
            if (Array.isArray(data) && Array.isArray(data[0])) {
              // If data[0][i] exists and is array of segments
              if (Array.isArray(data[0][0]) && data[0].length === toTranslate.length) {
                results = data[0].map(segArr => segArr.map(p => p[0]).join(''));
              } else {
                // Fallback: join first-level segments
                results = [data[0].map(p => p[0]).join('')];
              }
            }
          }
        }
      } catch (e) {
        // network error: leave results empty
      }
    }

    // Assign translations to caches and resolve resolvers
    // For items that were not translated (missing in results), resolve with empty string
    for (let i = 0; i < unique.length; i++) {
      const key = unique[i].key;
      let translated = '';
      const idx = translateIndex.indexOf(key);
      if (idx >= 0 && results[idx] !== undefined) translated = results[idx];
      // If translation was not in results but in-memory cache exists, use it
      if (!translated && _inMemoryCache.has(key)) {
        try { translated = await Promise.resolve(_inMemoryCache.get(key)); } catch (e) { translated = ''; }
      }
      // set caches
      if (translated) {
        _inMemoryCache.set(key, Promise.resolve(translated));
        try { _persistentCache[key] = { v: translated, t: now }; } catch (e) {}
      }
      // resolve all resolvers for this key (find original entry in items)
      for (const it of items) {
        if (it.key === key) {
          for (const r of it.resolvers) {
            try { r(translated); } catch (e) {}
          }
        }
      }
    }

    // Save persistent cache (debounced)
    scheduleSavePersistentCache();
  }

}

async function openPage() {
    browser.tabs.create({
        url: 'option.html'
    });
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'translate') {
    return doTranslate(msg.text, msg.target).then(translated => ({ translated }));
  }
  if (msg.type === 'clearCache') {
    _inMemoryCache = new Map();
    _persistentCache = {};
    return browser.storage.local.remove('translationCache').then(() => ({ ok: true }));
  }
  if (msg.type === 'purgeExpired') {
    // purge expired entries according to current TTL
    const now = Date.now();
    const ttlMs = CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const k of Object.keys(_persistentCache)) {
      const entry = _persistentCache[k];
      const ts = (entry && entry.t) ? entry.t : now;
      if (CACHE_TTL_DAYS > 0 && (now - ts) > ttlMs) { delete _persistentCache[k]; removed++; }
    }
    // persist
    return browser.storage.local.set({ translationCache: _persistentCache }).then(() => ({ removed }));
  }
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  let reload = false;
  if (changes.translationCache) {
    reload = true;
  }
  if (changes.cacheMaxEntries) {
    const v = changes.cacheMaxEntries.newValue;
    if (typeof v === 'number') MAX_PERSIST_ENTRIES = v;
  }
  if (changes.cacheTTLDays) {
    const v = changes.cacheTTLDays.newValue;
    if (typeof v === 'number') CACHE_TTL_DAYS = v;
  }
  if (changes.useCloudTranslate) {
    USE_CLOUD = !!changes.useCloudTranslate.newValue;
  }
  if (changes.googleApiKey) {
    GOOGLE_API_KEY = changes.googleApiKey.newValue || '';
  }
  if (reload) {
    // reload persistent cache
    loadSettingsAndCache();
  }
});

browser.browserAction.onClicked.addListener(() => {
    openPage();
});

// ...existing code...
browser.runtime.onMessage.addListener((msg, sender) => {
  console.log('background received message', msg && msg.type, 'from tab', sender && sender.tab && sender.tab.id);
  // ...existing code...
});
// Initial load
loadSettingsAndCache();