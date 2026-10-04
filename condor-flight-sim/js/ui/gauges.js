/**
 * Analog instruments rendered on canvas. Static dials are pre-rendered once; only needles and
 * moving cards are redrawn (at the instrument refresh rate). All values come from the simulation.
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;
  const { h, fitCanvas } = SIM.UI;
  const D = Math.PI / 180;
  const WHITE = '#ecebe6';
  const DIAL = '#0d0e10';
  const FONT = '"Barlow Condensed", "Arial Narrow", sans-serif';

  /* ------------------------------------------------------------------ helpers */

  function bezel(ctx, r) {
    const g = ctx.createRadialGradient(0, -r * 0.3, r * 0.2, 0, 0, r * 1.05);
    g.addColorStop(0, '#3b3e43');
    g.addColorStop(1, '#141517');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = DIAL;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.88, 0, Math.PI * 2);
    ctx.fill();
    // screws
    ctx.fillStyle = '#2a2c30';
    [45, 135, 225, 315].forEach((a) => {
      const x = Math.cos(a * D) * r * 0.95, y = Math.sin(a * D) * r * 0.95;
      ctx.beginPath();
      ctx.arc(x, y, r * 0.035, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  function glass(ctx, r) {
    const g = ctx.createLinearGradient(-r, -r, r * 0.4, r * 0.6);
    g.addColorStop(0, 'rgba(255,255,255,0.10)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.02)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.88, 0, Math.PI * 2);
    ctx.fill();
  }

  function ticks(ctx, r, a0, a1, n, len, width, color = WHITE) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    for (let i = 0; i <= n; i++) {
      const a = (a0 + ((a1 - a0) * i) / n) * D;
      ctx.beginPath();
      ctx.moveTo(Math.sin(a) * r, -Math.cos(a) * r);
      ctx.lineTo(Math.sin(a) * (r - len), -Math.cos(a) * (r - len));
      ctx.stroke();
    }
  }

  function arc(ctx, r, a0, a1, width, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.arc(0, 0, r, (a0 - 90) * D, (a1 - 90) * D);
    ctx.stroke();
  }

  function label(ctx, text, x, y, size, color = WHITE, weight = 600, align = 'center') {
    ctx.fillStyle = color;
    ctx.font = `${weight} ${size}px ${FONT}`;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
  }

  function needle(ctx, angleDeg, len, width, color = WHITE, tail = 0.18) {
    ctx.save();
    ctx.rotate(angleDeg * D);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(-width / 2, len * tail);
    ctx.lineTo(-width * 0.35, -len * 0.85);
    ctx.lineTo(0, -len);
    ctx.lineTo(width * 0.35, -len * 0.85);
    ctx.lineTo(width / 2, len * tail);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function hub(ctx, r) {
    ctx.fillStyle = '#1d1e21';
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#3a3c40';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function flag(ctx, text, x, y, w = 30) {
    ctx.fillStyle = '#c4302b';
    ctx.fillRect(x - w / 2, y - 7, w, 14);
    label(ctx, text, x, y + 0.5, 11, '#fff', 700);
  }

  /* ------------------------------------------------------------------ base class */

  class Gauge {
    constructor(size, name) {
      this.size = size;
      this.name = name;
      this.canvas = h('canvas.gauge', { 'aria-label': name, role: 'img' });
      this.ctx = fitCanvas(this.canvas, size, size);
      this.face = null;
      this.r = size / 2;
    }

    prepare() {
      const c = document.createElement('canvas');
      const ctx = fitCanvas(c, this.size, this.size);
      ctx.translate(this.r, this.r);
      bezel(ctx, this.r);
      this.drawFace(ctx, this.r);
      this.face = c;
    }

    drawFace() {}

    render(d) {
      if (!this.face) this.prepare();
      const ctx = this.ctx;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.drawImage(this.face, 0, 0);
      ctx.restore();
      ctx.save();
      ctx.translate(this.r, this.r);
      this.drawDynamic(ctx, this.r, d);
      glass(ctx, this.r);
      ctx.restore();
    }
  }

  /* ------------------------------------------------------------------ airspeed */

  class AirspeedIndicator extends Gauge {
    constructor(size, perf) {
      super(size, 'Airspeed indicator');
      this.perf = perf;
      this.max = Math.ceil((perf.vne * 1.15) / 20) * 20;
      this.min = perf.vs0 > 70 ? 40 : 20;
    }
    ang(kt) {
      // non-linear: lower part expanded like real ASIs
      const f = M.clamp((kt - this.min) / (this.max - this.min), 0, 1);
      return 22 + Math.pow(f, 0.9) * 316;
    }
    drawFace(ctx, r) {
      const p = this.perf;
      arc(ctx, r * 0.8, this.ang(p.vs0), this.ang(p.vfe), r * 0.05, '#e9e9e9');
      arc(ctx, r * 0.74, this.ang(p.vs1), this.ang(p.vno), r * 0.06, '#2fa84f');
      arc(ctx, r * 0.74, this.ang(p.vno), this.ang(p.vne), r * 0.06, '#e3b52b');
      ctx.save();
      ctx.rotate(this.ang(p.vne) * D);
      ctx.fillStyle = '#d6332c';
      ctx.fillRect(-r * 0.02, -r * 0.86, r * 0.04, r * 0.16);
      ctx.restore();
      const step = this.max > 260 ? 20 : 10;
      for (let v = this.min; v <= this.max; v += step) {
        const a = this.ang(v) * D;
        const major = v % (step * 2) === 0;
        ctx.strokeStyle = WHITE;
        ctx.lineWidth = major ? 2 : 1.2;
        ctx.beginPath();
        ctx.moveTo(Math.sin(a) * r * 0.86, -Math.cos(a) * r * 0.86);
        ctx.lineTo(Math.sin(a) * r * (major ? 0.72 : 0.77), -Math.cos(a) * r * (major ? 0.72 : 0.77));
        ctx.stroke();
        if (major) label(ctx, String(v), Math.sin(a) * r * 0.55, -Math.cos(a) * r * 0.55, r * 0.17);
      }
      label(ctx, 'AIRSPEED', 0, -r * 0.2, r * 0.1, '#9a9a96');
      label(ctx, 'KNOTS', 0, r * 0.25, r * 0.11, '#9a9a96');
    }
    drawDynamic(ctx, r, d) {
      needle(ctx, d.ias < this.min ? this.ang(this.min) - (this.min - Math.max(d.ias, 0)) * 0.8 : this.ang(d.ias), r * 0.8, r * 0.07);
      hub(ctx, r * 0.08);
    }
  }

  /* ------------------------------------------------------------------ attitude */

  class AttitudeIndicator extends Gauge {
    constructor(size) {
      super(size, 'Attitude indicator');
    }
    drawFace() {}
    drawDynamic(ctx, r, d) {
      const R = r * 0.86;
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, R, 0, Math.PI * 2);
      ctx.clip();
      ctx.rotate(-d.roll * D);
      const ppd = R / 25; // pixels per degree
      const off = M.clamp(d.pitch, -40, 40) * ppd;
      ctx.fillStyle = '#2f6fb3';
      ctx.fillRect(-R * 2, -R * 3 + off, R * 4, R * 3);
      ctx.fillStyle = '#7a4b25';
      ctx.fillRect(-R * 2, off, R * 4, R * 3);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-R * 2, off);
      ctx.lineTo(R * 2, off);
      ctx.stroke();
      ctx.lineWidth = 1.4;
      for (let p = -30; p <= 30; p += 5) {
        if (p === 0) continue;
        const y = off - p * ppd;
        const w = p % 10 === 0 ? R * 0.32 : R * 0.15;
        ctx.beginPath();
        ctx.moveTo(-w, y);
        ctx.lineTo(w, y);
        ctx.stroke();
        if (p % 10 === 0) {
          label(ctx, String(Math.abs(p)), -w - R * 0.12, y, R * 0.1, '#fff');
          label(ctx, String(Math.abs(p)), w + R * 0.12, y, R * 0.1, '#fff');
        }
      }
      // Roll scale (moves with the card)
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60].forEach((a) => {
        const rr = R * 0.92, l = Math.abs(a) % 30 === 0 ? R * 0.14 : R * 0.08;
        ctx.beginPath();
        ctx.moveTo(Math.sin(a * D) * rr, -Math.cos(a * D) * rr);
        ctx.lineTo(Math.sin(a * D) * (rr - l), -Math.cos(a * D) * (rr - l));
        ctx.stroke();
      });
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.moveTo(0, -R * 0.78);
      ctx.lineTo(-R * 0.06, -R * 0.9);
      ctx.lineTo(R * 0.06, -R * 0.9);
      ctx.fill();
      ctx.restore();
      // Fixed roll pointer and aircraft symbol
      ctx.fillStyle = '#ff8a1f';
      ctx.beginPath();
      ctx.moveTo(0, -R * 0.74);
      ctx.lineTo(-R * 0.06, -R * 0.63);
      ctx.lineTo(R * 0.06, -R * 0.63);
      ctx.fill();
      ctx.strokeStyle = '#ff8a1f';
      ctx.lineWidth = r * 0.05;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-R * 0.55, 0);
      ctx.lineTo(-R * 0.18, 0);
      ctx.lineTo(-R * 0.09, R * 0.09);
      ctx.moveTo(R * 0.55, 0);
      ctx.lineTo(R * 0.18, 0);
      ctx.lineTo(R * 0.09, R * 0.09);
      ctx.stroke();
      ctx.fillStyle = '#ff8a1f';
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.04, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineCap = 'butt';
      if (d.flag) flag(ctx, 'GYRO', 0, R * 0.55, 40);
    }
  }

  /* ------------------------------------------------------------------ altimeter */

  class Altimeter extends Gauge {
    constructor(size) {
      super(size, 'Altimeter');
    }
    drawFace(ctx, r) {
      ticks(ctx, r * 0.86, 0, 360, 50, r * 0.07, 1.2);
      ticks(ctx, r * 0.86, 0, 360, 10, r * 0.13, 2.2);
      for (let i = 0; i < 10; i++) {
        const a = i * 36 * D;
        label(ctx, String(i), Math.sin(a) * r * 0.62, -Math.cos(a) * r * 0.62, r * 0.2);
      }
      label(ctx, 'ALT', 0, -r * 0.3, r * 0.1, '#9a9a96');
      label(ctx, '100 FEET', 0, r * 0.27, r * 0.075, '#9a9a96');
    }
    drawDynamic(ctx, r, d) {
      // Kollsman window
      ctx.fillStyle = '#000';
      ctx.fillRect(r * 0.32, -r * 0.08, r * 0.42, r * 0.16);
      label(ctx, d.baroText, r * 0.53, 0, r * 0.12, '#fff', 600);
      const alt = d.alt;
      needle(ctx, (alt / 100000) * 360, r * 0.84, r * 0.03, '#d8d8d4', 0.05);
      needle(ctx, ((alt % 10000) / 10000) * 360, r * 0.5, r * 0.11);
      needle(ctx, ((alt % 1000) / 1000) * 360, r * 0.8, r * 0.07);
      hub(ctx, r * 0.07);
    }
  }

  /* ------------------------------------------------------------------ turn coordinator */

  class TurnCoordinator extends Gauge {
    constructor(size) {
      super(size, 'Turn coordinator');
    }
    drawFace(ctx, r) {
      ctx.strokeStyle = WHITE;
      ctx.lineWidth = 2.4;
      [-20, 0, 20].forEach((a) => {
        const aa = (a + 90) * D;
        ctx.beginPath();
        ctx.moveTo(-Math.cos(aa) * r * 0.62, -Math.sin(aa) * r * 0.25 + r * 0.05);
        ctx.lineTo(-Math.cos(aa) * r * 0.76, -Math.sin(aa) * r * 0.3 + r * 0.05);
        ctx.stroke();
      });
      label(ctx, 'L', -r * 0.66, r * 0.28, r * 0.13);
      label(ctx, 'R', r * 0.66, r * 0.28, r * 0.13);
      label(ctx, 'TURN COORDINATOR', 0, -r * 0.55, r * 0.085, '#9a9a96');
      label(ctx, '2 MIN', 0, r * 0.68, r * 0.085, '#9a9a96');
      // inclinometer tube
      ctx.fillStyle = '#1b1c1f';
      ctx.strokeStyle = '#555';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(0, r * 0.47, r * 0.42, r * 0.09, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = '#ddd';
      ctx.beginPath();
      ctx.moveTo(-r * 0.09, r * 0.39);
      ctx.lineTo(-r * 0.09, r * 0.55);
      ctx.moveTo(r * 0.09, r * 0.39);
      ctx.lineTo(r * 0.09, r * 0.55);
      ctx.stroke();
    }
    drawDynamic(ctx, r, d) {
      // ball
      const bx = M.clamp(d.slip * r * 1.6, -r * 0.33, r * 0.33);
      ctx.fillStyle = '#111';
      ctx.beginPath();
      ctx.arc(bx, r * 0.47, r * 0.075, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#bbb';
      ctx.stroke();
      // aircraft symbol rotates with turn rate (standard rate = 20°)
      ctx.save();
      ctx.translate(0, r * 0.05);
      ctx.rotate(M.clamp(d.turnRate / 3, -1.6, 1.6) * 20 * D);
      ctx.fillStyle = WHITE;
      ctx.fillRect(-r * 0.62, -r * 0.03, r * 1.24, r * 0.06);
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.1, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(-r * 0.02, -r * 0.2, r * 0.04, r * 0.12);
      ctx.fillRect(-r * 0.14, -r * 0.2, r * 0.28, r * 0.04);
      ctx.restore();
      if (d.flag) flag(ctx, 'OFF', 0, -r * 0.3, 36);
    }
  }

  /* ------------------------------------------------------------------ heading indicator */

  class HeadingIndicator extends Gauge {
    constructor(size) {
      super(size, 'Heading indicator');
    }
    drawDynamic(ctx, r, d) {
      ctx.save();
      ctx.rotate(-d.heading * D);
      for (let a = 0; a < 360; a += 5) {
        const major = a % 30 === 0, mid = a % 10 === 0;
        ctx.strokeStyle = WHITE;
        ctx.lineWidth = major ? 2 : 1.1;
        const l = major ? r * 0.13 : mid ? r * 0.1 : r * 0.06;
        ctx.beginPath();
        ctx.moveTo(Math.sin(a * D) * r * 0.84, -Math.cos(a * D) * r * 0.84);
        ctx.lineTo(Math.sin(a * D) * (r * 0.84 - l), -Math.cos(a * D) * (r * 0.84 - l));
        ctx.stroke();
        if (major) {
          ctx.save();
          ctx.rotate(a * D);
          const txt = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[a] || String(a / 10);
          label(ctx, txt, 0, -r * 0.6, r * (txt.length === 1 && /[NESW]/.test(txt) ? 0.19 : 0.15));
          ctx.restore();
        }
      }
      // heading bug
      ctx.rotate(d.bug * D);
      ctx.fillStyle = '#ff8a1f';
      ctx.fillRect(-r * 0.07, -r * 0.88, r * 0.05, r * 0.1);
      ctx.fillRect(r * 0.02, -r * 0.88, r * 0.05, r * 0.1);
      ctx.restore();
      // lubber line + aircraft
      ctx.fillStyle = '#ff8a1f';
      ctx.beginPath();
      ctx.moveTo(0, -r * 0.7);
      ctx.lineTo(-r * 0.05, -r * 0.82);
      ctx.lineTo(r * 0.05, -r * 0.82);
      ctx.fill();
      ctx.strokeStyle = '#ff8a1f';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(0, -r * 0.35);
      ctx.lineTo(0, r * 0.3);
      ctx.moveTo(-r * 0.3, -r * 0.02);
      ctx.lineTo(r * 0.3, -r * 0.02);
      ctx.moveTo(-r * 0.12, r * 0.25);
      ctx.lineTo(r * 0.12, r * 0.25);
      ctx.stroke();
      if (d.flag) flag(ctx, 'GYRO', 0, r * 0.45, 40);
    }
  }

  /* ------------------------------------------------------------------ VSI */

  class VerticalSpeedIndicator extends Gauge {
    constructor(size, maxFpm = 2000) {
      super(size, 'Vertical speed indicator');
      this.maxFpm = maxFpm;
    }
    ang(fpm) {
      return -90 + M.clamp(fpm / this.maxFpm, -1, 1) * 170;
    }
    drawFace(ctx, r) {
      const max = this.maxFpm;
      const step = max / 20;
      for (let v = -max; v <= max; v += step) {
        const a = this.ang(v) * D;
        const major = Math.round(v / step) % 5 === 0;
        ctx.strokeStyle = WHITE;
        ctx.lineWidth = major ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(Math.sin(a) * r * 0.85, -Math.cos(a) * r * 0.85);
        ctx.lineTo(Math.sin(a) * r * (major ? 0.72 : 0.78), -Math.cos(a) * r * (major ? 0.72 : 0.78));
        ctx.stroke();
        if (major) label(ctx, String(Math.abs(v / 100)), Math.sin(a) * r * 0.58, -Math.cos(a) * r * 0.58, r * 0.16);
      }
      label(ctx, 'UP', -r * 0.42, -r * 0.25, r * 0.1, '#9a9a96');
      label(ctx, 'DOWN', -r * 0.42, r * 0.25, r * 0.1, '#9a9a96');
      label(ctx, 'VERTICAL SPEED', r * 0.15, -r * 0.12, r * 0.075, '#9a9a96');
      label(ctx, '100 FT PER MIN', r * 0.15, r * 0.12, r * 0.075, '#9a9a96');
    }
    drawDynamic(ctx, r, d) {
      needle(ctx, this.ang(d.vs), r * 0.8, r * 0.07);
      hub(ctx, r * 0.07);
    }
  }

  /* ------------------------------------------------------------------ tachometer */

  class Tachometer extends Gauge {
    constructor(size, eng, twin = false) {
      super(size, 'Tachometer');
      this.eng = eng;
      this.twin = twin;
      this.max = 3500;
    }
    ang(rpm) {
      return -135 + M.clamp(rpm / this.max, 0, 1.05) * 270;
    }
    drawFace(ctx, r) {
      const e = this.eng;
      const greenLo = e.propType === 'constant' ? 2100 : Math.round(e.staticRPM * 0.92 / 100) * 100;
      arc(ctx, r * 0.78, this.ang(greenLo), this.ang(e.redline), r * 0.07, '#2fa84f');
      ctx.save();
      ctx.rotate(this.ang(e.redline) * D);
      ctx.fillStyle = '#d6332c';
      ctx.fillRect(-r * 0.02, -r * 0.86, r * 0.04, r * 0.16);
      ctx.restore();
      for (let v = 0; v <= this.max; v += 100) {
        const a = this.ang(v) * D;
        const major = v % 500 === 0;
        ctx.strokeStyle = WHITE;
        ctx.lineWidth = major ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(Math.sin(a) * r * 0.86, -Math.cos(a) * r * 0.86);
        ctx.lineTo(Math.sin(a) * r * (major ? 0.72 : 0.79), -Math.cos(a) * r * (major ? 0.72 : 0.79));
        ctx.stroke();
        if (major) label(ctx, String(v / 100), Math.sin(a) * r * 0.57, -Math.cos(a) * r * 0.57, r * 0.16);
      }
      label(ctx, 'RPM', 0, -r * 0.3, r * 0.11, '#9a9a96');
      label(ctx, 'x100', 0, -r * 0.17, r * 0.08, '#9a9a96');
    }
    drawDynamic(ctx, r, d) {
      if (!this.twin) {
        ctx.fillStyle = '#000';
        ctx.fillRect(-r * 0.28, r * 0.32, r * 0.56, r * 0.15);
        label(ctx, d.hours.toFixed(1).padStart(6, '0'), 0, r * 0.4, r * 0.12, '#e6e6e6', 500);
        needle(ctx, this.ang(d.rpm), r * 0.8, r * 0.07);
      } else {
        needle(ctx, this.ang(d.rpm2), r * 0.8, r * 0.06, '#c9c9c4');
        label(ctx, '2', Math.sin(this.ang(d.rpm2) * D) * r * 0.3, -Math.cos(this.ang(d.rpm2) * D) * r * 0.3, r * 0.12, '#000', 700);
        needle(ctx, this.ang(d.rpm), r * 0.8, r * 0.06);
      }
      hub(ctx, r * 0.07);
    }
  }

  /* ------------------------------------------------------------------ generic small arc gauge */

  class ArcGauge extends Gauge {
    /**
     * @param {object} o {min, max, green:[a,b], yellow, red:[a,b], title, unit, digits, labels:[...]}
     */
    constructor(size, o) {
      super(size, o.title);
      this.o = o;
    }
    ang(v) {
      return -120 + M.clamp((v - this.o.min) / (this.o.max - this.o.min), -0.02, 1.02) * 240;
    }
    drawFace(ctx, r) {
      const o = this.o;
      if (o.green) arc(ctx, r * 0.78, this.ang(o.green[0]), this.ang(o.green[1]), r * 0.08, '#2fa84f');
      if (o.yellow) arc(ctx, r * 0.78, this.ang(o.yellow[0]), this.ang(o.yellow[1]), r * 0.08, '#e3b52b');
      if (o.red) arc(ctx, r * 0.78, this.ang(o.red[0]), this.ang(o.red[1]), r * 0.08, '#d6332c');
      ticks(ctx, r * 0.86, -120, 120, o.ticks || 8, r * 0.1, 1.4);
      (o.labels || []).forEach((v) => {
        const a = this.ang(v) * D;
        label(ctx, String(v), Math.sin(a) * r * 0.55, -Math.cos(a) * r * 0.55, r * 0.17);
      });
      label(ctx, o.title, 0, r * 0.3, r * 0.14, '#b9b9b4');
      if (o.unit) label(ctx, o.unit, 0, r * 0.5, r * 0.11, '#8a8a86');
    }
    drawDynamic(ctx, r, d) {
      if (d.value2 !== undefined) {
        needle(ctx, this.ang(d.value2), r * 0.78, r * 0.07, '#c9c9c4');
      }
      needle(ctx, this.ang(d.value), r * 0.8, r * 0.08);
      hub(ctx, r * 0.08);
    }
  }

  /* ------------------------------------------------------------------ engine cluster (C172) */

  class EngineCluster {
    constructor(w, hgt, eng, fuelCfg) {
      this.w = w;
      this.h = hgt;
      this.eng = eng;
      this.fuelCfg = fuelCfg;
      this.canvas = h('canvas.gauge.cluster', { 'aria-label': 'Engine instruments', role: 'img' });
      this.ctx = fitCanvas(this.canvas, w, hgt);
    }
    half(ctx, x, y, w, hh, title, vL, vR, rangeL, rangeR, labL, labR, greenL, greenR) {
      ctx.save();
      ctx.translate(x, y);
      ctx.fillStyle = '#0d0e10';
      ctx.strokeStyle = '#2b2d31';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(0, 0, w, hh, 6) : ctx.rect(0, 0, w, hh);
      ctx.fill();
      ctx.stroke();
      const cx = w / 2, cy = hh * 0.82, R = Math.min(w * 0.42, hh * 0.72);
      const side = (val, range, sign, green, lab) => {
        const a0 = sign < 0 ? -80 : 80, a1 = sign < 0 ? -10 : 10;
        const angle = (v) => a0 + (M.clamp((v - range[0]) / (range[1] - range[0]), 0, 1)) * (a1 - a0);
        if (green) {
          ctx.strokeStyle = '#2fa84f';
          ctx.lineWidth = 4;
          ctx.beginPath();
          const s0 = (angle(green[0]) - 90) * D, s1 = (angle(green[1]) - 90) * D;
          ctx.arc(cx, cy, R * 0.92, Math.min(s0, s1), Math.max(s0, s1));
          ctx.stroke();
        }
        ctx.strokeStyle = WHITE;
        ctx.lineWidth = 1.2;
        for (let i = 0; i <= 4; i++) {
          const a = (a0 + ((a1 - a0) * i) / 4) * D;
          ctx.beginPath();
          ctx.moveTo(cx + Math.sin(a) * R, cy - Math.cos(a) * R);
          ctx.lineTo(cx + Math.sin(a) * R * 0.84, cy - Math.cos(a) * R * 0.84);
          ctx.stroke();
        }
        label(ctx, lab, cx + sign * R * 0.62, cy - R * 0.2, 10, '#9a9a96', 600);
        ctx.save();
        ctx.translate(cx, cy);
        needle(ctx, angle(val), R * 0.95, 4.5);
        ctx.restore();
      };
      side(vL, rangeL, -1, greenL, labL);
      side(vR, rangeR, 1, greenR, labR);
      ctx.fillStyle = '#1d1e21';
      ctx.beginPath();
      ctx.arc(cx, cy, 5, 0, Math.PI * 2);
      ctx.fill();
      label(ctx, title, cx, hh * 0.12, 10, '#b9b9b4', 700);
      ctx.restore();
    }
    render(d) {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.w, this.h);
      const gw = this.w / 2 - 4, gh = this.h / 2 - 4;
      const cap = this.fuelCfg.tanks[0].capacity;
      const fuelUnit = this.fuelCfg.unit === 'kg' ? 'KG' : 'GAL';
      this.half(ctx, 0, 0, gw, gh, `FUEL QTY ${fuelUnit}`, d.fuelL, d.fuelR, [0, cap], [0, cap], 'L', 'R', [cap * 0.15, cap], [cap * 0.15, cap]);
      this.half(ctx, gw + 8, 0, gw, gh, 'OIL', d.oilT, d.oilP, [40, 125], [0, 115], '°C', 'PSI', [38, 118], [50, 90]);
      this.half(ctx, 0, gh + 8, gw, gh, 'EGT  ·  FUEL FLOW', d.egt, d.ff, [300, 900], [0, this.eng.fuelFlowMax * 1.25], 'EGT', 'GPH', null, [0, this.eng.fuelFlowMax]);
      this.half(ctx, gw + 8, gh + 8, gw, gh, 'VAC  ·  AMP', d.vac, d.amp, [3, 7], [-60, 60], 'SUC', 'AMP', [4.5, 5.5], null);
    }
  }

  /* ------------------------------------------------------------------ CDI / ILS */

  class CourseIndicator extends Gauge {
    constructor(size, title = 'NAV 1') {
      super(size, 'Course deviation indicator');
      this.title = title;
    }
    drawDynamic(ctx, r, d) {
      // OBS card
      ctx.save();
      ctx.rotate(-d.course * D);
      for (let a = 0; a < 360; a += 10) {
        const major = a % 30 === 0;
        ctx.strokeStyle = WHITE;
        ctx.lineWidth = major ? 1.8 : 1;
        ctx.beginPath();
        ctx.moveTo(Math.sin(a * D) * r * 0.84, -Math.cos(a * D) * r * 0.84);
        ctx.lineTo(Math.sin(a * D) * r * (major ? 0.72 : 0.78), -Math.cos(a * D) * r * (major ? 0.72 : 0.78));
        ctx.stroke();
        if (major) {
          ctx.save();
          ctx.rotate(a * D);
          label(ctx, { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[a] || String(a / 10), 0, -r * 0.62, r * 0.13);
          ctx.restore();
        }
      }
      ctx.restore();
      // course index
      ctx.fillStyle = '#ff8a1f';
      ctx.beginPath();
      ctx.moveTo(0, -r * 0.7);
      ctx.lineTo(-r * 0.05, -r * 0.82);
      ctx.lineTo(r * 0.05, -r * 0.82);
      ctx.fill();
      // dots
      ctx.fillStyle = WHITE;
      for (let i = -5; i <= 5; i++) {
        if (!i) continue;
        ctx.beginPath();
        ctx.arc(i * r * 0.08, 0, r * 0.02, 0, Math.PI * 2);
        ctx.fill();
        if (d.gsValid !== undefined) {
          ctx.beginPath();
          ctx.arc(0, i * r * 0.08, r * 0.02, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.strokeStyle = WHITE;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.06, 0, Math.PI * 2);
      ctx.stroke();
      // CDI needle
      const dev = d.valid ? M.clamp(d.needle, -2.5, 2.5) : 0;
      ctx.strokeStyle = WHITE;
      ctx.lineWidth = r * 0.035;
      ctx.beginPath();
      ctx.moveTo(dev * r * 0.16, -r * 0.5);
      ctx.lineTo(dev * r * 0.16, r * 0.5);
      ctx.stroke();
      // Glideslope needle
      if (d.gsValid) {
        const gs = M.clamp(d.gsNeedle, -2.5, 2.5);
        ctx.beginPath();
        ctx.moveTo(-r * 0.5, -gs * r * 0.16);
        ctx.lineTo(r * 0.5, -gs * r * 0.16);
        ctx.stroke();
      }
      // flags
      if (!d.valid) flag(ctx, 'NAV', -r * 0.35, -r * 0.28, 34);
      else label(ctx, d.toFrom === 'TO' ? 'TO ▲' : d.toFrom === 'FROM' ? 'FR ▼' : '', r * 0.38, -r * 0.24, r * 0.11, '#fff', 700);
      if (d.gsValid === false && d.isIls) flag(ctx, 'GS', r * 0.35, r * 0.3, 28);
      label(ctx, d.source || this.title, 0, r * 0.33, r * 0.1, d.source === 'GPS' ? '#d24ad6' : '#3fd16f', 700);
      if (d.ident) label(ctx, d.ident, 0, r * 0.45, r * 0.09, '#9a9a96', 600);
    }
  }

  /* ------------------------------------------------------------------ magnetic compass strip */

  class CompassStrip {
    constructor(w, hh) {
      this.w = w;
      this.h = hh;
      this.canvas = h('canvas.gauge.compass', { 'aria-label': 'Magnetic compass', role: 'img' });
      this.ctx = fitCanvas(this.canvas, w, hh);
    }
    render(d) {
      const ctx = this.ctx, w = this.w, hh = this.h;
      ctx.clearRect(0, 0, w, hh);
      ctx.fillStyle = '#121315';
      ctx.fillRect(0, 0, w, hh);
      const pxPerDeg = w / 70;
      ctx.save();
      ctx.beginPath();
      ctx.rect(2, 2, w - 4, hh - 4);
      ctx.clip();
      for (let a = Math.floor(d.heading - 40); a <= d.heading + 40; a++) {
        if (a % 5) continue;
        const x = w / 2 + (a - d.heading) * pxPerDeg;
        const aa = M.wrap360(a);
        ctx.strokeStyle = '#e6e2d6';
        ctx.lineWidth = aa % 30 === 0 ? 1.6 : 1;
        ctx.beginPath();
        ctx.moveTo(x, hh * 0.62);
        ctx.lineTo(x, hh * (aa % 10 === 0 ? 0.38 : 0.5));
        ctx.stroke();
        if (aa % 30 === 0) label(ctx, { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[aa] || String(aa / 10), x, hh * 0.22, hh * 0.3, '#e6e2d6');
      }
      ctx.restore();
      ctx.strokeStyle = '#ff8a1f';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(w / 2, hh * 0.3);
      ctx.lineTo(w / 2, hh * 0.95);
      ctx.stroke();
    }
  }

  SIM.Gauges = { Gauge, AirspeedIndicator, AttitudeIndicator, Altimeter, TurnCoordinator, HeadingIndicator, VerticalSpeedIndicator, Tachometer, ArcGauge, EngineCluster, CourseIndicator, CompassStrip, draw: { label, needle, hub, bezel, glass, arc, ticks, flag } };
})(window.SIM);
