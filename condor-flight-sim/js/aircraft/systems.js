/**
 * AircraftSystems — electrical bus, fuel, lights, flaps, landing gear, brakes, speed brakes,
 * vacuum/gyro, pitot-static icing, annunciators and warnings. All cockpit switches end up here.
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;

  /** Electrical load per consumer, in amps on a 28 V bus. */
  const LOADS = Object.freeze({
    base: 2.5, avionics: 6, land: 8, taxi: 6, nav: 3, strobe: 4, beacon: 3, pitot: 10, panel: 1.2, pump: 3, logo: 2, flaps: 10, gear: 15,
  });

  const SWITCH_LABELS = Object.freeze({
    batt: 'MASTER BAT', alt: 'MASTER ALT', gen: 'GENERATORS', avionics: 'AVIONICS', beacon: 'BEACON', land: 'LANDING LIGHT',
    taxi: 'TAXI LIGHT', nav: 'NAV LIGHTS', strobe: 'STROBE', pitot: 'PITOT HEAT', panel: 'PANEL LIGHTS', pump: 'FUEL PUMP', logo: 'LOGO LIGHT',
  });

  class AircraftSystems {
    constructor(aircraft) {
      this.ac = aircraft;
      const cfg = aircraft.cfg;
      this.cfg = cfg;
      this.switches = {};
      cfg.cockpit.switches.forEach((s) => (this.switches[s] = false));

      const engineCount = cfg.engines.length;
      this.fuelSelectors = new Array(cfg.fuel.perEngine ? engineCount : 1).fill(cfg.fuel.defaultSelector);
      this.tanks = cfg.fuel.tanks.map((t) => ({ id: t.id, name: t.name, capacity: t.capacity, qty: t.capacity, x: t.x }));

      const v0 = cfg.systems.battery.volts;
      this.elec = {
        nominal: v0,
        charging: v0 === 12 ? 14 : 28,
        battCharge: 0.92,
        busVolts: 0,
        amps: 0,
        battAmps: 0,
        altOnline: false,
        busPowered: false,
        avionicsPowered: false,
      };

      const flapTable = cfg.aero.flaps;
      this.flaps = { handle: 0, pos: 0, maxIndex: flapTable.length - 1, moving: false };
      this.gear = { handle: 1, pos: 1, moving: false, emergency: false, stuck: false };
      this.brakes = { left: 0, right: 0, parking: false };
      this.speedbrake = { lever: 0, pos: 0 };
      this.gyro = { vacuum: 0, spin: 0, elecSpin: 0 };
      this.pitot = { ice: 0, frozenIas: 0 };
      this.failures = { alternator: false, electrical: false, vacuum: false, pitot: false, gear: false, flaps: false, brakes: false, fuelLeak: false };
      this.warnings = { stall: false, overspeed: false, lowFuel: false, gear: false, oilPress: false, lowVolts: false, vac: false, fuelL: false, fuelR: false, flapOverspeed: false };
      this.annunciatorTest = false;
      this.flapOverspeedTime = 0;
      this.lowFuelNotified = false;
    }

    /* ------------------------------------------------------------- setup presets */

    /** Cold and dark: everything off, parking brake set. */
    setupCold() {
      Object.keys(this.switches).forEach((k) => this.switches[k] !== undefined && (this.switches[k] = false));
      this.brakes.parking = true;
      this.flaps.handle = 0;
      this.flaps.pos = 0;
      this.gear.handle = 1;
      this.gear.pos = 1;
      this.gyro.spin = 0;
      this.gyro.elecSpin = 0;
    }

    /** Engines running, ready to taxi/take off. */
    setupReady({ airborne = false, approach = false } = {}) {
      const s = this.switches;
      ['batt', 'alt', 'gen', 'avionics', 'beacon', 'nav', 'strobe', 'logo'].forEach((k) => s[k] !== undefined && (s[k] = true));
      if (s.land !== undefined) s.land = true;
      if (s.taxi !== undefined) s.taxi = !airborne;
      if (s.pump !== undefined) s.pump = !airborne || approach;
      this.brakes.parking = false;
      this.gyro.spin = 1;
      this.gyro.elecSpin = 1;
      this.elec.altOnline = true;
      if (airborne && !approach) {
        this.gear.handle = this.cfg.gear.retractable ? 0 : 1;
        this.gear.pos = this.gear.handle;
      }
    }

    /* ------------------------------------------------------------- interactions */

    toggleSwitch(name, value) {
      if (this.switches[name] === undefined) return;
      const v = value === undefined ? !this.switches[name] : !!value;
      if (this.switches[name] === v) return;
      this.switches[name] = v;
      SIM.events.emit('system:switch', { name, value: v, label: SWITCH_LABELS[name] || name.toUpperCase() });
    }

    setFlapsHandle(index) {
      const i = M.clamp(Math.round(index), 0, this.flaps.maxIndex);
      if (i === this.flaps.handle) return;
      this.flaps.handle = i;
      const entry = this.cfg.aero.flaps[i];
      SIM.events.emit('system:flaps', { index: i, label: entry.label || String(entry.deg) });
    }

    flapsDown() {
      this.setFlapsHandle(this.flaps.handle + 1);
    }

    flapsUp() {
      this.setFlapsHandle(this.flaps.handle - 1);
    }

    setGearHandle(down) {
      if (!this.cfg.gear.retractable) return;
      const target = down ? 1 : 0;
      if (this.gear.handle === target) return;
      if (!down && this.ac.onGround) {
        SIM.events.emit('notify', { text: 'GEAR LOCKED — ON GROUND', level: 'warn' });
        return;
      }
      this.gear.handle = target;
      SIM.events.emit('system:gear', { down });
    }

    toggleGear() {
      this.setGearHandle(this.gear.handle === 0);
    }

    emergencyGearExtension() {
      if (!this.cfg.gear.retractable || this.gear.pos >= 1) return;
      this.gear.emergency = true;
      this.gear.handle = 1;
      SIM.events.emit('notify', { text: 'EMERGENCY GEAR EXTENSION', level: 'warn' });
    }

    setFuelSelector(index, value) {
      if (!this.cfg.fuel.selector.includes(value)) return;
      if (this.fuelSelectors[index] === value) return;
      this.fuelSelectors[index] = value;
      SIM.events.emit('system:switch', { name: 'fuelSelector', value, label: 'FUEL ' + value });
    }

    cycleFuelSelector(index = 0) {
      const opts = this.cfg.fuel.selector;
      const i = opts.indexOf(this.fuelSelectors[index]);
      this.setFuelSelector(index, opts[(i + 1) % opts.length]);
    }

    toggleParkingBrake() {
      this.brakes.parking = !this.brakes.parking;
      SIM.events.emit('system:switch', { name: 'parking', value: this.brakes.parking, label: this.brakes.parking ? 'PARKING BRAKE SET' : 'PARKING BRAKE RELEASED' });
    }

    /* ------------------------------------------------------------- queries */

    get flapDeg() {
      return this.flaps.pos;
    }

    /** Interpolated aerodynamic flap increments for the current flap position. */
    flapAero() {
      const t = this.cfg.aero.flaps;
      const deg = this.flaps.pos;
      for (let i = 0; i < t.length - 1; i++) {
        if (deg <= t[i + 1].deg) {
          const f = M.invLerp(t[i].deg, t[i + 1].deg, deg);
          return { cl: M.lerp(t[i].cl, t[i + 1].cl, f), cd: M.lerp(t[i].cd, t[i + 1].cd, f), clmax: M.lerp(t[i].clmax, t[i + 1].clmax, f) };
        }
      }
      const l = t[t.length - 1];
      return { cl: l.cl, cd: l.cd, clmax: l.clmax };
    }

    flapLabel(index = this.flaps.handle) {
      const e = this.cfg.aero.flaps[index];
      return e.label || (e.deg === 0 ? 'UP' : e.deg + '°');
    }

    lightOn(name) {
      return !!this.switches[name] && this.elec.busPowered;
    }

    get totalFuel() {
      return this.tanks.reduce((s, t) => s + t.qty, 0);
    }

    get fuelCapacity() {
      return this.tanks.reduce((s, t) => s + t.capacity, 0);
    }

    get fuelMassKg() {
      const k = this.cfg.fuel.unit === 'kg' ? 1 : SIM.Units.AVGAS_KG_PER_GAL;
      return this.totalFuel * k;
    }

    setFuelFraction(f) {
      this.tanks.forEach((t) => (t.qty = t.capacity * M.clamp(f, 0, 1)));
      // Airliner: fill wing tanks before the centre tank, like real fuel loading.
      if (this.cfg.fuel.unit === 'kg') {
        const total = this.fuelCapacity * M.clamp(f, 0, 1);
        const wings = this.tanks.filter((t) => t.id !== 'C');
        const center = this.tanks.find((t) => t.id === 'C');
        const wingCap = wings.reduce((s, t) => s + t.capacity, 0);
        const inWings = Math.min(total, wingCap);
        wings.forEach((t) => (t.qty = inWings * (t.capacity / wingCap)));
        if (center) center.qty = Math.max(0, total - inWings);
      }
    }

    /** Which tanks feed engine i given current selector positions. */
    feedTanks(i) {
      const fuel = this.cfg.fuel;
      const unusablePerTank = fuel.unusable / this.tanks.length;
      const usable = (t) => t.qty > unusablePerTank;
      if (fuel.selector[0] === 'AUTO') {
        const c = this.tanks.find((t) => t.id === 'C');
        if (c && usable(c)) return [c];
        const own = this.tanks.find((t) => t.id === (i === 0 ? 'L' : 'R'));
        if (own && usable(own)) return [own];
        return this.tanks.filter(usable); // crossfeed as last resort
      }
      const sel = this.fuelSelectors[fuel.perEngine ? i : 0];
      if (sel === 'OFF') return [];
      if (fuel.perEngine) return [this.tanks[i]].filter(usable);
      if (sel === 'LEFT') return [this.tanks[0]].filter(usable);
      if (sel === 'RIGHT') return [this.tanks[1]].filter(usable);
      return this.tanks.filter(usable); // BOTH / ON
    }

    /* ------------------------------------------------------------- simulation */

    update(dt, ctx) {
      const cfg = this.cfg;
      const engines = this.ac.engines;
      const s = this.switches;

      /* ---- electrical */
      const e = this.elec;
      const altSwitch = s.alt !== undefined ? s.alt : s.gen;
      const genRunning = engines.some((en) => (en.kind === 'turbofan' ? en.n2 > 50 : en.rpm > 850));
      e.altOnline = !!(s.batt && altSwitch && genRunning && !this.failures.alternator && !this.failures.electrical);
      let amps = 0;
      if (s.batt && !this.failures.electrical) {
        amps += LOADS.base;
        if (s.avionics) amps += LOADS.avionics;
        ['land', 'taxi', 'nav', 'strobe', 'beacon', 'pitot', 'panel', 'pump', 'logo'].forEach((k) => s[k] && (amps += LOADS[k]));
        if (this.flaps.moving && cfg.systems.electricalFlaps) amps += LOADS.flaps;
        if (this.gear.moving && !this.gear.emergency) amps += LOADS.gear;
        if (engines.some((en) => en.state === SIM.EngineState.STARTING && en.kind === 'piston')) amps += 110;
      }
      e.amps = amps;
      if (!s.batt || this.failures.electrical) {
        e.busVolts = 0;
        e.battAmps = 0;
      } else if (e.altOnline) {
        const altCap = cfg.systems.alternatorAmps;
        const chargeAmps = (1 - e.battCharge) * 25;
        e.battAmps = amps > altCap ? altCap - amps : Math.min(chargeAmps, altCap - amps);
        e.busVolts = amps > altCap ? e.nominal * (0.9 + 0.1 * e.battCharge) : e.charging;
      } else {
        e.battAmps = -amps;
        e.busVolts = e.battCharge > 0.02 ? e.nominal * (0.86 + 0.14 * e.battCharge) - amps * 0.004 * (24 / e.nominal) : 0;
      }
      e.battCharge = M.clamp(e.battCharge + (e.battAmps * dt) / 3600 / cfg.systems.battery.ah, 0, 1);
      const lowV = cfg.systems.lowVolts || 24;
      e.busPowered = e.busVolts > lowV * 0.75;
      e.avionicsPowered = e.busPowered && !!s.avionics;

      /* ---- vacuum / gyros */
      const vac = this.failures.vacuum ? 0 : engines.reduce((m, en) => Math.max(m, en.vacuum), 0);
      this.gyro.vacuum = M.damp(this.gyro.vacuum, vac, 2, dt);
      if (cfg.systems.vacuum) {
        const target = M.clamp(this.gyro.vacuum / 4.5, 0, 1);
        this.gyro.spin = M.damp(this.gyro.spin, target, target > this.gyro.spin ? 0.08 : 0.012, dt);
      } else {
        // Airliner: electric/inertial attitude reference.
        this.gyro.spin = M.damp(this.gyro.spin, e.busPowered ? 1 : 0, e.busPowered ? 0.2 : 0.01, dt);
      }
      this.gyro.elecSpin = M.damp(this.gyro.elecSpin, e.busPowered ? 1 : 0, e.busPowered ? 0.25 : 0.02, dt);

      /* ---- pitot icing */
      const heated = this.lightOn('pitot');
      if (this.failures.pitot) {
        this.pitot.ice = 1;
      } else if (ctx.visibleMoisture && ctx.oatC < 2 && !heated) {
        this.pitot.ice = M.clamp(this.pitot.ice + dt * 0.01, 0, 1);
      } else {
        this.pitot.ice = M.clamp(this.pitot.ice - dt * (heated ? 0.05 : 0.004), 0, 1);
      }
      if (this.pitot.ice < 0.5) this.pitot.frozenIas = ctx.ias;

      /* ---- flaps */
      const flapPowered = cfg.systems.electricalFlaps ? e.busPowered : cfg.systems.hydraulic ? engines.some((en) => en.running) || e.busPowered : true;
      const flapTarget = cfg.aero.flaps[this.flaps.handle].deg;
      const prevFlap = this.flaps.pos;
      if (flapPowered && !this.failures.flaps) {
        this.flaps.pos = M.approach(this.flaps.pos, flapTarget, cfg.systems.flapRateDeg * dt);
      }
      this.flaps.moving = Math.abs(this.flaps.pos - prevFlap) > 1e-6;

      /* ---- gear */
      if (cfg.gear.retractable) {
        const powered = this.gear.emergency || (cfg.systems.hydraulic ? engines.some((en) => en.running) : e.busPowered);
        const rate = this.gear.emergency ? 1 / 22 : 1 / cfg.gear.transitTime;
        const prev = this.gear.pos;
        const freefall = cfg.systems.hydraulic && !powered && this.gear.handle === 1; // gravity extension
        if ((powered || freefall) && !(this.gear.stuck && this.gear.pos > 0.25 && this.gear.pos < 0.75 && !this.gear.emergency)) {
          this.gear.pos = M.approach(this.gear.pos, this.gear.handle, rate * (freefall ? 0.4 : 1) * dt);
        }
        if (this.failures.gear && !this.gear.emergency && this.gear.pos > 0.4 && this.gear.pos < 0.6) this.gear.stuck = true;
        this.gear.moving = Math.abs(this.gear.pos - prev) > 1e-6;
        if (prev < 1 && this.gear.pos >= 1) SIM.events.emit('system:gearLocked', { down: true });
        if (prev > 0 && this.gear.pos <= 0) SIM.events.emit('system:gearLocked', { down: false });
        if (this.gear.pos >= 1) this.gear.emergency = false;
      }

      /* ---- speed brake */
      if (cfg.systems.speedbrake) this.speedbrake.pos = M.approach(this.speedbrake.pos, this.speedbrake.lever, dt * 1.2);

      /* ---- fuel consumption */
      const kgUnit = cfg.fuel.unit === 'kg';
      engines.forEach((en, i) => {
        const feeds = this.feedTanks(i);
        en.fuelAvailable = feeds.length > 0;
        if (cfg.systems.fuelPump && en.state === SIM.EngineState.STARTING && !this.lightOn('pump')) en.fuelAvailable = false;
        if (en.fuelFlow > 0 && feeds.length) {
          const burn = (en.fuelFlow * dt) / 3600; // gal or kg
          feeds.forEach((t) => (t.qty = Math.max(0, t.qty - burn / feeds.length)));
        }
      });
      if (this.failures.fuelLeak) {
        const leak = ((kgUnit ? 900 : 18) * dt) / 3600;
        const t = this.tanks[0].qty > 0 ? this.tanks[0] : this.tanks[this.tanks.length - 1];
        t.qty = Math.max(0, t.qty - leak);
      }

      this.updateWarnings(dt, ctx);
    }

    updateWarnings(dt, ctx) {
      const cfg = this.cfg;
      const w = this.warnings;
      const perf = cfg.performance;
      const prev = Object.assign({}, w);
      const ias = ctx.ias;
      const unusable = cfg.fuel.unusable;
      const lowPerTank = cfg.fuel.unit === 'kg' ? 450 : Math.max(2, this.fuelCapacity * 0.08);

      w.stall = !ctx.onGround && ias > 20 * 0.514 && ctx.aoaDeg > ctx.stallAlphaDeg - cfg.stallHornMarginDeg;
      w.overspeed = ias / SIM.Units.KT > perf.vne;
      w.lowFuel = this.totalFuel - unusable < this.fuelCapacity * 0.12;
      const lTank = this.tanks.find((t) => t.id === 'L');
      const rTank = this.tanks.find((t) => t.id === 'R');
      w.fuelL = !!lTank && lTank.qty < lowPerTank;
      w.fuelR = !!rTank && rTank.qty < lowPerTank;
      w.lowVolts = this.elec.busPowered && !this.elec.altOnline;
      w.vac = !!cfg.systems.vacuum && this.gyro.vacuum < 3.0;
      w.oilPress = this.ac.engines.some((en) => en.oilPress < en.cfg.oil?.minPress * 0.8 || (en.kind === 'turbofan' && en.oilPress < 13));
      if (cfg.gear.retractable) {
        const throttleLow = this.ac.engines.every((en) => en.throttle < 0.15);
        const flapsLanding = this.flaps.pos >= (cfg.aero.flaps[this.flaps.maxIndex].deg * 0.6);
        w.gear = this.gear.pos < 1 && !ctx.onGround && ((throttleLow && ctx.agl < 1200) || flapsLanding);
      }
      // Flap overspeed (structural)
      const vfe = cfg.aero.flapSpeeds ? cfg.aero.flapSpeeds[this.flaps.handle] : this.flaps.pos > 12 ? perf.vfe : perf.vfeFirst;
      w.flapOverspeed = this.flaps.pos > 0.5 && ias / SIM.Units.KT > vfe + 5;
      if (w.flapOverspeed) {
        this.flapOverspeedTime += dt;
        if (this.flapOverspeedTime > 3 && !this.failures.flaps) {
          this.failures.flaps = true;
          SIM.events.emit('failure', { id: 'flaps', label: 'FLAP DAMAGE — OVERSPEED' });
          this.ac.addDamage(0.08, 'Flap overspeed');
        }
      } else {
        this.flapOverspeedTime = 0;
      }

      Object.keys(w).forEach((k) => {
        if (w[k] && !prev[k]) SIM.events.emit('warning', { id: k, active: true });
        if (!w[k] && prev[k]) SIM.events.emit('warning', { id: k, active: false });
      });
    }

    /** Annunciator states for the cockpit (only lit with bus power). */
    annunciators() {
      const p = this.elec.busPowered;
      const t = this.annunciatorTest && p;
      const w = this.warnings;
      return {
        VOLTS: t || (p && w.lowVolts),
        'OIL PRESS': t || (p && w.oilPress),
        'L FUEL': t || (p && w.fuelL),
        'R FUEL': t || (p && w.fuelR),
        VAC: t || (p && w.vac),
        GEAR: t || (p && w.gear),
        STALL: t || (p && w.stall),
      };
    }

    serialize() {
      return {
        switches: Object.assign({}, this.switches),
        tanks: this.tanks.map((t) => t.qty),
        flaps: this.flaps.handle,
        gear: this.gear.handle,
      };
    }
  }

  SIM.AircraftSystems = AircraftSystems;
  SIM.SWITCH_LABELS = SWITCH_LABELS;
})(window.SIM);
