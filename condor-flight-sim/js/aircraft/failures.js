/**
 * FailureManager — OFF / RANDOM / CUSTOM failure modes. Failures act on the real systems
 * (engines, electrical bus, vacuum, pitot, gear, flaps, brakes, fuel) rather than on the UI.
 */
(function (SIM) {
  'use strict';

  /** Catalogue of failures. `rate` = expected occurrences per flight hour in RANDOM mode. */
  const FAILURES = [
    { id: 'engine', label: 'ENGINE FAILURE', rate: 0.25, description: 'Engine stops producing power.' },
    { id: 'alternator', label: 'ALTERNATOR FAILURE', rate: 0.3, description: 'Battery only: manage the electrical load.' },
    { id: 'electrical', label: 'ELECTRICAL FAILURE', rate: 0.1, description: 'Total loss of the electrical bus.' },
    { id: 'vacuum', label: 'VACUUM PUMP FAILURE', rate: 0.25, gaOnly: true, description: 'Attitude and heading gyros spin down.' },
    { id: 'pitot', label: 'PITOT BLOCKAGE', rate: 0.15, description: 'Airspeed indicator freezes.' },
    { id: 'fuelLeak', label: 'FUEL LEAK', rate: 0.15, description: 'Fuel quantity decreases quickly: LOW FUEL.' },
    { id: 'overheat', label: 'OIL OVERHEAT', rate: 0.2, pistonOnly: true, description: 'Oil temperature climbs; reduce power.' },
    { id: 'gear', label: 'GEAR FAILURE', rate: 0.15, retractOnly: true, description: 'Gear jams in transit: use emergency extension.' },
    { id: 'flaps', label: 'FLAP FAILURE', rate: 0.1, description: 'Flaps stay at their current position.' },
    { id: 'brakes', label: 'BRAKE FAILURE', rate: 0.05, description: 'Wheel brakes inoperative.' },
  ];

  class FailureManager {
    /**
     * @param {Aircraft} aircraft
     * @param {string} mode 'off' | 'random' | 'custom'
     * @param {Array} custom [{id, minutes}]
     */
    constructor(aircraft, mode = 'off', custom = []) {
      this.ac = aircraft;
      this.mode = mode;
      this.custom = (custom || []).map((c) => ({ id: c.id, minutes: Number(c.minutes) || 0, fired: false }));
      this.active = new Set();
      this.flightTime = 0;
      this.randomCount = 0;
      this.maxRandom = 2;
    }

    available() {
      const cfg = this.ac.cfg;
      return FAILURES.filter((f) => {
        if (f.gaOnly && !cfg.systems.vacuum) return false;
        if (f.pistonOnly && cfg.engines[0].type !== 'piston') return false;
        if (f.retractOnly && !cfg.gear.retractable) return false;
        return true;
      });
    }

    update(dt) {
      if (this.mode === 'off') return;
      const airborne = !this.ac.onGround;
      if (airborne || this.ac.groundSpeed > 15) this.flightTime += dt;

      if (this.mode === 'custom') {
        this.custom.forEach((c) => {
          if (!c.fired && this.flightTime >= c.minutes * 60 && (airborne || c.minutes === 0)) {
            c.fired = true;
            this.trigger(c.id);
          }
        });
      } else if (this.mode === 'random' && airborne && this.flightTime > 90 && this.randomCount < this.maxRandom) {
        for (const f of this.available()) {
          if (this.active.has(f.id)) continue;
          // Scaled so a typical 45-minute flight has a reasonable chance of one failure.
          const p = (f.rate * 0.8 * dt) / 3600 * 3;
          if (Math.random() < p) {
            this.randomCount++;
            this.trigger(f.id);
            break;
          }
        }
      }
    }

    trigger(id) {
      const def = FAILURES.find((f) => f.id === id);
      if (!def || this.active.has(id)) return;
      const ac = this.ac;
      const sys = ac.systems;
      switch (id) {
        case 'engine': {
          const i = ac.engines.length > 1 ? Math.floor(Math.random() * ac.engines.length) : 0;
          ac.engines[i].failed = true;
          break;
        }
        case 'overheat':
          ac.engines.forEach((e) => (e._overheatFailure = true));
          break;
        case 'gear':
          sys.failures.gear = true;
          if (sys.gear.pos > 0 && sys.gear.pos < 1) sys.gear.stuck = true;
          break;
        default:
          sys.failures[id] = true;
      }
      this.active.add(id);
      SIM.events.emit('failure', { id, label: def.label });
    }

    repairAll() {
      const ac = this.ac;
      ac.engines.forEach((e) => {
        e.failed = false;
        e._overheatFailure = false;
      });
      Object.keys(ac.systems.failures).forEach((k) => (ac.systems.failures[k] = false));
      ac.systems.gear.stuck = false;
      this.active.clear();
      SIM.events.emit('notify', { text: 'ALL FAILURES CLEARED', level: 'info' });
    }
  }

  SIM.FAILURES = FAILURES;
  SIM.FailureManager = FailureManager;
})(window.SIM);
