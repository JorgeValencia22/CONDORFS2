/**
 * Safe localStorage wrapper. Falls back to in-memory storage when the browser blocks access
 * (private mode, file:// restrictions, quota errors) so the simulator never crashes because of it.
 */
(function (SIM) {
  'use strict';

  const memory = new Map();
  let available = false;

  try {
    const probe = SIM.Config.STORAGE_PREFIX + '__probe';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    available = true;
  } catch (e) {
    console.warn('[Storage] localStorage unavailable, using memory storage', e);
  }

  const Storage = {
    get available() {
      return available;
    },

    load(key, fallback) {
      const k = SIM.Config.STORAGE_PREFIX + key;
      try {
        const raw = available ? window.localStorage.getItem(k) : memory.get(k);
        if (raw == null) return fallback;
        return JSON.parse(raw);
      } catch (e) {
        console.warn(`[Storage] could not read ${key}`, e);
        return fallback;
      }
    },

    save(key, value) {
      const k = SIM.Config.STORAGE_PREFIX + key;
      const raw = JSON.stringify(value);
      try {
        if (available) window.localStorage.setItem(k, raw);
        else memory.set(k, raw);
        return true;
      } catch (e) {
        console.warn(`[Storage] could not write ${key}`, e);
        memory.set(k, raw);
        return false;
      }
    },

    remove(key) {
      const k = SIM.Config.STORAGE_PREFIX + key;
      try {
        if (available) window.localStorage.removeItem(k);
      } catch (e) {
        /* ignored */
      }
      memory.delete(k);
    },
  };

  /** Deep merge of plain objects; arrays and primitives from `src` replace those in `dst`. */
  function deepMerge(dst, src) {
    if (!src || typeof src !== 'object') return dst;
    for (const key of Object.keys(src)) {
      const s = src[key];
      if (s && typeof s === 'object' && !Array.isArray(s) && dst[key] && typeof dst[key] === 'object' && !Array.isArray(dst[key])) {
        deepMerge(dst[key], s);
      } else if (s !== undefined) {
        dst[key] = Array.isArray(s) ? s.slice() : s;
      }
    }
    return dst;
  }

  const deepClone = (o) => JSON.parse(JSON.stringify(o));

  SIM.Storage = Storage;
  SIM.deepMerge = deepMerge;
  SIM.deepClone = deepClone;
})(window.SIM);
