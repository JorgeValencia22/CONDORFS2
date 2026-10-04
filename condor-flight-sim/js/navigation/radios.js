/**
 * Radio stack: COM1/COM2 (25 kHz), NAV1/NAV2 (50 kHz) with active/standby frequencies,
 * OBS courses, CDI source selection and transponder. All units require avionics power.
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;

  const RANGES = {
    com: { min: 118.0, max: 136.975, step: 0.025 },
    nav: { min: 108.0, max: 117.95, step: 0.05 },
  };

  const round = (f, step) => Math.round(f / step) * step;

  class RadioStack {
    constructor(avionicsCfg) {
      this.cfg = avionicsCfg;
      this.units = {
        com1: { kind: 'com', active: 118.1, standby: 121.9 },
        com2: { kind: 'com', active: 122.8, standby: 132.1 },
        nav1: { kind: 'nav', active: 116.2, standby: 109.9 },
        nav2: { kind: 'nav', active: 113.4, standby: 112.7 },
      };
      this.obs = { nav1: 0, nav2: 0 };
      this.cdiSource = avionicsCfg.gps ? 'GPS' : 'NAV1';
      this.transmit = 'com1';
      this.xpdr = { code: 1200, mode: 'ALT', ident: 0 };
      this.powered = false;
    }

    has(name) {
      if (name.startsWith('com')) return Number(name[3]) <= this.cfg.com;
      if (name.startsWith('nav')) return Number(name[3]) <= this.cfg.nav;
      return false;
    }

    swap(name) {
      const u = this.units[name];
      if (!u || !this.powered) return;
      [u.active, u.standby] = [u.standby, u.active];
      SIM.events.emit('radio:changed', { name, active: u.active });
    }

    /** Tunes the standby frequency: coarse = MHz, fine = channel step. */
    tune(name, delta, coarse = false) {
      const u = this.units[name];
      if (!u || !this.powered) return;
      const r = RANGES[u.kind];
      let f = u.standby;
      if (coarse) {
        const frac = f - Math.floor(f);
        let mhz = Math.floor(f) + delta;
        const lo = Math.floor(r.min), hi = Math.floor(r.max);
        if (mhz > hi) mhz = lo;
        if (mhz < lo) mhz = hi;
        f = mhz + frac;
      } else {
        const mhz = Math.floor(f + 1e-6);
        let frac = round(f - mhz + delta * r.step, r.step);
        if (frac >= 1 - 1e-6) frac = 0;
        if (frac < -1e-6) frac = 1 - r.step;
        f = mhz + frac;
      }
      u.standby = M.clamp(Number(round(f, r.step).toFixed(3)), r.min, r.max);
    }

    /** Directly sets a frequency (validated). Returns true on success. */
    set(name, freq, which = 'standby') {
      const u = this.units[name];
      if (!u) return false;
      const r = RANGES[u.kind];
      const f = Number(freq);
      if (!Number.isFinite(f) || f < r.min - 1e-6 || f > r.max + 1e-6) return false;
      u[which] = Number(round(f, r.step).toFixed(3));
      if (which === 'active') SIM.events.emit('radio:changed', { name, active: u[which] });
      return true;
    }

    adjustObs(name, delta) {
      this.obs[name] = M.wrap360(Math.round(this.obs[name] + delta));
    }

    toggleCdiSource() {
      if (!this.cfg.gps) return;
      this.cdiSource = this.cdiSource === 'GPS' ? 'NAV1' : 'GPS';
      SIM.events.emit('notify', { text: `CDI ${this.cdiSource === 'GPS' ? 'GPS' : 'VLOC'}`, level: 'info' });
    }

    setSquawk(code) {
      const s = String(code).padStart(4, '0');
      if (!/^[0-7]{4}$/.test(s)) return false;
      this.xpdr.code = Number(s);
      return true;
    }

    format(name, which = 'active') {
      const u = this.units[name];
      if (!u) return '---.---';
      return u.kind === 'com' ? u[which].toFixed(3) : u[which].toFixed(2);
    }
  }

  SIM.RadioStack = RadioStack;
  SIM.RadioRanges = RANGES;
})(window.SIM);
