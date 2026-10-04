/**
 * Procedural textures generated on canvas at load time (no external image downloads needed):
 * terrain detail, asphalt, concrete, building facades with night windows, clouds, light glows,
 * water normal map and runway designators.
 */
(function (SIM) {
  'use strict';

  const cache = new Map();
  const { valueNoise, fbm } = SIM.Noise;

  function canvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  function finish(c, repeat = true, anisotropy = 4) {
    const t = new THREE.CanvasTexture(c);
    if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = anisotropy;
    t.needsUpdate = true;
    return t;
  }

  function noiseImage(size, fn) {
    const c = canvas(size, size);
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const v = fn(x, y);
        const i = (y * size + x) * 4;
        img.data[i] = v[0];
        img.data[i + 1] = v[1];
        img.data[i + 2] = v[2];
        img.data[i + 3] = v[3] === undefined ? 255 : v[3];
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  /** Tileable noise: samples on a torus so edges match. */
  function tileNoise(x, y, size, scale, seed, oct = 4) {
    const a = (x / size) * Math.PI * 2, b = (y / size) * Math.PI * 2;
    const r = scale / (Math.PI * 2);
    return fbm(Math.cos(a) * r + Math.sin(b) * r * 0.37 + 100, Math.sin(a) * r + Math.cos(b) * r + 50, oct, seed);
  }

  const Textures = {
    get(name) {
      if (!cache.has(name)) cache.set(name, this['make_' + name]());
      return cache.get(name);
    },

    make_terrainDetail() {
      const s = 256;
      const c = noiseImage(s, (x, y) => {
        const n = tileNoise(x, y, s, 9, 3, 5);
        const v = Math.round(214 + (n - 0.5) * 52 + (valueNoise(x * 0.7, y * 0.7, 9) - 0.5) * 14);
        return [v, v, v];
      });
      return finish(c, true, 8);
    },

    make_asphalt() {
      const s = 256;
      const c = noiseImage(s, (x, y) => {
        const n = tileNoise(x, y, s, 40, 11, 3);
        const g = valueNoise(x * 0.9, y * 0.9, 5);
        const v = Math.round(62 + (n - 0.5) * 26 + (g - 0.5) * 18);
        return [v, v + 1, v + 3];
      });
      return finish(c, true, 8);
    },

    make_concrete() {
      const s = 256;
      const c = noiseImage(s, (x, y) => {
        const n = tileNoise(x, y, s, 18, 21, 3);
        const joint = x % 64 === 0 || y % 64 === 0 ? -24 : 0;
        const v = Math.round(140 + (n - 0.5) * 30 + joint);
        return [v, v, v - 4];
      });
      return finish(c, true, 8);
    },

    /** Building facade: 16 floors x 16 window columns, tileable. */
    make_facade() {
      const c = canvas(256, 256);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#9a958c';
      ctx.fillRect(0, 0, 256, 256);
      for (let y = 0; y < 256; y += 16) {
        ctx.fillStyle = 'rgba(0,0,0,0.08)';
        ctx.fillRect(0, y + 13, 256, 3);
        for (let x = 4; x < 256; x += 16) {
          ctx.fillStyle = '#2e3a46';
          ctx.fillRect(x, y + 3, 10, 9);
        }
      }
      return finish(c, true, 4);
    },

    /** Emissive map: some windows lit at night. */
    make_facadeLights() {
      const c = canvas(256, 256);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, 256, 256);
      const rnd = SIM.mulberry32(42);
      for (let y = 0; y < 256; y += 16) {
        for (let x = 4; x < 256; x += 16) {
          if (rnd() < 0.38) {
            const warm = rnd();
            ctx.fillStyle = warm < 0.7 ? '#ffd9a0' : warm < 0.9 ? '#fff1d6' : '#bcd6ff';
            ctx.fillRect(x, y + 3, 10, 9);
          }
        }
      }
      return finish(c, true, 4);
    },

    make_cloud() {
      const s = 128;
      const c = noiseImage(s, (x, y) => {
        const dx = (x - s / 2) / (s / 2), dy = (y - s / 2) / (s / 2);
        const d = Math.sqrt(dx * dx + dy * dy);
        const n = fbm(x / 22, y / 22, 4, 7);
        const a = Math.max(0, 1 - d * (1.05 - (n - 0.5) * 0.7));
        const alpha = Math.pow(a, 1.4) * 255;
        const shade = 255 - Math.max(0, dy) * 45;
        return [shade, shade, shade, alpha];
      });
      return finish(c, false, 1);
    },

    make_cloudLayer() {
      const s = 512;
      const c = noiseImage(s, (x, y) => {
        const n = tileNoise(x, y, s, 6, 17, 5);
        const a = Math.min(1, Math.max(0, (n - 0.32) * 2.6));
        const v = Math.round(225 + n * 30);
        return [v, v, v, Math.round(a * 255)];
      });
      return finish(c, true, 4);
    },

    make_glow() {
      const s = 64;
      const c = canvas(s, s);
      const ctx = c.getContext('2d');
      const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.18, 'rgba(255,255,255,0.85)');
      g.addColorStop(0.45, 'rgba(255,255,255,0.22)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
      return finish(c, false, 1);
    },

    make_smoke() {
      const s = 64;
      const c = noiseImage(s, (x, y) => {
        const dx = (x - s / 2) / (s / 2), dy = (y - s / 2) / (s / 2);
        const d = Math.sqrt(dx * dx + dy * dy);
        const n = fbm(x / 10, y / 10, 3, 9);
        const a = Math.max(0, 1 - d) * (0.6 + n * 0.6);
        return [255, 255, 255, Math.round(Math.min(1, a) * 255)];
      });
      return finish(c, false, 1);
    },

    make_waterNormal() {
      const s = 256;
      const h = (x, y) => tileNoise(x, y, s, 24, 31, 4);
      const c = noiseImage(s, (x, y) => {
        const dx = h(x + 1, y) - h(x - 1, y);
        const dy = h(x, y + 1) - h(x, y - 1);
        return [Math.round(128 - dx * 900), Math.round(128 - dy * 900), 255];
      });
      return finish(c, true, 4);
    },

    make_grass() {
      const s = 128;
      const c = noiseImage(s, (x, y) => {
        const n = tileNoise(x, y, s, 30, 41, 3);
        return [Math.round(88 + n * 40), Math.round(112 + n * 40), Math.round(58 + n * 20)];
      });
      return finish(c, true, 4);
    },

    /**
     * Livery texture for a fuselage. Canvas X = position along the body (nose -> tail),
     * canvas Y = position around it (0 bottom, .25 right side, .5 top, .75 left side).
     * @param {object} visual aircraft visual config
     * @param {object} layout window layout fractions from the model builder
     */
    livery(visual, layout) {
      const key = 'livery_' + visual.tailNumber;
      if (cache.has(key)) return cache.get(key);
      const W = 1024, H = 256;
      const c = canvas(W, H);
      const ctx = c.getContext('2d');
      ctx.fillStyle = visual.base;
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = 'rgba(0,0,0,0.06)';
      for (let x = 60; x < W; x += 70) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H);
        ctx.stroke();
      }
      const rect = (u0, u1, a0, a1, color) => {
        ctx.fillStyle = color;
        ctx.fillRect(u0 * W, a0 * H, (u1 - u0) * W, (a1 - a0) * H);
      };
      const text = (str, a, u, size, color, rotate) => {
        ctx.save();
        ctx.translate(u * W, a * H);
        if (rotate) ctx.rotate(Math.PI);
        ctx.font = `700 ${size}px "Barlow Condensed", "Arial Narrow", sans-serif`;
        ctx.fillStyle = color;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(str, 0, 0);
        ctx.restore();
      };
      const s1 = visual.stripe, s2 = visual.stripe2;
      if (layout.airliner) {
        rect(0, 1, 0, 0.12, '#c9ccd1');
        rect(0, 1, 0.88, 1, '#c9ccd1');
        rect(0.03, 0.97, 0.2, 0.232, s1);
        rect(0.03, 0.97, 0.768, 0.8, s1);
        rect(0.03, 0.97, 0.236, 0.246, s2);
        rect(0.03, 0.97, 0.754, 0.764, s2);
        ctx.fillStyle = visual.glass;
        for (let x = 0.18; x < 0.84; x += 0.0137) {
          rect(x, x + 0.0068, 0.31, 0.334, visual.glass);
          rect(x, x + 0.0068, 0.666, 0.69, visual.glass);
        }
        // cockpit windows (front top)
        rect(0.035, 0.075, 0.35, 0.43, visual.glass);
        rect(0.035, 0.075, 0.57, 0.65, visual.glass);
        rect(0.06, 0.088, 0.43, 0.57, visual.glass);
        // doors
        ctx.strokeStyle = 'rgba(0,0,0,0.25)';
        [[0.11, 0.135], [0.86, 0.885]].forEach(([u0, u1]) => {
          ctx.strokeRect(u0 * W, 0.26 * H, (u1 - u0) * W, 0.09 * H);
          ctx.strokeRect(u0 * W, 0.65 * H, (u1 - u0) * W, 0.09 * H);
        });
        text(visual.airline, 0.29, 0.42, 26, s1, true);
        text(visual.airline, 0.71, 0.42, 26, s1, false);
        text(visual.tailNumber, 0.235, 0.91, 12, '#333', true);
        text(visual.tailNumber, 0.765, 0.91, 12, '#333', false);
      } else {
        rect(0.02, 0.98, 0.2, 0.232, s1);
        rect(0.02, 0.98, 0.768, 0.8, s1);
        rect(0.06, 0.98, 0.236, 0.247, s2);
        rect(0.06, 0.98, 0.753, 0.764, s2);
        // cowling accent
        rect(0, 0.14, 0, 0.18, s1);
        rect(0, 0.14, 0.82, 1, s1);
        const [a0, a1] = layout.winA;
        const g = visual.glass;
        if (layout.ovalWindows) {
          const n = layout.ovalWindows;
          const span = layout.cabin[1] - layout.cabin[0];
          for (let i = 0; i < n; i++) {
            const u0 = layout.cabin[0] + (span / n) * (i + 0.15), u1 = u0 + (span / n) * 0.7;
            rect(u0, u1, a0 + 0.015, a1 - 0.01, g);
            rect(u0, u1, 1 - a1 + 0.01, 1 - a0 - 0.015, g);
          }
        } else {
          rect(layout.cabin[0], layout.cabin[1], a0, a1, g);
          rect(layout.cabin[0], layout.cabin[1], 1 - a1, 1 - a0, g);
          // window frame divider
          const mid = (layout.cabin[0] + layout.cabin[1]) / 2;
          rect(mid - 0.004, mid + 0.004, a0, a1, visual.base);
          rect(mid - 0.004, mid + 0.004, 1 - a1, 1 - a0, visual.base);
        }
        if (layout.rear) {
          rect(layout.rear[0], layout.rear[1], a0 + 0.02, a1 - 0.01, g);
          rect(layout.rear[0], layout.rear[1], 1 - a1 + 0.01, 1 - a0 - 0.02, g);
        }
        // windshield over the top
        rect(layout.windshield[0], layout.windshield[1], a1 - 0.02, 1 - a1 + 0.02, g);
        text(visual.tailNumber, 0.3, layout.reg, 24, '#1d1f22', true);
        text(visual.tailNumber, 0.7, layout.reg, 24, '#1d1f22', false);
      }
      const t = finish(c, false, 8);
      cache.set(key, t);
      return t;
    },

    /** Runway designator label ("17L"), white on transparent. */
    runwayLabel(id) {
      const key = 'rwy_' + id;
      if (cache.has(key)) return cache.get(key);
      const c = canvas(128, 256);
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, 128, 256);
      ctx.fillStyle = '#f2f2ee';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const num = id.replace(/[LRC]/, '');
      const side = id.replace(/\d/g, '');
      ctx.font = '700 104px "Barlow Condensed", Arial Narrow, sans-serif';
      ctx.fillText(num, 64, side ? 84 : 128);
      if (side) {
        ctx.font = '700 84px "Barlow Condensed", Arial Narrow, sans-serif';
        ctx.fillText(side, 64, 200);
      }
      const t = finish(c, false, 8);
      cache.set(key, t);
      return t;
    },

    /** Small text sprite used for windsock signs and tower labels. */
    clear() {
      cache.forEach((t) => t.dispose && t.dispose());
      cache.clear();
    },
  };

  SIM.Textures = Textures;
})(window.SIM);
