/**
 * Propeller — thrust and torque from non-dimensional coefficients as a function of advance ratio
 * J = V / (n·D):  CT(J) = CT0 − kT·J²,  CP(J) = CP0 − kP·J²  (T = CT·ρ·n²·D⁴, Q = CP·ρ·n²·D⁵ / 2π).
 *
 * The coefficients are calibrated from real data at construction:
 *  - CP0 from the static RPM the engine reaches at full throttle (engine torque = prop torque),
 *  - CT0 from the static thrust,
 *  - kT from the zero-thrust advance ratio given by the geometric pitch,
 *  - kP so that the peak propulsive efficiency matches a realistic value (≈0.80 fixed pitch,
 *    ≈0.86 constant speed).
 * Constant-speed propellers shift the curves with blade pitch, driven by a governor.
 * Written in "n² form" so a stopped or windmilling propeller stays well defined (no 1/n).
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;
  const TWO_PI = Math.PI * 2;
  const IN = 0.0254;

  class Propeller {
    /**
     * @param {object} cfg engine config (propDiameter, propPitchIn, blades, propType, minGovRPM, maxRPM)
     */
    constructor(cfg) {
      this.cfg = cfg;
      this.D = cfg.propDiameter;
      this.R = this.D / 2;
      this.area = Math.PI * this.R * this.R;
      this.blades = cfg.blades || 2;
      this.constantSpeed = cfg.propType === 'constant';
      this.pitch = 0;               // constant speed: blade angle above the fine stop (curve scale s = 1 + pitch)
      this.pitchMax = 1.7;
      this.featherable = !!cfg.featherable;
      this.feather = 0;             // 0 = governed, 1 = blades fully feathered (edge-on to the airflow)
      this.thrust = 0;
      this.torque = 0;
      this.vi = 0;                  // induced (slipstream) velocity at the disk
      this.swirl = 0;
      this.efficiency = 0;
      this.J = 0;
    }

    /**
     * Calibrates the coefficients.
     * @param {number} staticPower shaft power absorbed at static full throttle (W) at staticRPM
     */
    calibrate(staticPower) {
      const c = this.cfg;
      const rho = SIM.Phys.RHO0;
      const n = c.staticRPM / 60;
      const D = this.D;
      this.CP0 = staticPower / (rho * n * n * n * Math.pow(D, 5));
      this.CT0 = c.staticThrust / (rho * n * n * Math.pow(D, 4));
      const pd = (c.propPitchIn * IN) / D;
      this.J0 = this.constantSpeed ? 0.95 : M.clamp(pd * 1.34, 0.7, 1.4);
      this.kT = this.CT0 / (this.J0 * this.J0);
      const etaPeak = this.constantSpeed ? 0.86 : 0.8;
      // Bisection on kP so that max_J η(J) = etaPeak
      let lo = 0, hi = (this.CP0 / (this.J0 * this.J0)) * 0.999;
      for (let it = 0; it < 40; it++) {
        const kP = (lo + hi) / 2;
        let best = 0;
        for (let J = 0.05; J < this.J0; J += 0.01) {
          const cp = this.CP0 - kP * J * J;
          if (cp <= 1e-5) break;
          best = Math.max(best, (J * (this.CT0 - this.kT * J * J)) / cp);
        }
        // larger kP lowers CP at high J and raises efficiency
        if (best > etaPeak) hi = kP;
        else lo = kP;
      }
      this.kP = (lo + hi) / 2;
    }

    /**
     * Coefficients evaluated in n² form: returns {ctn2, cpn2} (CT·n², CP·n²).
     * Constant-speed blade angle is a similarity scale s = 1 + pitch on the fine-pitch curves:
     * CT(J, s) = CT(J/s), CP(J, s) = s·CP(J/s). Coarser blades absorb more power and stretch the
     * curves to higher advance ratios while the peak efficiency stays the same (η(J, s) = η(J/s)).
     */
    coeffN2(n, V) {
      const s = 1 + this.pitch;
      const vd = V / this.D;
      const vd2 = vd * vd;
      return {
        ctn2: this.CT0 * n * n - (this.kT * vd2) / (s * s),
        cpn2: this.CP0 * s * n * n - (this.kP * vd2) / s,
      };
    }

    /**
     * Thrust (N) and absorbed torque (N·m, positive = loads the engine) at a rotation speed.
     * @param {number} rpm
     * @param {number} V axial airspeed (m/s, forward positive)
     * @param {number} rho air density
     */
    evaluate(rpm, V, rho) {
      const n = Math.max(rpm, 0) / 60;
      const D = this.D;
      const { ctn2, cpn2 } = this.coeffN2(n, Math.max(V, 0));
      let T = ctn2 * rho * Math.pow(D, 4);
      let Q = (cpn2 * rho * Math.pow(D, 5)) / TWO_PI;
      // Physical limits for a stopped/windmilling propeller
      const q = 0.5 * rho * V * V;
      const Tmin = -q * 0.045 * D * D * this.blades;
      const Qdrive = -q * 0.012 * D * D * D * this.blades;
      if (T < Tmin) T = Tmin;
      if (Q < Qdrive) Q = Qdrive;
      if (this.feather > 0) {
        // Feathered blades: almost no drag, and any rotation is braked by the very coarse blade angle
        const Tf = -q * 0.0022 * D * D * this.blades;
        const Qf = (0.22 * rho * n * n * Math.pow(D, 5)) / TWO_PI;
        T += (Tf - T) * this.feather;
        Q += (Qf - Q) * this.feather;
      }
      return { T, Q, J: n > 0.1 ? V / (n * D) : 99 };
    }

    /** Constant-speed governor: adjusts blade pitch to hold the selected RPM. */
    govern(dt, rpm, targetRpm, oilPressureOk, lever = 1) {
      if (!this.constantSpeed) return;
      if (this.featherable) {
        // Lever in the FEATHER detent, or loss of oil pressure above the anti-feather latch speed
        // (counterweights and the feathering spring drive the blades coarse) — about 6 s to feather.
        const wantFeather = lever < 0.03 || (!oilPressureOk && rpm > 800) || (this.feather > 0.98 && !oilPressureOk);
        if (wantFeather) {
          this.feather = Math.min(1, this.feather + dt / 6);
          return;
        }
        if (this.feather > 0) {
          // Unfeathering needs oil pressure (accumulator / starter)
          if (oilPressureOk || rpm > 300) this.feather = Math.max(0, this.feather - dt / 4);
          if (this.feather > 0) return;
        }
      }
      if (!oilPressureOk) {
        // No oil pressure on a non-feathering prop: the blades drift to fine pitch
        this.pitch = M.approach(this.pitch, 0, dt * 0.5);
        return;
      }
      const err = (rpm - targetRpm) / targetRpm;
      this.pitch = M.clamp(this.pitch + err * 6 * dt, 0, this.pitchMax);
    }

    /** Updates thrust, torque and slipstream at the current state. */
    update(rpm, V, rho) {
      const r = this.evaluate(rpm, V, rho);
      this.thrust = r.T;
      this.torque = r.Q;
      this.J = r.J;
      const Vp = Math.max(V, 0);
      // Momentum theory: induced velocity at the disk
      this.vi = r.T > 0 ? 0.5 * (-Vp + Math.sqrt(Vp * Vp + (2 * r.T) / (rho * this.area))) : 0;
      // Swirl (tangential) velocity at 70 % radius from the torque
      const mdot = rho * this.area * (Vp + this.vi);
      this.swirl = mdot > 1 ? M.clamp(r.Q / (mdot * 0.7 * this.R), 0, 25) : 0;
      const P = r.Q * (rpm * Math.PI / 30);
      this.efficiency = P > 100 && r.T > 0 ? (r.T * Vp) / P : 0;
    }
  }

  SIM.Propeller = Propeller;
})(window.SIM);
