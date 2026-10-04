/**
 * Aircraft configuration objects. Each aircraft is entirely data driven: flight model, engines,
 * systems, gear, cockpit layout and 3D model parameters live here so new types can be added
 * without touching simulation code.
 *
 * Units: SI (m, kg, N, W, s) unless the property name says otherwise (kt, ft, gal, deg).
 * Body frame: x = right, y = up, z = aft (nose points -z). Origin = centre of gravity.
 * Aerodynamic derivatives are per radian (angles) or per unit control deflection (-1..1).
 */
(function (SIM) {
  'use strict';

  const HP = SIM.Units.HP;

  /** Shared defaults for light single-engine trainers; individual aircraft override them. */
  const GA_AERO = {
    cl0: 0.31, clAlpha: 4.6, alphaStallDeg: 16, stallSharpness: 40,
    cd0: 0.031, oswald: 0.75, cdGear: 0, cdSeparated: 1.1,
    cm0: 0.045, cmAlpha: -0.89, cmq: -12.4, cmDe: 0.55, cmTrim: 0.16, cmFlap: -0.04,
    clBeta: -0.089, clP: -0.47, clR: 0.096, clDa: 0.042, clDr: 0.004,
    cnBeta: 0.065, cnR: -0.099, cnP: -0.03, cnDr: 0.020, cnDa: -0.006,
    cyBeta: -0.31, cyDr: 0.05,
    propwashTail: 0.55, groundEffect: true,
    pFactor: 0.012, torqueRoll: 0.02,
  };

  const data = {};

  /* ------------------------------------------------------------------ Cessna 172 */
  data.c172 = {
    id: 'c172',
    name: 'Cessna 172 Skyhawk',
    shortName: 'C172',
    manufacturer: 'Cessna',
    role: 'TRAINER',
    category: 'Single-engine piston',
    difficulty: 1,
    capacity: '4 seats',
    description: 'The world\'s most produced aircraft. Stable, forgiving and the reference trainer of this simulator, with the most complete cockpit.',
    registration: 'CC-KMR',
    callsign: 'Kilo Mike Romeo',
    callsignFull: 'Charlie Charlie Kilo Mike Romeo',
    performance: { vs0: 40, vs1: 48, vr: 55, vx: 62, vy: 74, vfe: 85, vfeFirst: 110, vno: 129, vne: 163, cruise: 122, vapp: 65, vref: 62, ceiling: 14000, climbFpm: 730, rangeNm: 640, taxiKt: 15 },
    mass: { empty: 767, maxTakeoff: 1157, defaultPayload: 90 },
    inertia: { pitch: 1825, yaw: 2667, roll: 1285 },
    geometry: { wingArea: 16.2, span: 11.0, chord: 1.49, length: 8.28, eye: [-0.27, 0.62, -0.55], wingType: 'high' },
    aero: Object.assign({}, GA_AERO, {
      cd0: 0.033, oswald: 0.68,
      flaps: [
        { deg: 0, cl: 0, cd: 0, clmax: 0 },
        { deg: 10, cl: 0.22, cd: 0.012, clmax: 0.18 },
        { deg: 20, cl: 0.42, cd: 0.035, clmax: 0.33 },
        { deg: 30, cl: 0.58, cd: 0.065, clmax: 0.44 },
      ],
    }),
    controls: { rate: 3.2, elevatorMax: 1, aileronMax: 1, rudderMax: 1, trimRate: 0.22, steerDeg: 12, steerTaxiDeg: 30 },
    engines: [
      {
        type: 'piston', name: 'Lycoming O-320', position: [0, 0, -2.0], maxPower: 160 * HP, maxRPM: 2700, redline: 2700,
        idleRPM: 650, staticRPM: 2330, propDiameter: 1.91, propType: 'fixed', staticThrust: 2350, propEff: 0.8,
        cylinders: 4, carb: true, fuelFlowMax: 10.5, primer: false, rpmPerMs: 0.0022, windmill: 24,
        oil: { normalTemp: 82, maxTemp: 118, minPress: 25, maxPress: 100 },
        rotation: 1,
      },
    ],
    fuel: { type: 'AVGAS', unit: 'gal', tanks: [{ id: 'L', name: 'LEFT', capacity: 28, x: -1.8 }, { id: 'R', name: 'RIGHT', capacity: 28, x: 1.8 }], unusable: 1.5, selector: ['OFF', 'LEFT', 'BOTH', 'RIGHT'], defaultSelector: 'BOTH' },
    gear: {
      retractable: false,
      points: [
        { id: 'nose', pos: [0, -1.12, -1.35], steer: true, brake: false, compression: 0.11, damping: 0.55 },
        { id: 'left', pos: [-1.15, -1.12, 0.38], steer: false, brake: true, compression: 0.08, damping: 0.6 },
        { id: 'right', pos: [1.15, -1.12, 0.38], steer: false, brake: true, compression: 0.08, damping: 0.6 },
      ],
      contacts: [
        { id: 'tail', pos: [0, -0.4, 4.4] }, { id: 'prop', pos: [0, -0.85, -2.3] },
        { id: 'ltip', pos: [-5.5, 0.85, 0.15] }, { id: 'rtip', pos: [5.5, 0.85, 0.15] },
        { id: 'belly', pos: [0, -0.62, 0.3] }, { id: 'roof', pos: [0, 1.25, 0.2] },
      ],
    },
    systems: { electricalFlaps: true, flapRateDeg: 3.5, vacuum: true, battery: { volts: 24, ah: 35 }, alternatorAmps: 60, fuelPump: false, carbHeat: true, parkingBrake: true },
    avionics: { com: 2, nav: 2, gps: true, autopilot: 'ga', autothrottle: false, transponder: true, adf: false },
    cockpit: { layout: 'ga', panelColor: '#2d3034', panelEdge: '#3b3f44', label: 'SKYHAWK', engineGauges: 'single', switches: ['batt', 'alt', 'avionics', 'beacon', 'land', 'taxi', 'nav', 'strobe', 'pitot', 'panel'] },
    visual: { model: 'highwing', base: '#f4f4f1', stripe: '#1f3b73', stripe2: '#c19a3d', glass: '#28323c', strut: true, fairings: true, tailNumber: 'CC-KMR' },
    sound: { kind: 'piston', cylinders: 4, character: 0.9 },
    stallHornMarginDeg: 3,
  };

  /* ------------------------------------------------------------------ Cessna 152 */
  data.c152 = {
    id: 'c152',
    name: 'Cessna 152',
    shortName: 'C152',
    manufacturer: 'Cessna',
    role: 'TRAINER',
    category: 'Single-engine piston',
    difficulty: 1,
    capacity: '2 seats',
    description: 'Light two-seat trainer. Lower power and mass than the 172 make it lively in pitch and noticeably more sensitive to wind.',
    registration: 'CC-PLV',
    callsign: 'Papa Lima Victor',
    callsignFull: 'Charlie Charlie Papa Lima Victor',
    performance: { vs0: 35, vs1: 40, vr: 50, vx: 55, vy: 67, vfe: 85, vfeFirst: 85, vno: 111, vne: 149, cruise: 107, vapp: 60, vref: 54, ceiling: 14700, climbFpm: 715, rangeNm: 415, taxiKt: 15 },
    mass: { empty: 490, maxTakeoff: 757, defaultPayload: 80 },
    inertia: { pitch: 1050, yaw: 1580, roll: 820 },
    geometry: { wingArea: 14.9, span: 10.1, chord: 1.47, length: 7.34, eye: [-0.25, 0.6, -0.45], wingType: 'high' },
    aero: Object.assign({}, GA_AERO, {
      cl0: 0.33, clAlpha: 4.5, cd0: 0.033, cmq: -11, cmDe: 0.6, clDa: 0.046, cnDr: 0.022,
      flaps: [
        { deg: 0, cl: 0, cd: 0, clmax: 0 },
        { deg: 10, cl: 0.2, cd: 0.012, clmax: 0.16 },
        { deg: 20, cl: 0.38, cd: 0.035, clmax: 0.3 },
        { deg: 30, cl: 0.52, cd: 0.065, clmax: 0.4 },
      ],
    }),
    controls: { rate: 3.6, elevatorMax: 1, aileronMax: 1, rudderMax: 1, trimRate: 0.25, steerDeg: 12, steerTaxiDeg: 30 },
    engines: [
      {
        type: 'piston', name: 'Lycoming O-235', position: [0, 0, -1.8], maxPower: 110 * HP, maxRPM: 2550, redline: 2550,
        idleRPM: 650, staticRPM: 2280, propDiameter: 1.75, propType: 'fixed', staticThrust: 1650, propEff: 0.78,
        cylinders: 4, carb: true, fuelFlowMax: 7, rpmPerMs: 0.0021, windmill: 24,
        oil: { normalTemp: 80, maxTemp: 118, minPress: 25, maxPress: 100 }, rotation: 1,
      },
    ],
    fuel: { type: 'AVGAS', unit: 'gal', tanks: [{ id: 'L', name: 'LEFT', capacity: 13, x: -1.6 }, { id: 'R', name: 'RIGHT', capacity: 13, x: 1.6 }], unusable: 0.75, selector: ['OFF', 'ON'], defaultSelector: 'ON' },
    gear: {
      retractable: false,
      points: [
        { id: 'nose', pos: [0, -1.05, -1.25], steer: true, brake: false, compression: 0.1, damping: 0.55 },
        { id: 'left', pos: [-0.98, -1.05, 0.32], steer: false, brake: true, compression: 0.07, damping: 0.6 },
        { id: 'right', pos: [0.98, -1.05, 0.32], steer: false, brake: true, compression: 0.07, damping: 0.6 },
      ],
      contacts: [
        { id: 'tail', pos: [0, -0.35, 4.0] }, { id: 'prop', pos: [0, -0.8, -2.05] },
        { id: 'ltip', pos: [-5.05, 0.8, 0.1] }, { id: 'rtip', pos: [5.05, 0.8, 0.1] },
        { id: 'belly', pos: [0, -0.6, 0.25] }, { id: 'roof', pos: [0, 1.15, 0.2] },
      ],
    },
    systems: { electricalFlaps: true, flapRateDeg: 3.5, vacuum: true, battery: { volts: 24, ah: 25 }, alternatorAmps: 60, fuelPump: false, carbHeat: true, parkingBrake: true },
    avionics: { com: 1, nav: 1, gps: true, autopilot: null, autothrottle: false, transponder: true, adf: false },
    cockpit: { layout: 'ga', panelColor: '#3a3a36', panelEdge: '#4a4a44', label: 'CESSNA 152', engineGauges: 'single', switches: ['batt', 'alt', 'avionics', 'beacon', 'land', 'nav', 'strobe', 'pitot', 'panel'] },
    visual: { model: 'highwing', base: '#f2f0ea', stripe: '#9c2f2a', stripe2: '#3d3d3d', glass: '#2b333a', strut: true, fairings: false, tailNumber: 'CC-PLV', scale: 0.9 },
    sound: { kind: 'piston', cylinders: 4, character: 1.1 },
    stallHornMarginDeg: 3,
  };

  /* ------------------------------------------------------------------ Piper PA-28 */
  data.pa28 = {
    id: 'pa28',
    name: 'Piper PA-28-161 Warrior',
    shortName: 'PA-28',
    manufacturer: 'Piper',
    role: 'TRAINER',
    category: 'Single-engine piston',
    difficulty: 2,
    capacity: '4 seats',
    description: 'Low-wing trainer with a stabilator: lighter pitch forces, stronger ground effect and LEFT/RIGHT fuel tank management with an electric fuel pump.',
    registration: 'CC-AHW',
    callsign: 'Alfa Hotel Whiskey',
    callsignFull: 'Charlie Charlie Alfa Hotel Whiskey',
    performance: { vs0: 44, vs1: 50, vr: 60, vx: 63, vy: 79, vfe: 103, vfeFirst: 103, vno: 126, vne: 160, cruise: 115, vapp: 70, vref: 66, ceiling: 11000, climbFpm: 644, rangeNm: 510, taxiKt: 15 },
    mass: { empty: 680, maxTakeoff: 1055, defaultPayload: 90 },
    inertia: { pitch: 1700, yaw: 2650, roll: 1250 },
    geometry: { wingArea: 15.8, span: 10.67, chord: 1.6, length: 7.25, eye: [-0.27, 0.55, -0.35], wingType: 'low' },
    aero: Object.assign({}, GA_AERO, {
      cl0: 0.28, clAlpha: 4.8, alphaStallDeg: 15, cd0: 0.031, oswald: 0.7, cmDe: 0.6, cmq: -13.5, cmAlpha: -0.8, clBeta: -0.07, clDa: 0.046,
      flaps: [
        { deg: 0, cl: 0, cd: 0, clmax: 0 },
        { deg: 10, cl: 0.18, cd: 0.01, clmax: 0.15 },
        { deg: 25, cl: 0.4, cd: 0.035, clmax: 0.3 },
        { deg: 40, cl: 0.55, cd: 0.08, clmax: 0.4 },
      ],
    }),
    controls: { rate: 3.4, elevatorMax: 1, aileronMax: 1, rudderMax: 1, trimRate: 0.26, steerDeg: 12, steerTaxiDeg: 28 },
    engines: [
      {
        type: 'piston', name: 'Lycoming O-320-D3G', position: [0, 0, -1.9], maxPower: 160 * HP, maxRPM: 2700, redline: 2700,
        idleRPM: 650, staticRPM: 2350, propDiameter: 1.88, propType: 'fixed', staticThrust: 2250, propEff: 0.8,
        cylinders: 4, carb: true, fuelFlowMax: 10.5, rpmPerMs: 0.0021, windmill: 24,
        oil: { normalTemp: 82, maxTemp: 118, minPress: 25, maxPress: 100 }, rotation: 1,
      },
    ],
    fuel: { type: 'AVGAS', unit: 'gal', tanks: [{ id: 'L', name: 'LEFT', capacity: 25, x: -1.7 }, { id: 'R', name: 'RIGHT', capacity: 25, x: 1.7 }], unusable: 1, selector: ['OFF', 'LEFT', 'RIGHT'], defaultSelector: 'LEFT' },
    gear: {
      retractable: false,
      points: [
        { id: 'nose', pos: [0, -1.18, -1.6], steer: true, brake: false, compression: 0.11, damping: 0.55 },
        { id: 'left', pos: [-1.6, -1.18, 0.35], steer: false, brake: true, compression: 0.08, damping: 0.6 },
        { id: 'right', pos: [1.6, -1.18, 0.35], steer: false, brake: true, compression: 0.08, damping: 0.6 },
      ],
      contacts: [
        { id: 'tail', pos: [0, -0.25, 4.3] }, { id: 'prop', pos: [0, -0.9, -2.2] },
        { id: 'ltip', pos: [-5.3, -0.35, 0.2] }, { id: 'rtip', pos: [5.3, -0.35, 0.2] },
        { id: 'belly', pos: [0, -0.7, 0.2] }, { id: 'roof', pos: [0, 1.0, 0.1] },
      ],
    },
    systems: { electricalFlaps: false, flapRateDeg: 25, vacuum: true, battery: { volts: 12, ah: 35 }, alternatorAmps: 60, fuelPump: true, carbHeat: true, parkingBrake: true, lowVolts: 12 },
    avionics: { com: 2, nav: 2, gps: true, autopilot: 'ga', autothrottle: false, transponder: true, adf: false },
    cockpit: { layout: 'ga', panelColor: '#262a30', panelEdge: '#353b42', label: 'WARRIOR', engineGauges: 'single', switches: ['batt', 'alt', 'avionics', 'pump', 'beacon', 'land', 'taxi', 'nav', 'strobe', 'pitot', 'panel'] },
    visual: { model: 'lowwing', base: '#f5f5f2', stripe: '#7a1f24', stripe2: '#2b2b2b', glass: '#25303a', strut: false, fairings: true, tailNumber: 'CC-AHW' },
    sound: { kind: 'piston', cylinders: 4, character: 0.95 },
    stallHornMarginDeg: 3,
  };

  /* ------------------------------------------------------------------ Beechcraft Baron 58 */
  data.be58 = {
    id: 'be58',
    name: 'Beechcraft Baron 58',
    shortName: 'BARON 58',
    manufacturer: 'Beechcraft',
    role: 'TWIN ENGINE',
    category: 'Twin-engine piston',
    difficulty: 3,
    capacity: '6 seats',
    description: 'High-performance twin with retractable gear and constant-speed propellers. Engine failures create real asymmetric thrust; keep blue line in mind.',
    registration: 'CC-BTN',
    callsign: 'Bravo Tango November',
    callsignFull: 'Charlie Charlie Bravo Tango November',
    performance: { vs0: 75, vs1: 84, vr: 90, vx: 98, vy: 105, vyse: 101, vmc: 84, vfe: 122, vfeFirst: 152, vle: 152, vno: 195, vne: 223, cruise: 200, vapp: 100, vref: 95, ceiling: 20000, climbFpm: 1700, rangeNm: 1000, taxiKt: 18 },
    mass: { empty: 1580, maxTakeoff: 2495, defaultPayload: 180 },
    inertia: { pitch: 6200, yaw: 10600, roll: 5600 },
    geometry: { wingArea: 18.5, span: 11.53, chord: 1.65, length: 9.09, eye: [-0.3, 0.62, -1.0], wingType: 'low' },
    aero: Object.assign({}, GA_AERO, {
      cl0: 0.22, clAlpha: 5.0, alphaStallDeg: 15, cd0: 0.0245, cdGear: 0.016, oswald: 0.78,
      cm0: 0.05, cmAlpha: -1.1, cmq: -14, cmDe: 0.75, cmTrim: 0.2, clDa: 0.045, clP: -0.5, cnDr: 0.028, cnBeta: 0.075,
      propwashTail: 0.15, pFactor: 0, torqueRoll: 0,
      flaps: [
        { deg: 0, cl: 0, cd: 0, clmax: 0 },
        { deg: 15, cl: 0.3, cd: 0.02, clmax: 0.24 },
        { deg: 30, cl: 0.55, cd: 0.06, clmax: 0.45 },
      ],
    }),
    controls: { rate: 2.8, elevatorMax: 1, aileronMax: 1, rudderMax: 1, trimRate: 0.18, steerDeg: 10, steerTaxiDeg: 26 },
    engines: [
      {
        type: 'piston', name: 'IO-550-C (L)', position: [-2.1, 0.1, -1.4], maxPower: 300 * HP, maxRPM: 2700, redline: 2700,
        idleRPM: 700, staticRPM: 2650, propDiameter: 1.98, propType: 'constant', staticThrust: 3900, propEff: 0.83,
        cylinders: 6, carb: false, fuelFlowMax: 26, rpmPerMs: 0, windmill: 22, minGovRPM: 2000,
        oil: { normalTemp: 85, maxTemp: 116, minPress: 30, maxPress: 100 }, rotation: 1,
      },
      {
        type: 'piston', name: 'IO-550-C (R)', position: [2.1, 0.1, -1.4], maxPower: 300 * HP, maxRPM: 2700, redline: 2700,
        idleRPM: 700, staticRPM: 2650, propDiameter: 1.98, propType: 'constant', staticThrust: 3900, propEff: 0.83,
        cylinders: 6, carb: false, fuelFlowMax: 26, rpmPerMs: 0, windmill: 22, minGovRPM: 2000,
        oil: { normalTemp: 85, maxTemp: 116, minPress: 30, maxPress: 100 }, rotation: 1,
      },
    ],
    fuel: { type: 'AVGAS', unit: 'gal', tanks: [{ id: 'L', name: 'LEFT', capacity: 68, x: -2.5 }, { id: 'R', name: 'RIGHT', capacity: 68, x: 2.5 }], unusable: 2, selector: ['OFF', 'ON'], defaultSelector: 'ON', perEngine: true },
    gear: {
      retractable: true,
      transitTime: 6,
      points: [
        { id: 'nose', pos: [0, -1.3, -2.3], steer: true, brake: false, compression: 0.12, damping: 0.55 },
        { id: 'left', pos: [-1.5, -1.3, 0.4], steer: false, brake: true, compression: 0.1, damping: 0.6 },
        { id: 'right', pos: [1.5, -1.3, 0.4], steer: false, brake: true, compression: 0.1, damping: 0.6 },
      ],
      contacts: [
        { id: 'tail', pos: [0, -0.3, 5.0] }, { id: 'lprop', pos: [-2.1, -0.85, -2.1] }, { id: 'rprop', pos: [2.1, -0.85, -2.1] },
        { id: 'ltip', pos: [-5.7, -0.3, 0.3] }, { id: 'rtip', pos: [5.7, -0.3, 0.3] },
        { id: 'belly', pos: [0, -0.75, 0.0] }, { id: 'roof', pos: [0, 1.0, -0.2] },
      ],
    },
    systems: { electricalFlaps: true, flapRateDeg: 3.5, vacuum: true, battery: { volts: 24, ah: 35 }, alternatorAmps: 100, fuelPump: true, carbHeat: false, parkingBrake: true, gearWarning: true },
    avionics: { com: 2, nav: 2, gps: true, autopilot: 'ga', autothrottle: false, transponder: true, adf: false },
    cockpit: { layout: 'ga-twin', panelColor: '#1f2328', panelEdge: '#2e333a', label: 'BARON 58', engineGauges: 'twin', switches: ['batt', 'alt', 'avionics', 'pump', 'beacon', 'land', 'taxi', 'nav', 'strobe', 'pitot', 'panel'] },
    visual: { model: 'twin', base: '#f6f6f4', stripe: '#24456e', stripe2: '#8b96a3', glass: '#1d2731', strut: false, fairings: false, tailNumber: 'CC-BTN' },
    sound: { kind: 'piston', cylinders: 6, character: 0.8 },
    stallHornMarginDeg: 3,
  };

  /* ------------------------------------------------------------------ Boeing 737-800 */
  data.b738 = {
    id: 'b738',
    name: 'Boeing 737-800',
    shortName: 'B737',
    manufacturer: 'Boeing',
    role: 'AIRLINER',
    category: 'Twin-engine jet',
    difficulty: 4,
    capacity: '162–189 pax',
    description: 'Narrow-body airliner with glass cockpit, autothrottle, speed brakes, thrust reversers and slow-spooling turbofans. Plan your energy well ahead.',
    registration: 'CC-CDR',
    callsign: 'Condor Five One Two',
    callsignFull: 'Condor Five One Two',
    flightNumber: 'CDR512',
    performance: { vs0: 108, vs1: 135, vr: 145, vx: 160, vy: 220, vfe: 162, vfeFirst: 250, vle: 270, vno: 340, vne: 340, mmo: 0.82, cruise: 450, vapp: 145, vref: 140, ceiling: 41000, climbFpm: 2500, rangeNm: 2900, taxiKt: 20 },
    mass: { empty: 41400, maxTakeoff: 79000, defaultPayload: 13000 },
    inertia: { pitch: 3.1e6, yaw: 4.0e6, roll: 1.25e6 },
    geometry: { wingArea: 124.6, span: 35.8, chord: 4.17, length: 39.5, eye: [-0.55, 1.2, -16.6], wingType: 'low' },
    aero: {
      cl0: 0.22, clAlpha: 5.1, alphaStallDeg: 14, stallSharpness: 35,
      cd0: 0.0195, oswald: 0.8, cdGear: 0.018, cdSeparated: 1.0, cdSpeedbrake: 0.03, clSpeedbrake: -0.18,
      cm0: 0.04, cmAlpha: -1.4, cmq: -22, cmDe: 0.9, cmTrim: 0.25, cmFlap: -0.06,
      clBeta: -0.12, clP: -0.42, clR: 0.11, clDa: 0.05, clDr: 0.005,
      cnBeta: 0.09, cnR: -0.18, cnP: -0.02, cnDr: 0.032, cnDa: -0.004,
      cyBeta: -0.6, cyDr: 0.08,
      propwashTail: 0, groundEffect: true, pFactor: 0, torqueRoll: 0, machDrag: true,
      flaps: [
        { deg: 0, cl: 0, cd: 0, clmax: 0, label: 'UP' },
        { deg: 1, cl: 0.25, cd: 0.004, clmax: 0.3, label: '1' },
        { deg: 2, cl: 0.32, cd: 0.006, clmax: 0.38, label: '2' },
        { deg: 5, cl: 0.42, cd: 0.01, clmax: 0.5, label: '5' },
        { deg: 10, cl: 0.52, cd: 0.016, clmax: 0.6, label: '10' },
        { deg: 15, cl: 0.62, cd: 0.024, clmax: 0.7, label: '15' },
        { deg: 25, cl: 0.75, cd: 0.04, clmax: 0.8, label: '25' },
        { deg: 30, cl: 0.85, cd: 0.055, clmax: 0.88, label: '30' },
        { deg: 40, cl: 0.95, cd: 0.08, clmax: 0.95, label: '40' },
      ],
      flapSpeeds: [999, 250, 250, 250, 210, 200, 190, 175, 162],
    },
    controls: { rate: 2.2, elevatorMax: 1, aileronMax: 1, rudderMax: 1, trimRate: 0.08, steerDeg: 7, steerTaxiDeg: 60 },
    engines: [
      { type: 'turbofan', name: 'CFM56-7B26 (1)', position: [-4.9, -1.2, -3.2], maxThrust: 117000, idleN1: 21, idleN2: 60, spoolUp: 4.5, fuelFlowIdle: 360, fuelFlowMax: 3400, egtMax: 950, reverseMax: 0.32 },
      { type: 'turbofan', name: 'CFM56-7B26 (2)', position: [4.9, -1.2, -3.2], maxThrust: 117000, idleN1: 21, idleN2: 60, spoolUp: 4.5, fuelFlowIdle: 360, fuelFlowMax: 3400, egtMax: 950, reverseMax: 0.32 },
    ],
    fuel: { type: 'JET-A', unit: 'kg', tanks: [{ id: 'L', name: 'TANK 1', capacity: 3900, x: -6 }, { id: 'C', name: 'CENTER', capacity: 13000, x: 0 }, { id: 'R', name: 'TANK 2', capacity: 3900, x: 6 }], unusable: 50, selector: ['AUTO'], defaultSelector: 'AUTO', perEngine: false },
    gear: {
      retractable: true,
      transitTime: 8,
      points: [
        { id: 'nose', pos: [0, -2.95, -13.9], steer: true, brake: false, compression: 0.2, damping: 0.6 },
        { id: 'left', pos: [-2.86, -2.95, 1.2], steer: false, brake: true, compression: 0.25, damping: 0.65 },
        { id: 'right', pos: [2.86, -2.95, 1.2], steer: false, brake: true, compression: 0.25, damping: 0.65 },
      ],
      contacts: [
        { id: 'tail', pos: [0, -1.6, 15.5] }, { id: 'leng', pos: [-4.9, -2.3, -3.2] }, { id: 'reng', pos: [4.9, -2.3, -3.2] },
        { id: 'ltip', pos: [-17.9, 0.4, 5.5] }, { id: 'rtip', pos: [17.9, 0.4, 5.5] },
        { id: 'belly', pos: [0, -1.95, -2] }, { id: 'nosecone', pos: [0, -0.2, -20] }, { id: 'roof', pos: [0, 2.2, 0] },
      ],
    },
    systems: { electricalFlaps: false, flapRateDeg: 2.2, vacuum: false, battery: { volts: 24, ah: 48 }, alternatorAmps: 400, fuelPump: false, carbHeat: false, parkingBrake: true, speedbrake: true, reversers: true, gearWarning: true, hydraulic: true },
    avionics: { com: 2, nav: 2, gps: true, autopilot: 'mcp', autothrottle: true, transponder: true, adf: false },
    cockpit: { layout: 'airliner', panelColor: '#4a5560', panelEdge: '#5b6672', label: '737-800', engineGauges: 'jet', switches: ['batt', 'gen', 'avionics', 'beacon', 'land', 'taxi', 'nav', 'strobe', 'logo', 'pitot', 'panel'] },
    visual: { model: 'airliner', base: '#f3f4f6', stripe: '#1c3557', stripe2: '#c8a24a', glass: '#151b22', tailNumber: 'CC-CDR', airline: 'CÓNDOR' },
    sound: { kind: 'jet' },
    stallHornMarginDeg: 2,
  };

  /** Display order in menus. */
  SIM.AircraftOrder = ['c172', 'c152', 'pa28', 'be58', 'b738'];
  SIM.AircraftData = data;

  /** Freezes nested config so systems cannot mutate shared data by accident. */
  function deepFreeze(o) {
    Object.values(o).forEach((v) => v && typeof v === 'object' && deepFreeze(v));
    return Object.freeze(o);
  }
  Object.values(data).forEach(deepFreeze);
})(window.SIM);
