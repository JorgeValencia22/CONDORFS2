/**
 * Terrain generation micro-benchmarks: `node tests/perf.js`
 */
'use strict';

const { createContext } = require('./harness');

(async () => {
  const SIM = createContext();
  const region = SIM.Regions.chile;
  const geo = new SIM.GeoProjection(region.origin[0], region.origin[1]);
  const airports = region.airports.map((id) => SIM.Airports.buildLayout(SIM.AirportDB[id], geo));
  const t = new SIM.Terrain(region, geo, airports, 'summer');
  const time = (label, n, fn) => {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < n; i++) fn(i);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`${label.padEnd(28)} ${ms.toFixed(0).padStart(6)} ms  (${((ms * 1000) / n).toFixed(2)} µs/op)`);
  };
  const t0 = Date.now();
  await t.buildMacro();
  console.log(`buildMacro                   ${Date.now() - t0} ms  (${t.nx}x${t.nz})`);
  const rx = () => Math.random() * 100000 - 50000;
  const c = [0, 0, 0];
  time('rawHeight', 100000, () => t.rawHeight(rx(), rx()));
  time('colorAt', 100000, () => t.colorAt(rx(), rx(), 500, 0.1, c));
  time('urbanAt', 100000, () => t.urbanAt(rx(), rx()));
  time('landDistance', 100000, () => t.landDistance(rx(), rx()));
  time('treeDensity', 100000, () => t.treeDensity(rx(), rx(), 500, 0.1));
})();
