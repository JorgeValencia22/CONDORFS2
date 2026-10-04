/**
 * Small DOM toolkit (element builder, unit formatting, icons) shared by all UI modules.
 */
(function (SIM) {
  'use strict';

  /**
   * Creates an element: h('div.card#id', {onclick, dataset, style}, children...)
   */
  function h(sel, attrs, ...children) {
    const m = sel.match(/^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i);
    const el = document.createElement((m && m[1]) || 'div');
    if (m && m[2]) {
      m[2].replace(/([.#])([\w-]+)/g, (_, t, v) => {
        if (t === '.') el.classList.add(v);
        else el.id = v;
      });
    }
    if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
      children.unshift(attrs);
      attrs = null;
    }
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k === 'className') String(v).split(/\s+/).filter(Boolean).forEach((c) => el.classList.add(c));
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'text') el.textContent = v;
        else if (k in el && k !== 'list' && k !== 'type') el[k] = v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    append(el, children);
    return el;
  }

  function append(el, children) {
    children.flat(Infinity).forEach((c) => {
      if (c == null || c === false) return;
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    });
    return el;
  }

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /** Inline SVG icons (stroke-based, 24x24). */
  const ICONS = {
    play: '<path d="M7 4.5v15l12-7.5z"/>',
    plane: '<path d="M21 15.5 13.5 11V5.2a1.5 1.5 0 0 0-3 0V11L3 15.5v2l7.5-2.2V19L8 20.8V22l4-1 4 1v-1.2L13.5 19v-3.7L21 17.5z"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    route: '<circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M8.5 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.5"/>',
    target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r=".8"/>',
    sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
    gamepad: '<rect x="2.5" y="7" width="19" height="10" rx="5"/><path d="M7 10v4M5 12h4"/><circle cx="16" cy="11" r=".9"/><circle cx="18" cy="13" r=".9"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
    bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    map: '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2zM9 4v14M15 6v14"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    restart: '<path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5"/>',
    exit: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>',
    check: '<path d="M5 12.5 10 17 19 7"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    radio: '<rect x="3" y="8" width="18" height="12" rx="2"/><path d="M7 8 17 3M7 14h4M15 14h2"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    cloud: '<path d="M7 18a4 4 0 0 1-.6-8A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z"/>',
    wind: '<path d="M3 8h11a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h8"/>',
    fuel: '<path d="M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M4 11h10M14 8l3 1.5V17a1.5 1.5 0 0 0 3 0V8l-3-3"/>',
    warning: '<path d="M12 3 2 20h20zM12 10v5M12 17.5v.5"/>',
    engine: '<rect x="5" y="8" width="11" height="9" rx="1"/><path d="M16 11h3v3h-3M8 8V5h5v3M2 11v3h3"/>',
    nav: '<path d="M12 2 19 21l-7-4-7 4z"/>',
    camera: '<path d="M3 8h4l2-3h6l2 3h4v11H3z"/><circle cx="12" cy="13" r="3.5"/>',
    star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    weight: '<path d="M6 9h12l2 11H4zM9 9a3 3 0 1 1 6 0"/>',
    chevronRight: '<path d="m9 6 6 6-6 6"/>',
    chevronLeft: '<path d="m15 6-6 6 6 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    up: '<path d="m6 15 6-6 6 6"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    crosshair: '<circle cx="12" cy="12" r="7"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5zM3 13l9 5 9-5"/>',
    volume: '<path d="M4 9v6h4l5 4V5L8 9zM16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    access: '<circle cx="12" cy="4.5" r="1.8"/><path d="M5 8h14M12 8v6M9 21l3-7 3 7"/>',
    keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  };

  function icon(name, cls = '') {
    const span = document.createElement('span');
    span.className = 'icon ' + cls;
    span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
    return span;
  }

  /** Unit helpers honouring the units setting (aviation vs metric). */
  const Fmt = {
    metric: () => SIM.app && SIM.app.settings.metric,
    speed(kt) {
      return Fmt.metric() ? `${Math.round(kt * 1.852)}` : `${Math.round(kt)}`;
    },
    speedUnit: () => (Fmt.metric() ? 'km/h' : 'kt'),
    alt(ft) {
      return Fmt.metric() ? `${Math.round(ft * 0.3048)}` : `${Math.round(ft)}`;
    },
    altUnit: () => (Fmt.metric() ? 'm' : 'ft'),
    vs(fpm) {
      return Fmt.metric() ? `${(fpm * 0.00508).toFixed(1)}` : `${Math.round(fpm / 10) * 10}`;
    },
    vsUnit: () => (Fmt.metric() ? 'm/s' : 'fpm'),
    dist(m) {
      return Fmt.metric() ? `${(m / 1000).toFixed(1)} km` : `${(m / 1852).toFixed(1)} nm`;
    },
    hdg(deg) {
      return String(Math.round(SIM.MathUtil.wrap360(deg)) % 360 || 360).padStart(3, '0');
    },
    fuel(qty, unit) {
      if (unit === 'kg') return `${Math.round(qty).toLocaleString('en-US')} kg`;
      return Fmt.metric() ? `${(qty * 3.785).toFixed(0)} L` : `${qty.toFixed(1)} gal`;
    },
    time(sec) {
      sec = Math.max(0, Math.round(sec));
      const hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = sec % 60;
      return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
    },
    clock(hours) {
      const hh = Math.floor(hours) % 24, mm = Math.floor((hours % 1) * 60);
      return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    },
  };

  /** Hi-DPI canvas sizing helper. */
  function fitCanvas(canvas, w, h, scale = 1) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * scale;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  SIM.UI = { h, append, $, $$, icon, Fmt, fitCanvas, ICONS };
})(window.SIM);
