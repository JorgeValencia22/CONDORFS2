/**
 * Avionics units for the cockpit panel: COM/NAV radios, GPS navigator, GA autopilot, airliner MCP,
 * transponder, clock/OAT unit and track-up mini map. All units need avionics bus power.
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;
  const { h, icon, Fmt } = SIM.UI;
  const { Knob } = SIM.Widgets;
  const NM = SIM.Units.NM;
  const sound = () => SIM.app && SIM.app.audio;

  /** Unit wrapper that blanks when unpowered. */
  function unit(cls, title, ...children) {
    return h(`div.av-unit.${cls}`, h('div.av-title', title), ...children);
  }

  /* ------------------------------------------------------------------ COM/NAV */

  class RadioUnit {
    constructor(nav, n) {
      this.nav = nav;
      this.n = n;
      const radios = nav.radios;
      const mk = (name) => {
        const act = h('span.lcd-freq.active');
        const stby = h('button.lcd-freq.standby', { type: 'button', title: 'Click to type a frequency' });
        stby.addEventListener('click', () => this.typeFreq(name, stby));
        const swap = h('button.av-btn.swap', { type: 'button', title: `${name.toUpperCase()} swap active/standby`, onclick: () => {
          radios.swap(name);
          sound() && sound().click();
        } }, '⇆');
        const knob = new Knob(`${name.toUpperCase()} tune`, (dir, coarse) => radios.tune(name, dir, coarse), { small: true, noLabel: true });
        const coarse = h('button.av-btn.tiny', { type: 'button', title: 'MHz', onclick: (e) => radios.tune(name, e.shiftKey ? -1 : 1, true) }, 'MHz');
        return { name, act, stby, el: h('div.radio-half', h('span.radio-label', name.toUpperCase()), h('div.lcd', act, swap, stby), knob.el, coarse) };
      };
      this.com = mk('com' + n);
      this.navU = mk('nav' + n);
      this.el = unit('radio', `COM/NAV ${n}`, h('div.radio-row', this.com.el, this.navU.el), (this.ident = h('div.radio-ident.mono')));
    }
    typeFreq(name, el) {
      if (!this.nav.radios.powered) return;
      const input = h('input.freq-input.mono', { type: 'text', value: this.nav.radios.format(name, 'standby'), 'aria-label': `${name} standby frequency` });
      el.replaceWith(input);
      input.focus();
      input.select();
      const done = (ok) => {
        if (ok && !this.nav.radios.set(name, parseFloat(input.value.replace(',', '.')))) {
          SIM.events.emit('notify', { text: 'INVALID FREQUENCY', level: 'warn' });
        }
        input.replaceWith(el);
      };
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') done(true);
        if (e.key === 'Escape') done(false);
      });
      input.addEventListener('blur', () => input.isConnected && done(true));
    }
    update() {
      const r = this.nav.radios;
      const on = r.powered;
      this.el.classList.toggle('off', !on);
      [this.com, this.navU].forEach((u) => {
        u.act.textContent = on ? r.format(u.name, 'active') : '';
        u.stby.textContent = on ? r.format(u.name, 'standby') : '';
      });
      const rx = this.nav.receivers['nav' + this.n];
      this.ident.textContent = on && rx && rx.valid ? `${rx.ident}  ${rx.type}${rx.dist ? '  ' + (rx.dist / NM).toFixed(1) + ' NM' : ''}` : on ? '' : '';
    }
  }

  /* ------------------------------------------------------------------ GPS */

  class GpsUnit {
    constructor(session) {
      this.s = session;
      this.nav = session.nav;
      this.page = 'MAP';
      this.range = 10; // NM
      this.screen = h('div.gps-screen');
      this.dataBar = h('div.gps-data');
      this.body = h('div.gps-body');
      this.mapCanvas = h('canvas.gps-map');
      this.screen.append(this.dataBar, this.body);
      const btn = (label, fn, title) => h('button.av-btn', { type: 'button', title: title || label, onclick: () => {
        fn();
        sound() && sound().click(0.8);
      } }, label);
      this.el = unit('gps', 'GPS NAVIGATOR',
        h('div.gps-wrap',
          this.screen,
          h('div.gps-keys',
            btn('D→', () => this.setPage('DIRECT'), 'Direct-to'),
            btn('FPL', () => this.setPage('FPL'), 'Flight plan'),
            btn('NRST', () => this.setPage('NRST'), 'Nearest airports'),
            btn('MAP', () => this.setPage('MAP'), 'Moving map'),
            btn('RNG+', () => (this.range = Math.min(80, this.range * 2)), 'Zoom out'),
            btn('RNG−', () => (this.range = Math.max(2.5, this.range / 2)), 'Zoom in'),
            btn('CDI', () => this.nav.radios.toggleCdiSource(), 'Toggle CDI source GPS/VLOC'))));
      this.ctx = SIM.UI.fitCanvas(this.mapCanvas, 268, 108, 1, SIM.UI.canvasPixelRatio);
      this.render();
    }
    setPage(p) {
      this.page = p;
      this.render();
    }
    render() {
      this.body.innerHTML = '';
      const nav = this.nav;
      if (this.page === 'MAP') {
        this.body.append(this.mapCanvas);
      } else if (this.page === 'DIRECT') {
        const input = h('input.gps-input.mono', { type: 'text', placeholder: 'IDENT', maxLength: 6, 'aria-label': 'Direct-to identifier' });
        const list = h('div.gps-list');
        const fill = () => {
          list.innerHTML = '';
          nav.search(input.value, 5).forEach((w) => list.append(h('button.gps-item', { type: 'button', onclick: () => {
            nav.directTo(w);
            this.setPage('MAP');
          } }, h('span', w.ident), h('span.dim', w.type), h('span.dim', w.name.slice(0, 18)))));
        };
        input.addEventListener('input', fill);
        input.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            const w = nav.find(input.value) || nav.search(input.value, 1)[0];
            if (w) {
              nav.directTo(w);
              this.setPage('MAP');
            }
          }
        });
        this.body.append(h('div.gps-page-title', 'DIRECT TO'), input, list);
        fill();
        setTimeout(() => input.focus(), 30);
      } else if (this.page === 'NRST') {
        const list = h('div.gps-list');
        const p = this.s.aircraft.fm.pos;
        nav.nearest(6, 'APT').forEach((w) => {
          const d = Math.hypot(w.x - p.x, w.z - p.z);
          const brg = nav.toMag(SIM.Geo.bearing(p.x, p.z, w.x, w.z));
          list.append(h('button.gps-item', { type: 'button', onclick: () => {
            nav.directTo(w);
            this.setPage('MAP');
          } }, h('span', w.ident), h('span', `${Fmt.hdg(brg)}°`), h('span', `${(d / NM).toFixed(1)}NM`)));
        });
        this.body.append(h('div.gps-page-title', 'NEAREST AIRPORTS'), list);
      } else if (this.page === 'FPL') {
        const list = h('div.gps-list');
        if (!nav.route.length) list.append(h('div.dim', 'NO FLIGHT PLAN — use the map (M) or D→'));
        nav.route.forEach((w, i) => list.append(h('button.gps-item', { className: i === nav.activeLeg ? 'active' : '', type: 'button', onclick: () => {
          nav.directTo(w);
        } }, h('span', `${i === nav.activeLeg ? '▶' : ' '} ${w.ident}`), h('span.dim', w.type), h('span.dim', w.name.slice(0, 14)))));
        this.body.append(h('div.gps-page-title', 'ACTIVE FLIGHT PLAN'), list);
      }
    }
    update() {
      const on = this.nav.radios.powered;
      this.el.classList.toggle('off', !on);
      if (!on) return;
      const g = this.nav.gps;
      const f = (k, v) => `<span><b>${k}</b>${v}</span>`;
      this.dataBar.innerHTML = [
        f('GS', `${Math.round(g.gsKt || 0)}KT`),
        f('DTK', g.wp ? `${Fmt.hdg(g.dtk)}°` : '___'),
        f('TRK', `${Fmt.hdg(g.trk || 0)}°`),
        f('DIS', g.wp ? `${(g.dist / NM).toFixed(1)}NM` : '__._'),
        f('ETE', g.wp ? SIM.NavigationSystem.formatTime(g.ete) : '__:__'),
        f('ETA', g.wp ? SIM.NavigationSystem.formatClock(g.eta) : '__:__'),
        f('WPT', g.wp ? g.wp.ident : '____'),
        f('XTK', g.wp ? `${(Math.abs(g.xtk) / NM).toFixed(2)}${g.xtk > 0 ? 'R' : 'L'}` : '_.__'),
      ].join('');
      if (this.page === 'MAP') {
        const s = this.s;
        const v = { cx: s.aircraft.fm.pos.x, cz: s.aircraft.fm.pos.z, scale: 54 / (this.range * NM), rot: s.aircraft.state.trueTrackDeg * M.DEG, w: 268, h: 108, mini: true };
        s.mapRenderer.draw(this.ctx, v);
        this.ctx.fillStyle = '#e9e9e9';
        this.ctx.font = '500 10px "JetBrains Mono", monospace';
        this.ctx.fillText(`${this.range}NM`, 6, 102);
        this.ctx.fillText('TRK UP', 222, 12);
        this.ctx.fillText(`POS ${SIM.Geo.formatLat(g.lat)} ${SIM.Geo.formatLon(g.lon)}`, 6, 12);
      }
      if (this.page === 'FPL' && this._leg !== this.nav.activeLeg + ':' + this.nav.route.length) {
        this._leg = this.nav.activeLeg + ':' + this.nav.route.length;
        this.render();
      }
    }
  }

  /* ------------------------------------------------------------------ GA autopilot */

  class AutopilotUnit {
    constructor(ac) {
      this.ap = ac.autopilot;
      this.display = h('div.ap-display.mono');
      const b = (label, fn, cls = '') => h(`button.av-btn${cls}`, { type: 'button', onclick: () => {
        fn();
        sound() && sound().click(0.8);
      } }, label);
      const ap = this.ap;
      this.el = unit('ap', 'AUTOPILOT',
        this.display,
        h('div.ap-keys',
          b('AP', () => ap.toggleAP(), '.ap-key'),
          b('HDG', () => ap.setLateral('HDG')),
          b('NAV', () => ap.setLateral('NAV')),
          b('APR', () => ap.setLateral('APR')),
          b('ALT', () => ap.setVertical('ALT')),
          b('VS', () => ap.setVertical('VS')),
          b('UP', () => ap.adjustVS(100)),
          b('DN', () => ap.adjustVS(-100))),
        h('div.ap-knobs',
          new Knob('HDG', (d, c) => ap.adjustHeading(d * (c ? 10 : 1)), { small: true }).el,
          new Knob('ALT SEL', (d, c) => ap.adjustAltitude(d * (c ? 1000 : 100)), { small: true }).el));
    }
    update() {
      const ap = this.ap;
      const a = ap.annunciation();
      this.el.classList.toggle('off', !ap.powered);
      if (!ap.powered) {
        this.display.innerHTML = '';
        return;
      }
      const flash = ap.disconnectFlash > 0 && Math.floor(ap.disconnectFlash * 4) % 2 === 0;
      this.display.innerHTML = `<div class="ap-row"><span class="ap-mode ${a.ap ? 'on' : ''}">${flash ? 'AP' : a.ap ? 'AP' : '  '}</span><span>${a.lat || ''}</span><span>${a.vert || ''}</span></div>
        <div class="ap-row dim"><span>ARM ${a.armed || '--'}</span><span>HDG ${Fmt.hdg(ap.hdgBug)}</span></div>
        <div class="ap-row"><span>ALT ${Math.round(ap.altTarget)}</span><span>VS ${ap.vsTarget > 0 ? '+' : ''}${ap.vsTarget}</span></div>`;
    }
  }

  /* ------------------------------------------------------------------ airliner MCP */

  class McpUnit {
    constructor(ac, nav) {
      this.ac = ac;
      this.ap = ac.autopilot;
      this.nav = nav;
      const ap = this.ap;
      const win = (id) => h(`span.mcp-win.mono#${id}`);
      const b = (label, fn, key) => {
        const el = h('button.mcp-btn', { type: 'button', onclick: () => {
          fn();
          sound() && sound().click(0.8);
        } }, h('span.mcp-led'), label);
        if (key) this.leds[key] = el;
        return el;
      };
      this.leds = {};
      this.win = { spd: win('mcp-spd'), hdg: win('mcp-hdg'), alt: win('mcp-alt'), vs: win('mcp-vs'), crs: win('mcp-crs') };
      const group = (title, w, knob, ...btns) => h('div.mcp-group', h('span.mcp-label', title), w, knob ? knob.el : null, h('div.mcp-btns', btns));
      this.el = unit('mcp', 'MODE CONTROL PANEL',
        h('div.mcp-row',
          group('COURSE', this.win.crs, new Knob('CRS', (d, c) => nav.radios.adjustObs('nav1', d * (c ? 10 : 1)), { small: true, noLabel: true })),
          group('A/T · IAS', this.win.spd, new Knob('SPD', (d, c) => ap.adjustSpeed(d * (c ? 10 : 1)), { small: true, noLabel: true }), b('A/T', () => ap.toggleAutothrottle(), 'at')),
          group('HEADING', this.win.hdg, new Knob('HDG', (d, c) => ap.adjustHeading(d * (c ? 10 : 1)), { small: true, noLabel: true }), b('HDG SEL', () => ap.setLateral('HDG'), 'HDG'), b('LNAV', () => ap.setLateral('NAV'), 'NAV'), b('APP', () => ap.setLateral('APR'), 'APR')),
          group('ALTITUDE', this.win.alt, new Knob('ALT', (d, c) => ap.adjustAltitude(d * (c ? 1000 : 100)), { small: true, noLabel: true }), b('ALT HLD', () => ap.setVertical('ALT'), 'ALT')),
          group('V/S', this.win.vs, new Knob('VS', (d) => ap.adjustVS(d * 100), { small: true, noLabel: true }), b('V/S', () => ap.setVertical('VS'), 'VS')),
          h('div.mcp-group', h('span.mcp-label', 'A/P ENGAGE'), b('CMD A', () => ap.toggleAP(), 'ap'))));
    }
    update() {
      const ap = this.ap;
      const on = ap.powered;
      this.el.classList.toggle('off', !on);
      if (!on) return;
      this.win.spd.textContent = String(Math.round(ap.spdTarget));
      this.win.hdg.textContent = Fmt.hdg(ap.hdgBug);
      this.win.alt.textContent = String(Math.round(ap.altTarget));
      this.win.vs.textContent = ap.vertical === 'VS' && ap.engaged ? `${ap.vsTarget > 0 ? '+' : ''}${ap.vsTarget}` : '';
      this.win.crs.textContent = Fmt.hdg(this.nav.radios.obs.nav1);
      const lit = (k, v) => this.leds[k] && this.leds[k].classList.toggle('lit', !!v);
      lit('at', ap.atEngaged);
      lit('ap', ap.engaged);
      lit('HDG', ap.engaged && ap.lateral === 'HDG');
      lit('NAV', ap.engaged && (ap.lateral === 'NAV' || ap.armedLateral === 'NAV'));
      lit('APR', ap.engaged && (ap.lateral === 'APR' || ap.armedLateral === 'APR'));
      lit('ALT', ap.engaged && ap.vertical === 'ALT');
      lit('VS', ap.engaged && ap.vertical === 'VS');
    }
  }

  /* ------------------------------------------------------------------ transponder */

  class TransponderUnit {
    constructor(nav) {
      this.nav = nav;
      this.digits = [0, 1, 2, 3].map((i) => h('button.xpdr-digit.mono', { type: 'button', title: 'Click to change digit (right-click: down)', onclick: () => this.bump(i, 1), oncontextmenu: (e) => {
        e.preventDefault();
        this.bump(i, -1);
      } }));
      this.modeBtns = ['STBY', 'ALT'].map((m) => h('button.av-btn.tiny', { type: 'button', onclick: () => (nav.radios.xpdr.mode = m) }, m));
      this.ident = h('button.av-btn.tiny', { type: 'button', onclick: () => (nav.radios.xpdr.ident = 18) }, 'IDENT');
      this.el = unit('xpdr', 'TRANSPONDER', h('div.xpdr-row', h('div.lcd.xpdr-lcd', this.digits, (this.modeLbl = h('span.xpdr-mode'))), this.modeBtns, this.ident,
        h('button.av-btn.tiny', { type: 'button', title: 'VFR code', onclick: () => nav.radios.setSquawk(1200) }, 'VFR')));
    }
    bump(i, d) {
      const x = this.nav.radios.xpdr;
      const s = String(x.code).padStart(4, '0').split('').map(Number);
      s[i] = (s[i] + d + 8) % 8;
      this.nav.radios.setSquawk(s.join(''));
    }
    update(dt = 0.1) {
      const x = this.nav.radios.xpdr;
      const on = this.nav.radios.powered;
      this.el.classList.toggle('off', !on);
      const s = String(x.code).padStart(4, '0');
      this.digits.forEach((d, i) => (d.textContent = on ? s[i] : ''));
      if (x.ident > 0) x.ident -= dt;
      this.modeLbl.textContent = on ? (x.ident > 0 ? 'IDENT' : x.mode === 'ALT' ? 'ALT  R' : 'STBY') : '';
      this.modeBtns.forEach((b) => b.classList.toggle('active', b.textContent === x.mode));
    }
  }

  /* ------------------------------------------------------------------ clock / OAT / volts */

  class ClockUnit {
    constructor(session) {
      this.s = session;
      this.el = h('div.clock-unit.mono', (this.l1 = h('div')), (this.l2 = h('div.dim')));
    }
    update() {
      const s = this.s;
      const on = s.aircraft.systems.elec.busPowered;
      this.el.classList.toggle('off', !on);
      if (!on) return;
      const atm = s.world.weather.atmosphereAt(s.aircraft.fm.pos.y);
      this.l1.textContent = `${SIM.UI.Fmt.clock(s.hour)} LCL`;
      this.l2.textContent = `OAT ${Math.round(atm.tempC)}°C  ${s.aircraft.systems.elec.busVolts.toFixed(1)}V`;
    }
  }

  /* ------------------------------------------------------------------ mini map */

  class MiniMap {
    constructor(session, w = 210, hh = 150) {
      this.s = session;
      this.w = w;
      this.h = hh;
      this.range = 8;
      this.canvas = h('canvas.minimap');
      this.ctx = SIM.UI.fitCanvas(this.canvas, w, hh, 1, SIM.UI.canvasPixelRatio);
      this.el = unit('minimap', 'MAP',
        this.canvas,
        h('div.minimap-btns',
          h('button.av-btn.tiny', { type: 'button', onclick: () => (this.range = Math.max(2, this.range / 2)) }, '−'),
          h('button.av-btn.tiny', { type: 'button', onclick: () => (this.range = Math.min(64, this.range * 2)) }, '+'),
          h('button.av-btn.tiny', { type: 'button', onclick: () => SIM.events.emit('action', { id: 'map' }) }, 'FULL')));
    }
    update() {
      const s = this.s;
      const on = s.aircraft.systems.elec.avionicsPowered;
      this.el.classList.toggle('off', !on);
      if (!on) {
        this.ctx.fillStyle = '#050607';
        this.ctx.fillRect(0, 0, this.w, this.h);
        return;
      }
      const v = { cx: s.aircraft.fm.pos.x, cz: s.aircraft.fm.pos.z, scale: (this.h * 0.45) / (this.range * NM), rot: s.aircraft.state.trueTrackDeg * M.DEG, w: this.w, h: this.h, mini: true };
      s.mapRenderer.draw(this.ctx, v);
      this.ctx.fillStyle = '#e8e8e8';
      this.ctx.font = '500 10px "JetBrains Mono", monospace';
      this.ctx.fillText(`${this.range} NM`, 5, this.h - 6);
    }
  }

  SIM.Avionics = { RadioUnit, GpsUnit, AutopilotUnit, McpUnit, TransponderUnit, ClockUnit, MiniMap };
})(window.SIM);
