/**
 * CÓNDOR Flight Simulator — global namespace, unit conversions and engine-wide configuration.
 *
 * The project uses classic scripts attached to a single namespace (SIM) instead of ES modules so the
 * simulator also runs when index.html is opened directly from disk (file://), where module imports
 * are blocked by browser CORS rules.
 */
(function () {
  'use strict';

  const SIM = (window.SIM = window.SIM || {});

  SIM.VERSION = '1.0.0';
  SIM.PRODUCT = 'CÓNDOR Flight Simulator';

  /** Unit conversion factors. Everything inside the simulation runs in SI units. */
  SIM.Units = Object.freeze({
    KT: 0.514444,        // m/s per knot
    FT: 0.3048,          // m per foot
    NM: 1852,            // m per nautical mile
    LB: 0.453592,        // kg per pound
    GAL: 3.78541,        // litres per US gallon
    HP: 745.7,           // W per horsepower
    FPM: 0.00508,        // m/s per foot-per-minute
    INHG: 33.8639,       // hPa per inHg
    LBF: 4.44822,        // N per pound-force
    AVGAS_KG_PER_GAL: 2.72,
    JETA_KG_PER_L: 0.8,
  });

  /** Physical constants (ISA). */
  SIM.Phys = Object.freeze({
    G: 9.80665,
    R: 287.053,
    RHO0: 1.225,
    P0: 101325,
    T0: 288.15,
    LAPSE: 0.0065,
  });

  /** Engine-wide tunables, centralised to avoid magic numbers scattered through the code. */
  SIM.Config = Object.freeze({
    PHYSICS_HZ: 240,             // fixed physics rate
    MAX_PHYSICS_STEPS: 24,       // per rendered frame (prevents spiral of death)
    MAX_FRAME_DT: 0.1,           // s, clamps long frames (tab switches)
    INSTRUMENT_HZ: 30,           // gauge redraw rate
    UI_HZ: 10,                   // text panels refresh rate
    STORAGE_PREFIX: 'condor.fs.',
    TERRAIN_MACRO_CELL: 1000,    // m, macro heightfield resolution
    TERRAIN_TILE_SEGMENTS: 48,
    TERRAIN_ROOT_SIZE: 32000,    // m
    TERRAIN_MAX_LEVEL: 5,        // root / 2^5 = 1000 m finest tile
    TERRAIN_BUILD_BUDGET_MS: 6,
    TERRAIN_CACHE_LIMIT: 520,
    WATER_LEVEL: 0,
    CRASH_SPEED: 2.5,            // m/s structural contact speed considered a crash
    TOUCHDOWN_MIN_AIRTIME: 4,    // s airborne before a ground contact counts as a landing
  });

  /** Shared helper for small id generation. */
  let uid = 0;
  SIM.uid = (prefix = 'id') => `${prefix}${++uid}`;
})();
