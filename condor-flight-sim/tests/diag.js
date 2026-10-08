/**
 * Aerodynamic diagnostics for one aircraft: `node tests/diag.js c172`
 * Prints CL/CD/Cm versus angle of attack, trim points and derived stability figures.
 */
'use strict';

const { createContext } = require('./harness');

const SIM = createContext();
const id = process.argv[2] || 'c172';
const cfg = SIM.AircraftData[id];
const ac = new SIM.Aircraft(id, { fuel: 0.8 });
ac.engines.forEach((e) => (e.state = SIM.EngineState.RUNNING));
const aero = ac.fm.aero;
const D = Math.PI / 180;
const V = 45;
const zero = new SIM.Vec3();
console.log(`${cfg.name}: S=${aero.S} b=${aero.b} MAC=${aero.c.toFixed(3)} wingAR=${aero.wingInfo.AR.toFixed(2)} strips=${aero.strips.length} tailArm=${aero.tailArm.toFixed(2)}`);
console.log(`geometric wing area ${cfg.geometry.wingAreaGeo.toFixed(2)} m²   rigging fin ${aero.rigging.finDeg.toFixed(2)}° ail ${aero.rigging.aileronDeg.toFixed(2)}°`);
console.log(' alpha   CL      CD      Cm      stall');
const qS = 0.5 * 1.225 * V * V * aero.S;
for (let a = -4; a <= 24; a += 2) {
  const vb = new SIM.Vec3(0, -V * Math.sin(a * D), -V * Math.cos(a * D));
  const o = aero.compute({ vb, omega: zero, rho: 1.225, controls: { elevator: 0, aileron: 0, rudder: 0, elevatorTrim: 0, rudderTrim: 0 }, flapDeg: 0, gearPos: 1, props: [], dt: 0, mach: 0.13 });
  console.log(`${String(a).padStart(5)}  ${o.CL.toFixed(3).padStart(6)}  ${o.CD.toFixed(4)}  ${(o.moment.x / (qS * aero.c)).toFixed(3).padStart(6)}  ${o.stallFactor.toFixed(2)}  margin ${o.stallMarginDeg.toFixed(1)}`);
}
{
  const at = (a) => { const vb = new SIM.Vec3(0, -V * Math.sin(a * D), -V * Math.cos(a * D)); return aero.compute({ vb, omega: zero, rho: 1.225, controls: { elevator: 0, aileron: 0, rudder: 0, elevatorTrim: 0, rudderTrim: 0 }, flapDeg: 0, gearPos: 1, props: [], dt: 0, mach: 0.13 }); };
  const o1 = at(2), cl1 = o1.CL, m1 = o1.moment.x;
  const o2 = at(6);
  const dCL = o2.CL - cl1, dCm = (o2.moment.x - m1) / (qS * aero.c);
  console.log(`CLalpha ${(dCL / 4 * 57.3).toFixed(2)}/rad  Cmalpha ${(dCm / 4 * 57.3).toFixed(2)}/rad  static margin ${(-dCm / dCL * 100).toFixed(1)}% MAC`);
}
for (const f of cfg.aero.flaps) console.log(`flaps ${f.label}: CLmax ${aero.clmax(f.deg).toFixed(2)}  Vs ${aero.stallSpeedKt(cfg.mass.maxTakeoff, f.deg).toFixed(1)} KCAS`);
const atm = { rho: 1.225, pressure: 101325, tempC: 15, soundSpeed: 340 };
for (const kt of [60, 80, 100, 120]) {
  const t = ac.solveTrim(kt * 0.5144, atm, 0);
  const ss = ac.engines[0].steadyState(t.throttle, kt * 0.5144, atm);
  console.log(`trim ${kt} KTAS: alpha ${(t.alpha / D).toFixed(2)}°  trim ${t.trim.toFixed(2)}  throttle ${t.throttle.toFixed(2)}  rpm ${ss.rpm.toFixed(0)}  T ${ss.thrust.toFixed(0)} N`);
}
const e = ac.engines[0];
if (e.kind === 'piston') {
  const p = e.propeller;
  console.log(`prop CT0 ${p.CT0.toFixed(4)} kT ${p.kT.toFixed(4)} CP0 ${p.CP0.toFixed(4)} kP ${p.kP.toFixed(4)} J0 ${p.J0.toFixed(2)}  mpIdle ${e.mpIdle.toFixed(3)}`);
  console.log(`static: ${JSON.stringify(e.steadyState(1, 0, atm))}  idle: ${JSON.stringify(e.steadyState(0, 0, atm))}`);
}
