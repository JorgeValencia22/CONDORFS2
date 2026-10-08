/**
 * Lateral-directional derivatives: `node tests/lateral.js [id]`
 * Body axes x right, y up, z aft. Printed in the usual stability-axis sign convention:
 * Clβ < 0 (dihedral effect), Cnβ > 0 (weathercock), Clp < 0 (roll damping), Cnr < 0 (yaw damping).
 */
'use strict';

const { createContext } = require('./harness');

const SIM = createContext();
const D = Math.PI / 180;
for (const id of process.argv[2] ? [process.argv[2]] : SIM.AircraftOrder) {
  const ac = new SIM.Aircraft(id, { fuel: 0.6 });
  const aero = ac.fm.aero;
  const V = id === 'b738' ? 120 : 50;
  const a = 3 * D;
  const ctl = { elevator: 0, aileron: 0, rudder: 0, elevatorTrim: 0, rudderTrim: 0 };
  const run = (beta, omega) => {
    const vb = new SIM.Vec3(V * Math.sin(beta), -V * Math.sin(a) * Math.cos(beta), -V * Math.cos(a) * Math.cos(beta));
    const o = aero.compute({ vb, omega, rho: 1.225, controls: ctl, flapDeg: 0, gearPos: 0, props: [], dt: 0, mach: V / 340 });
    return { l: o.moment.z, n: o.moment.y };
  };
  const qSb = 0.5 * 1.225 * V * V * aero.S * aero.b;
  const z = new SIM.Vec3();
  const b1 = run(2 * D, z), b0 = run(-2 * D, z);
  // stability convention: roll positive right wing down = -Mz(body); yaw positive nose right = -My(body)
  const Clb = -(b1.l - b0.l) / (4 * D) / qSb, Cnb = -(b1.n - b0.n) / (4 * D) / qSb;
  const ph = 0.2; // rad/s, positive = right wing down = body -z rotation
  const p1 = run(0, new SIM.Vec3(0, 0, -ph)), p0 = run(0, new SIM.Vec3(0, 0, ph));
  const pHat = (ph * aero.b) / (2 * V);
  const Clp = -(p1.l - p0.l) / (2 * pHat) / qSb, Cnp = -(p1.n - p0.n) / (2 * pHat) / qSb;
  const r1 = run(0, new SIM.Vec3(0, -ph, 0)), r0 = run(0, new SIM.Vec3(0, ph, 0));
  const Cnr = -(r1.n - r0.n) / (2 * pHat) / qSb, Clr = -(r1.l - r0.l) / (2 * pHat) / qSb;
  const spiral = Clb * Cnr - Cnb * Clr;
  console.log(`${id.padEnd(5)} Clβ ${Clb.toFixed(4)}  Cnβ ${Cnb.toFixed(4)}  Clp ${Clp.toFixed(3)}  Cnp ${Cnp.toFixed(3)}  Cnr ${Cnr.toFixed(3)}  Clr ${Clr.toFixed(3)}  spiral ${spiral > 0 ? 'stable' : 'UNSTABLE'} (${spiral.toFixed(5)})`);
}
