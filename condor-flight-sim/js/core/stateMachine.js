/**
 * FlightStateMachine — MENU, LOADING, PARKED, TAXI, TAKEOFF, FLIGHT, APPROACH, LANDING, CRASH, PAUSED.
 * Flight phases are derived from the real aircraft state each frame; other systems (ATC, HUD,
 * audio, results, missions) listen to `state:change`.
 */
(function (SIM) {
  'use strict';

  const FlightState = Object.freeze({
    MENU: 'MENU', LOADING: 'LOADING', PARKED: 'PARKED', TAXI: 'TAXI', TAKEOFF: 'TAKEOFF', FLIGHT: 'FLIGHT',
    APPROACH: 'APPROACH', LANDING: 'LANDING', CRASH: 'CRASH', PAUSED: 'PAUSED',
  });

  const NM = SIM.Units.NM;

  class FlightStateMachine {
    constructor() {
      this.state = FlightState.MENU;
      this.previous = null;
      this.time = 0;
      this.resumeState = null;
    }

    set(state) {
      if (state === this.state) return;
      this.previous = this.state;
      this.state = state;
      this.time = 0;
      SIM.events.emit('state:change', { state, previous: this.previous });
    }

    pause() {
      if (this.state === FlightState.PAUSED || this.state === FlightState.MENU || this.state === FlightState.LOADING) return;
      this.resumeState = this.state;
      this.set(FlightState.PAUSED);
    }

    resume() {
      if (this.state !== FlightState.PAUSED) return;
      this.set(this.resumeState || FlightState.FLIGHT);
    }

    get isFlying() {
      return ![FlightState.MENU, FlightState.LOADING, FlightState.PAUSED, FlightState.CRASH].includes(this.state);
    }

    /** Derives the flight phase from the aircraft. */
    update(dt, session) {
      this.time += dt;
      if (!this.isFlying) return;
      const ac = session.aircraft;
      const s = ac.state;
      if (ac.crashed) {
        this.set(FlightState.CRASH);
        return;
      }
      const perf = ac.cfg.performance;
      const cur = this.state;
      if (s.onGround) {
        const enginesOff = ac.engines.every((e) => !e.running);
        if (s.gsKt < 1 && (enginesOff || ac.systems.brakes.parking)) {
          this.set(FlightState.PARKED);
        } else if (cur === FlightState.FLIGHT || cur === FlightState.APPROACH) {
          this.set(FlightState.LANDING);
        } else if (cur === FlightState.LANDING) {
          if (s.gsKt < perf.taxiKt * 1.6) this.set(FlightState.TAXI);
        } else if (s.gsKt > perf.taxiKt * 1.5 && s.throttle > 0.5) {
          this.set(FlightState.TAKEOFF);
        } else if (cur === FlightState.TAKEOFF && s.gsKt > perf.taxiKt) {
          // rejected takeoff still rolling
        } else if (s.gsKt >= 0.5 || cur !== FlightState.PARKED) {
          this.set(FlightState.TAXI);
        }
      } else {
        if (cur === FlightState.TAKEOFF && s.aglFt < 400) return;
        let nearField = false;
        for (const ap of session.airports) {
          if (Math.hypot(ap.x - ac.fm.pos.x, ap.z - ac.fm.pos.z) < 7 * NM) {
            nearField = true;
            break;
          }
        }
        const configured = s.flapDeg > 0.5 || (ac.cfg.gear.retractable && s.gearPos > 0.9) || s.iasKt < perf.vapp * 1.25;
        if (nearField && s.aglFt < 2000 && s.vsFpm < -150 && configured) this.set(FlightState.APPROACH);
        else if (cur !== FlightState.APPROACH || s.aglFt > 2500 || s.vsFpm > 500) this.set(FlightState.FLIGHT);
      }
    }
  }

  SIM.FlightState = FlightState;
  SIM.FlightStateMachine = FlightStateMachine;
})(window.SIM);
