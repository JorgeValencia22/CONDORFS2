/**
 * Air-start trace: `node tests/airstart.js <aircraft> [kias] [altFt]`
 * Starts trimmed in level flight and logs the hands-off response second by second.
 */
'use strict';

const { createContext, createWorld } = require('./harness');

(async () => {
  const SIM = createContext();
  const w = await createWorld(SIM);
  w.weather.set('clear', { windKt: 0, gustKt: 0, turbulence: 0, tempC: 15, qnh: 1013.25 });
  const id = process.argv[2] || 'c172';
  const ac = new SIM.Aircraft(id, { fuel: 0.6 });
  const kias = Number(process.argv[3] || ac.cfg.performance.cruise * 0.9);
  const alt = Number(process.argv[4] || 5500) * SIM.Units.FT;
  ac.initAirborne(0, alt, -20000, 0, kias, w.env);
  const dt = 1 / 240;
  for (let t = 0; t <= 30; t++) {
    ac.updateState();
    const s = ac.state;
    console.log(`${String(t).padStart(3)}s ias=${s.iasKt.toFixed(0)} vs=${s.vsFpm.toFixed(0)} pitch=${s.pitchDeg.toFixed(1)} a=${s.aoaDeg.toFixed(1)} roll=${s.rollDeg.toFixed(1)} hdg=${s.trueHeadingDeg.toFixed(0)} trim=${ac.controls.elevatorTrim.toFixed(2)} ` +
      `eng=${ac.engines.map((e) => `${e.state}/${(e.rpm || e.n1).toFixed(0)}/${e.thrust.toFixed(0)}${e.propeller ? '/p' + e.propeller.pitch.toFixed(2) : ''}`).join(' ')}`);
    for (let i = 0; i < 240; i++) ac.step(dt, w.env);
  }
})();
