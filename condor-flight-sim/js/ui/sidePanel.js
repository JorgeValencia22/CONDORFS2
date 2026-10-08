/**
 * SidePanel — optional inspection panel with tabs AIRCRAFT, ENGINE, FUEL, NAVIGATION, WEATHER and
 * FAILURES. Shows live data and allows in-flight changes (weather, time, failures, refuel on ground).
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;
  const { h, icon, Fmt } = SIM.UI;
  const TABS = [
    ['aircraft', 'AIRCRAFT', 'plane'],
    ['engine', 'ENGINE', 'engine'],
    ['fuel', 'FUEL', 'fuel'],
    ['navigation', 'NAVIGATION', 'nav'],
    ['weather', 'WEATHER', 'cloud'],
    ['failures', 'FAILURES', 'warning'],
  ];

  const bar = (v, cls = '') => h('div.bar' + cls, h('span', { style: { width: `${M.clamp(v, 0, 1) * 100}%` } }));
  const kv = (rows) => h('dl.kv', rows.filter(Boolean).map(([k, v, cls]) => [h('dt', k), h('dd.mono', { className: cls || '' }, v)]));

  class SidePanel {
    constructor(session) {
      this.s = session;
      this.tab = 'aircraft';
      this.el = h('aside.side-panel', { 'aria-label': 'Aircraft information' });
      this.tabs = h('div.sp-tabs', { role: 'tablist' }, TABS.map(([id, label, ic]) => h('button.sp-tab', { type: 'button', role: 'tab', dataset: { tab: id }, onclick: () => this.select(id), title: label }, icon(ic), h('span', label))));
      this.body = h('div.sp-body');
      this.controls = h('div.sp-controls');
      this.el.append(h('div.sp-head', h('span', 'FLIGHT DATA'), h('button.icon-btn', { onclick: () => SIM.events.emit('action', { id: 'sidePanel' }), 'aria-label': 'Close panel' }, icon('close'))), this.tabs, this.body, this.controls);
      this.select('aircraft');
    }

    select(id) {
      this.tab = id;
      this.tabs.querySelectorAll('.sp-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === id));
      this.buildControls();
      this.update(true);
    }

    buildControls() {
      const s = this.s;
      const ac = s.aircraft;
      const c = this.controls;
      c.innerHTML = '';
      if (this.tab === 'engine') {
        c.append(h('div.btn-row', h('button.btn.btn-sm', { onclick: () => ac.autoStart() }, icon('bolt'), 'AUTO START / SHUTDOWN')));
      } else if (this.tab === 'fuel') {
        const sel = ac.cfg.fuel.selector;
        if (sel.length > 1) {
          ac.systems.fuelSelectors.forEach((cur, i) => {
            c.append(h('label.field', h('span', ac.systems.fuelSelectors.length > 1 ? `SELECTOR ${i + 1}` : 'FUEL SELECTOR'),
              h('div.seg', sel.map((o) => h('button.seg-btn', { type: 'button', className: o === ac.systems.fuelSelectors[i] ? 'active' : '', onclick: () => {
                ac.systems.setFuelSelector(i, o);
                this.buildControls();
              } }, o)))));
          });
        }
        c.append(h('div.btn-row', h('button.btn.btn-sm', { onclick: () => this.refuel() }, icon('fuel'), 'REFUEL (ON GROUND)')));
      } else if (this.tab === 'navigation') {
        c.append(h('div.btn-row',
          h('button.btn.btn-sm', { onclick: () => SIM.events.emit('action', { id: 'map' }) }, icon('map'), 'OPEN MAP'),
          h('button.btn.btn-sm', { onclick: () => s.nav.radios.toggleCdiSource() }, 'CDI GPS/VLOC'),
          h('button.btn.btn-sm', { onclick: () => s.nav.clearRoute() }, 'CLEAR ROUTE')));
      } else if (this.tab === 'weather') {
        this.buildWeatherControls(c);
      } else if (this.tab === 'failures') {
        const list = h('div.failure-list');
        ac.failures.available().forEach((f) => {
          list.append(h('div.failure-row', h('div', h('b', f.label), h('div.muted', f.description)),
            h('button.btn.btn-xs.btn-danger', { onclick: () => {
              ac.failures.trigger(f.id);
              this.update(true);
            } }, 'TRIGGER')));
        });
        c.append(list, h('div.btn-row',
          h('button.btn.btn-sm', { onclick: () => ac.failures.repairAll() }, icon('check'), 'REPAIR ALL'),
          ac.cfg.gear.retractable ? h('button.btn.btn-sm', { onclick: () => ac.systems.emergencyGearExtension() }, 'EMERGENCY GEAR') : null));
      }
    }

    buildWeatherControls(c) {
      const s = this.s;
      const w = s.world.weather;
      const presets = Object.entries(SIM.WeatherPresets);
      c.append(h('div.seg.wrap', presets.map(([id, p]) => h('button.seg-btn', { type: 'button', className: w.preset === id ? 'active' : '', onclick: () => {
        w.set(id);
        this.buildControls();
      } }, p.label))));
      const slider = (label, key, min, max, step, fmt) => {
        const out = h('span.mono', fmt(w.p[key]));
        const input = h('input.range', { type: 'range', min, max, step, value: w.p[key], 'aria-label': label });
        input.addEventListener('input', () => {
          w.setParam(key, Number(input.value));
          out.textContent = fmt(w.p[key]);
        });
        return h('label.field', h('span', label, out), input);
      };
      c.append(
        slider('WIND DIRECTION', 'windDir', 0, 359, 1, (v) => `${Fmt.hdg(v)}°`),
        slider('WIND SPEED', 'windKt', 0, 45, 1, (v) => `${v} kt`),
        slider('GUSTS', 'gustKt', 0, 25, 1, (v) => `${v} kt`),
        slider('VISIBILITY', 'visibilityKm', 0.5, 80, 0.5, (v) => `${v} km`),
        slider('CLOUD COVER', 'cloudCover', 0, 1, 0.01, (v) => `${Math.round(v * 8)}/8`),
        slider('CLOUD BASE', 'cloudBaseFt', 300, 12000, 100, (v) => `${v} ft`),
        slider('TEMPERATURE', 'tempC', -20, 40, 1, (v) => `${v} °C`),
        slider('PRESSURE (QNH)', 'qnh', 970, 1045, 1, (v) => `${v} hPa`),
        slider('TURBULENCE', 'turbulence', 0, 1, 0.01, (v) => `${Math.round(v * 100)}%`),
        slider('PRECIPITATION', 'precipitation', 0, 1, 0.01, (v) => `${Math.round(v * 100)}%`));
      const timeOut = h('span.mono', Fmt.clock(s.hour));
      const time = h('input.range', { type: 'range', min: 0, max: 23.99, step: 0.05, value: s.hour, 'aria-label': 'Time of day' });
      time.addEventListener('input', () => {
        s.setHour(Number(time.value));
        timeOut.textContent = Fmt.clock(s.hour);
      });
      const rates = [1, 2, 4, 8, 16];
      c.append(h('label.field', h('span', 'TIME OF DAY', timeOut), time),
        h('label.field', h('span', 'TIME RATE'), h('div.seg', rates.map((r) => h('button.seg-btn', { type: 'button', className: s.timeRate === r ? 'active' : '', onclick: () => {
          s.timeRate = r;
          this.buildControls();
        } }, `${r}×`)))));
    }

    refuel() {
      const ac = this.s.aircraft;
      if (!ac.onGround || ac.groundSpeed > 0.5) {
        SIM.events.emit('notify', { text: 'REFUEL ONLY WHEN STOPPED ON THE GROUND', level: 'warn' });
        return;
      }
      ac.systems.setFuelFraction(1);
      SIM.events.emit('notify', { text: 'TANKS FULL', level: 'success' });
    }

    update(force) {
      if (!force && !this.el.classList.contains('open')) return;
      const s = this.s, ac = s.aircraft, st = ac.state, sys = ac.systems, cfg = ac.cfg;
      const b = this.body;
      b.innerHTML = '';
      if (this.tab === 'aircraft') {
        const ctl = ac.controls;
        b.append(
          h('div.sp-title', cfg.name, h('span.chip', cfg.role)),
          kv([
            ['FLIGHT PHASE', s.state.state],
            ['GROSS WEIGHT', `${Math.round(ac.mass)} kg / ${cfg.mass.maxTakeoff} kg`, ac.mass > cfg.mass.maxTakeoff ? 'red' : ''],
            ['IAS / CAS / TAS / GS', `${Math.round(st.iasKt)} / ${Math.round(st.casKt)} / ${Math.round(st.tasKt)} / ${Math.round(st.gsKt)} kt`],
            ['STALL SPEED (1 g)', `${Math.round(ac.fm.aero.stallSpeedKt(ac.mass, sys.flaps.pos) * Math.sqrt(Math.max(st.gLoad, 0.3)))} KCAS`],
            ['ALTITUDE', `${Math.round(st.altFt)} ft  (AGL ${Math.round(st.aglFt)})`],
            ['VERTICAL SPEED', `${Math.round(st.vsFpm)} fpm`],
            ['ATTITUDE', `P ${st.pitchDeg.toFixed(1)}°  R ${st.rollDeg.toFixed(1)}°`],
            ['ANGLE OF ATTACK', `${st.aoaDeg.toFixed(1)}°  (stall ≈${ac.fm.stallAlphaDeg.toFixed(1)}°)`, sys.warnings.stall ? 'red' : ''],
            ['LOAD FACTOR', `${st.gLoad.toFixed(2)} g`],
            ['FLAPS / GEAR', `${sys.flapLabel()} / ${cfg.gear.retractable ? (sys.gear.pos >= 1 ? 'DOWN' : sys.gear.pos <= 0 ? 'UP' : 'TRANSIT') : 'FIXED'}`],
            ['DAMAGE', `${Math.round(ac.damage * 100)}%`, ac.damage > 0.3 ? 'red' : ''],
            ['BUS / BATTERY', `${sys.elec.busVolts.toFixed(1)} V · ${Math.round(sys.elec.battCharge * 100)}% · ${sys.elec.battAmps >= 0 ? '+' : ''}${sys.elec.battAmps.toFixed(1)} A`],
          ]),
          h('div.sp-sub', 'CONTROLS'),
          h('div.ctl-bars', ['elevator', 'aileron', 'rudder', 'elevatorTrim', 'rudderTrim'].map((k) => h('div.ctl', h('span', k.replace('Trim', ' trim').toUpperCase()), h('div.ctl-track', h('span', { style: { left: `${(ctl[k] / (k === 'rudderTrim' ? 0.8 : 2) + 0.5) * 100}%` } }))))),
          h('div.sp-sub', 'LIGHTS'),
          h('div.chips', Object.keys(sys.switches).map((k) => h('span.chip', { className: sys.switches[k] ? 'on' : '' }, (SIM.SWITCH_LABELS[k] || k).replace('LIGHTS', '').replace('LIGHT', '')))));
      } else if (this.tab === 'engine') {
        ac.engines.forEach((e, i) => {
          b.append(h('div.sp-title', `ENGINE ${ac.engines.length > 1 ? i + 1 : ''}`, h('span.chip', { className: e.running ? 'on' : e.failed ? 'red' : '' }, e.failed ? 'FAILED' : e.state)), e.kind === 'piston'
            ? kv([
              ['RPM', `${Math.round(e.rpm)}`, e.rpm > e.cfg.redline ? 'red' : ''],
              ['POWER', `${Math.round((e.power / e.cfg.maxPower) * 100)}%  (${Math.round(e.power / SIM.Units.HP)} hp)`],
              ['MANIFOLD', `${e.manifold.toFixed(1)} inHg`],
              ['THROTTLE / MIXTURE', `${Math.round(e.throttle * 100)}% / ${Math.round(e.mixture * 100)}%`],
              e.cfg.propType === 'constant' ? ['PROPELLER', e.propeller.feather > 0.5 ? 'FEATHERED' : `${Math.round(e.governorTarget())} rpm`] : null,
              ['MAGNETOS', SIM.MAG_LABELS[e.magnetos]],
              ['FUEL FLOW', `${e.fuelFlow.toFixed(1)} gph`],
              ['EGT / CHT', `${Math.round(e.egt)} / ${Math.round(e.cht)} °C`],
              ['OIL', `${Math.round(e.oilTemp)} °C · ${Math.round(e.oilPress)} psi`, e.oilTemp > e.cfg.oil.maxTemp ? 'red' : ''],
              e.cfg.carb ? ['CARB ICE / HEAT', `${Math.round(e.carbIce * 100)}% / ${e.carbHeat ? 'ON' : 'OFF'}`, e.carbIce > 0.2 ? 'red' : ''] : null,
              ['DAMAGE', `${Math.round(e.damage * 100)}%`, e.damage > 0.2 ? 'red' : ''],
              ['HOURS', e.hours.toFixed(1)],
            ])
            : kv([
              ['N1 / N2', `${e.n1.toFixed(1)}% / ${e.n2.toFixed(1)}%`],
              ['THRUST', `${Math.round(Math.abs(e.thrust) / 1000)} kN${e.thrust < 0 ? ' REV' : ''}`],
              ['EGT', `${Math.round(e.egt)} °C`, e.egt > e.cfg.egtMax ? 'red' : ''],
              ['FUEL FLOW', `${Math.round(e.fuelFlow)} kg/h`],
              ['OIL', `${Math.round(e.oilTemp)} °C · ${Math.round(e.oilPress)} psi`],
              ['FUEL CONTROL / START', `${e.mixture > 0.5 ? 'RUN' : 'CUTOFF'} / ${e.starter ? 'GRD' : 'OFF'}`],
              ['DAMAGE', `${Math.round(e.damage * 100)}%`],
            ]));
        });
      } else if (this.tab === 'fuel') {
        const unit = cfg.fuel.unit;
        const flow = ac.engines.reduce((t, e) => t + e.fuelFlow, 0);
        const usable = Math.max(0, sys.totalFuel - cfg.fuel.unusable);
        const endurance = flow > 0.01 ? (usable / flow) * 3600 : Infinity;
        b.append(h('div.sp-title', `FUEL — ${cfg.fuel.type}`));
        sys.tanks.forEach((t) => b.append(h('div.tank', h('div.tank-head', h('span', t.name), h('span.mono', `${Fmt.fuel(t.qty, unit)} / ${Fmt.fuel(t.capacity, unit)}`)), bar(t.qty / t.capacity, t.qty / t.capacity < 0.15 ? '.low' : ''))));
        b.append(kv([
          ['TOTAL', Fmt.fuel(sys.totalFuel, unit), sys.warnings.lowFuel ? 'red' : ''],
          ['FUEL MASS', `${Math.round(sys.fuelMassKg)} kg`],
          ['FLOW', unit === 'kg' ? `${Math.round(flow)} kg/h` : `${flow.toFixed(1)} gph`],
          ['ENDURANCE', Number.isFinite(endurance) ? Fmt.time(endurance) : '—'],
          ['RANGE (still air)', Number.isFinite(endurance) ? Fmt.dist((endurance * st.gsKt * SIM.Units.KT)) : '—'],
          ['USED THIS FLIGHT', Fmt.fuel(Math.max(0, s.stats.fuelStart - sys.totalFuel), unit)],
          ['SELECTOR', sys.fuelSelectors.join(' / ')],
        ]));
      } else if (this.tab === 'navigation') {
        const nav = s.nav, g = nav.gps;
        const r1 = nav.receivers.nav1, r2 = nav.receivers.nav2;
        b.append(h('div.sp-title', 'NAVIGATION'), kv([
          ['POSITION', g.lat != null ? `${SIM.Geo.formatLat(g.lat)} ${SIM.Geo.formatLon(g.lon)}` : '—'],
          ['HEADING / TRACK', `${Fmt.hdg(st.headingDeg)}° / ${Fmt.hdg(st.trackDeg)}° MAG`],
          ['ACTIVE WAYPOINT', g.wp ? `${g.wp.ident} — ${g.wp.name}` : 'NONE'],
          ['DTK / BRG', g.wp ? `${Fmt.hdg(g.dtk)}° / ${Fmt.hdg(g.brg)}°` : '—'],
          ['DISTANCE', g.wp ? Fmt.dist(g.dist) : '—'],
          ['ETE / ETA', g.wp ? `${SIM.NavigationSystem.formatTime(g.ete)} / ${SIM.NavigationSystem.formatClock(g.eta)}` : '—'],
          ['CROSS TRACK', g.wp ? `${(Math.abs(g.xtk) / 1852).toFixed(2)} nm ${g.xtk > 0 ? 'R' : 'L'}` : '—'],
          ['DESTINATION', nav.destination ? `${nav.destination.ident} · ${Fmt.dist(g.distDest || 0)}` : '—'],
          ['NAV1', r1.valid ? `${r1.ident} ${r1.type} ${r1.toFrom || ''} R${Fmt.hdg(r1.radial)} ${(r1.dist / 1852).toFixed(1)}nm` : `${nav.radios.format('nav1')} — NO SIGNAL`],
          ['NAV2', r2.valid ? `${r2.ident} ${r2.type} R${Fmt.hdg(r2.radial)} ${(r2.dist / 1852).toFixed(1)}nm` : `${nav.radios.format('nav2')} — NO SIGNAL`],
          ['CDI SOURCE', nav.radios.cdiSource],
          ['ROUTE', nav.route.map((w) => w.ident).join(' → ') || '—'],
        ]));
      } else if (this.tab === 'weather') {
        const w = s.world.weather;
        const atm = w.atmosphereAt(ac.fm.pos.y);
        const prof = w.windProfile(ac.fm.pos.y, ac.fm.groundHeight);
        b.append(h('div.sp-title', w.label), h('div.metar.mono', w.metar(s.startAirport ? s.startAirport.icao : 'XXXX', s.region.magVar)), kv([
          ['WIND AT AIRCRAFT', `${Fmt.hdg(prof.dir)}° / ${Math.round(prof.speed / SIM.Units.KT)} kt`],
          ['OUTSIDE AIR TEMP', `${atm.tempC.toFixed(1)} °C`],
          ['DENSITY', `${atm.rho.toFixed(3)} kg/m³ (σ ${(atm.rho / 1.225).toFixed(2)})`],
          ['LOCAL TIME', Fmt.clock(s.hour)],
          ['SUN ELEVATION', s.world.sky ? `${s.world.sky.sun.elevation.toFixed(1)}°` : '—'],
        ]));
      } else if (this.tab === 'failures') {
        const f = ac.failures;
        b.append(h('div.sp-title', 'FAILURES', h('span.chip', f.mode.toUpperCase())), kv([
          ['ACTIVE', Array.from(f.active).map((id) => SIM.FAILURES.find((x) => x.id === id).label).join(', ') || 'NONE', f.active.size ? 'red' : ''],
          ['AIRCRAFT DAMAGE', `${Math.round(ac.damage * 100)}%`],
          ['PITOT ICE', `${Math.round(sys.pitot.ice * 100)}%`],
          ['VACUUM', `${sys.gyro.vacuum.toFixed(1)} inHg`],
        ]));
      }
    }
  }

  SIM.SidePanel = SidePanel;
})(window.SIM);
