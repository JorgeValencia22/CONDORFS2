/**
 * HUD — external-view flight data overlay (airspeed, altitude, heading ribbon, vertical speed,
 * throttle, flaps, gear, fuel, engine status, trim, brakes, autopilot modes, flight phase).
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;
  const { h, Fmt } = SIM.UI;

  class Hud {
    constructor(session) {
      this.s = session;
      this.el = h('div.hud', { 'aria-live': 'off' });
      const block = (cls, label) => {
        const v = h('div.hud-value.mono');
        const u = h('div.hud-unit');
        return { el: h(`div.hud-block.${cls}`, h('div.hud-label', label), v, u), v, u };
      };
      this.spd = block('left', 'IAS');
      this.alt = block('right', 'ALT');
      this.vs = h('div.hud-vs.mono');
      this.alt.el.append(this.vs);
      this.gsTxt = h('div.hud-sub.mono');
      this.spd.el.append(this.gsTxt);
      this.ribbon = h('canvas.hud-ribbon');
      this.ribbonCtx = SIM.UI.fitCanvas(this.ribbon, 360, 34);
      this.hdgTxt = h('div.hud-hdg.mono');
      this.top = h('div.hud-top', this.ribbon, this.hdgTxt);
      this.cells = {};
      const cell = (k, label) => (this.cells[k] = h('div.hud-cell', h('span.hud-cell-label', label), h('span.hud-cell-value.mono')));
      this.bottom = h('div.hud-bottom', cell('thr', 'THR'), cell('rpm', 'RPM'), cell('flaps', 'FLAPS'), cell('gear', 'GEAR'), cell('fuel', 'FUEL'), cell('eng', 'ENGINE'), cell('trim', 'TRIM'), cell('brk', 'BRAKE'), cell('ap', 'A/P'));
      this.phase = h('div.hud-phase.mono');
      this.warn = h('div.hud-warn');
      this.el.append(this.top, this.spd.el, this.alt.el, this.bottom, this.phase, this.warn);
    }

    set(k, text, cls) {
      const v = this.cells[k].lastChild;
      if (v.textContent !== text) v.textContent = text;
      this.cells[k].className = 'hud-cell' + (cls ? ' ' + cls : '');
    }

    drawRibbon(hdg) {
      const ctx = this.ribbonCtx, w = 360, hh = 34;
      ctx.clearRect(0, 0, w, hh);
      const ppd = w / 90;
      ctx.strokeStyle = 'rgba(220,255,230,0.85)';
      ctx.fillStyle = 'rgba(220,255,230,0.9)';
      ctx.font = '600 12px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      for (let a = Math.floor(hdg - 46); a <= hdg + 46; a++) {
        if (a % 5) continue;
        const x = w / 2 + (a - hdg) * ppd;
        const aa = M.wrap360(a);
        ctx.lineWidth = aa % 10 === 0 ? 1.6 : 1;
        ctx.beginPath();
        ctx.moveTo(x, hh);
        ctx.lineTo(x, hh - (aa % 10 === 0 ? 10 : 6));
        ctx.stroke();
        if (aa % 30 === 0) ctx.fillText({ 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[aa] || String(aa / 10).padStart(2, '0'), x, 12);
      }
      const bug = this.s.aircraft.autopilot.hdgBug;
      const bx = w / 2 + M.angleDiff(hdg, bug) * ppd;
      if (Math.abs(bx - w / 2) < w / 2) {
        ctx.fillStyle = '#ff9cff';
        ctx.fillRect(bx - 5, hh - 4, 10, 4);
      }
    }

    update() {
      const s = this.s;
      const ac = s.aircraft;
      const st = ac.state;
      const sys = ac.systems;
      this.spd.v.textContent = Fmt.speed(st.iasKt);
      this.spd.u.textContent = Fmt.speedUnit().toUpperCase();
      this.gsTxt.textContent = `GS ${Fmt.speed(st.gsKt)}  M${st.mach.toFixed(2)}`;
      this.alt.v.textContent = Fmt.alt(st.altFt);
      this.alt.u.textContent = `${Fmt.altUnit().toUpperCase()}  AGL ${Fmt.alt(st.aglFt)}`;
      const vs = st.vsFpm;
      this.vs.textContent = `${vs >= 0 ? '▲' : '▼'} ${Fmt.vs(Math.abs(vs))} ${Fmt.vsUnit()}`;
      this.vs.classList.toggle('neg', vs < -1500);
      this.hdgTxt.textContent = `${Fmt.hdg(st.headingDeg)}°  TRK ${Fmt.hdg(st.trackDeg)}°`;
      this.drawRibbon(st.headingDeg);
      const e = ac.engines;
      this.set('thr', `${Math.round(e[0].throttle * 100)}%${e[0].reverse ? ' REV' : ''}`);
      this.set('rpm', ac.isJet ? `N1 ${e.map((x) => x.n1.toFixed(0)).join('/')}` : e.map((x) => Math.round(x.rpm)).join('/'));
      this.set('flaps', sys.flapLabel(), sys.flaps.moving ? 'amber' : '');
      const gp = ac.cfg.gear.retractable ? sys.gear.pos : 1;
      this.set('gear', !ac.cfg.gear.retractable ? 'FIXED' : gp >= 1 ? 'DOWN' : gp <= 0 ? 'UP' : 'TRANSIT', gp > 0 && gp < 1 ? 'amber' : gp >= 1 ? 'green' : '');
      const pct = sys.totalFuel / sys.fuelCapacity;
      this.set('fuel', `${Math.round(pct * 100)}%`, sys.warnings.lowFuel ? 'red' : '');
      const states = Array.from(new Set(e.map((x) => x.state)));
      const failed = e.some((x) => x.failed);
      this.set('eng', failed ? 'FAILURE' : states.join('/'), failed || e.some((x) => x.state === 'DAMAGED') ? 'red' : e.some((x) => x.state === 'OVERPOWER') ? 'amber' : e.every((x) => x.running) ? 'green' : '');
      this.set('trim', `${ac.controls.elevatorTrim >= 0 ? '+' : ''}${(ac.controls.elevatorTrim * 100).toFixed(0)}`);
      this.set('brk', sys.brakes.parking ? 'PARK' : sys.brakes.left > 0.5 || sys.brakes.right > 0.5 ? 'ON' : 'OFF', sys.brakes.parking ? 'amber' : '');
      const ap = ac.autopilot.annunciation();
      this.set('ap', ac.autopilot.available ? (ap.ap ? `${ap.lat} ${ap.vert}` : ap.at ? 'A/T' : 'OFF') : '—', ap.ap ? 'green' : '');
      this.phase.textContent = `${s.state.state} · ${s.camera ? s.camera.label : 'INSTRUMENTS'}`;
      const w = sys.warnings;
      const warns = [];
      if (w.stall) warns.push('STALL');
      if (w.overspeed) warns.push('OVERSPEED');
      if (w.gear) warns.push('GEAR');
      if (ac.fm.gLoad > 3.5) warns.push(`${ac.fm.gLoad.toFixed(1)} G`);
      if (Math.abs(st.rollDeg) > 45 && !st.onGround) warns.push('BANK ANGLE');
      const txt = warns.join('  ·  ');
      if (this.warn.textContent !== txt) this.warn.textContent = txt;
      this.warn.classList.toggle('show', !!txt);
    }
  }

  SIM.Hud = Hud;
})(window.SIM);
