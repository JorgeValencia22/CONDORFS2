/**
 * Engine simulation.
 *
 * PistonEngine: crankshaft speed is integrated from a torque balance
 *   I·dω/dt = Q_engine(MP, mixture, magnetos, carb ice) + Q_starter − Q_friction(rpm) − Q_propeller(rpm, V)
 * so RPM, windmilling, overspeed in a dive and stopping the propeller all emerge from physics.
 * The idle throttle stop and the propeller coefficients are calibrated so that idle RPM and static
 * full-throttle RPM match the real aircraft. Constant-speed propellers use a governor.
 *
 * TurbofanEngine: N1/N2 spool dynamics with start sequence, thrust lapse with altitude and Mach,
 * thrust reversers.
 *
 * States: OFF, STARTING, IDLE, RUNNING, OVERPOWER, DAMAGED.
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;
  const U = SIM.Units;

  const EngineState = Object.freeze({
    OFF: 'OFF', STARTING: 'STARTING', IDLE: 'IDLE', RUNNING: 'RUNNING', OVERPOWER: 'OVERPOWER', DAMAGED: 'DAMAGED',
  });

  const MAG = Object.freeze({ OFF: 0, R: 1, L: 2, BOTH: 3, START: 4 });
  const MAG_LABELS = ['OFF', 'R', 'L', 'BOTH', 'START'];
  const RPM2RAD = Math.PI / 30;
  const K_IND = 1.15; // indicated/brake torque ratio at rated RPM (friction + pumping ≈ 15 %)

  class PistonEngine {
    constructor(cfg, index) {
      this.cfg = cfg;
      this.index = index;
      this.kind = 'piston';
      // Controls
      this.throttle = 0;
      this.mixture = 1;
      this.prop = 1;          // propeller lever (constant speed): 1 = max RPM
      this.carbHeat = false;
      this.magnetos = MAG.OFF;
      this.starter = false;
      // State
      this.state = EngineState.OFF;
      this.rpm = 0;
      this.omega = 0;
      this.power = 0;          // brake power (W)
      this.thrust = 0;         // N
      this.torque = 0;         // propeller torque (N·m) — reaction on the airframe
      this.fuelFlow = 0;       // gal/h
      this.oilTemp = 15;
      this.oilPress = 0;
      this.egt = 15;
      this.cht = 15;
      this.manifold = 29.9;    // inHg
      this.carbIce = 0;
      this.crankTime = 0;
      this.catchTime = 0.9 + Math.random() * 0.9;
      this.starveTime = 0;
      this.overspeedTime = 0;
      this.overheatTime = 0;
      this.damage = 0;
      this.failed = false;
      this.fuelAvailable = true;
      this.hours = 1243.6 + index * 3.1;
      this.roughness = 0;
      this.Qref = cfg.maxPower / (cfg.maxRPM * RPM2RAD);
      this.inertia = cfg.inertia || 2;
      this.propeller = new SIM.Propeller(cfg);
      this.calibrate();
    }

    get running() {
      return this.state !== EngineState.OFF && this.state !== EngineState.STARTING;
    }

    /** Friction + pumping torque (N·m) at a given RPM. */
    friction(rpm, running = true) {
      const f = 0.07 + 0.08 * Math.pow(rpm / this.cfg.maxRPM, 2);
      return this.Qref * (f + (running ? 0 : 0.1));
    }

    /** Calibrates the propeller (static RPM) and the throttle idle stop (idle RPM). */
    calibrate() {
      const c = this.cfg;
      const staticRpm = c.staticRPM;
      const qNet = K_IND * this.Qref - this.friction(staticRpm);
      this.propeller.calibrate(qNet * staticRpm * RPM2RAD);
      // idle: indicated torque at the throttle stop balances friction + propeller at idle RPM
      const qProp = this.propeller.evaluate(c.idleRPM, 0, SIM.Phys.RHO0).Q;
      this.mpIdle = M.clamp((this.friction(c.idleRPM) + qProp) / (K_IND * this.Qref), 0.08, 0.5);
    }

    /** Best-power mixture position for the air density (full rich at sea level, leaner aloft). */
    bestMixture(sigma) {
      return M.clamp(0.25 + 0.75 * Math.pow(sigma, 1.4), 0.3, 1);
    }

    mixtureFactor(sigma) {
      const dm = this.mixture - this.bestMixture(sigma);
      let f = dm >= 0 ? 1 - 0.55 * dm * dm : 1 - 3.2 * dm * dm;
      if (dm < -0.28) f -= (-0.28 - dm) * 2.5;
      return M.clamp(f, 0, 1);
    }

    /** Manifold pressure (inHg) for a throttle position. */
    manifoldPressure(throttle, ambientInHg) {
      return ambientInHg * (this.mpIdle + (1 - this.mpIdle) * Math.pow(throttle, 1.25));
    }

    /** Indicated (combustion) torque, N·m. */
    indicatedTorque(throttle, ambientInHg, oatC, sigma) {
      const mp = this.manifoldPressure(throttle, ambientInHg) * (1 - this.carbIce * 0.3);
      const charge = Math.sqrt(288.15 / (oatC + 273.15));
      const mag = this.magnetos === MAG.BOTH || this.magnetos === MAG.START ? 1 : 0.96;
      const carb = this.carbHeat ? 0.9 : 1;
      return K_IND * this.Qref * (mp / 29.92) * charge * this.mixtureFactor(sigma) * mag * carb * (1 - this.damage * 0.6);
    }

    governorTarget() {
      const c = this.cfg;
      return c.minGovRPM + (c.maxRPM - c.minGovRPM) * M.clamp((this.prop - 0.04) / 0.96, 0, 1);
    }

    /**
     * Steady-state operating point (used for trimmed air starts and performance tools).
     * @returns {{rpm:number, thrust:number, torque:number}}
     */
    steadyState(throttle, V, atm, running = this.running || this.state === EngineState.STARTING) {
      const c = this.cfg;
      const p = this.propeller;
      const sigma = atm.rho / SIM.Phys.RHO0;
      const amb = atm.pressure / 100 / U.INHG;
      const saved = { thr: this.throttle, pitch: p.pitch };
      this.throttle = throttle;
      if (!running) {
        // windmilling: the airflow drives the propeller against engine friction/compression
        const netOff = (rpm) => -p.evaluate(rpm, V, atm.rho).Q - this.friction(rpm, false);
        let rpmW = 0;
        if (netOff(1) > 0) {
          let lo = 1, hi = c.maxRPM * 1.5;
          for (let i = 0; i < 40; i++) {
            const mid = (lo + hi) / 2;
            if (netOff(mid) > 0) lo = mid;
            else hi = mid;
          }
          rpmW = (lo + hi) / 2;
        }
        const rw = p.evaluate(rpmW, V, atm.rho);
        this.throttle = saved.thr;
        return { rpm: rpmW, thrust: rw.T, torque: rw.Q, pitch: p.pitch };
      }
      const qEng = (rpm) => this.indicatedTorque(throttle, amb, atm.tempC, sigma) - this.friction(rpm);
      const net = (rpm) => qEng(rpm) - p.evaluate(rpm, V, atm.rho).Q;
      const solveRpm = () => {
        let lo = 50, hi = c.maxRPM * 1.6;
        if (net(lo) < 0) return lo;
        for (let i = 0; i < 40; i++) {
          const mid = (lo + hi) / 2;
          if (net(mid) > 0) lo = mid;
          else hi = mid;
        }
        return (lo + hi) / 2;
      };
      let rpm;
      if (p.constantSpeed) {
        const target = this.governorTarget();
        p.pitch = 0;
        rpm = solveRpm();
        if (rpm > target) {
          let lo = 0, hi = p.pitchMax;
          for (let i = 0; i < 40; i++) {
            p.pitch = (lo + hi) / 2;
            if (net(target) > 0) lo = p.pitch;
            else hi = p.pitch;
          }
          rpm = target;
        }
      } else {
        rpm = solveRpm();
      }
      const r = p.evaluate(rpm, V, atm.rho);
      const out = { rpm, thrust: r.T, torque: r.Q, pitch: p.pitch };
      this.throttle = saved.thr;
      if (!this._keepPitch) p.pitch = saved.pitch;
      return out;
    }

    /** Snaps the engine to a stabilised running state at the given flight condition. */
    setRunning(throttle = 0.2, V = 0, atm = null) {
      this.state = EngineState.RUNNING;
      this.magnetos = MAG.BOTH;
      this.throttle = throttle;
      const a = atm || { rho: SIM.Phys.RHO0, pressure: SIM.Phys.P0, tempC: 15 };
      this._keepPitch = true;
      const ss = this.steadyState(throttle, V, a, true);
      this._keepPitch = false;
      this.rpm = ss.rpm;
      this.omega = ss.rpm * RPM2RAD;
      this.oilTemp = this.cfg.oil.normalTemp;
      this.oilPress = 65;
      this.egt = 650;
      this.cht = 170;
    }

    /**
     * @param {number} dt
     * @param {object} env { sigma, rho, pressureInHg, oatC, tas, vAxial, busVolts, lowVolts, humidity }
     */
    update(dt, env) {
      const c = this.cfg;
      const sigma = env.sigma;
      const magsOn = this.magnetos !== MAG.OFF;
      const cranking = this.starter && this.magnetos === MAG.START && env.busVolts > (env.lowVolts || 24) * 0.75;
      const mixOk = this.mixture > 0.08;
      const best = this.bestMixture(sigma);

      if (!this.fuelAvailable) this.starveTime += dt;
      else this.starveTime = 0;
      const fuelOk = this.starveTime < 2.5;

      // Carburettor icing: humid air between −7 and 25 °C, worse at low power
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
          if (this.crankTime > this.catchTime && this.rpm > 120 && fuelOk && mixOk && this.mixture > 0.35 && this.throttle < 0.6 && !this.failed && this.damage < 0.95) {
            this.state = EngineState.RUNNING;
            this.sinceCatch = 0;
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
      let running = this.running;

      /* ---- torques */
      const V = Math.max(0, env.vAxial !== undefined ? env.vAxial : env.tas);
      const prop = this.propeller;
      if (prop.constantSpeed) prop.govern(dt, this.rpm, this.governorTarget(), this.oilPress > 15, this.prop);
      prop.update(this.rpm, V, env.rho);
      let qInd = 0;
      if (running) {
        qInd = this.indicatedTorque(this.throttle, env.pressureInHg, env.oatC, sigma);
        const mixF = this.mixtureFactor(sigma);
        this.roughness = M.clamp(Math.max(0, best - this.mixture - 0.15) * 3 + this.carbIce * 0.8 + this.damage * 0.7 + (this.magnetos === MAG.R || this.magnetos === MAG.L ? 0.15 : 0), 0, 1);
        if (mixF < 0.12) {
          this.state = EngineState.OFF;
          running = false;
          SIM.events.emit('engine:stopped', { index: this.index, reason: 'mixture' });
        }
      } else {
        this.roughness = 0;
      }
      // the starter keeps turning the engine while the key is held in START (also just after it fires)
      const qStarter = cranking ? this.Qref * 0.38 * Math.max(0, 1 - this.rpm / 380) : 0;
      this.sinceCatch = (this.sinceCatch ?? 99) + dt;
      const qFric = this.friction(this.rpm, running);
      const drive = qInd + qStarter - prop.torque;
      // Static friction: a stopped engine stays stopped unless something overcomes it
      if (this.omega < 1 && drive < qFric) {
        this.omega = 0;
      } else {
        this.omega = Math.max(0, this.omega + ((drive - qFric) / this.inertia) * dt);
      }
      this.rpm = this.omega / RPM2RAD;
      if (running && this.rpm < c.idleRPM * 0.4 && this.sinceCatch > 2) {
        // engine stalled (e.g. prop strike or extreme lean)
        this.state = EngineState.OFF;
        running = false;
        SIM.events.emit('engine:stopped', { index: this.index, reason: 'stalled' });
      }

      this.thrust = prop.thrust * (1 - this.damage * 0.15);
      this.torque = prop.torque;
      this.power = running ? Math.max(0, (qInd - qFric) * this.omega) : 0;
      this.manifold = running || this.rpm > 100 ? this.manifoldPressure(this.throttle, env.pressureInHg) * (1 - this.carbIce * 0.3) : env.pressureInHg;

      /* ---- fuel flow (gal/h) */
      if (running) {
        const richness = M.clamp(1 + (this.mixture - best) * 1.2, 0.55, 1.4);
        this.fuelFlow = Math.max(0.8, c.fuelFlowMax * (this.power / c.maxPower) * richness);
      } else {
        this.fuelFlow = 0;
      }

      /* ---- temperatures and pressures */
      const pf = this.power / c.maxPower;
      const lean = M.clamp(best - this.mixture + 0.1, -0.4, 0.4);
      const egtTarget = running ? 480 + 380 * pf + 650 * Math.max(0, lean) * pf * 2 - 120 * Math.max(0, -lean) : env.oatC;
      this.egt = M.damp(this.egt, egtTarget, 0.5, dt);
      const cooling = 1 + Math.max(0, env.tas) / 35;
      const chtTarget = running ? env.oatC + ((90 + 140 * pf + 80 * Math.max(0, lean)) / Math.sqrt(cooling)) * 1.4 : env.oatC;
      this.cht = M.damp(this.cht, chtTarget, 0.05, dt);
      const oilTarget = running ? Math.min(c.oil.maxTemp + 30, env.oatC + 45 + (75 * pf) / Math.sqrt(cooling) + (this.cht - 180) * 0.15 + (this._overheatFailure ? 55 : 0)) : env.oatC;
      this.oilTemp = M.damp(this.oilTemp, oilTarget, 0.025, dt);
      const pressTarget = this.rpm > 200 ? M.clamp((30 + this.rpm / 40) * (1 + (60 - this.oilTemp) * 0.004), 0, c.oil.maxPress) * (1 - this.damage * 0.6) : 0;
      this.oilPress = M.damp(this.oilPress, pressTarget, 2.0, dt);

      /* ---- abuse and damage */
      if (this.rpm > c.redline * 1.04) {
        this.overspeedTime += dt;
        if (running) this.state = EngineState.OVERPOWER;
        if (this.overspeedTime > 12 || this.rpm > c.redline * 1.25) this.addDamage(dt * (this.rpm > c.redline * 1.25 ? 0.2 : 0.03));
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

    addDamage(amount) {
      const before = this.damage;
      this.damage = M.clamp(this.damage + amount, 0, 1);
      if (before <= 0.5 && this.damage > 0.5) SIM.events.emit('engine:damaged', { index: this.index });
    }

    /** Vacuum pump output (inHg) for gyro instruments. */
    get vacuum() {
      return this.rpm < 100 ? 0 : M.clamp(1.2 + this.rpm / 420, 0, 5.3);
    }

    get displayRPM() {
      return this.rpm;
    }

    get vi() {
      return this.propeller.vi;
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
      this.mixture = 1;    // fuel control lever: 1 = RUN (idle), 0 = CUTOFF
      this.prop = 1;
      this.starter = false;
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
      this.vi = 0;
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

    n1Command(throttle, sigma) {
      const c = this.cfg;
      return (c.idleN1 + (100 - c.idleN1) * Math.pow(throttle, 0.85) * (1 - this.damage * 0.5)) * M.clamp(0.9 + 0.1 * sigma, 0.85, 1.02);
    }

    /** Net thrust (N) for an N1 at a flight condition. */
    thrustAt(n1, sigma, mach) {
      const c = this.cfg;
      const n1f = M.clamp((n1 - c.idleN1 * 0.6) / (100 - c.idleN1 * 0.6), 0, 1.05);
      // high-bypass lapse: falls with density and with Mach (ram drag)
      return c.maxThrust * Math.pow(n1f, 1.9) * Math.pow(sigma, 0.72) * (1 - 0.62 * mach + 0.04 * mach * mach) + c.maxThrust * 0.012;
    }

    steadyState(throttle, V, atm) {
      const sigma = atm.rho / SIM.Phys.RHO0;
      const n1 = this.n1Command(throttle, sigma);
      return { rpm: n1, thrust: this.thrustAt(n1, sigma, V / 340), torque: 0 };
    }

    setRunning(throttle = 0, V = 0, atm = null) {
      this.state = EngineState.RUNNING;
      this.mixture = 1;
      this.throttle = throttle;
      const sigma = atm ? atm.rho / SIM.Phys.RHO0 : 1;
      this.n1 = this.n1Command(throttle, sigma);
      this.n2 = this.cfg.idleN2 + (100 - this.cfg.idleN2) * Math.pow(throttle, 0.7);
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
          if (this.starter && env.busVolts > 18 && !this.failed) this.state = EngineState.STARTING;
          break;
        case EngineState.STARTING:
          if (!this.starter && this.n2 < 25) {
            this.state = EngineState.OFF;
            break;
          }
          if (this.n2 > 56 && fuelOn && fuelOk) {
            this.state = EngineState.RUNNING;
            this.starter = false;
            SIM.events.emit('engine:started', { index: this.index });
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
        n1Target = this.n1Command(cmd, env.sigma);
        n2Target = c.idleN2 + (100 - c.idleN2) * Math.pow(cmd, 0.7);
      } else if (this.state === EngineState.STARTING) {
        n2Target = lit ? 62 : this.starter ? 26 : 0;
        n1Target = lit ? 18 : 6;
      } else {
        n2Target = ram;
        n1Target = ram * 1.4;
      }
      const spool = this.state === EngineState.STARTING ? 0.32 : (1 / c.spoolUp) * (0.35 + this.n1 / 110);
      const down = !running && this.state !== EngineState.STARTING ? 0.25 : spool * 1.25;
      this.n1 = M.damp(this.n1, n1Target, n1Target > this.n1 ? spool : down, dt);
      this.n2 = M.damp(this.n2, n2Target, n2Target > this.n2 ? spool * 1.1 : down, dt);

      this.reverserPos = M.approach(this.reverserPos, this.reverse ? 1 : 0, dt / 2.0);
      let thrust = running ? this.thrustAt(this.n1, env.sigma, env.tas / 340) : 0;
      if (this.reverserPos > 0.05) thrust = -thrust * c.reverseMax * this.reverserPos * 1.2;
      this.thrust = thrust;

      const n1f = M.clamp((this.n1 - c.idleN1 * 0.6) / (100 - c.idleN1 * 0.6), 0, 1.05);
      this.fuelFlow = running || lit ? c.fuelFlowIdle + (c.fuelFlowMax - c.fuelFlowIdle) * Math.pow(n1f, 2.2) * env.sigma : 0;
      const egtTarget = running ? 420 + 420 * n1f + this.damage * 150 : lit ? 600 : env.oatC;
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
})(window.SIM);
