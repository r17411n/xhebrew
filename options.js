// Options page script for xhebrew extension
(function () {
  const DEFAULTS = [
    { find: "Twitter", replace: "X (Twitter)" },
    { find: "hello", replace: "שלום" }
  ];

  function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    for (const c of children) {
      if (typeof c === 'string') e.appendChild(document.createTextNode(c));
      else if (c) e.appendChild(c);
    }
    return e;
  }

  function createRow(mapping) {
    const row = el('div', { class: 'row' });
    const find = el('input', { type: 'text', value: mapping.find || '', placeholder: 'find' });
    const replace = el('input', { type: 'text', value: mapping.replace || '', placeholder: 'replace' });
    const del = el('button', {}, 'Remove');
    del.addEventListener('click', () => row.remove());
    row.appendChild(find);
    row.appendChild(replace);
    row.appendChild(del);
    return row;
  }

  async function load() {
    try {
      const res = await browser.storage.local.get(['mappings','translateEnabled','translateTarget','translateReplace','cacheMaxEntries','cacheTTLDays','translationCache','useCloudTranslate','googleApiKey']);
      const mappings = (res && Array.isArray(res.mappings) && res.mappings.length) ? res.mappings : DEFAULTS;
      const translateEnabled = !!res.translateEnabled;
      const translateTarget = (res.translateTarget || 'en');
      const translateReplace = (res.translateReplace === undefined) ? true : !!res.translateReplace;
      const cacheMaxEntries = (typeof res.cacheMaxEntries === 'number') ? res.cacheMaxEntries : 1000;
      const cacheTTLDays = (typeof res.cacheTTLDays === 'number') ? res.cacheTTLDays : 30;
      const useCloudTranslate = !!res.useCloudTranslate;
      const googleApiKey = (res.googleApiKey || '');
      const list = document.getElementById('list');
      list.innerHTML = '';
      for (const m of mappings) list.appendChild(createRow(m));
      document.getElementById('translateEnabled').checked = translateEnabled;
      document.getElementById('translateTarget').value = translateTarget;
      document.getElementById('translateReplace').checked = translateReplace;
      document.getElementById('cacheMaxEntries').value = cacheMaxEntries;
      document.getElementById('cacheTTLDays').value = cacheTTLDays;

      // show cache stats
      const cacheObj = res.translationCache || {};
      const keys = Object.keys(cacheObj);
      let bytes = 0;
      for (const k of keys) {
        const v = cacheObj[k];
        if (v && typeof v === 'object' && v.v) bytes += (v.v.length || 0);
        else if (typeof v === 'string') bytes += v.length;
      }
      const stats = `${keys.length} entries — approx ${Math.round(bytes/1024)} KB`;
      const statsEl = document.getElementById('cacheStats');
      if (statsEl) statsEl.textContent = 'Cache: ' + stats;
      // cloud translate settings
      document.getElementById('useCloudTranslate').checked = useCloudTranslate;
      document.getElementById('googleApiKey').value = googleApiKey;
    } catch (e) {
      console.error('Failed to load mappings', e);
    }
  }

  async function save() {
    const list = document.getElementById('list');
    const rows = Array.from(list.children || []);
    const mappings = rows.map(r => {
      const inputs = r.querySelectorAll('input');
      return { find: inputs[0].value || '', replace: inputs[1].value || '' };
    }).filter(m => m.find !== '');
    const translateEnabled = document.getElementById('translateEnabled').checked;
    const translateTarget = document.getElementById('translateTarget').value || 'en';
    const translateReplace = document.getElementById('translateReplace').checked;
    const cacheMaxEntries = Number(document.getElementById('cacheMaxEntries').value) || 1000;
    const cacheTTLDays = Number(document.getElementById('cacheTTLDays').value) || 30;
    const useCloudTranslate = !!document.getElementById('useCloudTranslate').checked;
    const googleApiKey = (document.getElementById('googleApiKey').value || '');
    await browser.storage.local.set({ mappings, translateEnabled, translateTarget, translateReplace, cacheMaxEntries, cacheTTLDays, useCloudTranslate, googleApiKey });
    const s = document.createElement('span');
    s.textContent = 'Saved.';
    s.style.marginLeft = '8px';
    document.getElementById('save').after(s);
    setTimeout(() => s.remove(), 2000);
  }

  async function resetDefaults() {
    await browser.storage.local.set({ mappings: DEFAULTS, translateEnabled: false, translateTarget: 'en', translateReplace: true });
    await load();
  }

  async function clearTranslationCache() {
    try {
      await browser.storage.local.remove('translationCache');
      const s = document.createElement('span');
      s.textContent = 'Translation cache cleared.';
      s.style.marginLeft = '8px';
      document.getElementById('clearCache').after(s);
      setTimeout(() => s.remove(), 2000);
      const statsEl = document.getElementById('cacheStats');
      if (statsEl) statsEl.textContent = 'Cache: 0 entries — approx 0 KB';
    } catch (e) {
      console.error('Failed to clear translation cache', e);
    }
  }

  function makeRandomKey() {
    // generate 32 random bytes and convert to base64-like string
    const arr = new Uint8Array(24);
    crypto.getRandomValues(arr);
    // toBase64
    let s = btoa(String.fromCharCode.apply(null, Array.from(arr)));
    // remove padding
    s = s.replace(/=+$/, '');
    return s;
  }

  async function purgeExpiredCache() {
    try {
      const res = await browser.storage.local.get(['translationCache','cacheTTLDays']);
      const cache = res.translationCache || {};
      const ttlDays = (typeof res.cacheTTLDays === 'number') ? res.cacheTTLDays : Number(document.getElementById('cacheTTLDays').value) || 30;
      const now = Date.now();
      const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
      let removed = 0;
      for (const k of Object.keys(cache)) {
        const entry = cache[k];
        const ts = (entry && entry.t) ? entry.t : now;
        if (ttlDays > 0 && (now - ts) > ttlMs) {
          delete cache[k];
          removed++;
        }
      }
      await browser.storage.local.set({ translationCache: cache });
      const s = document.createElement('span');
      s.textContent = `Purged ${removed} expired entries.`;
      s.style.marginLeft = '8px';
      document.getElementById('purgeExpired').after(s);
      setTimeout(() => s.remove(), 2000);
      // update stats
      const keys = Object.keys(cache);
      let bytes = 0;
      for (const k of keys) {
        const v = cache[k];
        if (v && v.v) bytes += (v.v.length || 0);
      }
      const statsEl = document.getElementById('cacheStats');
      if (statsEl) statsEl.textContent = `Cache: ${keys.length} entries — approx ${Math.round(bytes/1024)} KB`;
    } catch (e) {
      console.error('Failed to purge expired cache', e);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('add').addEventListener('click', () => {
      document.getElementById('list').appendChild(createRow({ find: '', replace: '' }));
    });
    document.getElementById('save').addEventListener('click', save);
    document.getElementById('reset').addEventListener('click', resetDefaults);
    const clearBtn = document.getElementById('clearCache');
    if (clearBtn) clearBtn.addEventListener('click', clearTranslationCache);
    const purgeBtn = document.getElementById('purgeExpired');
    if (purgeBtn) purgeBtn.addEventListener('click', purgeExpiredCache);
    const useCloudEl = document.getElementById('useCloudTranslate');
    if (useCloudEl) useCloudEl.addEventListener('change', () => {});
    const toggleBtn = document.getElementById('toggleShowKey');
    const keyInput = document.getElementById('googleApiKey');
    if (toggleBtn && keyInput) {
      toggleBtn.addEventListener('click', () => {
        if (keyInput.type === 'password') {
          keyInput.type = 'text';
          toggleBtn.textContent = 'Hide';
        } else {
          keyInput.type = 'password';
          toggleBtn.textContent = 'Show';
        }
      });
    }
    const rotateBtn = document.getElementById('rotateKey');
    if (rotateBtn && keyInput) {
      rotateBtn.addEventListener('click', async () => {
        const newKey = makeRandomKey();
        keyInput.value = newKey;
        // immediately save new key without overwriting mappings
        const translateEnabled = document.getElementById('translateEnabled').checked;
        const translateTarget = document.getElementById('translateTarget').value || 'en';
        const translateReplace = document.getElementById('translateReplace').checked;
        const cacheMaxEntries = Number(document.getElementById('cacheMaxEntries').value) || 1000;
        const cacheTTLDays = Number(document.getElementById('cacheTTLDays').value) || 30;
        const useCloudTranslate = !!document.getElementById('useCloudTranslate').checked;
        const res = await browser.storage.local.get('mappings');
        const existingMappings = (res && Array.isArray(res.mappings)) ? res.mappings : [];
        await browser.storage.local.set({ mappings: existingMappings, translateEnabled, translateTarget, translateReplace, cacheMaxEntries, cacheTTLDays, useCloudTranslate, googleApiKey: newKey });
        const s = document.createElement('span');
        s.textContent = 'Key rotated and saved.';
        s.style.marginLeft = '8px';
        rotateBtn.after(s);
        setTimeout(() => s.remove(), 2000);
      });
    }
    load();
  });
})();
