/**
 * Aircraft — owns the flight model, engines, systems, autopilot and failures of one aircraft and
 * turns pilot input into rate-limited control surface deflections. Also tracks damage, crashes,
 * touchdowns and exposes a per-frame state snapshot used by instruments, HUD and UI.
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;
  const U = SIM.Units;

  const REALISM_SCALE = { easy: 0.35, normal: 0.75, realistic: 1 };

  /** Gaussian elimination with partial pivoting for a 3×3 system A·x = b. */
  function solve3(A, b) {
    const m = A.map((r, i) => r.concat([b[i]]));
    for (let c = 0; c < 3; c++) {
      let p = c;
      for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
      if (Math.abs(m[p][c]) < 1e-12) return null;
      [m[c], m[p]] = [m[p], m[c]];
      for (let r = 0; r < 3; r++) {
        if (r === c) continue;
        const k = m[r][c] / m[c][c];
        for (let j = c; j < 4; j++) m[r][j] -= k * m[c][j];
      }
    }
    return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
  }
  const G_LIMITS = { piston: { pos: 3.8, neg: -1.52 }, jet: { pos: 2.5, neg: -1.0 } };

  class Aircraft {
    /**
     * @param {string} id aircraft id in SIM.AircraftData
     * @param {object} opts { payload, fuel, realism, failures, customFailures, crashDetection, magVar }
     */
    constructor(id, opts = {}) {
      const cfg = SIM.AircraftData[id];
      if (!cfg) throw new Error(`Unknown aircraft "${id}"`);
      this.id = id;
      this.cfg = cfg;
      this.engines = cfg.engines.map((e, i) => SIM.createEngine(e, i));
      this.systems = new SIM.AircraftSystems(this);
      this.fm = new SIM.FlightModel(this);
      this.autopilot = new SIM.Autopilot(this);
      this.failures = new SIM.FailureManager(this, opts.failures || 'off', opts.customFailures || []);
      this.payload = opts.payload != null ? opts.payload : cfg.mass.defaultPayload;
      this.systems.setFuelFraction(opts.fuel != null ? opts.fuel : 0.8);
      this.realismScale = REALISM_SCALE[opts.realism] ?? REALISM_SCALE.normal;
      this.crashEnabled = opts.crashDetection !== false;
      this.magVar = opts.magVar || 0;
      this.autoRudder = !!opts.autoRudder;

      /** Pilot input after the InputManager (normalised -1..1). */
      this.input = { pitch: 0, roll: 0, yaw: 0, brakeL: 0, brakeR: 0 };
      /** Actual surface deflections (rate limited) and trim. */
      this.controls = { elevator: 0, aileron: 0, rudder: 0, elevatorTrim: 0, rudderTrim: 0, apElevator: 0, apAileron: 0 };
      this.kollsman = 1013.25; // hPa
      this.damage = 0;
      this.crashed = false;
      this.crashReason = '';
      this.airTime = 0;
      this.procedure = null;
      this.overspeedTime = 0;
      this.touchdown = null;
      this.state = {};
      this.nav = null; // set by the session
      this.attitude = { heading: 0, pitch: 0, roll: 0 };
      this.computeRigging();
      this.updateState();
    }

    /* ---------------------------------------------------------------- mass properties */

    get mass() {
      return this.cfg.mass.empty + this.payload + this.systems.fuelMassKg;
    }

    get inertia() {
      const c = this.cfg;
      const ref = 0.5 * (c.mass.empty + c.mass.maxTakeoff);
      const s = M.clamp(this.mass / ref, 0.75, 1.25);
      if (!this._inertia) this._inertia = { pitch: 0, yaw: 0, roll: 0 };
      this._inertia.pitch = c.inertia.pitch * s;
      this._inertia.yaw = c.inertia.yaw * s;
      this._inertia.roll = c.inertia.roll * s;
      return this._inertia;
    }

    get onGround() {
      return this.fm.onGround;
    }

    get groundSpeed() {
      return this.fm.vel.horizontalLength();
    }

    get isJet() {
      return this.engines[0].kind === 'turbofan';
    }

    /* ---------------------------------------------------------------- initial conditions */

    /** Cold & dark on the ground. */
    initParked(x, z, headingRad, terrain) {
      this.fm.placeOnGround(x, z, headingRad, terrain);
      this.systems.setupCold();
      this.engines.forEach((e) => {
        e.throttle = 0;
        e.mixture = e.kind === 'turbofan' ? 0 : 1;
        e.prop = 1;
      });
      this.controls.elevatorTrim = this.takeoffTrim();
    }

    /** Engines running, lined up. */
    initReady(x, z, headingRad, terrain) {
      this.fm.placeOnGround(x, z, headingRad, terrain);
      this.systems.setupReady();
      this.engines.forEach((e) => e.setRunning(0));
      this.systems.brakes.parking = false;
      this.controls.elevatorTrim = this.takeoffTrim();
      if (this.isJet) this.systems.setFlapsHandle(3);
    }

    /** In flight, trimmed for steady flight at the given indicated airspeed (KIAS). */
    initAirborne(x, y, z, headingRad, iasKt, env, { approach = false } = {}) {
      this.systems.setupReady({ airborne: true, approach });
      if (approach) {
        const idx = Math.min(this.systems.flaps.maxIndex, this.isJet ? 7 : this.systems.flaps.maxIndex - 1);
        this.systems.flaps.handle = idx;
        this.systems.flaps.pos = this.cfg.aero.flaps[idx].deg;
      }
      if (this.cfg.gear.retractable && !approach) {
        this.systems.gear.handle = 0;
        this.systems.gear.pos = 0;
      }
      const atm = Object.assign({}, env.atmosphereAt(y));
      const tas = (this.casFromIas(iasKt) * U.KT) / Math.sqrt(atm.rho / SIM.Phys.RHO0);
      this.engines.forEach((e) => (e.prop = this.cfg.engines[0].propType === 'constant' ? 0.85 : 1));
      const trim = this.solveTrim(tas, atm, approach ? -3 : 0);
      this.fm.placeInAir(x, y, z, headingRad, tas, trim.alpha + trim.gamma);
      this.fm.vel.set(Math.sin(headingRad) * tas * Math.cos(trim.gamma), tas * Math.sin(trim.gamma), -Math.cos(headingRad) * tas * Math.cos(trim.gamma));
      this.controls.elevatorTrim = M.clamp(trim.trim, -1, 1);
      this.engines.forEach((e) => e.setRunning(trim.throttle, tas * Math.cos(trim.alpha), atm));
      this.fm.onGround = false;
      this.airTime = 10;
    }

    /** Elevator trim for takeoff: trimmed for a full-power climb at Vy. */
    takeoffTrim() {
      const atm = { rho: SIM.Phys.RHO0, pressure: SIM.Phys.P0, tempC: 15, soundSpeed: 340 };
      const v = this.casFromIas(this.cfg.performance.vy) * U.KT;
      const t = this.solveTrim(v, atm, this.isJet ? 6 : 4, { fixedThrottle: 1 });
      return M.clamp(t.trim, -1, 1);
    }

    /**
     * Complete steady-state forces/moments (body frame) for a flight condition: aerodynamics,
     * thrust at the propeller/engine positions, torque reaction, P-factor and gravity.
     */
    steadyForces(tas, alpha, gamma, atm, throttle, beta = 0, enginesRunning = true) {
      const fm = this.fm;
      const W = this.mass * SIM.Phys.G;
      const vbody = new SIM.Vec3(tas * Math.sin(beta), -tas * Math.sin(alpha) * Math.cos(beta), -tas * Math.cos(alpha) * Math.cos(beta));
      const vAx = tas * Math.cos(alpha);
      const props = fm.props.map((p) => Object.assign({}, p));
      let thrust = 0;
      const moment = new SIM.Vec3();
      const force = new SIM.Vec3();
      this.engines.forEach((e, i) => {
        const ss = e.steadyState(throttle, vAx, atm, enginesRunning);
        const T = ss.thrust;
        thrust += T;
        const p = e.cfg.position;
        force.z -= T;
        moment.x += p[1] * -T;
        moment.y += p[0] * T;
        if (e.kind === 'piston') {
          const rot = e.cfg.rotation || 1;
          moment.z += ss.torque * rot;
          moment.y += 0.22 * e.cfg.propDiameter * Math.sin(alpha) * this.realismScale * T * rot;
          const A = Math.PI * Math.pow(e.cfg.propDiameter / 2, 2);
          const vi = T > 0 ? 0.5 * (-vAx + Math.sqrt(vAx * vAx + (2 * T) / (atm.rho * A))) : 0;
          props[i].vi = vi;
          const mdot = atm.rho * A * (vAx + vi);
          props[i].swirl = mdot > 1 ? M.clamp(ss.torque / (mdot * 0.7 * e.cfg.propDiameter / 2), 0, 25) : 0;
        }
      });
      const input = fm.aeroInput(vbody, new SIM.Vec3(), atm.rho, 0);
      input.props = props;
      input.agl = 1e4;
      input.onGround = false;
      input.mach = tas / (atm.soundSpeed || 340);
      const a = fm.aero.compute(input);
      force.add(a.force);
      moment.add(a.moment);
      // gravity in body axes for pitch attitude θ = α + γ (wings level)
      const th = alpha + gamma;
      force.y -= W * Math.cos(th);
      force.z += W * Math.sin(th);
      return { force, moment, thrust, CL: a.CL };
    }

    /**
     * Numerical trim on the full model. With free throttle it solves angle of attack, elevator trim
     * and throttle for a flight-path angle; with a fixed throttle it solves angle of attack, trim and
     * the resulting flight-path angle.
     * @returns {{alpha:number, trim:number, throttle:number, gamma:number}}
     */
    solveTrim(tas, atm, gammaDeg = 0, opts = {}) {
      const W = this.mass * SIM.Phys.G;
      const c = this.cfg.geometry.chord;
      const saved = Object.assign({}, this.controls);
      const ctl = this.controls;
      ctl.elevator = 0;
      ctl.aileron = 0;
      ctl.rudder = 0;
      const fixed = opts.fixedThrottle !== undefined;
      // variables: [alpha, trim, throttle or gamma]
      const resid = (x) => {
        ctl.elevatorTrim = x[1];
        const run = !opts.enginesOff;
        const r = fixed ? this.steadyForces(tas, x[0], x[2], atm, opts.fixedThrottle, 0, run) : this.steadyForces(tas, x[0], gammaDeg * M.DEG, atm, x[2], 0, run);
        return [r.force.y / W, r.force.z / W, r.moment.x / (W * c)];
      };
      const q = 0.5 * atm.rho * tas * tas;
      const x = [M.clamp((W / (q * this.cfg.geometry.wingArea)) / 5 - 0.03, -0.05, 0.25), 0, fixed ? gammaDeg * M.DEG : 0.5];
      const lo = [-0.2, -1.8, fixed ? -0.5 : 0], hi = [0.35, 1.8, fixed ? 0.6 : 1];
      const h = [1e-4, 1e-3, 1e-3];
      for (let it = 0; it < 30; it++) {
        const f = resid(x);
        if (Math.abs(f[0]) + Math.abs(f[1]) + Math.abs(f[2]) < 1e-6) break;
        const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        for (let k = 0; k < 3; k++) {
          const xp = x.slice();
          xp[k] += h[k];
          const fp = resid(xp);
          for (let i = 0; i < 3; i++) A[i][k] = (fp[i] - f[i]) / h[k];
        }
        const dx = solve3(A, [-f[0], -f[1], -f[2]]);
        if (!dx) break;
        for (let k = 0; k < 3; k++) x[k] = M.clamp(x[k] + M.clamp(dx[k], -0.25, 0.25), lo[k], hi[k]);
      }
      Object.assign(this.controls, saved);
      return fixed ? { alpha: x[0], trim: x[1], throttle: opts.fixedThrottle, gamma: x[2] } : { alpha: x[0], trim: x[1], throttle: x[2], gamma: gammaDeg * M.DEG };
    }

    /**
     * Factory rigging of propeller aircraft: fixed fin offset and aileron tab so the aircraft
     * flies straight hands-off at cruise power. Torque and slipstream are cancelled at that speed
     * only, as on the real airplane — at full power and low speed right rudder is still needed.
     */
    computeRigging() {
      const aero = this.fm.aero;
      if (this.isJet) return;
      const atm = { rho: 0.96, pressure: 75300, tempC: -1, soundSpeed: 333 };
      const tas = this.cfg.performance.cruise * U.KT;
      const t = this.solveTrim(tas, atm, 0);
      const saved = Object.assign({}, this.controls);
      this.controls.elevatorTrim = t.trim;
      const mom = () => this.steadyForces(tas, t.alpha, 0, atm, t.throttle).moment;
      for (let it = 0; it < 6; it++) {
        const m0 = mom();
        aero.rigging.finDeg += 0.1;
        const m1 = mom();
        aero.rigging.finDeg -= 0.1;
        const dN = (m1.y - m0.y) / 0.1;
        if (Math.abs(dN) > 1e-6) aero.rigging.finDeg = M.clamp(aero.rigging.finDeg - m0.y / dN, -4, 4);
        const r0 = mom();
        aero.rigging.aileronDeg += 0.1;
        const r1 = mom();
        aero.rigging.aileronDeg -= 0.1;
        const dL = (r1.z - r0.z) / 0.1;
        if (Math.abs(dL) > 1e-6) aero.rigging.aileronDeg = M.clamp(aero.rigging.aileronDeg - r0.z / dL, -3, 3);
      }
      Object.assign(this.controls, saved);
      aero.clmaxCache.clear();
    }

    /** KCAS → KIAS using the POH airspeed calibration table. */
    iasFromCas(kcas) {
      const t = this.cfg.asiCalibration;
      if (!t || kcas <= 0) return Math.max(0, kcas);
      if (kcas <= t[0][0]) return Math.max(0, kcas * (t[0][1] / t[0][0]));
      for (let i = 0; i < t.length - 1; i++) {
        if (kcas <= t[i + 1][0]) return M.lerp(t[i][1], t[i + 1][1], (kcas - t[i][0]) / (t[i + 1][0] - t[i][0]));
      }
      const l = t[t.length - 1];
      return kcas + (l[1] - l[0]);
    }

    /** KIAS → KCAS (inverse table lookup). */
    casFromIas(kias) {
      const t = this.cfg.asiCalibration;
      if (!t) return kias;
      if (kias <= t[0][1]) return kias * (t[0][0] / t[0][1]);
      for (let i = 0; i < t.length - 1; i++) {
        if (kias <= t[i + 1][1]) return M.lerp(t[i][0], t[i + 1][0], (kias - t[i][1]) / (t[i + 1][1] - t[i][1]));
      }
      const l = t[t.length - 1];
      return kias - (l[1] - l[0]);
    }

    /** Elevator travel equivalent of full trim (used by the autopilot trim servo). */
    get trimToElevator() {
      const h = this.cfg.htail;
      return h.trimRange / (h.elevator ? h.elevator.up : h.stabilator.up);
    }

    /* ---------------------------------------------------------------- control handling */

    /** Applies pilot input + autopilot to the control surfaces with realistic rate limits. */
    updateControls(dt) {
      const c = this.controls;
      const rate = this.cfg.controls.rate * dt;
      const ap = this.autopilot.on;
      let pitch = this.input.pitch, roll = this.input.roll, yaw = this.input.yaw;
      if (ap) {
        pitch = c.apElevator + pitch * 0.3;
        roll = c.apAileron + roll * 0.3;
      }
      // Auto-rudder assist: coordinates turns using sideslip feedback
      if (this.autoRudder && !this.onGround) yaw = M.clamp(yaw + this.fm.beta * 6 + roll * 0.15, -1, 1);
      c.elevator = M.approach(c.elevator, M.clamp(pitch, -1, 1) * this.cfg.controls.elevatorMax, rate);
      c.aileron = M.approach(c.aileron, M.clamp(roll, -1, 1) * this.cfg.controls.aileronMax, rate);
      c.rudder = M.approach(c.rudder, M.clamp(yaw, -1, 1) * this.cfg.controls.rudderMax, rate);
      this.systems.brakes.left = this.input.brakeL;
      this.systems.brakes.right = this.input.brakeR;
    }

    adjustElevatorTrim(dir, dt) {
      this.controls.elevatorTrim = M.clamp(this.controls.elevatorTrim + dir * this.cfg.controls.trimRate * dt, -1, 1);
    }

    adjustRudderTrim(dir, dt) {
      this.controls.rudderTrim = M.clamp(this.controls.rudderTrim + dir * 0.25 * dt, -0.4, 0.4);
    }

    setThrottle(v) {
      if (this.autopilot.atEngaged && Math.abs(v - this.engines[0].throttle) > 0.05) this.autopilot.toggleAutothrottle();
      this.engines.forEach((e) => (e.throttle = M.clamp(v, 0, 1)));
    }

    adjustThrottle(delta) {
      this.setThrottle(this.engines[0].throttle + delta);
    }

    setMixture(v) {
      this.engines.forEach((e) => {
        if (e.kind === 'piston') e.mixture = M.clamp(v, 0, 1);
      });
    }

    adjustMixture(delta) {
      const e = this.engines.find((en) => en.kind === 'piston');
      if (e) this.setMixture(e.mixture + delta);
    }

    adjustProp(delta) {
      // The keyboard stops at the low-RPM end; the FEATHER detent is only reached with the cockpit lever
      this.engines.forEach((e) => (e.prop = e.prop < 0.04 && delta > 0 ? M.clamp(e.prop + delta, 0, 1) : M.clamp(e.prop + delta, Math.min(e.prop, 0.04), 1)));
    }

    setReverse(on) {
      if (!this.cfg.systems.reversers) return;
      const allowed = on && this.onGround && this.engines.every((e) => e.throttle < 0.25 || e.reverse);
      this.engines.forEach((e) => (e.reverse = allowed));
    }

    toggleSpeedbrake() {
      if (!this.cfg.systems.speedbrake) return;
      const sb = this.systems.speedbrake;
      sb.lever = sb.lever > 0 ? 0 : this.onGround ? 1 : 0.5;
      SIM.events.emit('system:switch', { name: 'speedbrake', value: sb.lever > 0, label: sb.lever > 0 ? 'SPEED BRAKE EXTENDED' : 'SPEED BRAKE RETRACTED' });
    }

    /* ---------------------------------------------------------------- procedures */

    /** Automatic start (Ctrl+E): runs the real checklist on the real switches over time. */
    autoStart() {
      if (this.engines.every((e) => e.running)) {
        this.autoShutdown();
        return;
      }
      const s = this.systems;
      const steps = [];
      const add = (wait, fn, until) => steps.push({ wait, fn, until });
      add(0.3, () => s.toggleSwitch('batt', true));
      add(0.3, () => s.toggleSwitch('beacon', true));
      if (this.isJet) {
        this.engines.slice().reverse().forEach((e) => {
          add(0.5, () => (e.starter = true));
          add(0.5, () => {}, () => e.n2 > 25);
          add(0.3, () => (e.mixture = 1));
          add(0.5, () => {}, () => e.running);
        });
        add(0.4, () => s.toggleSwitch('gen', true));
      } else {
        s.fuelSelectors.forEach((_, i) => add(0.3, () => s.setFuelSelector(i, this.cfg.fuel.defaultSelector)));
        if (s.switches.pump !== undefined) add(0.3, () => s.toggleSwitch('pump', true));
        add(0.3, () => {
          this.setMixture(1);
          this.setThrottle(0.1);
          this.engines.forEach((e) => {
            e.prop = 1;
            e.carbHeat = false;
          });
        });
        this.engines.forEach((e) => {
          add(0.4, () => {
            e.magnetos = SIM.MAG.START;
            e.starter = true;
          });
          add(0.2, () => {}, () => e.running);
          add(0.1, () => {
            e.starter = false;
            e.magnetos = SIM.MAG.BOTH;
          });
        });
        add(0.3, () => s.toggleSwitch('alt', true));
      }
      add(0.3, () => s.toggleSwitch('avionics', true));
      add(0.2, () => s.toggleSwitch('nav', true));
      add(0.2, () => s.switches.logo !== undefined && s.toggleSwitch('logo', true));
      add(0.2, () => this.setThrottle(0.05));
      this.procedure = { steps, index: 0, t: 0, timeout: 0, name: 'AUTO START' };
      SIM.events.emit('notify', { text: 'AUTO START SEQUENCE', level: 'info' });
    }

    autoShutdown() {
      const s = this.systems;
      const steps = [];
      const add = (wait, fn) => steps.push({ wait, fn });
      add(0.2, () => this.setThrottle(0));
      add(0.6, () => s.toggleSwitch('avionics', false));
      if (this.isJet) {
        add(0.4, () => this.engines.forEach((e) => (e.mixture = 0)));
      } else {
        add(0.4, () => this.setMixture(0));
        add(1.5, () => this.engines.forEach((e) => (e.magnetos = SIM.MAG.OFF)));
      }
      ['land', 'taxi', 'strobe', 'nav', 'logo', 'pump', 'beacon', 'alt', 'gen', 'batt'].forEach((k) => add(0.2, () => s.toggleSwitch(k, false)));
      this.procedure = { steps, index: 0, t: 0, timeout: 0, name: 'SHUTDOWN' };
      SIM.events.emit('notify', { text: 'SHUTDOWN SEQUENCE', level: 'info' });
    }

    updateProcedure(dt) {
      const p = this.procedure;
      if (!p) return;
      const step = p.steps[p.index];
      if (!step) {
        this.procedure = null;
        return;
      }
      p.t += dt;
      if (p.t < step.wait) return;
      if (step.until && !step.until()) {
        p.timeout += dt;
        if (p.timeout > 25) {
          this.procedure = null;
          this.engines.forEach((e) => (e.starter = false));
          SIM.events.emit('notify', { text: `${p.name} ABORTED`, level: 'warn' });
        }
        return;
      }
      if (step.fn) step.fn();
      p.index++;
      p.t = 0;
      p.timeout = 0;
    }

    /* ---------------------------------------------------------------- damage & events */

    addDamage(amount, reason) {
      if (this.crashed) return;
      this.damage = M.clamp(this.damage + amount, 0, 1);
      if (reason && amount >= 0.05) SIM.events.emit('notify', { text: reason.toUpperCase(), level: 'warn' });
      if (this.damage >= 1 && this.crashEnabled) this.crash(reason || 'Structural failure');
    }

    crash(reason) {
      if (this.crashed || !this.crashEnabled) return;
      this.crashed = true;
      this.crashReason = reason;
      this.damage = 1;
      this.engines.forEach((e) => (e.state = SIM.EngineState.OFF));
      SIM.events.emit('aircraft:crash', { reason });
    }

    /**
     * First contact of a structural point or an over-compressed gear leg.
     * @param {string} id contact id
     * @param {number} vn impact speed along the ground normal (m/s)
     * @param {number} speed total point speed (m/s)
     * @param {boolean} water
     */
    registerImpact(id, vn, speed, water) {
      if (this.crashed) return;
      if (!this.crashEnabled) {
        this.damage = M.clamp(this.damage + vn * 0.01, 0, 0.99);
        return;
      }
      if (water) {
        if (speed > 3) this.crash('Ditched in the water');
        return;
      }
      const limit = SIM.Config.CRASH_SPEED;
      switch (id) {
        case 'gear':
          if (vn > (this.isJet ? 3.6 : 4.5)) this.crash('Landing gear collapsed');
          break;
        case 'belly':
          if (vn > limit * 1.6) this.crash('Hard belly impact');
          else this.addDamage(0.25 + vn * 0.05, 'Belly landing');
          break;
        case 'tail':
          if (vn > limit * 1.4) this.crash('Tail impact');
          else this.addDamage(0.08, 'Tail strike');
          break;
        case 'prop':
        case 'lprop':
        case 'rprop': {
          const en = id === 'rprop' ? this.engines[1] : this.engines[0];
          if (en) en.addDamage ? en.addDamage(1) : (en.damage = 1);
          if (en) en.failed = true;
          if (vn > limit || speed > 35) this.crash('Propeller strike');
          else this.addDamage(0.15, 'Propeller strike');
          break;
        }
        case 'leng':
        case 'reng':
          if (speed > 20 || vn > limit) this.crash('Engine nacelle struck the ground');
          else this.addDamage(0.2, 'Engine pod strike');
          break;
        case 'ltip':
        case 'rtip':
          if (speed > 18 || vn > limit) this.crash('Wingtip struck the ground');
          else this.addDamage(0.1, 'Wingtip strike');
          break;
        default:
          this.crash(id === 'roof' ? 'Aircraft overturned' : 'Collision with terrain');
      }
    }

    /** Continuous scraping while a structural point stays in contact. */
    scrape(id, speed, dt) {
      if (speed > 2) this.addDamage(dt * speed * 0.004);
    }

    onTouchdown() {
      if (this.crashed) return;
      const fm = this.fm;
      const vs = fm.vel.y;
      const td = {
        vsFpm: (vs / U.FPM),
        iasKt: fm.ias / U.KT,
        gsKt: fm.vel.horizontalLength() / U.KT,
        gLoad: fm.gLoad,
        x: fm.pos.x,
        z: fm.pos.z,
        heading: this.attitude.heading,
        pitchDeg: this.attitude.pitch * M.RAD,
        rollDeg: this.attitude.roll * M.RAD,
        airTime: this.airTime,
        gearDown: !this.cfg.gear.retractable || this.systems.gear.pos > 0.98,
      };
      if (this.airTime > SIM.Config.TOUCHDOWN_MIN_AIRTIME) {
        const crashVs = this.isJet ? 3.6 : 4.6;
        if (-vs > crashVs && this.crashEnabled) {
          this.crash('Excessive sink rate at touchdown');
        } else if (-vs > (this.isJet ? 2.4 : 3.0)) {
          this.addDamage(0.2, 'Hard landing');
        }
        if (Math.abs(td.rollDeg) > 12 && this.crashEnabled) this.addDamage(0.25, 'Wing low at touchdown');
        this.touchdown = td;
        SIM.events.emit('aircraft:touchdown', td);
      }
      this.airTime = 0;
    }

    onLiftoff() {
      if (this.crashed) return;
      SIM.events.emit('aircraft:liftoff', { iasKt: this.fm.ias / U.KT });
    }

    /* ---------------------------------------------------------------- main step */

    /**
     * One fixed physics step.
     * @param {number} dt
     * @param {object} env environment provided by the session (terrain, atmosphere, wind...)
     */
    step(dt, env) {
      if (this.crashed) return;
      this.updateProcedure(dt);
      this.updateControls(dt);
      this.autopilot.update(dt, this.nav);

      const atm = env.atmosphereAt(this.fm.pos.y);
      const sysCtx = {
        ias: this.fm.ias,
        onGround: this.fm.onGround,
        stallMarginDeg: this.fm.stallMarginDeg,
        agl: this.fm.agl / U.FT,
        oatC: atm.tempC,
        visibleMoisture: env.visibleMoisture(this.fm.pos.y),
      };
      this.systems.update(dt, sysCtx);
      const engEnv = {
        sigma: atm.rho / SIM.Phys.RHO0,
        pressureInHg: atm.pressure / 100 / U.INHG,
        oatC: atm.tempC,
        tas: this.fm.tas,
        vAxial: this.fm.vAxial || 0,
        rho: atm.rho,
        busVolts: this.systems.elec.busVolts,
        lowVolts: this.cfg.systems.lowVolts || 24,
        humidity: env.humidity,
      };
      for (const e of this.engines) e.update(dt, engEnv);
      this.fm.step(dt, env);
      this.failures.update(dt);

      if (!this.fm.onGround) this.airTime += dt;

      // Structural limits
      const lim = this.isJet ? G_LIMITS.jet : G_LIMITS.piston;
      const g = this.fm.gLoad;
      if (g > lim.pos * 1.5 || g < lim.neg * 1.5) this.addDamage(dt * 0.6, 'Over-G: structural damage');
      if (g > lim.pos * 2.1 || g < lim.neg * 2.2) this.crash('Structural failure (over-G)');
      const vne = this.cfg.performance.vne * U.KT;
      if (this.fm.ias > vne * 1.08) {
        this.overspeedTime += dt;
        if (this.overspeedTime > 4) this.addDamage(dt * 0.05, 'Overspeed: structural damage');
        if (this.fm.ias > vne * 1.3) this.crash('In-flight breakup (overspeed)');
      } else {
        this.overspeedTime = 0;
      }
    }

    /** Builds the per-frame snapshot (cheap, called once per rendered frame). */
    updateState() {
      const fm = this.fm;
      const s = this.state;
      fm.attitude(this.attitude);
      const hdgTrue = this.attitude.heading * M.RAD;
      s.trueHeadingDeg = hdgTrue;
      s.headingDeg = M.wrap360(hdgTrue - this.magVar);
      s.pitchDeg = this.attitude.pitch * M.RAD;
      s.rollDeg = this.attitude.roll * M.RAD;
      s.casKt = fm.ias / U.KT;
      // Indicated airspeed includes the pitot-static position error from the POH calibration table
      s.iasKt = this.iasFromCas(s.casKt);
      s.tasKt = fm.tas / U.KT;
      s.gsKt = fm.vel.horizontalLength() / U.KT;
      s.vsFpm = fm.vel.y / U.FPM;
      s.altFtTrue = fm.pos.y / U.FT;
      // Indicated altitude depends on the altimeter setting vs actual QNH
      s.altFt = s.altFtTrue + (this.kollsman - (this.qnh || 1013.25)) * 27.3;
      s.aglFt = Math.max(0, fm.agl / U.FT);
      s.trueTrackDeg = s.gsKt > 2 ? M.wrap360(Math.atan2(fm.vel.x, -fm.vel.z) * M.RAD) : hdgTrue;
      s.trackDeg = M.wrap360(s.trueTrackDeg - this.magVar);
      s.aoaDeg = fm.alpha * M.RAD;
      s.betaDeg = fm.beta * M.RAD;
      s.gLoad = fm.gLoad;
      s.mach = fm.mach;
      s.onGround = fm.onGround;
      s.turnRate = -fm.omega.y * M.RAD; // deg/s, right positive (approximation in body yaw)
      s.stallFactor = fm.stallFactor;
      s.stall = this.systems.warnings.stall;
      s.throttle = this.engines[0].throttle;
      s.fuel = this.systems.totalFuel;
      s.fuelCapacity = this.systems.fuelCapacity;
      s.flapLabel = this.systems.flapLabel(this.systems.flaps.handle);
      s.flapDeg = this.systems.flaps.pos;
      s.gearPos = this.cfg.gear.retractable ? this.systems.gear.pos : 1;
      s.damage = this.damage;
      return s;
    }
  }

  SIM.Aircraft = Aircraft;
})(window.SIM);
