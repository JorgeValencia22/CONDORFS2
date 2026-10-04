/**
 * Automated flight-model tests: run with `node tests/physics.test.js`.
 * A simple scripted pilot performs takeoff, climb, cruise, glide (engine off) and landing checks.
 */
'use strict';

const { createContext, createWorld } = require('./harness');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function main() {
  const SIM = createContext();
  const world = await createWorld(SIM);
  const { terrain, env, airports } = world;
  const dt = 1 / SIM.Config.PHYSICS_HZ;
  const KT = SIM.Units.KT, FT = SIM.Units.FT;

  // Terrain sanity
  const scel = airports.find((a) => a.icao === 'SCEL');
  const hScel = terrain.heightAt(scel.runways[0].cx, scel.runways[0].cz);
  check('Terrain flattened at SCEL elevation', Math.abs(hScel - scel.elev) < 1, `${hScel.toFixed(1)} m vs ${scel.elev.toFixed(1)} m`);
  const ocean = terrain.rawHeight(-90000, 0);
  check('Ocean west of the coast', ocean < 0, `${ocean.toFixed(1)} m`);
  const andes = SIM.Regions.chile.peaks[0];
  const pa = world.geo.xz([andes.lat, andes.lon]);
  const hA = terrain.heightAt(pa[0], pa[1]);
  check('Andes are high (Aconcagua area > 4500 m)', hA > 4500, `${hA.toFixed(0)} m`);
  check('Runway surface detected', terrain.surfaceAt(scel.runways[0].cx, scel.runways[0].cz).type === 'runway');

  for (const id of SIM.AircraftOrder) {
    const ac = new SIM.Aircraft(id, { fuel: 0.6, realism: 'normal' });
    const end = SIM.Airports.findRunwayEnd(scel, '17L');
    const hdg = end.hdg * SIM.MathUtil.DEG;
    ac.initReady(end.x + end.dirX * 60, end.z + end.dirZ * 60, hdg, terrain);
    const startY = ac.fm.pos.y;
    // settle on gear
    for (let i = 0; i < 240 * 2; i++) ac.step(dt, env);
    const settled = Math.abs(ac.fm.vel.y) < 0.05 && ac.fm.onGround;
    check(`[${id}] rests on gear`, settled, `vy=${ac.fm.vel.y.toFixed(3)} y=${(ac.fm.pos.y - startY).toFixed(3)}`);

    // Takeoff run
    ac.setThrottle(1);
    ac.engines.forEach((e) => (e.prop = 1));
    if (ac.isJet) ac.systems.setFlapsHandle(3);
    const vr = ac.cfg.performance.vr;
    let t = 0, liftoff = null, roll = 0;
    let maxDev = 0;
    while (t < 90) {
      ac.updateState();
      const s = ac.state;
      // centreline keeping with rudder (simple P controller on heading)
      const hErr = SIM.MathUtil.angleDiff(s.trueHeadingDeg, end.hdg);
      ac.input.yaw = SIM.MathUtil.clamp(hErr * 0.15 - ac.fm.omega.y * -0.5, -1, 1);
      ac.input.roll = SIM.MathUtil.clamp(-s.rollDeg * 0.05, -1, 1);
      if (s.iasKt > vr) ac.input.pitch = SIM.MathUtil.clamp((8 - s.pitchDeg) * 0.08, -0.5, 1);
      else ac.input.pitch = 0;
      ac.step(dt, env);
      t += dt;
      if (ac.onGround) roll = Math.hypot(ac.fm.pos.x - end.x, ac.fm.pos.z - end.z);
      const px = ac.fm.pos.x - end.x, pz = ac.fm.pos.z - end.z;
      maxDev = Math.max(maxDev, Math.abs(px * -end.dirZ + pz * end.dirX));
      if (!ac.onGround && !liftoff) liftoff = { t, ias: ac.state.iasKt, roll };
      if (liftoff && t - liftoff.t > 25) break;
      if (ac.crashed) break;
    }
    check(`[${id}] lifts off`, !!liftoff && !ac.crashed, liftoff ? `t=${liftoff.t.toFixed(1)}s IAS=${liftoff.ias.toFixed(0)}kt roll=${liftoff.roll.toFixed(0)}m dev=${maxDev.toFixed(1)}m` : ac.crashReason || 'no liftoff');
    ac.updateState();
    check(`[${id}] climbs after takeoff`, ac.state.vsFpm > 200 && !ac.crashed, `VS=${ac.state.vsFpm.toFixed(0)} fpm IAS=${ac.state.iasKt.toFixed(0)} pitch=${ac.state.pitchDeg.toFixed(1)}`);
  }

  // Trimmed cruise (air start) — level flight should hold roughly hands-off
  for (const id of SIM.AircraftOrder) {
    const ac = new SIM.Aircraft(id, { fuel: 0.6 });
    const cruiseKt = id === 'b738' ? 280 : ac.cfg.performance.cruise * 0.9;
    const alt = (id === 'b738' ? 10000 : 5500) * FT;
    ac.initAirborne(0, alt, -20000, 0, cruiseKt, env);
    let maxDrift = 0;
    for (let i = 0; i < 240 * 30; i++) {
      ac.step(dt, env);
      maxDrift = Math.max(maxDrift, Math.abs(ac.fm.pos.y - alt));
    }
    ac.updateState();
    check(`[${id}] trimmed air start holds altitude (30 s)`, maxDrift < 120 && !ac.crashed, `drift=${maxDrift.toFixed(0)} m IAS=${ac.state.iasKt.toFixed(0)} VS=${ac.state.vsFpm.toFixed(0)} roll=${ac.state.rollDeg.toFixed(1)}`);
  }

  // Stall: pull to high AoA at idle, expect stall factor > 0.5 and loss of lift
  {
    const ac = new SIM.Aircraft('c172', { fuel: 0.6 });
    ac.initAirborne(0, 2000, -20000, 0, 80, env);
    ac.setThrottle(0);
    let stalled = false, warn = false;
    for (let i = 0; i < 240 * 25; i++) {
      ac.input.pitch = 1;
      ac.step(dt, env);
      if (ac.systems.warnings.stall) warn = true;
      if (ac.fm.stallFactor > 0.5) stalled = true;
    }
    check('[c172] stall warning and stall develop', warn && stalled, `warn=${warn} stall=${stalled}`);
  }

  // Glide with engine off
  {
    const ac = new SIM.Aircraft('c172', { fuel: 0.6 });
    ac.initAirborne(0, 1500, -20000, 0, 68, env);
    ac.engines[0].mixture = 0;
    let t = 0, h0 = null, d0 = null;
    while (t < 60) {
      ac.updateState();
      ac.input.pitch = SIM.MathUtil.clamp((ac.state.iasKt - 68) * 0.04 - ac.fm.omega.x * 0.8, -0.6, 0.6);
      ac.input.roll = SIM.MathUtil.clamp(-ac.state.rollDeg * 0.05, -1, 1);
      ac.step(dt, env);
      t += dt;
      if (t > 15 && h0 === null) {
        h0 = ac.fm.pos.y;
        d0 = ac.fm.pos.z;
      }
    }
    const ratio = Math.abs(ac.fm.pos.z - d0) / Math.max(1, h0 - ac.fm.pos.y);
    check('[c172] engine-off glide ratio 6–12', ratio > 6 && ratio < 12 && ac.engines[0].state === 'OFF', `L/D≈${ratio.toFixed(1)} IAS=${ac.state.iasKt.toFixed(0)}`);
  }

  // Autopilot: heading and altitude hold
  {
    const ac = new SIM.Aircraft('c172', { fuel: 0.6 });
    ac.initAirborne(0, 1800, -20000, 0, 100, env);
    ac.systems.elec.avionicsPowered = true;
    ac.autopilot.hdgBug = 90;
    for (let i = 0; i < 4; i++) ac.step(dt, env);
    ac.updateState();
    ac.autopilot.engage();
    ac.autopilot.setLateral('HDG');
    ac.autopilot.setVertical('ALT');
    const altHold = ac.autopilot.altHold;
    let maxAltErr = 0;
    for (let i = 0; i < 240 * 90; i++) {
      ac.updateState();
      ac.step(dt, env);
      if (i > 240 * 20) maxAltErr = Math.max(maxAltErr, Math.abs(ac.state.altFt - altHold));
    }
    ac.updateState();
    const hdgErr = Math.abs(SIM.MathUtil.angleDiff(ac.state.headingDeg, 90));
    check('[c172] autopilot HDG captures 090', hdgErr < 5 && ac.autopilot.engaged, `hdg=${ac.state.headingDeg.toFixed(1)} roll=${ac.state.rollDeg.toFixed(1)} engaged=${ac.autopilot.engaged}`);
    check('[c172] autopilot ALT hold ±100 ft', maxAltErr < 100, `maxErr=${maxAltErr.toFixed(0)} ft`);
  }

  // Cold start: engine start through the real switches
  {
    const ac = new SIM.Aircraft('c172', { fuel: 0.6 });
    const end = SIM.Airports.findRunwayEnd(scel, '17L');
    ac.initParked(end.x, end.z, end.hdg * SIM.MathUtil.DEG, terrain);
    ac.autoStart();
    for (let i = 0; i < 240 * 15; i++) ac.step(dt, env);
    check('[c172] auto start runs the engine', ac.engines[0].running && ac.systems.elec.busPowered, `state=${ac.engines[0].state} rpm=${ac.engines[0].rpm.toFixed(0)}`);
    for (let i = 0; i < 240 * 5; i++) ac.step(dt, env);
    const moved = Math.hypot(ac.fm.pos.x - end.x, ac.fm.pos.z - end.z);
    check('[c172] parking brake holds at idle', moved < 0.5, `moved ${moved.toFixed(2)} m`);
  }
  {
    const ac = new SIM.Aircraft('b738', { fuel: 0.5 });
    ac.initParked(scel.parking[0].x, scel.parking[0].z, scel.parking[0].hdg * SIM.MathUtil.DEG, terrain);
    ac.autoStart();
    for (let i = 0; i < 240 * 90; i++) ac.step(dt, env);
    check('[b738] auto start spools both engines', ac.engines.every((e) => e.running), ac.engines.map((e) => `${e.state} N1=${e.n1.toFixed(0)}`).join(', '));
  }

  // Landing: start on final, fly down a 3° path, flare, touch down
  for (const id of ['c172', 'pa28', 'b738']) {
    const ac = new SIM.Aircraft(id, { fuel: 0.4 });
    const end = SIM.Airports.findRunwayEnd(scel, '17L');
    const dist = (id === 'b738' ? 5 : 2.5) * 1852;
    const vapp = ac.cfg.performance.vapp;
    const tdz = 300; // aim point beyond threshold
    const sx = end.x - end.dirX * dist, sz = end.z - end.dirZ * dist;
    ac.initAirborne(sx, scel.elev + Math.tan(3 * Math.PI / 180) * (dist + tdz), sz, end.hdg * SIM.MathUtil.DEG, vapp, env, { approach: true });
    if (ac.cfg.gear.retractable) {
      ac.systems.gear.handle = 1;
      ac.systems.gear.pos = 1;
    }
    let touched = null;
    const off = SIM.events.on('aircraft:touchdown', (td) => (touched = td));
    const throttlePid = new SIM.PID(0.04, 0.01, 0, -0.5, 0.5);
    for (let i = 0; i < 240 * 220 && !touched && !ac.crashed; i++) {
      ac.updateState();
      const s = ac.state;
      const along = (ac.fm.pos.x - end.x) * end.dirX + (ac.fm.pos.z - end.z) * end.dirZ; // negative before threshold
      const cross = (ac.fm.pos.x - end.x) * -end.dirZ + (ac.fm.pos.z - end.z) * end.dirX;
      const pathY = scel.elev + Math.tan(3 * Math.PI / 180) * Math.max(0, tdz - along);
      const agl = ac.fm.pos.y - scel.elev + ac.fm.lowestGearY;
      const flare = agl < (id === 'b738' ? 9 : 5);
      const targetVs = flare ? -0.8 : SIM.MathUtil.clamp((pathY - ac.fm.pos.y) * 0.25 - Math.tan(3 * Math.PI / 180) * s.gsKt * KT, -6, 2);
      const vsErr = targetVs - ac.fm.vel.y;
      const pitchCmd = SIM.MathUtil.clamp((flare ? 5 : 2) + vsErr * 3, -5, 12);
      const jet = id === 'b738';
      ac.input.pitch = SIM.MathUtil.clamp((pitchCmd - s.pitchDeg) * (jet ? 0.05 : 0.066 / ac.cfg.aero.cmDe) - ac.fm.omega.x * (jet ? 2.5 : 0.6), -1, 1);
      const trk = SIM.MathUtil.angleDiff(s.trueHeadingDeg, end.hdg - SIM.MathUtil.clamp(cross * 0.3, -20, 20));
      ac.input.roll = SIM.MathUtil.clamp((SIM.MathUtil.clamp(trk * 1.2, -10, 10) - s.rollDeg) * 0.05 + ac.fm.omega.z * 0.4, -1, 1);
      const thr = flare ? 0 : SIM.MathUtil.clamp(0.4 + throttlePid.update(vapp - s.iasKt, dt), 0, 1);
      ac.setThrottle(thr);
      ac.step(dt, env);
    }
    off();
    check(`[${id}] lands without crashing`, !!touched && !ac.crashed, touched ? `VS=${touched.vsFpm.toFixed(0)}fpm IAS=${touched.iasKt.toFixed(0)} bank=${touched.rollDeg.toFixed(1)}` : `crash=${ac.crashReason}`);
    // Roll-out with brakes
    ac.setThrottle(0);
    ac.input.brakeL = ac.input.brakeR = 1;
    ac.input.pitch = 0;
    ac.input.roll = 0;
    for (let i = 0; i < 240 * 60; i++) ac.step(dt, env);
    check(`[${id}] stops on the runway with brakes`, ac.groundSpeed < 0.5 && !ac.crashed, `GS=${(ac.groundSpeed / KT).toFixed(1)} kt surface=${ac.fm.surface}`);
  }

  // Crash detection: dive into terrain
  {
    const ac = new SIM.Aircraft('c172', { fuel: 0.6 });
    let crashed = false;
    const off = SIM.events.on('aircraft:crash', () => (crashed = true));
    ac.initAirborne(0, 900, -20000, 0, 100, env);
    for (let i = 0; i < 240 * 40 && !crashed; i++) {
      ac.input.pitch = -0.6;
      ac.step(dt, env);
    }
    off();
    check('Crash detected on terrain impact', crashed, ac.crashReason);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
