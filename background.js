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
  const modePrefix = USE_CLOUD ? 'cloud|' : 'public|';
  const key = modePrefix + text + '||' + target;
  if (_inMemoryCache.has(key)) return _inMemoryCache.get(key);
  if (_persistentCache && _persistentCache[key] && _persistentCache[key].v) {
    const val = _persistentCache[key].v;
    _inMemoryCache.set(key, Promise.resolve(val));
    return val;
  }

  const p = (async () => {
    try {
      if (USE_CLOUD && GOOGLE_API_KEY) {
        const url = 'https://translation.googleapis.com/language/translate/v2?key=' + encodeURIComponent(GOOGLE_API_KEY) + '&q=' + encodeURIComponent(text) + '&target=' + encodeURIComponent(target) + '&format=text';
        const resp = await fetch(url, { method: 'GET' });
        if (!resp.ok) return '';
        const data = await resp.json();
        if (data && data.data && Array.isArray(data.data.translations) && data.data.translations[0]) {
          return data.data.translations[0].translatedText || '';
        }
        return '';
      } else {
        const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' + encodeURIComponent(target) + '&dt=t&q=' + encodeURIComponent(text);
        const resp = await fetch(url, { method: 'GET' });
        if (!resp.ok) return '';
        const data = await resp.json();
        if (Array.isArray(data) && Array.isArray(data[0])) {
          return data[0].map(p => p[0]).join('');
        }
        return '';
      }
    } catch (e) {
      return '';
    }
  })();

  _inMemoryCache.set(key, p);
  p.then(result => {
    if (result) {
      try {
        _persistentCache[key] = { v: result, t: Date.now() };
        scheduleSavePersistentCache();
      } catch (e) {}
    }
  }).catch(() => {});
  return p;
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

// initial load
loadSettingsAndCache();
