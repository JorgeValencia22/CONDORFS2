/**
 * Performance validation against the aircraft flight manuals: `node tests/performance.test.js [id]`
 *
 * Every figure is measured on the complete simulation model (aerodynamics + propeller + engine +
 * landing gear), the same code that flies in the browser:
 *  - stall speed: power-off deceleration at 1 kt/s (flight-test technique), flaps up and full,
 *  - rate of climb at Vy, full throttle, sea level ISA, maximum weight,
 *  - cruise true airspeed at 75 % power, 8000 ft ISA,
 *  - glide ratio with the engine stopped at best-glide speed,
 *  - takeoff ground roll and landing ground roll (sea level, no wind, paved runway),
 *  - static full-throttle RPM.
 */
'use strict';

const { createContext, createWorld } = require('./harness');

const TOL = { stall: 0.09, climb: 0.15, cruise: 0.07, glide: 0.15, takeoff: 0.2, landing: 0.3 };

async function main() {
  const SIM = createContext();
  const world = await createWorld(SIM);
  const { env, terrain } = world;
  const M = SIM.MathUtil, KT = SIM.Units.KT, FT = SIM.Units.FT, FPM = SIM.Units.FPM;
  const ISA = (hFt) => {
    const h = hFt * FT;
    const T = 288.15 - 0.0065 * h;
    const p = 101325 * Math.pow(T / 288.15, 5.25588);
    return { rho: p / (287.053 * T), pressure: p, tempC: T - 273.15, soundSpeed: Math.sqrt(1.4 * 287.053 * T) };
  };
  const only = process.argv[2];
  const rows = [];
  let failures = 0;
  const check = (id, name, got, target, tol, unit, fmt = 0) => {
    const ok = Math.abs(got - target) <= Math.abs(target) * tol;
    if (!ok) failures++;
    rows.push({ id, name, got: got.toFixed(fmt), target: String(target), unit, ok });
  };
  // Standard atmosphere, no wind, for the dynamic tests
  world.weather.set('clear', { windKt: 0, gustKt: 0, turbulence: 0, tempC: 15, qnh: 1013.25 });
  const scel = world.airports.find((a) => a.icao === 'SCEL');
  const dt = 1 / SIM.Config.PHYSICS_HZ;

  for (const id of SIM.AircraftOrder) {
    if (only && only !== id) continue;
    const cfg = SIM.AircraftData[id];
    const P = cfg.pohTargets;
    const mk = (fuel = 1) => {
      const ac = new SIM.Aircraft(id, { fuel, realism: 'normal' });
      // POH figures are quoted at max take-off mass, or at the reference mass given with the targets
      ac.payload = (P.massKg || cfg.mass.maxTakeoff) - cfg.mass.empty - ac.systems.fuelMassKg;
      return ac;
    };
    const maxFlapIdx = cfg.aero.flaps.length - 1;

    /* ---- static RPM */
    if (P.staticRPM) {
      const ac = mk();
      const ss = ac.engines[0].steadyState(1, 0, ISA(0), true);
      const mid = (P.staticRPM[0] + P.staticRPM[1]) / 2;
      check(id, 'static RPM', ss.rpm, mid, (P.staticRPM[1] - P.staticRPM[0]) / mid / 2 + 0.01, 'rpm');
    }

    /* ---- stall speeds (power off, 1 kt/s deceleration) */
    for (const [flapIdx, pohStall, label] of [[0, P.stallCleanKcas, 'stall flaps up'], [maxFlapIdx, P.stallFullKcas, 'stall flaps full']]) {
      const ac = mk();
      ac.systems.flaps.handle = flapIdx;
      ac.systems.flaps.pos = cfg.aero.flaps[flapIdx].deg;
      const startKias = ac.iasFromCas(pohStall * 1.3);
      ac.initAirborne(0, 1500, 0, 0, startKias, world.weather, { approach: false });
      ac.systems.flaps.handle = flapIdx;
      ac.systems.flaps.pos = cfg.aero.flaps[flapIdx].deg;
      if (cfg.gear.retractable && flapIdx > 0) {
        ac.systems.gear.handle = 1;
        ac.systems.gear.pos = 1;
      }
      ac.setThrottle(0);
      ac.updateState();
      let tgt = ac.state.casKt;
      let minCas = 999, t = 0, broke = false;
      while (t < 90 && !broke) {
        ac.updateState();
        const s = ac.state;
        tgt -= 1 * dt;
        const pitchCmd = M.clamp(s.pitchDeg + (s.casKt - tgt) * 1.5, -10, 30);
        ac.input.pitch = M.clamp((pitchCmd - s.pitchDeg) * 0.08 - ac.fm.omega.x * 0.8, -1, 1);
        ac.input.roll = M.clamp(-s.rollDeg * 0.08 + ac.fm.omega.z * 0.5, -1, 1);
        ac.step(dt, env);
        t += dt;
        // stall speed is quoted at 1 g: normalise by the load factor
        if (t > 0.5 && ac.fm.stallFactor < 0.5) minCas = Math.min(minCas, ac.fm.ias / KT / Math.sqrt(M.clamp(ac.fm.gLoad, 0.6, 1.5)));
        // stall: pitch break / sustained high sink with full aft stick, or wing section stall spreading
        if (ac.fm.stallFactor > 0.55 || (ac.controls.elevator > 0.97 && s.vsFpm < -900)) broke = true;
      }
      check(id, label, minCas, pohStall, TOL.stall, 'KCAS');
    }

    /* ---- climb at Vy, full throttle, sea level */
    {
      const ac = mk();
      const atm = ISA(0);
      ac.engines.forEach((e) => {
        e.state = SIM.EngineState.RUNNING;
        e.prop = 1;
        e.mixture = 1;
      });
      const v = ac.casFromIas(cfg.performance.vy) * KT;
      const tr = ac.solveTrim(v, atm, 4, { fixedThrottle: P.climbThrottle || 1 });
      const roc = v * Math.sin(tr.gamma) / FPM;
      check(id, P.climbThrottle ? 'climb SL @Vy, CLB thrust' : 'climb SL @Vy', roc, P.climbFpmSL, TOL.climb, 'fpm');
    }

    /* ---- cruise: 75 % power at 8000 ft (jets: 280 KIAS level at 10000 ft is not a POH figure; use FL100 300 KTAS) */
    {
      const ac = mk(0.6);
      const atm = ISA(8000);
      ac.engines.forEach((e) => {
        e.state = SIM.EngineState.RUNNING;
        e.prop = e.cfg.propType === 'constant' ? (2500 - e.cfg.minGovRPM) / (e.cfg.maxRPM - e.cfg.minGovRPM) : 1;
        e.mixture = e.kind === 'piston' ? e.bestMixture(atm.rho / 1.225) : 1;
      });
      if (cfg.gear.retractable) {
        ac.systems.gear.handle = 0;
        ac.systems.gear.pos = 0;
      }
      let tas;
      if (ac.isJet) {
        // thrust-limited check: level flight speed at 82 % N1 at 8000 ft
        let lo = 120 * KT, hi = 320 * KT;
        for (let i = 0; i < 30; i++) {
          const mid = (lo + hi) / 2;
          const tr = ac.solveTrim(mid, atm, 0);
          if (tr.throttle < 0.62) lo = mid;
          else hi = mid;
        }
        tas = (lo + hi) / 2;
      } else {
        // POH cruise: speed where level flight needs 75 % power, or full throttle if 75 % is not available
        const e0 = ac.engines[0];
        const sigma = atm.rho / 1.225;
        const amb = atm.pressure / 100 / SIM.Units.INHG;
        const powerAt = (thr, v) => {
          const ss = e0.steadyState(thr, v, atm, true);
          e0.throttle = thr;
          return (e0.indicatedTorque(thr, amb, atm.tempC, sigma) - e0.friction(ss.rpm)) * ss.rpm * Math.PI / 30;
        };
        let lo = 50 * KT, hi = 300 * KT;
        for (let i = 0; i < 30; i++) {
          const mid = (lo + hi) / 2;
          const tr = ac.solveTrim(mid, atm, 0);
          const vAx = mid * Math.cos(tr.alpha);
          const target = Math.min(0.75 * e0.cfg.maxPower, powerAt(1, vAx) - 1);
          if (powerAt(tr.throttle, vAx) < target) lo = mid;
          else hi = mid;
        }
        tas = (lo + hi) / 2;
      }
      check(id, ac.isJet ? 'level TAS 8000ft 62% thr' : 'cruise 75% 8000ft', tas / KT, P.cruiseKtas8000, TOL.cruise, 'KTAS');
    }

    /* ---- glide, engine(s) stopped */
    if (!SIM.AircraftData[id].engines[0].type.startsWith('turbo')) {
      const ac = mk(0.5);
      // POH glide figures for twins are with both propellers feathered
      ac.engines.forEach((e) => { e.state = SIM.EngineState.OFF; if (e.propeller.featherable) { e.prop = 0; e.propeller.feather = 1; } });
      if (cfg.gear.retractable) {
        ac.systems.gear.handle = 0;
        ac.systems.gear.pos = 0;
      }
      const atm = ISA(3000);
      const v = (ac.casFromIas(cfg.performance.bestGlide) * KT) / Math.sqrt(atm.rho / 1.225);
      const tr = ac.solveTrim(v, atm, -6, { fixedThrottle: 0, enginesOff: true });
      check(id, cfg.engines[0].featherable ? 'glide ratio (props feathered)' : 'glide ratio (prop windmilling)', 1 / Math.tan(-tr.gamma), P.glideRatio, TOL.glide, ':1', 1);
    }

    /* ---- takeoff ground roll */
    {
      const ac = mk();
      const end = SIM.Airports.findRunwayEnd(scel, '17L');
      // sea-level performance: use a flat patch of SCEL but correct density to sea level by using SL ISA env
      const slEnv = Object.assign({}, env, { atmosphereAt: () => ISA(0) });
      ac.initReady(end.x + end.dirX * 40, end.z + end.dirZ * 40, end.hdg * M.DEG, terrain);
      ac.systems.flaps.handle = P.takeoffFlapIdx;
      ac.systems.flaps.pos = cfg.aero.flaps[P.takeoffFlapIdx].deg;
      for (let i = 0; i < 240; i++) ac.step(dt, slEnv);
      const x0 = ac.fm.pos.x, z0 = ac.fm.pos.z;
      ac.setThrottle(1);
      ac.engines.forEach((e) => (e.prop = 1));
      let t = 0, roll = null, pitchTgt = null;
      while (t < 90 && roll === null) {
        ac.updateState();
        const s = ac.state;
        const hErr = M.angleDiff(s.trueHeadingDeg, end.hdg);
        ac.input.yaw = M.clamp(hErr * 0.2 + ac.fm.omega.y * 0.6, -1, 1);
        ac.input.roll = M.clamp(-s.rollDeg * 0.05, -1, 1);
        // rotation at Vr; airliners are rotated smoothly at about 2.5°/s
        if (s.iasKt >= P.rotateKias) pitchTgt = pitchTgt === null ? s.pitchDeg : Math.min(ac.isJet ? 9 : 12, pitchTgt + (ac.isJet ? 2.5 : 1000) * dt);
        ac.input.pitch = pitchTgt !== null ? M.clamp((pitchTgt - s.pitchDeg) * (ac.isJet ? 0.15 : 0.08) - ac.fm.omega.x * 0.6, -0.4, 1) : 0;
        ac.step(dt, slEnv);
        t += dt;
        if (!ac.onGround) roll = Math.hypot(ac.fm.pos.x - x0, ac.fm.pos.z - z0);
      }
      check(id, 'takeoff ground roll', roll || 9999, P.takeoffRollM, TOL.takeoff, 'm');
    }

    /* ---- landing ground roll (full flaps, idle, max braking from touchdown at 1.15 Vs0) */
    {
      const ac = mk(0.3);
      const end = SIM.Airports.findRunwayEnd(scel, '17L');
      const slEnv = Object.assign({}, env, { atmosphereAt: () => ISA(0) });
      ac.initReady(end.x + end.dirX * 200, end.z + end.dirZ * 200, end.hdg * M.DEG, terrain);
      ac.systems.flaps.handle = maxFlapIdx;
      ac.systems.flaps.pos = cfg.aero.flaps[maxFlapIdx].deg;
      for (let i = 0; i < 120; i++) ac.step(dt, slEnv);
      const vTd = P.stallFullKcas * 1.15 * KT;
      const d = SIM.Geo.dir(end.hdg);
      ac.fm.vel.set(d.x * vTd, 0, d.z * vTd);
      ac.setThrottle(0);
      if (ac.isJet) {
        ac.systems.speedbrake.lever = 1;
        ac.systems.speedbrake.pos = 1;
      }
      const x0 = ac.fm.pos.x, z0 = ac.fm.pos.z;
      let t = 0;
      while (t < 120 && ac.groundSpeed > 0.3) {
        ac.updateState();
        ac.input.brakeL = ac.input.brakeR = 1;
        ac.input.pitch = 0;
        const hErr = M.angleDiff(ac.state.trueHeadingDeg, end.hdg);
        ac.input.yaw = M.clamp(hErr * 0.2, -1, 1);
        if (ac.isJet) ac.setReverse(t > 1.5 && ac.state.gsKt > 60);
        ac.step(dt, slEnv);
        t += dt;
      }
      check(id, 'landing ground roll', Math.hypot(ac.fm.pos.x - x0, ac.fm.pos.z - z0), P.landingRollM, TOL.landing, 'm');
    }
  }

  const pad = (s, n) => String(s).padEnd(n);
  console.log(`\n${pad('AIRCRAFT', 8)} ${pad('TEST', 32)} ${pad('MEASURED', 10)} ${pad('POH', 8)} UNIT`);
  for (const r of rows) console.log(`${pad(r.id, 8)} ${pad(r.name, 32)} ${pad(r.got, 10)} ${pad(r.target, 8)} ${pad(r.unit, 5)} ${r.ok ? 'OK' : 'OUT OF TOLERANCE'}`);
  console.log(`\n${rows.length - failures}/${rows.length} within tolerance`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
