/**
 * Autopilot — drives the real control surfaces (elevator, aileron, trim, throttle) through PID
 * loops, it never sets attitude directly.
 *
 * Lateral modes: ROL (wing leveller), HDG, NAV (GPS or VOR course), APR (localizer / GPS final).
 * Vertical modes: VS, ALT, GS (glideslope). Optional autothrottle SPD for the airliner.
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;

  class PID {
    constructor(kp, ki, kd, iMin = -1, iMax = 1) {
      Object.assign(this, { kp, ki, kd, iMin, iMax });
      this.i = 0;
      this.prev = null;
    }
    reset(i = 0) {
      this.i = i;
      this.prev = null;
    }
    update(err, dt, derivative) {
      this.i = M.clamp(this.i + err * this.ki * dt, this.iMin, this.iMax);
      let d = 0;
      if (derivative !== undefined) d = derivative;
      else if (this.prev !== null) d = (err - this.prev) / dt;
      this.prev = err;
      return this.kp * err + this.i + this.kd * d;
    }
  }

  class Autopilot {
    constructor(aircraft) {
      this.ac = aircraft;
      const type = aircraft.cfg.avionics.autopilot;
      this.available = !!type;
      this.type = type;
      this.engaged = false;
      this.lateral = 'ROL';
      this.vertical = 'VS';
      this.armedLateral = null;   // 'NAV' | 'LOC'
      this.armedVertical = null;  // 'ALT' | 'GS'
      this.hdgBug = 0;
      this.altTarget = 3000;      // ft
      this.vsTarget = 0;          // fpm
      this.spdTarget = 250;       // kt (autothrottle)
      this.atAvailable = !!aircraft.cfg.avionics.autothrottle;
      this.atEngaged = false;
      const jet = type === 'mcp';
      this.maxBank = jet ? 25 : 20;
      this.maxVs = jet ? 3000 : 1000;
      this.rollPid = new PID(0.045, 0.012, 0.0, -0.25, 0.25);
      this.pitchPid = new PID(jet ? 0.09 : 0.075, jet ? 0.04 : 0.05, 0, -0.5, 0.5);
      this.vsPid = new PID(0.006, 0.0015, 0, -6, 6);
      this.spdPid = new PID(0.05, 0.02, 0, -0.6, 0.9);
      this.pitchCmd = 0;
      this.disconnectFlash = 0;
      this.status = '';
    }

    get on() {
      return this.engaged && this.powered;
    }

    get powered() {
      return this.ac.systems.elec.avionicsPowered;
    }

    /* ---------------------------------------------------------------- buttons */

    toggleAP() {
      if (!this.available) return;
      if (this.engaged) this.disengage('manual');
      else this.engage();
    }

    engage() {
      if (!this.available || !this.powered) {
        SIM.events.emit('notify', { text: 'AUTOPILOT UNAVAILABLE — NO POWER', level: 'warn' });
        return;
      }
      const s = this.ac.state;
      this.engaged = true;
      if (this.lateral !== 'HDG' && this.lateral !== 'NAV' && this.lateral !== 'APR') this.lateral = 'ROL';
      if (this.vertical !== 'ALT' && this.vertical !== 'GS') {
        this.vertical = 'VS';
        this.vsTarget = Math.round(s.vsFpm / 100) * 100;
      }
      this.rollPid.reset();
      this.pitchPid.reset();
      this.vsPid.reset();
      this.pitchCmd = s.pitchDeg;
      SIM.events.emit('autopilot', { engaged: true });
    }

    disengage(reason = 'manual') {
      if (!this.engaged) return;
      this.engaged = false;
      this.armedLateral = null;
      this.armedVertical = null;
      this.disconnectFlash = 3;
      SIM.events.emit('autopilot', { engaged: false, reason });
    }

    setLateral(mode) {
      if (!this.available) return;
      if (!this.engaged) this.engage();
      if (!this.engaged) return;
      if (mode === 'HDG') {
        this.lateral = this.lateral === 'HDG' ? 'ROL' : 'HDG';
        this.armedLateral = null;
      } else if (mode === 'NAV') {
        if (this.lateral === 'NAV' || this.armedLateral === 'NAV') {
          this.lateral = this.lateral === 'NAV' ? 'ROL' : this.lateral;
          this.armedLateral = null;
        } else {
          this.armedLateral = 'NAV';
          if (this.lateral !== 'HDG') this.lateral = 'ROL';
        }
      } else if (mode === 'APR') {
        if (this.lateral === 'APR' || this.armedLateral === 'APR') {
          if (this.lateral === 'APR') this.lateral = 'ROL';
          this.armedLateral = null;
          if (this.vertical === 'GS') this.vertical = 'VS';
          this.armedVertical = null;
        } else {
          this.armedLateral = 'APR';
          this.armedVertical = 'GS';
          if (this.lateral !== 'HDG') this.lateral = 'ROL';
        }
      }
      SIM.events.emit('autopilot', { engaged: this.engaged });
    }

    setVertical(mode) {
      if (!this.available) return;
      if (!this.engaged) this.engage();
      if (!this.engaged) return;
      const s = this.ac.state;
      if (mode === 'ALT') {
        if (this.vertical === 'ALT') {
          this.vertical = 'VS';
          this.vsTarget = 0;
        } else {
          this.vertical = 'ALT';
          this.altHold = Math.round(s.altFt / 10) * 10;
        }
      } else if (mode === 'VS') {
        this.vertical = 'VS';
        this.vsTarget = Math.round(s.vsFpm / 100) * 100;
        // Arm altitude capture toward the preselected altitude
        this.armedVertical = 'ALT';
      }
      SIM.events.emit('autopilot', { engaged: this.engaged });
    }

    toggleAutothrottle() {
      if (!this.atAvailable) return;
      this.atEngaged = !this.atEngaged;
      if (this.atEngaged) {
        this.spdTarget = Math.round(this.ac.state.iasKt);
        this.spdPid.reset(this.ac.engines[0].throttle - 0.5);
      }
      SIM.events.emit('autopilot', { engaged: this.engaged, at: this.atEngaged });
    }

    adjustHeading(delta) {
      this.hdgBug = M.wrap360(this.hdgBug + delta);
    }

    adjustAltitude(delta) {
      this.altTarget = M.clamp(this.altTarget + delta, 0, 45000);
      if (this.engaged && this.vertical === 'VS') this.armedVertical = 'ALT';
    }

    adjustVS(delta) {
      if (this.vertical === 'ALT' && this.engaged) {
        // UP/DN in ALT mode nudges the held altitude (KAP-140 behaviour)
        this.altHold += delta > 0 ? 20 : -20;
        return;
      }
      this.vsTarget = M.clamp(this.vsTarget + delta, -this.maxVs, this.maxVs);
    }

    adjustSpeed(delta) {
      this.spdTarget = M.clamp(this.spdTarget + delta, 100, 340);
    }

    /* ---------------------------------------------------------------- update */

    update(dt, nav) {
      if (this.disconnectFlash > 0) this.disconnectFlash -= dt;
      const ac = this.ac;
      const s = ac.state;
      const ctl = ac.controls;

      // Autothrottle works independently of the AP.
      if (this.atEngaged) {
        if (!this.powered || ac.onGround) {
          this.atEngaged = false;
          SIM.events.emit('autopilot', { engaged: this.engaged, at: false });
        } else {
          const cmd = 0.5 + this.spdPid.update(this.spdTarget - s.iasKt, dt);
          ac.engines.forEach((e) => (e.throttle = M.clamp(M.approach(e.throttle, cmd, dt * 0.25), 0, 1)));
        }
      }

      if (!this.engaged) return;
      if (!this.powered) {
        this.disengage('power');
        return;
      }
      // Pilot override disconnects
      if (Math.abs(ac.input.pitch) > 0.45 || Math.abs(ac.input.roll) > 0.45) {
        this.disengage('override');
        return;
      }
      if (ac.onGround) {
        this.disengage('ground');
        return;
      }

      /* ---- mode transitions (arming/capture) */
      if (this.armedLateral && nav) {
        const g = nav.guidance(this.armedLateral === 'APR' ? 'APR' : 'NAV');
        if (g.valid) {
          const xtkLimit = g.isLoc ? 900 : 1852 * 1.2;
          const crs = M.angleDiff(s.trackDeg, g.course);
          if (Math.abs(g.xtk) < xtkLimit && Math.abs(crs) < 100) {
            this.lateral = this.armedLateral;
            this.armedLateral = null;
            SIM.events.emit('notify', { text: `AP ${this.lateral} CAPTURED`, level: 'info' });
          }
        }
      }
      if (this.armedVertical === 'GS' && this.lateral === 'APR' && nav) {
        const v = nav.verticalGuidance();
        if (v.valid && s.altFt >= v.pathAltFt - 60 && v.distNm < 15) {
          this.vertical = 'GS';
          this.armedVertical = null;
          SIM.events.emit('notify', { text: 'AP GLIDESLOPE CAPTURED', level: 'info' });
        }
      }
      if (this.armedVertical === 'ALT' && this.vertical === 'VS') {
        const toGo = this.altTarget - s.altFt;
        if (Math.abs(toGo) < Math.max(80, Math.abs(s.vsFpm) * 0.12) || Math.sign(toGo) !== Math.sign(this.vsTarget || toGo)) {
          if (Math.abs(toGo) < 400) {
            this.vertical = 'ALT';
            this.altHold = this.altTarget;
            this.armedVertical = null;
            SIM.events.emit('notify', { text: 'AP ALTITUDE CAPTURED', level: 'info' });
          }
        }
      }

      /* ---- lateral: target bank */
      let targetBank = 0;
      if (this.lateral === 'HDG') {
        targetBank = M.clamp(M.angleDiff(s.headingDeg, this.hdgBug) * 1.6, -this.maxBank, this.maxBank);
      } else if ((this.lateral === 'NAV' || this.lateral === 'APR') && nav) {
        const g = nav.guidance(this.lateral);
        if (g.valid) {
          const gain = g.isLoc ? 0.085 : 0.025;
          const intercept = M.clamp(-g.xtk * gain, -40, 40);
          const desiredTrack = M.wrap360(g.course + intercept);
          targetBank = M.clamp(M.angleDiff(s.trackDeg, desiredTrack) * (g.isLoc ? 2.0 : 1.6), -this.maxBank, this.maxBank);
        }
      } else if (Math.abs(s.rollDeg) < 5) {
        targetBank = 0;
      }
      // Gain scheduling by dynamic pressure keeps the loop behaviour similar across speeds.
      const qRef = 0.5 * 1.225 * Math.pow(ac.cfg.performance.cruise * SIM.Units.KT * 0.8, 2);
      const sched = M.clamp(qRef / Math.max(ac.fm.qbar, 200), 0.4, 3);
      const rollRate = -ac.fm.omega.z * M.RAD;
      const aCmd = this.rollPid.update(targetBank - s.rollDeg, dt, -rollRate) * sched - rollRate * 0.012 * sched;
      ctl.apAileron = M.clamp(aCmd, -0.6, 0.6);

      /* ---- vertical: target VS -> pitch -> elevator */
      let vsT = this.vsTarget;
      if (this.vertical === 'ALT') {
        vsT = M.clamp((this.altHold - s.altFt) * 4, -this.maxVs * 0.7, this.maxVs * 0.7);
      } else if (this.vertical === 'GS' && nav) {
        const v = nav.verticalGuidance();
        if (v.valid) {
          const nominal = -s.gsKt * 101.27 * Math.tan(3 * M.DEG);
          vsT = M.clamp(nominal + (v.pathAltFt - s.altFt) * 5, -2000, 500);
        }
      }
      const vsErr = vsT - s.vsFpm;
      this.pitchCmd = M.clamp(s.pitchDeg + this.vsPid.update(vsErr, dt), -12, 16);
      // Keep pitch command near the current attitude so the integrator never winds far away
      const pitchRate = ac.fm.omega.x * M.RAD;
      const eCmd = this.pitchPid.update(this.pitchCmd - s.pitchDeg, dt, -pitchRate) * sched;
      ctl.apElevator = M.clamp(eCmd - pitchRate * 0.01 * sched, -0.7, 0.7);

      // Trim servo slowly offloads the elevator, as on a real autopilot.
      if (Math.abs(ctl.apElevator) > 0.05) {
        ctl.elevatorTrim = M.clamp(ctl.elevatorTrim + Math.sign(ctl.apElevator) * dt * 0.03, -1, 1);
        this.pitchPid.i -= Math.sign(ctl.apElevator) * dt * 0.03 * ac.trimToElevator;
      }
    }

    /** Annunciator text for the AP display. */
    annunciation() {
      if (!this.powered) return { lat: '', vert: '', armed: '', ap: false };
      return {
        lat: this.engaged ? this.lateral : '',
        vert: this.engaged ? (this.vertical === 'VS' ? 'VS' : this.vertical) : '',
        armed: [this.armedLateral, this.armedVertical].filter(Boolean).join(' '),
        ap: this.engaged,
        at: this.atEngaged,
      };
    }
  }

  SIM.Autopilot = Autopilot;
  SIM.PID = PID;
})(window.SIM);
