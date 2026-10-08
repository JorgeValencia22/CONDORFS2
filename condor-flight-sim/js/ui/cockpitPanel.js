/**
 * CockpitPanel — interactive 2D instrument panel, different for each aircraft layout:
 *  - 'ga'       : six-pack, NAV CDIs, tachometer, engine cluster, radios, GPS, autopilot (C172/C152/PA-28)
 *  - 'ga-twin'  : six-pack plus twin engine gauges, prop levers, gear handle and lights (Baron)
 *  - 'airliner' : PFD/ND/engine display, MCP, start/fuel-control switches, thrust/speed brake levers (737)
 *
 * InstrumentModel turns the true aircraft state into what the instruments show (gyro spin-up and
 * tumbling, heading-indicator precession, VSI lag, pitot icing, compass oscillation, power loss).
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;
  const { h, Fmt } = SIM.UI;
  const G = SIM.Gauges;
  const W = SIM.Widgets;
  const A = SIM.Avionics;

  const SWITCH_TEXT = { batt: 'BAT', alt: 'ALT', gen: 'GEN', avionics: 'AVIONICS', beacon: 'BCN', land: 'LAND', taxi: 'TAXI', nav: 'NAV', strobe: 'STROBE', pitot: 'PITOT HT', panel: 'PANEL LT', pump: 'FUEL PUMP', logo: 'LOGO' };

  /* ================================================================== instrument model */

  class InstrumentModel {
    constructor(ac) {
      this.ac = ac;
      ac.updateState();
      this.ai = { pitch: ac.state.pitchDeg, roll: ac.state.rollDeg };
      this.hi = ac.state.headingDeg;
      this.prevHdg = ac.state.headingDeg;
      this.vsi = 0;
      this.compass = ac.state.headingDeg;
      this.compassVel = 0;
      this.turnRate = 0;
      this.t = 0;
      this.drift = ac.realismScale >= 1 ? (Math.random() - 0.5) * 0.012 : 0; // deg/s precession
    }

    update(dt) {
      const ac = this.ac;
      const s = ac.state;
      const sys = ac.systems;
      this.t += dt;
      const spin = sys.gyro.spin;
      // Attitude: precise when spun up, sluggish and wandering when vacuum fails
      const err = (1 - M.clamp(spin, 0, 1)) * 25;
      const tp = s.pitchDeg + Math.sin(this.t * 0.31) * err;
      const tr = s.rollDeg + Math.sin(this.t * 0.23 + 1) * err * 1.6;
      const k = spin > 0.3 ? 4 + 8 * spin : 0.15;
      this.ai.pitch = M.damp(this.ai.pitch, tp, k, dt);
      this.ai.roll = M.damp(this.ai.roll, tr, k, dt);
      // Heading indicator: integrates heading changes, precesses, freezes without vacuum
      const dh = M.angleDiff(this.prevHdg, s.headingDeg);
      this.prevHdg = s.headingDeg;
      this.hi = M.wrap360(this.hi + dh * M.clamp(spin * 1.2, 0, 1) + this.drift * dt + (1 - spin) * Math.sin(this.t * 0.17) * 0.05);
      // Turn rate (electric gyro) and VSI lag
      const rate = dt > 0 ? dh / dt : 0;
      this.turnRate = M.damp(this.turnRate, rate * sys.gyro.elecSpin, 3, dt);
      this.vsi = M.damp(this.vsi, s.vsFpm, ac.isJet ? 4 : 1.1, dt);
      // Magnetic compass: damped oscillation with acceleration error
      const target = s.headingDeg + (ac.isJet ? 0 : M.clamp(-ac.fm.lateralG * 25, -15, 15));
      const acc = M.angleDiff(this.compass, target) * 6 - this.compassVel * 2.2;
      this.compassVel += acc * dt;
      this.compass = M.wrap360(this.compass + this.compassVel * dt);
    }

    syncHeading() {
      this.hi = this.ac.state.headingDeg;
    }

    get ias() {
      const ac = this.ac;
      const p = ac.systems.pitot;
      const ias = ac.state.iasKt;
      if (p.ice < 0.05) return ias;
      // Blocked pitot: reads like an altimeter (static still open)
      const frozen = p.frozenIas / SIM.Units.KT + (ac.state.altFtTrue - (this._iceAlt ?? (this._iceAlt = ac.state.altFtTrue))) * 0.01;
      return M.lerp(ias, frozen, M.smoothstep(0.3, 0.9, p.ice));
    }
  }

  /* ================================================================== panel */

  class CockpitPanel {
    constructor(session) {
      this.s = session;
      this.ac = session.aircraft;
      this.nav = session.nav;
      this.cfg = this.ac.cfg;
      this.layout = this.cfg.cockpit.layout;
      this.im = new InstrumentModel(this.ac);
      this.widgets = [];
      this.gauges = [];
      /** Instruments by key: { factory, data } — the 3D cockpit builds its own copies from these. */
      this.spec = {};
      this.units = [];
      this.timer = 0;
      this.wtimer = 0;
      this.visible = true;
      this.root = h('div.cockpit-panel', { role: 'region', 'aria-label': `${this.cfg.name} instrument panel` });
      this.inner = h(`div.cp-inner.layout-${this.layout}`);
      this.root.append(this.inner);
      this.root.style.setProperty('--panel', this.cfg.cockpit.panelColor);
      this.root.style.setProperty('--panel-edge', this.cfg.cockpit.panelEdge);
      // The panel is CSS-scaled to the window: draw its canvases at the final on-screen density
      const lh = this.layout === 'airliner' ? 548 : 466;
      const shown = Math.min(window.innerWidth / 1600, (window.innerHeight * (window.innerWidth < 900 ? 0.4 : 0.44)) / lh);
      SIM.UI.canvasPixelRatio = Math.min(window.devicePixelRatio || 1, 2) * Math.max(1, shown);
      try {
        if (this.layout === 'airliner') this.buildAirliner();
        else this.buildGA(this.layout === 'ga-twin');
      } finally {
        SIM.UI.canvasPixelRatio = null;
      }
      this.logicalW = 1600;
      this.logicalH = this.layout === 'airliner' ? 548 : 466;
      this.inner.style.width = this.logicalW + 'px';
      this.inner.style.height = this.logicalH + 'px';
    }

    w(widget) {
      this.widgets.push(widget);
      return widget.el;
    }

    /** Creates a keyed instrument from a factory and registers it for the panel and the 3D cockpit. */
    mk(key, factory, data) {
      const gauge = factory();
      this.spec[key] = { factory, data };
      this.gauges.push({ gauge, data });
      return gauge;
    }

    g(gauge, data, cls = '') {
      this.gauges.push({ gauge, data });
      return h(`div.gauge-wrap${cls}`, gauge.canvas);
    }

    u(unit) {
      this.units.push(unit);
      return unit.el;
    }

    /* ------------------------------------------------------------------ shared builders */

    sixPack(size) {
      const ac = this.ac, im = this.im, perf = this.cfg.performance;
      const inHg = () => this.s.region.id === 'sfbay' && !this.s.app.settings.metric;
      const asi = this.mk('asi', () => new G.AirspeedIndicator(size, perf), () => ({ ias: im.ias }));
      const ai = this.mk('ai', () => new G.AttitudeIndicator(size), () => ({ pitch: im.ai.pitch, roll: im.ai.roll, flag: ac.systems.gyro.spin < 0.45 }));
      const alt = this.mk('alt', () => new G.Altimeter(size), () => ({ alt: ac.state.altFt, baroText: inHg() ? (ac.kollsman / SIM.Units.INHG).toFixed(2) : Math.round(ac.kollsman).toString() }));
      const tc = this.mk('tc', () => new G.TurnCoordinator(size), () => ({ turnRate: im.turnRate, slip: M.clamp(ac.fm.lateralG || 0, -0.4, 0.4), flag: ac.systems.gyro.elecSpin < 0.5 }));
      const hi = this.mk('hi', () => new G.HeadingIndicator(size), () => ({ heading: im.hi, bug: ac.autopilot.hdgBug, flag: ac.systems.gyro.spin < 0.45 }));
      const vsi = this.mk('vsi', () => new G.VerticalSpeedIndicator(size, 2000), () => ({ vs: im.vsi }));
      const baroKnob = new W.Knob('BARO', (d, c) => (ac.kollsman = M.clamp(ac.kollsman + d * (c ? 3.39 : 1), 940, 1060)), { small: true, noLabel: true });
      const hdgKnob = new W.Knob('HDG BUG', (d, c) => ac.autopilot.adjustHeading(d * (c ? 10 : 1)), { small: true, noLabel: true });
      const syncBtn = h('button.gauge-btn', { type: 'button', title: 'Sync heading indicator to compass', onclick: () => im.syncHeading() }, 'SYNC');
      const stdBtn = h('button.gauge-btn', { type: 'button', title: 'Set altimeter to current QNH', onclick: () => (ac.kollsman = this.s.world.weather.qnh) }, 'QNH');
      return h('div.cp-sixpack',
        h('div.gauge-wrap', asi.canvas),
        h('div.gauge-wrap', ai.canvas),
        h('div.gauge-wrap', alt.canvas, h('div.gauge-knobs.left', baroKnob.el, stdBtn)),
        h('div.gauge-wrap', tc.canvas),
        h('div.gauge-wrap', hi.canvas, h('div.gauge-knobs.left', syncBtn), h('div.gauge-knobs.right', hdgKnob.el)),
        h('div.gauge-wrap', vsi.canvas));
    }

    cdi(size, n) {
      const nav = this.nav;
      const obs = new W.Knob('OBS', (d, c) => {
        if (n === 1 && nav.radios.cdiSource === 'GPS') return;
        nav.radios.adjustObs('nav' + n, d * (c ? 10 : 1));
      }, { small: true, noLabel: true });
      const data = () => {
        if (!nav.radios.powered) return { valid: false, course: nav.radios.obs['nav' + n], needle: 0 };
        if (n === 1) {
          const c = nav.cdi();
          return { valid: c.valid, course: c.source === 'GPS' ? (c.course ?? 0) : nav.radios.obs.nav1, needle: c.needle || 0, toFrom: c.toFrom, source: c.source === 'GPS' ? 'GPS' : 'VLOC 1', ident: c.ident, gsValid: c.type === 'ILS' ? c.gsValid : undefined, gsNeedle: c.gsNeedle, isIls: c.type === 'ILS' };
        }
        const r = nav.receivers.nav2;
        return { valid: r.valid, course: nav.radios.obs.nav2, needle: r.needle || 0, toFrom: r.toFrom, source: 'VLOC 2', ident: r.ident };
      };
      const gauge = this.mk('cdi' + n, () => new G.CourseIndicator(size, `NAV ${n}`), data);
      return h('div.gauge-wrap', gauge.canvas, h('div.gauge-knobs.left', obs.el));
    }

    switches() {
      const sys = this.ac.systems;
      return h('div.cp-switches', this.cfg.cockpit.switches.map((name) => this.w(new W.Switch(SWITCH_TEXT[name] || name.toUpperCase(), () => sys.switches[name], () => sys.toggleSwitch(name), { color: name === 'batt' || name === 'alt' || name === 'gen' ? '#a8322b' : undefined }))));
    }

    ignition(engineIdx = 0, label = 'IGNITION') {
      const e = this.ac.engines[engineIdx];
      return this.w(new W.Selector(label, SIM.MAG_LABELS, () => e.magnetos, (i) => {
        e.magnetos = i;
        if (i !== SIM.MAG.START) e.starter = false;
      }, {
        kind: 'rotary',
        span: 200,
        hold: {
          index: SIM.MAG.START,
          onDown: () => {
            e.magnetos = SIM.MAG.START;
            e.starter = true;
          },
          onUp: () => {
            if (e.magnetos === SIM.MAG.START) {
              e.starter = false;
              e.magnetos = SIM.MAG.BOTH;
            }
          },
        },
      }));
    }

    fuelSelector(i = 0, label = 'FUEL') {
      const sys = this.ac.systems;
      const opts = this.cfg.fuel.selector;
      return this.w(new W.Selector(label, opts, () => opts.indexOf(sys.fuelSelectors[i]), (k) => sys.setFuelSelector(i, opts[k]), { kind: 'rotary', span: opts.length > 2 ? 270 : 90 }));
    }

    flapSelector() {
      const sys = this.ac.systems;
      const flaps = this.cfg.aero.flaps;
      const labels = flaps.map((f, i) => (f.label ? f.label : i === 0 ? 'UP' : `${f.deg}°`));
      const maxDeg = flaps[flaps.length - 1].deg;
      return this.w(new W.Selector('FLAPS', labels, () => sys.flaps.handle, (i) => sys.setFlapsHandle(i), { kind: 'flap', indicator: () => sys.flaps.pos / maxDeg }));
    }

    trim() {
      const c = this.ac.controls;
      return this.w(new W.TrimWheel('TRIM', () => c.elevatorTrim, (d) => (c.elevatorTrim = M.clamp(c.elevatorTrim + d, -1, 1))));
    }

    parkingBrake() {
      const sys = this.ac.systems;
      return this.w(new W.PullKnob('PARK BRK', () => sys.brakes.parking, () => sys.toggleParkingBrake(), { color: '#8a1d17' }));
    }

    yoke() {
      return this.w(new W.Yoke(this.s.app.input, () => this.ac.controls, { airliner: this.layout === 'airliner' }));
    }

    annunciators() {
      const sys = this.ac.systems;
      const names = ['VOLTS', 'OIL PRESS', 'L FUEL', 'R FUEL', 'VAC', 'STALL'];
      if (this.cfg.gear.retractable) names.push('GEAR');
      return this.w(new W.Annunciators(names, () => sys.annunciators(), (v) => (sys.annunciatorTest = v)));
    }

    gearHandle() {
      const sys = this.ac.systems;
      const lights = [0, 1, 2].map(() => h('span.gear-light'));
      const el = h('div.cp-gear', h('div.gear-lights', lights), this.w(new W.Selector('GEAR', ['UP', 'DN'], () => sys.gear.handle, (i) => sys.setGearHandle(i === 1), { kind: 'flap' })),
        h('button.av-btn.tiny', { type: 'button', title: 'Emergency gear extension (hand crank)', onclick: () => sys.emergencyGearExtension() }, 'EMER EXT'));
      this.widgets.push({
        update: () => {
          const p = sys.gear.pos;
          const powered = sys.elec.busPowered;
          lights.forEach((l) => {
            l.classList.toggle('green', powered && p >= 1);
            l.classList.toggle('red', powered && p > 0 && p < 1);
          });
        },
      });
      return el;
    }

    glareshield(extra) {
      const compass = this.mk('compass', () => new G.CompassStrip(150, 34), () => ({ heading: this.im.compass }));
      return h('div.cp-glare', this.annunciators(), h('div.cp-compass', compass.canvas), extra || null, this.u(new A.ClockUnit(this.s)), h('div.cp-model-label', this.cfg.cockpit.label));
    }

    radios() {
      const av = this.cfg.avionics;
      const list = [];
      for (let n = 1; n <= Math.max(av.com, av.nav); n++) list.push(this.u(new A.RadioUnit(this.nav, n)));
      if (av.transponder) list.push(this.u(new A.TransponderUnit(this.nav)));
      return h('div.cp-radios', list);
    }

    /* ------------------------------------------------------------------ GA layouts */

    buildGA(twin) {
      const ac = this.ac, cfg = this.cfg, sys = ac.systems;
      const e0 = ac.engines[0];
      const size = 126;
      const eng = cfg.engines[0];

      let engineCol;
      if (!twin) {
        const tach = this.mk('tach', () => new G.Tachometer(size, eng), () => ({ rpm: e0.rpm, hours: e0.hours }));
        const cluster = this.mk('cluster', () => new G.EngineCluster(268, 126, eng, cfg.fuel),
          () => {
            const pw = sys.elec.busPowered;
            return {
              fuelL: pw ? sys.tanks[0].qty : 0, fuelR: pw ? sys.tanks[1].qty : 0,
              oilT: pw ? e0.oilTemp : 40, oilP: e0.oilPress, egt: pw ? e0.egt : 300, ff: e0.fuelFlow,
              vac: sys.gyro.vacuum, amp: pw ? M.clamp(sys.elec.battAmps, -60, 60) : 0,
            };
          });
        engineCol = h('div.cp-engine', h('div.gauge-wrap', tach.canvas), h('div.gauge-wrap.wide', cluster.canvas));
      } else {
        const e1 = ac.engines[1];
        const gs = 86;
        const mp = this.mk('mp', () => new G.ArcGauge(gs, { min: 10, max: 35, green: [15, 29.6], red: [29.6, 30.2], title: 'MAN PRESS', unit: 'IN HG', labels: [10, 15, 20, 25, 30, 35], ticks: 10 }), () => ({ value: e0.manifold, value2: e1.manifold }));
        const rpm = this.mk('rpm', () => new G.Tachometer(gs, eng, true), () => ({ rpm: e0.rpm, rpm2: e1.rpm }));
        const ff = this.mk('ff', () => new G.ArcGauge(gs, { min: 0, max: 30, green: [4, 26], title: 'FUEL FLOW', unit: 'GPH', labels: [0, 10, 20, 30], ticks: 6 }), () => ({ value: e0.fuelFlow, value2: e1.fuelFlow }));
        const fuel = this.mk('fuel', () => new G.ArcGauge(gs, { min: 0, max: cfg.fuel.tanks[0].capacity, green: [10, cfg.fuel.tanks[0].capacity], red: [0, 8], title: 'FUEL L · R', unit: 'GAL', labels: [0, 34, 68], ticks: 4 }), () => ({ value: sys.elec.busPowered ? sys.tanks[0].qty : 0, value2: sys.elec.busPowered ? sys.tanks[1].qty : 0 }));
        const oil = this.mk('oil', () => new G.ArcGauge(gs, { min: 0, max: 120, green: [30, 100], title: 'OIL PRESS', unit: 'PSI', labels: [0, 60, 120], ticks: 6 }), () => ({ value: e0.oilPress, value2: e1.oilPress }));
        const egt = this.mk('egt', () => new G.ArcGauge(gs, { min: 200, max: 900, green: [400, 800], title: 'EGT', unit: '°C', labels: [200, 550, 900], ticks: 7 }), () => ({ value: sys.elec.busPowered ? e0.egt : 200, value2: sys.elec.busPowered ? e1.egt : 200 }));
        engineCol = h('div.cp-engine.twin', [mp, rpm, ff, fuel, oil, egt].map((gg) => h('div.gauge-wrap.small', gg.canvas)));
      }

      const navCol = h('div.cp-nav', this.cdi(size, 1), cfg.avionics.nav > 1 ? this.cdi(size, 2) : null);
      const right = h('div.cp-avionics',
        this.radios(),
        cfg.avionics.gps ? this.u(new A.GpsUnit(this.s)) : null,
        cfg.avionics.autopilot ? this.u(new A.AutopilotUnit(ac)) : null);

      // Lower row: switches, ignition, fuel, engine controls, flaps, trim, yoke, minimap
      const engineControls = h('div.cp-levers',
        this.w(new W.Lever(twin ? 'THROTTLES' : 'THROTTLE', () => e0.throttle, (v) => ac.setThrottle(v), { color: '#16171a' })),
        twin ? this.w(new W.Lever('PROPS', () => e0.prop, (v) => ac.engines.forEach((e) => (e.prop = v)), { color: '#1f4fa0', format: (v) => (v < 0.03 && e0.propeller.featherable ? 'FTHR' : `${Math.round(e0.cfg.minGovRPM + (e0.cfg.maxRPM - e0.cfg.minGovRPM) * Math.max(0, Math.min(1, (v - 0.04) / 0.96)))}`) })) : null,
        this.w(new W.Lever(twin ? 'MIXTURES' : 'MIXTURE', () => e0.mixture, (v) => ac.setMixture(v), { color: '#a2231b' })),
        cfg.systems.carbHeat ? this.w(new W.PullKnob('CARB HEAT', () => e0.carbHeat, () => ac.engines.forEach((e) => (e.carbHeat = !e.carbHeat)), { color: '#3a3a3a' })) : null);

      const ign = twin
        ? h('div.cp-ign-twin', this.ignition(0, 'L ENG'), this.ignition(1, 'R ENG'))
        : this.ignition(0);
      const fuelSel = cfg.fuel.perEngine ? h('div.cp-ign-twin', this.fuelSelector(0, 'L FUEL'), this.fuelSelector(1, 'R FUEL')) : this.fuelSelector(0, 'FUEL SEL');

      this.inner.append(
        this.glareshield(),
        h('div.cp-main', this.sixPack(size), navCol, engineCol, right),
        h('div.cp-lower',
          h('div.cp-lower-left', this.switches(), h('div.cp-row', ign, fuelSel, this.parkingBrake())),
          this.yoke(),
          engineControls,
          twin ? this.gearHandle() : null,
          this.flapSelector(),
          this.trim(),
          this.u(new A.MiniMap(this.s, 210, 108))));
    }

    /* ------------------------------------------------------------------ airliner layout */

    buildAirliner() {
      const ac = this.ac, cfg = this.cfg, sys = ac.systems, nav = this.nav, s = this.s;
      const im = this.im;
      const pfd = this.mk('pfd', () => new SIM.Glass.PFD(330, 330, cfg.performance),
        () => {
          const st = ac.state;
          const c = nav.receivers.nav1;
          const ap = ac.autopilot;
          const vStall = ac.fm.aero.stallSpeedKt(ac.mass, sys.flaps.pos);
          this._lastIas = this._lastIas ?? st.iasKt;
          const trend = (st.iasKt - this._lastIas) * 10 * 30;
          this._lastIas = M.lerp(this._lastIas, st.iasKt, 0.2);
          return {
            powered: sys.elec.busPowered, pitch: im.ai.pitch, roll: im.ai.roll, slip: ac.fm.lateralG, ias: im.ias, gsKt: st.gsKt, alt: st.altFt, vs: im.vsi,
            hdg: st.headingDeg, hdgBug: ap.hdgBug, spdBug: ap.spdTarget, altBug: ap.altTarget, vStall, vmo: cfg.performance.vne, trend: M.clamp(trend, -30, 30),
            baro: Math.round(ac.kollsman), baroUnit: 'HPA', ra: st.aglFt, stall: sys.warnings.stall, fma: ap.annunciation(),
            loc: c.valid && c.type === 'ILS' ? c.needle : null, gsDev: c.valid && c.gsValid ? c.gsNeedle : null,
            mins: st.aglFt < 220 && st.aglFt > 150 && !st.onGround && st.vsFpm < 0,
          };
        });
      const nd = this.mk('nd', () => new SIM.Glass.ND(330, 330),
        () => ({
          powered: sys.elec.avionicsPowered, hdg: ac.state.headingDeg, trueHdg: ac.state.trueHeadingDeg, x: ac.fm.pos.x, z: ac.fm.pos.z, altFt: ac.state.altFtTrue,
          route: nav.route, activeLeg: nav.activeLeg, wp: nav.gps.wp, wpDist: nav.gps.dist, eta: nav.gps.wp ? SIM.NavigationSystem.formatClock(nav.gps.eta) + 'Z' : '',
          gsKt: ac.state.gsKt, tasKt: ac.state.tasKt, windDir: s.world.weather.windProfile(ac.fm.pos.y).dir - s.region.magVar, windKt: s.world.weather.windProfile(ac.fm.pos.y).speed / SIM.Units.KT,
          airports: s.airports, traffic: s.traffic ? s.traffic.contacts() : [],
        }));
      const eicas = this.mk('eicas', () => new SIM.Glass.EngineDisplay(250, 336),
        () => ({
          powered: sys.elec.busPowered,
          engines: ac.engines.map((e) => ({ n1: e.n1, n2: e.n2, egt: e.egt, ff: e.fuelFlow, oilP: e.oilPress, reverse: e.reverserPos > 0.5, state: e.state })),
          tanks: sys.tanks.map((t) => ({ name: t.name, qty: t.qty })),
          totalFuel: sys.totalFuel, flaps: sys.flapLabel(), flapsMoving: sys.flaps.moving, gear: sys.gear.pos, speedbrake: sys.speedbrake.pos,
          alerts: [sys.warnings.gear && 'GEAR', sys.warnings.lowFuel && 'LOW FUEL', sys.warnings.overspeed && 'OVERSPEED', sys.warnings.oilPress && 'OIL PRESS', ac.engines.some((e) => e.failed) && 'ENGINE FAIL'].filter(Boolean),
        }));
      // ND range buttons
      const ndWrap = h('div.gauge-wrap.display', nd.canvas, h('div.nd-range',
        h('button.av-btn.tiny', { type: 'button', onclick: () => (nd.range = Math.max(5, nd.range / 2)) }, 'RNG −'),
        h('button.av-btn.tiny', { type: 'button', onclick: () => (nd.range = Math.min(160, nd.range * 2)) }, 'RNG +')));
      const startSw = (i) => this.w(new W.Selector(`ENG ${i + 1} START`, ['OFF', 'GRD'], () => (ac.engines[i].starter ? 1 : 0), (k) => (ac.engines[i].starter = k === 1), { kind: 'rotary', span: 90 }));
      const fuelSw = (i) => this.w(new W.Selector(`FUEL CTRL ${i + 1}`, ['CUTOFF', 'RUN'], () => (ac.engines[i].mixture > 0.5 ? 1 : 0), (k) => (ac.engines[i].mixture = k), { kind: 'flap' }));
      const mcp = this.u(new A.McpUnit(ac, nav));
      this.inner.append(
        h('div.cp-glare.airliner', this.annunciators(), mcp, this.u(new A.ClockUnit(s))),
        h('div.cp-main.airliner',
          h('div.gauge-wrap.display', pfd.canvas),
          ndWrap,
          h('div.gauge-wrap.display.eicas', eicas.canvas),
          h('div.cp-avionics.airliner', this.radios(), h('div.cp-row', startSw(0), startSw(1)), h('div.cp-row', fuelSw(0), fuelSw(1)))),
        h('div.cp-lower',
          h('div.cp-lower-left', this.switches(), h('div.cp-row', this.parkingBrake())),
          this.yoke(),
          h('div.cp-levers',
            this.w(new W.Lever('THRUST', () => ac.engines[0].throttle, (v) => ac.setThrottle(v), { color: '#1b1c1f', tall: true })),
            this.w(new W.Lever('SPD BRK', () => sys.speedbrake.lever, (v) => (sys.speedbrake.lever = v), { color: '#c9c9c4', format: (v) => (v < 0.05 ? 'DOWN' : `${Math.round(v * 100)}%`) }))),
          this.gearHandle(),
          this.flapSelector(),
          this.trim(),
          this.u(new A.MiniMap(this.s, 210, 108))));
    }

    /* ------------------------------------------------------------------ runtime */

    /** Scales the panel to the viewport; returns the fraction of the screen height it covers. */
    fit() {
      const vw = window.innerWidth, vh = window.innerHeight;
      const maxH = vh * (vw < 900 ? 0.4 : 0.44);
      const scale = Math.min(vw / this.logicalW, maxH / this.logicalH);
      this.scale = scale;
      this.inner.style.transform = `scale(${scale})`;
      this.root.style.height = `${this.logicalH * scale}px`;
      this.root.style.setProperty('--inv-scale', 1 / scale);
      return this.visible ? (this.logicalH * scale) / vh : 0;
    }

    setVisible(v) {
      this.visible = v;
      this.root.classList.toggle('hidden', !v);
    }

    update(dt) {
      this.im.update(dt);
      if (!this.visible) return;
      this.timer += dt;
      this.wtimer += dt;
      const rate = 1 / (this.s.app.settings.data.graphics.instrumentRate || 30);
      if (this.timer >= rate) {
        this.timer = 0;
        for (const g of this.gauges) g.gauge.render(g.data());
      }
      if (this.wtimer >= 0.08) {
        const step = this.wtimer;
        this.wtimer = 0;
        for (const w of this.widgets) w.update();
        for (const u of this.units) u.update(step);
        // Panel lighting: darker at night unless panel lights are on
        const day = this.s.world.env.daylight;
        const lights = this.ac.systems.lightOn('panel');
        const lum = M.clamp(day * 1.0 + (lights ? 0.75 : 0.22), 0.25, 1);
        this.root.style.setProperty('--lum', lum.toFixed(2));
        this.root.classList.toggle('night-lit', lights && day < 0.5);
      }
    }
  }

  SIM.CockpitPanel = CockpitPanel;
  SIM.InstrumentModel = InstrumentModel;
})(window.SIM);
