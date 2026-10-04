/**
 * Engine simulation: piston engines (fixed pitch or constant speed propellers) and turbofans.
 *
 * Engine states: OFF, STARTING, IDLE, RUNNING, OVERPOWER, DAMAGED.
 * Each engine produces thrust (N), shaft torque, fuel flow and gauge values (oil, EGT, vacuum...).
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;
  const U = SIM.Units;

  const EngineState = Object.freeze({
    OFF: 'OFF', STARTING: 'STARTING', IDLE: 'IDLE', RUNNING: 'RUNNING', OVERPOWER: 'OVERPOWER', DAMAGED: 'DAMAGED',
  });

  /** Magneto switch positions. */
  const MAG = Object.freeze({ OFF: 0, R: 1, L: 2, BOTH: 3, START: 4 });
  const MAG_LABELS = ['OFF', 'R', 'L', 'BOTH', 'START'];

  class PistonEngine {
    constructor(cfg, index) {
      this.cfg = cfg;
      this.index = index;
      this.kind = 'piston';
      // Controls
      this.throttle = 0;
      this.mixture = 1;
      this.prop = 1;          // constant-speed propeller lever (1 = high RPM)
      this.carbHeat = false;
      this.magnetos = MAG.OFF;
      this.starter = false;
      // State
      this.state = EngineState.OFF;
      this.rpm = 0;
      this.power = 0;          // W delivered to the propeller
      this.thrust = 0;         // N
      this.torque = 0;         // N·m
      this.fuelFlow = 0;       // gal/h
      this.oilTemp = 15;       // °C
      this.oilPress = 0;       // psi
      this.egt = 15;           // °C
      this.cht = 15;           // °C
      this.manifold = 29.9;    // inHg
      this.carbIce = 0;        // 0..1
      this.crankTime = 0;
      this.catchTime = 0.9 + Math.random() * 0.9;
      this.starveTime = 0;
      this.overspeedTime = 0;
      this.overheatTime = 0;
      this.damage = 0;         // 0..1
      this.failed = false;     // failure injected
      this.fuelAvailable = true;
      this.hours = 1243.6 + index * 3.1;
      this.roughness = 0;      // audio/vibration cue
    }

    get running() {
      return this.state !== EngineState.OFF && this.state !== EngineState.STARTING;
    }

    /** Ambient-adjusted best power mixture position (full rich at sea level, leaner at altitude). */
    bestMixture(sigma) {
      return M.clamp(0.25 + 0.75 * Math.pow(sigma, 1.4), 0.3, 1);
    }

    /** Snaps the engine to a stabilised running state (used for runway/air starts). */
    setRunning(throttle = 0.2) {
      this.state = EngineState.RUNNING;
      this.magnetos = MAG.BOTH;
      this.throttle = throttle;
      this.rpm = this.cfg.idleRPM + (this.cfg.staticRPM - this.cfg.idleRPM) * throttle;
      this.oilTemp = this.cfg.oil.normalTemp;
      this.oilPress = 65;
      this.egt = 650;
      this.cht = 170;
    }

    /**
     * @param {number} dt
     * @param {object} env { sigma, pressureInHg, oatC, tas, busVolts, humidity, visibleMoisture }
     */
    update(dt, env) {
      const c = this.cfg;
      const sigma = env.sigma;
      const magsOn = this.magnetos !== MAG.OFF;
      const cranking = this.starter && this.magnetos === MAG.START && env.busVolts > (env.lowVolts || 20) * 0.9;
      const mixOk = this.mixture > 0.08;
      const best = this.bestMixture(sigma);

      // Fuel starvation is tolerated briefly (fuel in lines) before the engine quits.
      if (!this.fuelAvailable) this.starveTime += dt;
      else this.starveTime = 0;
      const fuelOk = this.starveTime < 2.5;

      // Carburettor icing: high humidity, OAT -5..25 °C, low throttle setting makes it worse.
      if (c.carb) {
        const iceRisk = env.humidity > 0.6 && env.oatC > -7 && env.oatC < 25 ? (env.humidity - 0.55) * (1.3 - this.throttle) : 0;
        if (this.carbHeat) this.carbIce = Math.max(0, this.carbIce - dt * 0.08);
        else if (this.running) this.carbIce = M.clamp(this.carbIce + iceRisk * dt * 0.006 - dt * 0.002, 0, 1);
      }

      /* ---- state machine */
      switch (this.state) {
        case EngineState.OFF:
          if (cranking) {
            this.state = EngineState.STARTING;
            this.crankTime = 0;
          }
          break;
        case EngineState.STARTING:
          if (!cranking) {
            this.state = EngineState.OFF;
            break;
          }
          this.crankTime += dt;
          // Starts if it has fuel, spark and a sensible mixture; too much throttle floods it.
          if (this.crankTime > this.catchTime && fuelOk && mixOk && this.mixture > 0.35 && this.throttle < 0.6 && !this.failed && this.damage < 0.95) {
            this.state = EngineState.RUNNING;
            this.catchTime = 0.7 + Math.random() * 1.1;
            SIM.events.emit('engine:started', { index: this.index });
          }
          break;
        case EngineState.DAMAGED:
          if (!magsOn || !mixOk || !fuelOk || this.damage >= 1) this.state = EngineState.OFF;
          break;
        default:
          if (!magsOn || !mixOk || !fuelOk || this.failed) {
            const reason = this.failed ? 'failure' : !fuelOk ? 'fuel' : !mixOk ? 'mixture' : 'magnetos';
            this.state = EngineState.OFF;
            SIM.events.emit('engine:stopped', { index: this.index, reason });
          }
      }

      const running = this.running;

      /* ---- power available */
      let powerFrac = 0;
      if (running) {
        const thr = Math.pow(this.throttle, 1.15) * 0.97 + 0.03;
        // Mixture: power loss when too rich, steep drop when too lean.
        const dm = this.mixture - best;
        let mixFactor = dm >= 0 ? 1 - 0.55 * dm * dm : 1 - 3.2 * dm * dm;
        if (dm < -0.28) mixFactor -= (-0.28 - dm) * 2.5;
        mixFactor = M.clamp(mixFactor, 0, 1);
        const magFactor = this.magnetos === MAG.BOTH || this.magnetos === MAG.START ? 1 : 0.95;
        const carbFactor = (1 - this.carbIce * 0.9) * (this.carbHeat ? 0.9 : 1);
        const damageFactor = 1 - this.damage * 0.6;
        powerFrac = thr * Math.pow(sigma, 1.1) * mixFactor * magFactor * carbFactor * damageFactor;
        this.roughness = M.clamp(Math.max(0, -dm - 0.15) * 3 + this.carbIce * 0.8 + this.damage * 0.7 + (magFactor < 1 ? 0.15 : 0), 0, 1);
        if (mixFactor < 0.12 || powerFrac < 0.004) {
          // Too lean or iced: the engine dies.
          this.state = EngineState.OFF;
          SIM.events.emit('engine:stopped', { index: this.index, reason: mixFactor < 0.12 ? 'mixture' : 'carb ice' });
        }
      } else {
        this.roughness = 0;
      }

      /* ---- RPM dynamics */
      let rpmTarget;
      const v = Math.max(0, env.tas);
      if (this.state === EngineState.STARTING) {
        rpmTarget = 220;
      } else if (running) {
        const fixedPitch = c.staticRPM * Math.cbrt(Math.max(powerFrac, 0.0005) / Math.max(sigma, 0.3)) * (1 + c.rpmPerMs * v);
        if (c.propType === 'constant') {
          const governed = c.minGovRPM + (c.maxRPM - c.minGovRPM) * this.prop;
          // Below governing range the prop behaves like fine fixed pitch.
          const finePitch = c.staticRPM * Math.cbrt(Math.max(powerFrac, 0.0005) / Math.max(sigma, 0.3)) * (1 + 0.004 * v);
          rpmTarget = Math.min(governed, Math.max(finePitch, c.idleRPM * 0.9));
        } else {
          rpmTarget = fixedPitch;
        }
        rpmTarget = Math.max(rpmTarget, c.idleRPM * 0.85 * Math.min(1, powerFrac * 30 + 0.2));
      } else {
        // Windmilling propeller.
        rpmTarget = v > 18 ? (v - 12) * c.windmill * (c.propType === 'constant' ? 0.6 + 0.4 * this.prop : 1) : 0;
      }
      const tau = running || this.state === EngineState.STARTING ? 0.55 : 1.4;
      this.rpm = M.damp(this.rpm, rpmTarget, 1 / tau, dt);
      if (this.rpm < 1) this.rpm = 0;

      /* ---- delivered power, thrust, torque */
      const rpmFrac = this.rpm / c.maxRPM;
      this.power = running ? c.maxPower * powerFrac * M.clamp(0.35 + 0.65 * rpmFrac, 0, 1.1) : 0;
      if (c.propType === 'constant') this.power = running ? c.maxPower * powerFrac * M.clamp(this.rpm / c.maxRPM, 0.5, 1.05) : 0;
      const v0 = (c.propEff * c.maxPower) / c.staticThrust; // speed scale that yields static thrust
      this.thrust = (c.propEff * this.power) / Math.sqrt(v * v + v0 * v0);
      if (!running && this.rpm > 0) {
        // Windmilling prop produces drag.
        this.thrust = -0.00035 * this.rpm * v * (c.propType === 'constant' ? 1.2 - this.prop * 0.6 : 1);
      }
      const omega = Math.max(this.rpm, 300) * (Math.PI / 30);
      this.torque = this.power / omega;

      /* ---- manifold pressure */
      const ambientInHg = env.pressureInHg;
      this.manifold = running || this.rpm > 100 ? ambientInHg * (0.32 + 0.66 * this.throttle) * (1 - this.carbIce * 0.3) : ambientInHg;

      /* ---- fuel flow (gal/h) */
      if (running) {
        const richness = M.clamp(1 + (this.mixture - best) * 1.2, 0.55, 1.4);
        this.fuelFlow = Math.max(0.9, c.fuelFlowMax * (this.power / c.maxPower) * richness * 1.05);
      } else {
        this.fuelFlow = 0;
      }

      /* ---- temperatures and pressures */
      const pf = this.power / c.maxPower;
      const lean = M.clamp(best - this.mixture + 0.1, -0.4, 0.4);
      const egtTarget = running ? 480 + 380 * pf + 650 * Math.max(0, lean) * pf * 2 - 120 * Math.max(0, -lean) : env.oatC;
      this.egt = M.damp(this.egt, egtTarget, 0.5, dt);
      const cooling = 1 + v / 35;
      const chtTarget = running ? env.oatC + (90 + 140 * pf + 80 * Math.max(0, lean)) / Math.sqrt(cooling) * 1.4 : env.oatC;
      this.cht = M.damp(this.cht, chtTarget, 0.05, dt);
      const oilTarget = running ? Math.min(c.oil.maxTemp + 30, env.oatC + 45 + 75 * pf / Math.sqrt(cooling) + (this.cht - 180) * 0.15 + this.overheatBias()) : env.oatC;
      this.oilTemp = M.damp(this.oilTemp, oilTarget, 0.025, dt);
      const pressTarget = this.rpm > 200 ? M.clamp((30 + this.rpm / 40) * (1 + (60 - this.oilTemp) * 0.004), 0, c.oil.maxPress) * (1 - this.damage * 0.6) : 0;
      this.oilPress = M.damp(this.oilPress, pressTarget, 2.0, dt);

      /* ---- abuse and damage */
      if (running && this.rpm > c.redline * 1.04) {
        this.overspeedTime += dt;
        this.state = EngineState.OVERPOWER;
        if (this.overspeedTime > 12) this.addDamage(dt * 0.03);
      } else {
        this.overspeedTime = Math.max(0, this.overspeedTime - dt * 0.5);
        if (running && this.state !== EngineState.DAMAGED) this.state = this.throttle < 0.08 ? EngineState.IDLE : EngineState.RUNNING;
      }
      if (this.oilTemp > c.oil.maxTemp + 8 || this.cht > 260) {
        this.overheatTime += dt;
        if (this.overheatTime > 20) this.addDamage(dt * 0.01);
      } else {
        this.overheatTime = Math.max(0, this.overheatTime - dt);
      }
      if (this.damage > 0.5 && this.running) this.state = EngineState.DAMAGED;
      if (running) this.hours += dt / 3600;
    }

    overheatBias() {
      return this._overheatFailure ? 55 : 0;
    }

    addDamage(amount) {
      const before = this.damage;
      this.damage = M.clamp(this.damage + amount, 0, 1);
      if (before <= 0.5 && this.damage > 0.5) SIM.events.emit('engine:damaged', { index: this.index });
    }

    /** Vacuum pump output (inHg) for gyro instruments. */
    get vacuum() {
      return this.rpm < 100 ? 0 : M.clamp(1.2 + this.rpm / 420, 0, 5.3);
    }

    /** Percent "RPM" used by generic displays. */
    get displayRPM() {
      return this.rpm;
    }

    getStatusLabel() {
      return this.state;
    }
  }

  class TurbofanEngine {
    constructor(cfg, index) {
      this.cfg = cfg;
      this.index = index;
      this.kind = 'turbofan';
      this.throttle = 0;
      this.mixture = 1;    // fuel control lever: 1 = IDLE (fuel on), 0 = CUTOFF
      this.prop = 1;
      this.starter = false;  // engine start switch GRD
      this.reverse = false;
      this.state = EngineState.OFF;
      this.n1 = 0;
      this.n2 = 0;
      this.egt = 15;
      this.oilTemp = 15;
      this.oilPress = 0;
      this.thrust = 0;
      this.fuelFlow = 0;     // kg/h
      this.torque = 0;
      this.damage = 0;
      this.failed = false;
      this.fuelAvailable = true;
      this.starveTime = 0;
      this.reverserPos = 0;
      this.roughness = 0;
      this.hours = 18450.2 + index * 22.4;
    }

    get running() {
      return this.state !== EngineState.OFF && this.state !== EngineState.STARTING;
    }

    get rpm() {
      return this.n1;
    }

    get displayRPM() {
      return this.n1;
    }

    get vacuum() {
      return 0;
    }

    get manifold() {
      return 0;
    }

    setRunning(throttle = 0) {
      this.state = EngineState.RUNNING;
      this.mixture = 1;
      this.throttle = throttle;
      this.n2 = this.cfg.idleN2 + 35 * throttle;
      this.n1 = this.cfg.idleN1 + (98 - this.cfg.idleN1) * throttle;
      this.egt = 480 + 300 * throttle;
      this.oilTemp = 85;
      this.oilPress = 45;
    }

    update(dt, env) {
      const c = this.cfg;
      const fuelOn = this.mixture > 0.5;
      if (!this.fuelAvailable) this.starveTime += dt;
      else this.starveTime = 0;
      const fuelOk = this.starveTime < 4;

      switch (this.state) {
        case EngineState.OFF:
          if (this.starter && env.busVolts > 18 && !this.failed) {
            this.state = EngineState.STARTING;
          }
          break;
        case EngineState.STARTING:
          if (!this.starter && this.n2 < 25) {
            this.state = EngineState.OFF;
            break;
          }
          if (this.n2 > 24 && fuelOn && fuelOk) {
            // light-off: starter cuts out automatically around 56% N2
            if (this.n2 > 56) {
              this.state = EngineState.RUNNING;
              this.starter = false;
              SIM.events.emit('engine:started', { index: this.index });
            }
          }
          break;
        default:
          if (!fuelOn || !fuelOk || this.failed) {
            this.state = EngineState.OFF;
            SIM.events.emit('engine:stopped', { index: this.index, reason: this.failed ? 'failure' : fuelOn ? 'fuel' : 'cutoff' });
          }
      }

      const running = this.running;
      const lit = this.state === EngineState.STARTING && this.n2 > 24 && fuelOn && fuelOk;
      let n2Target, n1Target;
      const ram = Math.max(0, env.tas) * 0.08; // windmilling
      if (running) {
        const cmd = this.reverse ? Math.max(this.throttle, 0) : this.throttle;
        n1Target = c.idleN1 + (100 - c.idleN1) * Math.pow(cmd, 0.85) * (1 - this.damage * 0.5);
        n1Target *= M.clamp(0.9 + 0.1 * env.sigma, 0.85, 1.02);
        n2Target = c.idleN2 + (100 - c.idleN2) * Math.pow(cmd, 0.7);
      } else if (this.state === EngineState.STARTING) {
        n2Target = lit ? 62 : this.starter ? 26 : 0;
        n1Target = lit ? 18 : 6;
      } else {
        n2Target = ram;
        n1Target = ram * 1.4;
      }
      // Spool rate slower at low N1, as in real turbofans.
      const spool = this.state === EngineState.STARTING ? 0.32 : (1 / c.spoolUp) * (0.35 + this.n1 / 110);
      const down = !running && this.state !== EngineState.STARTING ? 0.25 : spool * 1.25;
      this.n1 = M.damp(this.n1, n1Target, n1Target > this.n1 ? spool : down, dt);
      this.n2 = M.damp(this.n2, n2Target, n2Target > this.n2 ? spool * 1.1 : down, dt);

      // Thrust reverser deployment (only meaningful on the ground, handled by FlightModel).
      this.reverserPos = M.approach(this.reverserPos, this.reverse ? 1 : 0, dt / 2.0);

      const n1f = M.clamp((this.n1 - c.idleN1 * 0.6) / (100 - c.idleN1 * 0.6), 0, 1.05);
      const mach = env.tas / 340;
      let thrust = running ? c.maxThrust * Math.pow(n1f, 1.9) * Math.pow(env.sigma, 0.75) * (1 - 0.32 * mach) : 0;
      thrust += running ? c.maxThrust * 0.012 : 0; // idle residual
      if (this.reverserPos > 0.05) thrust = -thrust * c.reverseMax * this.reverserPos * 1.2;
      this.thrust = thrust;

      this.fuelFlow = running || lit ? c.fuelFlowIdle + (c.fuelFlowMax - c.fuelFlowIdle) * Math.pow(n1f, 2.2) * env.sigma : 0;
      const egtTarget = running ? 420 + 420 * n1f + (this.damage * 150) : lit ? 600 : env.oatC;
      this.egt = M.damp(this.egt, egtTarget, lit ? 0.6 : 0.3, dt);
      this.oilTemp = M.damp(this.oilTemp, running ? 80 + 30 * n1f : env.oatC, 0.03, dt);
      this.oilPress = M.damp(this.oilPress, this.n2 > 10 ? 20 + this.n2 * 0.45 : 0, 1.5, dt);
      this.roughness = this.damage * 0.8;

      if (running) {
        this.state = this.n1 > 102 ? EngineState.OVERPOWER : this.damage > 0.5 ? EngineState.DAMAGED : this.throttle < 0.05 ? EngineState.IDLE : EngineState.RUNNING;
        if (this.egt > c.egtMax) this.damage = M.clamp(this.damage + dt * 0.004, 0, 1);
        this.hours += dt / 3600;
      }
    }

    getStatusLabel() {
      return this.state;
    }
  }

  function createEngine(cfg, index) {
    return cfg.type === 'turbofan' ? new TurbofanEngine(cfg, index) : new PistonEngine(cfg, index);
  }

  SIM.EngineState = EngineState;
  SIM.MAG = MAG;
  SIM.MAG_LABELS = MAG_LABELS;
  SIM.PistonEngine = PistonEngine;
  SIM.TurbofanEngine = TurbofanEngine;
  SIM.createEngine = createEngine;
  SIM.units = U;
})(window.SIM);
