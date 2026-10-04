/**
 * Boot — loads Three.js (CDN, or an optional local copy in js/vendor for offline use) and starts the App.
 * If every source fails the simulator still starts in instrument-only mode.
 */
(function (SIM) {
  'use strict';

  const THREE_SOURCES = [
    'https://cdn.jsdelivr.net/npm/three@0.149.0/build/three.min.js',
    'https://unpkg.com/three@0.149.0/build/three.min.js',
    'js/vendor/three.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js',
  ];

  const splash = document.getElementById('boot');
  const statusEl = document.getElementById('boot-status');
  const status = (t) => {
    if (statusEl) statusEl.textContent = t;
  };

  function loadScript(src, timeoutMs = 9000) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      const timer = setTimeout(() => {
        s.remove();
        reject(new Error('timeout'));
      }, timeoutMs);
      s.onload = () => {
        clearTimeout(timer);
        resolve();
      };
      s.onerror = () => {
        clearTimeout(timer);
        s.remove();
        reject(new Error('failed'));
      };
      document.head.appendChild(s);
    });
  }

  async function loadThree() {
    for (const src of THREE_SOURCES) {
      if (window.THREE) return true;
      status(src.startsWith('http') ? `Loading 3D engine (${new URL(src).host})…` : 'Loading 3D engine…');
      try {
        await loadScript(src);
        if (window.THREE && window.THREE.WebGLRenderer) {
          console.info(`[Boot] Three.js r${THREE.REVISION} from ${src}`);
          return true;
        }
      } catch (e) {
        console.info(`[Boot] Three.js not available from ${src}`);
      }
    }
    return false;
  }

  async function boot() {
    try {
      const ok = await loadThree();
      if (!ok) console.warn('[Boot] Three.js unavailable — instrument-only mode');
      const app = new SIM.App();
      await app.init(status);
      if (splash) {
        splash.classList.add('done');
        setTimeout(() => splash.remove(), 600);
      }
    } catch (e) {
      console.error(e);
      SIM.ErrorHandler.show('The simulator could not start', 'A required component failed to initialise. Check that JavaScript is enabled and that the browser is up to date (Chrome, Edge, Firefox or Safari).', { detail: e.stack || String(e) });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window.SIM);
