/**
 * Headless harness: loads the simulator's pure-JS modules (physics, systems, world data, navigation)
 * into a Node VM context with minimal browser stubs. Used by the automated tests.
 */
'use strict';

const vm = require('vm');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** Modules that do not need WebGL/DOM. Order matters (same as index.html). */
const PURE_MODULES = [
  'js/core/namespace.js',
  'js/core/math.js',
  'js/core/events.js',
  'js/core/storage.js',
  'js/input/bindings.js',
  'js/core/settings.js',
  'js/core/loader.js',
  'js/aircraft/aircraftData.js',
  'js/aircraft/propeller.js',
  'js/aircraft/engine.js',
  'js/aircraft/systems.js',
  'js/aircraft/failures.js',
  'js/aircraft/aerodynamics.js',
  'js/aircraft/flightModel.js',
  'js/aircraft/autopilot.js',
  'js/aircraft/aircraft.js',
  'js/world/geo.js',
  'js/world/regions.js',
  'js/world/airports.js',
  'js/world/terrain.js',
  'js/world/weather.js',
  'js/navigation/navdata.js',
  'js/navigation/radios.js',
  'js/navigation/navigation.js',
  'js/navigation/atc.js',
  'js/missions/missions.js',
  'js/core/stateMachine.js',
];

function createContext() {
  // Load into the real global (fast property access); a minimal browser surface is stubbed.
  if (global.SIM) return global.SIM;
  const store = new Map();
  global.window = global;
  global.requestAnimationFrame = (f) => setImmediate(() => f(0));
  if (!global.navigator) global.navigator = { hardwareConcurrency: 4 };
  global.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  global.addEventListener = () => {};
  global.removeEventListener = () => {};
  delete global.MessageChannel; // loader falls back to setTimeout in Node
  for (const rel of PURE_MODULES) {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) continue;
    vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: rel });
  }
  return global.SIM;
}

/** Builds region + terrain + weather + environment for physics. */
async function createWorld(SIM, regionId = 'chile', weatherId = 'clear', weatherCustom = null) {
  const region = SIM.Regions[regionId];
  const geo = new SIM.GeoProjection(region.origin[0], region.origin[1]);
  const airports = region.airports.map((id) => SIM.Airports.buildLayout(SIM.AirportDB[id], geo));
  const terrain = new SIM.Terrain(region, geo, airports, 'summer');
  await terrain.buildMacro();
  const weather = new SIM.Weather(weatherId, weatherCustom, region);
  const env = {
    terrain,
    atmosphereAt: (y) => weather.atmosphereAt(y),
    windAt: (pos, out) => weather.windAt(pos, out),
    turbulence: 0,
    humidity: weather.humidity,
    visibleMoisture: (y) => weather.visibleMoisture(y),
  };
  return { region, geo, airports, terrain, weather, env };
}

module.exports = { createContext, createWorld, ROOT };
