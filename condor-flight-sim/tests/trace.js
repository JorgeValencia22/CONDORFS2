/**
 * Flight trace tool: `node tests/trace.js <aircraft> takeoff|stall [flapIdx]`
 * Prints a second-by-second log of a scripted takeoff or stall for tuning and debugging.
 */
'use strict';

const { createContext, createWorld } = require('./harness');

(async () => {
  const SIM = createContext();
  const w = await createWorld(SIM);
  w.weather.set('clear', { windKt: 0, gustKt: 0, turbulence: 0, tempC: 15, qnh: 1013.25 });
  const M = SIM.MathUtil, KT = SIM.Units.KT;
  const id = process.argv[2] || 'c172';
  const mode = process.argv[3] || 'takeoff';
  const flapIdx = Number(process.argv[4] || 0);
  const cfg = SIM.AircraftData[id];
  const ISA0 = { rho: 1.225, pressure: 101325, tempC: 15, soundSpeed: 340 };
  const env = Object.assign({}, w.env, { atmosphereAt: () => ISA0 });
  const dt = 1 / 240;
  const ac = new SIM.Aircraft(id, { fuel: 1 });
  ac.payload = (cfg.pohTargets.massKg || cfg.mass.maxTakeoff) - cfg.mass.empty - ac.systems.fuelMassKg;
  const log = (t, extra = '') => {
    const s = ac.state;
    const g = ac.fm.gear;
    console.log(`${t.toFixed(1).padStart(5)}s cas=${s.casKt.toFixed(0)} pitch=${s.pitchDeg.toFixed(1)} a=${s.aoaDeg.toFixed(1)} vs=${s.vsFpm.toFixed(0)} roll=${s.rollDeg.toFixed(1)} CL=${ac.fm.cl.toFixed(2)} elev=${ac.controls.elevator.toFixed(2)} trim=${ac.controls.elevatorTrim.toFixed(2)} stall=${ac.fm.stallFactor.toFixed(2)} g=${ac.fm.gLoad.toFixed(2)} loads=${g.map((x) => x.load.toFixed(0)).join('/')} ${extra}`);
  };
  if (mode === 'takeoff') {
    const scel = w.airports.find((a) => a.icao === 'SCEL');
    const end = SIM.Airports.findRunwayEnd(scel, '17L');
    ac.initReady(end.x + end.dirX * 40, end.z + end.dirZ * 40, end.hdg * M.DEG, w.terrain);
    ac.systems.flaps.handle = cfg.pohTargets.takeoffFlapIdx;
    ac.systems.flaps.pos = cfg.aero.flaps[cfg.pohTargets.takeoffFlapIdx].deg;
    for (let i = 0; i < 240; i++) ac.step(dt, env);
    const x0 = ac.fm.pos.x, z0 = ac.fm.pos.z;
    ac.setThrottle(1);
    let t = 0;
    while (t < 70) {
      ac.updateState();
      const s = ac.state;
      ac.input.yaw = M.clamp(M.angleDiff(s.trueHeadingDeg, end.hdg) * 0.2 + ac.fm.omega.y * 0.6, -1, 1);
      ac.input.roll = M.clamp(-s.rollDeg * 0.05, -1, 1);
      ac.input.pitch = s.iasKt >= cfg.pohTargets.rotateKias ? M.clamp(((ac.isJet ? 9 : 12) - s.pitchDeg) * 0.08 - ac.fm.omega.x * 0.6, -0.4, 1) : 0;
      ac.step(dt, env);
      t += dt;
      if (Math.round(t * 240) % 240 === 0) log(t, `d=${Math.hypot(ac.fm.pos.x - x0, ac.fm.pos.z - z0).toFixed(0)} T=${ac.engines.map((e) => e.thrust.toFixed(0)).join('/')}`);
      if (!ac.onGround) {
        log(t, `LIFTOFF d=${Math.hypot(ac.fm.pos.x - x0, ac.fm.pos.z - z0).toFixed(0)}`);
        break;
      }
      if (ac.crashed) {
        console.log('CRASH', ac.crashReason);
        break;
      }
    }
  } else {
    ac.systems.flaps.handle = flapIdx;
    ac.systems.flaps.pos = cfg.aero.flaps[flapIdx].deg;
    const vs = ac.fm.aero.stallSpeedKt(ac.mass, cfg.aero.flaps[flapIdx].deg);
    ac.initAirborne(0, 1500, 0, 0, ac.iasFromCas(vs * 1.3), w.weather);
    ac.systems.flaps.handle = flapIdx;
    ac.systems.flaps.pos = cfg.aero.flaps[flapIdx].deg;
    ac.setThrottle(0);
    ac.updateState();
    let tgt = vs * 1.3, t = 0;
    while (t < 60) {
      ac.updateState();
      const s = ac.state;
      tgt -= dt;
      const pitchCmd = M.clamp(s.pitchDeg + (s.casKt - tgt) * 1.5, -10, 30);
      ac.input.pitch = M.clamp((pitchCmd - s.pitchDeg) * 0.08 - ac.fm.omega.x * 0.8, -1, 1);
      ac.input.roll = M.clamp(-s.rollDeg * 0.08 + ac.fm.omega.z * 0.5, -1, 1);
      ac.step(dt, env);
      t += dt;
      if (Math.round(t * 240) % 240 === 0) log(t, `target=${tgt.toFixed(0)}`);
      if (ac.crashed) break;
    }
  }
})();
