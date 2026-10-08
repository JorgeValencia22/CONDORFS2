/**
 * Glass cockpit displays for the airliner: Primary Flight Display (attitude, speed/altitude tapes,
 * vertical speed, heading, FMA, ILS deviation), Navigation Display (map mode with route, waypoints,
 * traffic, wind) and engine display (N1/EGT dials, N2, fuel flow, fuel, flaps, gear).
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;
  const { h, fitCanvas } = SIM.UI;
  const D = Math.PI / 180;
  const FONT = '"JetBrains Mono", "Consolas", monospace';
  const C = { white: '#f2f2f2', green: '#3fe07a', magenta: '#f05cf0', cyan: '#4fd6f0', amber: '#f0b23c', red: '#ff4a3d', grey: '#5c6670', sky: '#2a78c8', ground: '#7c4a22' };

  function txt(ctx, s, x, y, size, color = C.white, align = 'center', weight = 500) {
    ctx.fillStyle = color;
    ctx.font = `${weight} ${size}px ${FONT}`;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillText(s, x, y);
  }

  class Display {
    constructor(w, hh, name) {
      this.w = w;
      this.h = hh;
      this.canvas = h('canvas.display', { 'aria-label': name, role: 'img' });
      this.ctx = fitCanvas(this.canvas, w, hh, 1, SIM.UI.canvasPixelRatio);
    }
    clear() {
      this.ctx.fillStyle = '#05070a';
      this.ctx.fillRect(0, 0, this.w, this.h);
    }
    off() {
      this.ctx.fillStyle = '#020304';
      this.ctx.fillRect(0, 0, this.w, this.h);
    }
  }

  /* ------------------------------------------------------------------ PFD */

  class PFD extends Display {
    constructor(w, hh, perf) {
      super(w, hh, 'Primary flight display');
      this.perf = perf;
    }
    render(d) {
      if (!d.powered) return this.off();
      const ctx = this.ctx, W = this.w, H = this.h;
      this.clear();
      const cx = W * 0.47, cy = H * 0.47, R = Math.min(W, H) * 0.3;
      // Attitude
      ctx.save();
      ctx.beginPath();
      ctx.rect(cx - R, cy - R * 1.05, R * 2, R * 2.1);
      ctx.clip();
      ctx.translate(cx, cy);
      ctx.rotate(-d.roll * D);
      const ppd = R / 18;
      const off = d.pitch * ppd;
      ctx.fillStyle = C.sky;
      ctx.fillRect(-R * 3, -R * 4 + off, R * 6, R * 4);
      ctx.fillStyle = C.ground;
      ctx.fillRect(-R * 3, off, R * 6, R * 4);
      ctx.strokeStyle = C.white;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(-R * 3, off);
      ctx.lineTo(R * 3, off);
      ctx.stroke();
      for (let p = -30; p <= 30; p += 2.5) {
        if (!p) continue;
        const y = off - p * ppd;
        const w = p % 10 === 0 ? R * 0.35 : p % 5 === 0 ? R * 0.18 : R * 0.08;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(-w, y);
        ctx.lineTo(w, y);
        ctx.stroke();
        if (p % 10 === 0) txt(ctx, String(Math.abs(p)), -w - 14, y, 11);
      }
      ctx.restore();
      // roll arc and pointer
      ctx.save();
      ctx.translate(cx, cy);
      ctx.strokeStyle = C.white;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(0, 0, R * 1.0, (-90 - 60) * D, (-90 + 60) * D);
      ctx.stroke();
      [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60].forEach((a) => {
        const l = a % 30 === 0 ? 10 : 6;
        ctx.beginPath();
        ctx.moveTo(Math.sin(a * D) * R, -Math.cos(a * D) * R);
        ctx.lineTo(Math.sin(a * D) * (R + l), -Math.cos(a * D) * (R + l));
        ctx.stroke();
      });
      ctx.rotate(-d.roll * D);
      ctx.fillStyle = C.white;
      ctx.beginPath();
      ctx.moveTo(0, -R + 2);
      ctx.lineTo(-7, -R + 13);
      ctx.lineTo(7, -R + 13);
      ctx.fill();
      // slip indicator
      ctx.fillRect(-7 + M.clamp(d.slip * 60, -14, 14), -R + 15, 14, 4);
      ctx.restore();
      // aircraft symbol
      ctx.strokeStyle = '#000';
      ctx.fillStyle = C.amber;
      ctx.lineWidth = 1;
      [[-R * 0.62, -R * 0.2], [R * 0.2, R * 0.62]].forEach(([a, b]) => {
        ctx.fillRect(cx + a, cy - 3, b - a, 6);
        ctx.strokeRect(cx + a, cy - 3, b - a, 6);
      });
      ctx.fillRect(cx - 4, cy - 4, 8, 8);
      // ILS deviation
      if (d.loc != null) {
        const lx = cx + M.clamp(d.loc, -2.5, 2.5) * R * 0.3;
        ctx.fillStyle = C.magenta;
        ctx.beginPath();
        ctx.moveTo(lx, cy + R * 1.13);
        ctx.lineTo(lx - 6, cy + R * 1.18);
        ctx.lineTo(lx, cy + R * 1.23);
        ctx.lineTo(lx + 6, cy + R * 1.18);
        ctx.fill();
      }
      if (d.gsDev != null) {
        const gy = cy - M.clamp(d.gsDev, -2.5, 2.5) * R * 0.3;
        ctx.fillStyle = C.magenta;
        ctx.beginPath();
        ctx.moveTo(cx + R * 1.12, gy);
        ctx.lineTo(cx + R * 1.17, gy - 6);
        ctx.lineTo(cx + R * 1.22, gy);
        ctx.lineTo(cx + R * 1.17, gy + 6);
        ctx.fill();
      }
      this.speedTape(ctx, d, 6, cy, 56, R * 2.2);
      this.altTape(ctx, d, W - 78, cy, 60, R * 2.2);
      this.vsi(ctx, d, W - 14, cy, R * 1.6);
      this.heading(ctx, d, cx, H - 26, R * 1.2);
      // FMA
      ctx.fillStyle = '#0c0f13';
      ctx.fillRect(cx - R * 1.2, 4, R * 2.4, 22);
      const fma = d.fma || {};
      txt(ctx, fma.at ? 'SPD' : '', cx - R * 0.85, 15, 12, C.green);
      txt(ctx, fma.lat || '', cx, 15, 12, C.green);
      txt(ctx, fma.vert || '', cx + R * 0.85, 15, 12, C.green);
      txt(ctx, fma.ap ? 'CMD' : '', cx, 37, 14, C.green, 'center', 700);
      if (fma.armed) txt(ctx, fma.armed, cx, 52, 10, C.white);
      // radio altitude
      if (d.ra < 2500) txt(ctx, String(Math.round(d.ra / 10) * 10), cx, cy + R * 0.82, 14, C.white, 'center', 700);
      if (d.stall) txt(ctx, 'STALL', cx, cy - R * 0.55, 18, C.red, 'center', 700);
      if (d.mins) txt(ctx, 'MINIMUMS', cx, cy + R * 0.6, 12, C.amber, 'center', 700);
    }

    speedTape(ctx, d, x, cy, w, hh) {
      ctx.fillStyle = '#2a3036';
      ctx.fillRect(x, cy - hh / 2, w, hh);
      const pxPerKt = hh / 90;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, cy - hh / 2, w, hh);
      ctx.clip();
      for (let v = Math.floor((d.ias - 50) / 10) * 10; v < d.ias + 50; v += 10) {
        if (v < 30) continue;
        const y = cy - (v - d.ias) * pxPerKt;
        ctx.strokeStyle = C.white;
        ctx.beginPath();
        ctx.moveTo(x + w - 10, y);
        ctx.lineTo(x + w, y);
        ctx.stroke();
        if (v % 20 === 0) txt(ctx, String(v), x + w - 14, y, 12, C.white, 'right');
      }
      // stall band and overspeed band
      const band = (v0, v1, color) => {
        ctx.fillStyle = color;
        const y0 = cy - (v0 - d.ias) * pxPerKt, y1 = cy - (v1 - d.ias) * pxPerKt;
        ctx.fillRect(x + w - 5, Math.min(y0, y1), 5, Math.abs(y1 - y0));
      };
      band(0, d.vStall, C.red);
      band(d.vmo, d.vmo + 200, C.red);
      // speed bug
      if (d.spdBug) {
        const y = cy - (d.spdBug - d.ias) * pxPerKt;
        ctx.strokeStyle = C.magenta;
        ctx.lineWidth = 2;
        ctx.strokeRect(x + w - 8, y - 6, 8, 12);
        ctx.lineWidth = 1;
      }
      // trend vector
      if (Math.abs(d.trend) > 1) {
        ctx.strokeStyle = C.green;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x + w - 2, cy);
        ctx.lineTo(x + w - 2, cy - d.trend * pxPerKt);
        ctx.stroke();
        ctx.lineWidth = 1;
      }
      ctx.restore();
      ctx.fillStyle = '#000';
      ctx.strokeStyle = C.white;
      ctx.fillRect(x, cy - 13, w - 4, 26);
      ctx.strokeRect(x, cy - 13, w - 4, 26);
      txt(ctx, String(Math.round(d.ias)), x + w / 2 - 2, cy, 16, C.white, 'center', 700);
      txt(ctx, d.spdBug ? String(Math.round(d.spdBug)) : '---', x + w / 2, cy - hh / 2 - 10, 12, C.magenta);
      txt(ctx, `GS ${Math.round(d.gsKt)}`, x + w / 2, cy + hh / 2 + 12, 11, C.white);
    }

    altTape(ctx, d, x, cy, w, hh) {
      ctx.fillStyle = '#2a3036';
      ctx.fillRect(x, cy - hh / 2, w, hh);
      const pxPerFt = hh / 900;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, cy - hh / 2, w, hh);
      ctx.clip();
      for (let a = Math.floor((d.alt - 500) / 100) * 100; a < d.alt + 500; a += 100) {
        const y = cy - (a - d.alt) * pxPerFt;
        ctx.strokeStyle = C.white;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + 10, y);
        ctx.stroke();
        if (a % 200 === 0) txt(ctx, String(a), x + 14, y, 11, C.white, 'left');
      }
      if (d.altBug != null) {
        const y = cy - (d.altBug - d.alt) * pxPerFt;
        ctx.strokeStyle = C.magenta;
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y - 7, 8, 14);
        ctx.lineWidth = 1;
      }
      ctx.restore();
      ctx.fillStyle = '#000';
      ctx.strokeStyle = C.white;
      ctx.fillRect(x + 2, cy - 13, w, 26);
      ctx.strokeRect(x + 2, cy - 13, w, 26);
      txt(ctx, String(Math.round(d.alt)), x + w / 2 + 2, cy, 14, C.white, 'center', 700);
      txt(ctx, d.altBug != null ? String(Math.round(d.altBug)) : '', x + w / 2, cy - hh / 2 - 10, 12, C.magenta);
      txt(ctx, `${d.baro} ${d.baroUnit}`, x + w / 2, cy + hh / 2 + 12, 11, C.green);
    }

    vsi(ctx, d, x, cy, hh) {
      ctx.fillStyle = '#2a3036';
      ctx.fillRect(x - 10, cy - hh / 2, 18, hh);
      const f = (v) => Math.sign(v) * (1 - Math.exp(-Math.abs(v) / 1500));
      ctx.strokeStyle = C.white;
      [-2000, -1000, -500, 500, 1000, 2000].forEach((v) => {
        const y = cy - f(v) * hh * 0.5;
        ctx.beginPath();
        ctx.moveTo(x - 10, y);
        ctx.lineTo(x - 4, y);
        ctx.stroke();
      });
      const y = cy - f(d.vs) * hh * 0.5;
      ctx.strokeStyle = C.white;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x + 8, cy);
      ctx.lineTo(x - 8, y);
      ctx.stroke();
      ctx.lineWidth = 1;
      if (Math.abs(d.vs) > 400) txt(ctx, String(Math.round(d.vs / 50) * 50), x - 2, d.vs > 0 ? cy - hh / 2 - 9 : cy + hh / 2 + 9, 10, C.white);
    }

    heading(ctx, d, cx, cy, r) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(cx - r, cy - 22, r * 2, 44);
      ctx.clip();
      ctx.fillStyle = '#2a3036';
      ctx.fillRect(cx - r, cy - 22, r * 2, 44);
      const ppd = (r * 2) / 60;
      for (let a = Math.floor(d.hdg - 32); a < d.hdg + 32; a++) {
        if (a % 5) continue;
        const x = cx + (a - d.hdg) * ppd;
        const aa = M.wrap360(a);
        ctx.strokeStyle = C.white;
        ctx.beginPath();
        ctx.moveTo(x, cy - 22);
        ctx.lineTo(x, cy - (aa % 10 === 0 ? 12 : 16));
        ctx.stroke();
        if (aa % 10 === 0) txt(ctx, String(aa / 10), x, cy - 3, 11);
      }
      if (d.hdgBug != null) {
        const x = cx + M.angleDiff(d.hdg, d.hdgBug) * ppd;
        ctx.strokeStyle = C.magenta;
        ctx.lineWidth = 2;
        ctx.strokeRect(x - 6, cy - 22, 12, 7);
        ctx.lineWidth = 1;
      }
      ctx.restore();
      ctx.fillStyle = '#000';
      ctx.fillRect(cx - 22, cy - 34, 44, 16);
      txt(ctx, SIM.UI.Fmt.hdg(d.hdg), cx, cy - 26, 13, C.white, 'center', 700);
    }
  }

  /* ------------------------------------------------------------------ ND */

  class ND extends Display {
    constructor(w, hh) {
      super(w, hh, 'Navigation display');
      this.range = 20; // nm
    }
    render(d) {
      if (!d.powered) return this.off();
      const ctx = this.ctx, W = this.w, H = this.h;
      this.clear();
      const cx = W / 2, cy = H * 0.82, R = H * 0.72;
      const ppm = R / (this.range * 1852);
      // compass arc
      ctx.save();
      ctx.translate(cx, cy);
      ctx.strokeStyle = C.white;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(0, 0, R, (-90 - 50) * D, (-90 + 50) * D);
      ctx.stroke();
      for (let a = -50; a <= 50; a += 1) {
        const hdg = Math.round(d.hdg + a);
        if (hdg % 5) continue;
        const ang = (hdg - d.hdg) * D;
        const l = hdg % 10 === 0 ? 10 : 5;
        ctx.beginPath();
        ctx.moveTo(Math.sin(ang) * R, -Math.cos(ang) * R);
        ctx.lineTo(Math.sin(ang) * (R - l), -Math.cos(ang) * (R - l));
        ctx.stroke();
        if (hdg % 30 === 0) txt(ctx, String(M.wrap360(hdg) / 10), Math.sin(ang) * (R - 20), -Math.cos(ang) * (R - 20), 12);
      }
      // range ring
      ctx.setLineDash([4, 6]);
      ctx.beginPath();
      ctx.arc(0, 0, R / 2, (-90 - 50) * D, (-90 + 50) * D);
      ctx.stroke();
      ctx.setLineDash([]);
      txt(ctx, String(this.range / 2), -R / 2 * Math.sin(50 * D) - 12, -R / 2 * Math.cos(50 * D), 10, C.white);
      // map elements in heading-up frame
      const toScreen = (x, z) => {
        const dx = x - d.x, dz = z - d.z;
        const r = d.trueHdg * D;
        const ex = dx * Math.cos(r) - (-dz) * Math.sin(r);
        const ny = dx * Math.sin(r) + (-dz) * Math.cos(r);
        return [ex * ppm, -ny * ppm];
      };
      ctx.beginPath();
      ctx.rect(-W, -R - 5, W * 2, R + 40);
      ctx.clip();
      // route
      if (d.route && d.route.length) {
        ctx.strokeStyle = C.magenta;
        ctx.lineWidth = 2;
        ctx.beginPath();
        const first = toScreen(d.x, d.z);
        ctx.moveTo(first[0], first[1]);
        d.route.slice(d.activeLeg).forEach((w) => {
          const p = toScreen(w.x, w.z);
          ctx.lineTo(p[0], p[1]);
        });
        ctx.stroke();
        d.route.forEach((w, i) => {
          const p = toScreen(w.x, w.z);
          ctx.strokeStyle = i === d.activeLeg ? C.magenta : C.white;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(p[0], p[1] - 6);
          ctx.lineTo(p[0] + 6, p[1]);
          ctx.lineTo(p[0], p[1] + 6);
          ctx.lineTo(p[0] - 6, p[1]);
          ctx.closePath();
          ctx.stroke();
          txt(ctx, w.ident, p[0] + 10, p[1] - 8, 11, i === d.activeLeg ? C.magenta : C.white, 'left');
        });
      }
      // airports
      (d.airports || []).forEach((ap) => {
        const p = toScreen(ap.x, ap.z);
        ctx.strokeStyle = C.cyan;
        ctx.beginPath();
        ctx.arc(p[0], p[1], 5, 0, Math.PI * 2);
        ctx.stroke();
        txt(ctx, ap.icao, p[0] + 8, p[1] + 9, 10, C.cyan, 'left');
      });
      // traffic (TCAS-style)
      (d.traffic || []).forEach((t) => {
        const p = toScreen(t.x, t.z);
        const rel = Math.round((t.altFt - d.altFt) / 100);
        const close = Math.hypot(t.x - d.x, t.z - d.z) < 3 * 1852 && Math.abs(rel) < 10;
        ctx.fillStyle = close ? C.amber : C.cyan;
        ctx.beginPath();
        ctx.moveTo(p[0], p[1] - 5);
        ctx.lineTo(p[0] + 5, p[1]);
        ctx.lineTo(p[0], p[1] + 5);
        ctx.lineTo(p[0] - 5, p[1]);
        ctx.fill();
        txt(ctx, `${rel >= 0 ? '+' : '-'}${String(Math.abs(rel)).padStart(2, '0')}`, p[0], p[1] + (rel >= 0 ? -11 : 11), 9, ctx.fillStyle);
      });
      ctx.restore();
      // own aircraft
      ctx.strokeStyle = C.white;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy - 12);
      ctx.lineTo(cx, cy + 10);
      ctx.moveTo(cx - 9, cy - 2);
      ctx.lineTo(cx + 9, cy - 2);
      ctx.moveTo(cx - 4, cy + 8);
      ctx.lineTo(cx + 4, cy + 8);
      ctx.stroke();
      ctx.lineWidth = 1;
      // header data
      txt(ctx, `GS${Math.round(d.gsKt)}  TAS${Math.round(d.tasKt)}`, 8, 12, 11, C.white, 'left');
      txt(ctx, `${SIM.UI.Fmt.hdg(d.windDir)}°/${Math.round(d.windKt)}`, 8, 28, 11, C.white, 'left');
      if (d.wp) {
        txt(ctx, d.wp.ident, W - 8, 12, 12, C.magenta, 'right', 700);
        txt(ctx, `${(d.wpDist / 1852).toFixed(1)}NM`, W - 8, 28, 11, C.white, 'right');
        txt(ctx, d.eta || '', W - 8, 44, 11, C.white, 'right');
      }
      txt(ctx, `HDG ${SIM.UI.Fmt.hdg(d.hdg)} MAG`, cx, 12, 12, C.green, 'center', 700);
      txt(ctx, `RNG ${this.range}`, 8, H - 10, 10, C.cyan, 'left');
    }
  }

  /* ------------------------------------------------------------------ EICAS */

  class EngineDisplay extends Display {
    constructor(w, hh) {
      super(w, hh, 'Engine display');
    }
    dial(ctx, x, y, r, value, max, label, digits, warn) {
      ctx.strokeStyle = C.white;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, r, Math.PI, Math.PI * 2.1);
      ctx.stroke();
      const f = M.clamp(value / max, 0, 1.1);
      ctx.fillStyle = 'rgba(200,210,220,0.18)';
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.arc(x, y, r - 2, Math.PI, Math.PI + f * Math.PI * 1.1);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = warn ? C.red : C.white;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(x, y);
      const a = Math.PI + f * Math.PI * 1.1;
      ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.strokeStyle = C.white;
      ctx.strokeRect(x - 2, y - r - 14, r + 4, 18);
      txt(ctx, digits, x + r / 2, y - r - 5, 13, warn ? C.red : C.white, 'center', 700);
      txt(ctx, label, x, y + 14, 10, C.cyan);
    }
    render(d) {
      if (!d.powered) return this.off();
      const ctx = this.ctx;
      this.clear();
      // Layout is designed on a 420 px tall canvas and scaled to the actual size
      const k = this.h / 420;
      const W = this.w / k;
      ctx.save();
      ctx.scale(k, k);
      d.engines.forEach((e, i) => {
        const x = W * (i === 0 ? 0.27 : 0.73);
        this.dial(ctx, x, 70, 34, e.n1, 110, 'N1', e.n1.toFixed(1), e.n1 > 102);
        this.dial(ctx, x, 160, 30, e.egt, 1000, 'EGT', String(Math.round(e.egt)), e.egt > 950);
        txt(ctx, e.n2.toFixed(1), x, 205, 12);
        txt(ctx, (e.ff / 1000).toFixed(2), x, 225, 12);
        txt(ctx, String(Math.round(e.oilP)), x, 245, 12, e.oilP < 13 && e.n2 > 50 ? C.red : C.white);
        if (e.reverse) txt(ctx, 'REV', x, 108, 12, C.green, 'center', 700);
        if (e.state === 'STARTING') txt(ctx, 'START', x, 108, 11, C.amber, 'center', 700);
      });
      txt(ctx, 'N2', W / 2, 205, 10, C.cyan);
      txt(ctx, 'FF', W / 2, 225, 10, C.cyan);
      txt(ctx, 'OIL P', W / 2, 245, 10, C.cyan);
      // fuel
      ctx.strokeStyle = C.grey;
      ctx.beginPath();
      ctx.moveTo(8, 262);
      ctx.lineTo(W - 8, 262);
      ctx.stroke();
      d.tanks.forEach((t, i) => {
        const x = W * (0.2 + i * 0.3);
        txt(ctx, t.name, x, 278, 10, C.cyan);
        txt(ctx, String(Math.round(t.qty)), x, 295, 13, t.qty < 450 ? C.amber : C.white, 'center', 700);
      });
      txt(ctx, `TOTAL ${Math.round(d.totalFuel)} KG`, W / 2, 314, 11);
      // flaps and gear
      txt(ctx, `FLAPS ${d.flaps}`, W * 0.28, 336, 12, d.flapsMoving ? C.amber : C.green, 'center', 700);
      const gearTxt = d.gear >= 1 ? 'DOWN' : d.gear <= 0 ? 'UP' : 'TRANSIT';
      txt(ctx, `GEAR ${gearTxt}`, W * 0.72, 336, 12, d.gear >= 1 ? C.green : d.gear <= 0 ? C.white : C.amber, 'center', 700);
      if (d.speedbrake > 0.05) txt(ctx, 'SPEED BRAKE', W / 2, 356, 11, C.amber, 'center', 700);
      (d.alerts || []).slice(0, 3).forEach((a, i) => txt(ctx, a, W / 2, 374 + i * 16, 11, C.amber, 'center', 700));
      ctx.restore();
    }
  }

  SIM.Glass = { PFD, ND, EngineDisplay, COLORS: C };
})(window.SIM);
