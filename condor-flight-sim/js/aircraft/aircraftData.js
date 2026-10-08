/**
 * Aircraft definitions — single source of truth for the physics AND the 3D model.
 *
 * Geometry follows published dimensions (span, length, height, wing area, root/tip chords, dihedral,
 * twist, tail spans, wheel track/base, propeller diameter). Body frame: x = right, y = up, z = aft
 * (nose points to -z), origin at the centre of gravity. Lengths in metres, angles in degrees.
 *
 * Lifting surfaces are defined by spanwise sections {y, le, chord, twist}: `y` is the distance from
 * the centreline, `le` the body z of the leading edge, `twist` the local incidence. Dihedral raises
 * the sections. The aerodynamic model integrates these surfaces strip by strip, so stability and
 * control characteristics come from the geometry rather than from hand-tuned coefficients.
 *
 * Performance targets are taken from the aircraft flight manuals (POH/AFM) and are verified by
 * tests/performance.test.js. Speeds in `performance` are KIAS as marked on the airspeed indicator;
 * `pohTargets` speeds are KCAS (stall speeds) or KTAS (cruise), at max take-off mass unless a
 * reference `massKg` is given (airliner figures are quoted at a typical operating weight).
 */
(function (SIM) {
  'use strict';

  const HP = SIM.Units.HP;

  /* -------------------------------------------------------------------------- airfoils */
  // Section data: lift slope a0 (/rad), zero-lift angle (deg), max cl, section stall angle (deg),
  // minimum drag, drag-polar curvature, pitching moment about c/4, thickness ratio.
  const AIRFOILS = {
    naca2412: { a0: 6.0, alpha0: -2.1, clmax: 1.7, alphaStall: 15.5, cd0: 0.0066, kcd: 0.0075, clCdMin: 0.2, cm: -0.047, t: 0.12, camber: 0.02 },
    naca652415: { a0: 6.1, alpha0: -2.6, clmax: 1.78, alphaStall: 13.8, cd0: 0.0054, kcd: 0.0085, clCdMin: 0.4, cm: -0.065, t: 0.15, camber: 0.022 },
    naca23016: { a0: 6.0, alpha0: -1.2, clmax: 1.3, alphaStall: 16.0, cd0: 0.0068, kcd: 0.0065, clCdMin: 0.2, cm: -0.012, t: 0.16, camber: 0.018 },
    bac737: { a0: 6.2, alpha0: -2.8, clmax: 1.62, alphaStall: 13.0, cd0: 0.0060, kcd: 0.0060, clCdMin: 0.45, cm: -0.085, t: 0.13, camber: 0.018 },
    naca0012: { a0: 5.9, alpha0: 0, clmax: 1.3, alphaStall: 14.5, cd0: 0.0062, kcd: 0.0085, clCdMin: 0, cm: 0, t: 0.12, camber: 0 },
    naca0009: { a0: 5.8, alpha0: 0, clmax: 1.1, alphaStall: 12.5, cd0: 0.0058, kcd: 0.009, clCdMin: 0, cm: 0, t: 0.09, camber: 0 },
  };

  const data = {};

  /* ======================================================================= Cessna 172 */
  data.c172 = {
    id: 'c172',
    name: 'Cessna 172 Skyhawk',
    shortName: 'C172',
    manufacturer: 'Cessna',
    role: 'TRAINER',
    category: 'Single-engine piston',
    difficulty: 1,
    capacity: '4 seats',
    description: 'C172P-class Skyhawk with a 160 hp carburetted O-320 and fixed-pitch propeller. Stable, forgiving, gentle root-first stall thanks to wing washout. The most complete cockpit.',
    registration: 'CC-KMR',
    callsign: 'Kilo Mike Romeo',
    callsignFull: 'Charlie Charlie Kilo Mike Romeo',
    performance: { vs0: 33, vs1: 44, vr: 51, vx: 59, vy: 73, vfe: 85, vfeFirst: 110, vno: 127, vne: 158, cruise: 117, vapp: 65, vref: 61, ceiling: 13000, climbFpm: 700, rangeNm: 580, taxiKt: 15, bestGlide: 65 },
    pohTargets: { takeoffFlapIdx: 1, rotateKias: 51, stallCleanKcas: 51, stallFullKcas: 46, climbFpmSL: 700, cruiseKtas8000: 117, takeoffRollM: 271, landingRollM: 158, glideRatio: 9.0, staticRPM: [2280, 2400] },
    // Position error: [KCAS, KIAS] (POH airspeed calibration, flaps up)
    asiCalibration: [[40, 26], [51, 44], [56, 50], [62, 60], [70, 70], [80, 80], [100, 101], [120, 123], [140, 143], [160, 164]],
    mass: { empty: 680, maxTakeoff: 1089, defaultPayload: 160 },
    inertia: { pitch: 1825, yaw: 2667, roll: 1285 },
    geometry: { length: 8.2, height: 2.68, span: 10.92, wingArea: 16.2, eye: [-0.27, 0.6, -0.16], wingType: 'high' },
    wing: {
      airfoil: 'naca2412', y0: 1.02, dihedral: 1.73, oswald: 0.8,
      sections: [
        { y: 0, le: -0.42, chord: 1.638, twist: 1.5 },
        { y: 2.54, le: -0.42, chord: 1.638, twist: 1.0 },
        { y: 5.46, le: -0.39, chord: 1.118, twist: -1.5 },
      ],
      bodyHalfWidth: 0.56,
      flap: { y0: 0.56, y1: 2.95, chordFrac: 0.3, kind: 'slotted', gain: 2.2, clmaxShare: 0.85 },
      aileron: { y0: 2.95, y1: 5.2, chordFrac: 0.25, up: 20, down: 15 },
    },
    htail: {
      airfoil: 'naca0012', y0: 0.22, dihedral: 0, eta: 0.92, downwashGain: 1.15,
      sections: [{ y: 0, le: 4.3, chord: 1.16, twist: -2.5 }, { y: 1.725, le: 4.6, chord: 0.76, twist: -2.5 }],
      elevator: { chordFrac: 0.42, up: 28, down: 23 }, trimRange: 7,
    },
    vtail: {
      airfoil: 'naca0012', y0: 0.42,
      sections: [{ h: 0, le: 3.75, chord: 1.9 }, { h: 1.04, le: 5.0, chord: 0.78 }],
      rudder: { chordFrac: 0.45, max: 16 },
    },
    fuselage: {
      // [z, width, height, centre y, squareness]
      sections: [
        [-2.0, 0.6, 0.56, -0.08, 2.2], [-1.82, 0.86, 0.8, -0.04, 2.6], [-1.42, 0.98, 0.92, 0, 3], [-1.04, 1.04, 1.02, 0.05, 3.4],
        [-0.8, 1.08, 1.3, 0.18, 3.6], [-0.4, 1.12, 1.48, 0.25, 3.8], [0.4, 1.12, 1.5, 0.26, 3.8], [1.2, 1.04, 1.4, 0.24, 3.5],
        [1.7, 0.86, 1.12, 0.29, 3], [2.6, 0.62, 0.82, 0.32, 2.6], [3.6, 0.42, 0.58, 0.33, 2.4], [4.6, 0.28, 0.42, 0.33, 2.2],
        [5.4, 0.16, 0.28, 0.33, 2], [5.75, 0.05, 0.1, 0.33, 2],
      ],
      volume: 3.4,
    },
    drag: { fuselage: 0.2, gear: 0.085, struts: 0.035, cooling: 0.06, misc: 0.035 },
    struts: [{ from: [0.52, -0.43, 0.0], to: [2.62, 1.06, 0.0] }],
    aero: {
      flaps: [{ deg: 0, label: 'UP' }, { deg: 10, label: '10°' }, { deg: 20, label: '20°' }, { deg: 30, label: '30°' }],
      interferenceClBeta: -0.03,
    },
    controls: { rate: 3.2, elevatorMax: 1, aileronMax: 1, rudderMax: 1, trimRate: 0.22, steerDeg: 10, steerTaxiDeg: 30 },
    engines: [
      {
        type: 'piston', name: 'Lycoming O-320-D2J', position: [0, -0.06, -2.1], maxPower: 160 * HP, maxRPM: 2700, redline: 2700, idleRPM: 650,
        staticRPM: 2340, staticThrust: 2250, propType: 'fixed', propDiameter: 1.905, propPitchIn: 53, blades: 2, inertia: 1.9,
        cylinders: 4, carb: true, fuelFlowMax: 10.5, oil: { normalTemp: 82, maxTemp: 118, minPress: 25, maxPress: 100 }, rotation: 1,
      },
    ],
    fuel: { type: 'AVGAS', unit: 'gal', tanks: [{ id: 'L', name: 'LEFT', capacity: 21.5, x: -1.8 }, { id: 'R', name: 'RIGHT', capacity: 21.5, x: 1.8 }], unusable: 3, selector: ['OFF', 'LEFT', 'BOTH', 'RIGHT'], defaultSelector: 'BOTH' },
    gear: {
      brakeMu: 0.32,
      retractable: false,
      points: [
        { id: 'nose', pos: [0, -1.12, -1.21], steer: true, brake: false, compression: 0.11, damping: 0.55, radius: 0.17 },
        { id: 'left', pos: [-1.27, -1.12, 0.43], steer: false, brake: true, compression: 0.08, damping: 0.6, radius: 0.19 },
        { id: 'right', pos: [1.27, -1.12, 0.43], steer: false, brake: true, compression: 0.08, damping: 0.6, radius: 0.19 },
      ],
      contacts: [
        { id: 'tail', pos: [0, 0.05, 5.6] }, { id: 'prop', pos: [0, -1.0, -2.12] },
        { id: 'ltip', pos: [-5.46, 1.18, 0.2] }, { id: 'rtip', pos: [5.46, 1.18, 0.2] },
        { id: 'belly', pos: [0, -0.5, 0.3] }, { id: 'roof', pos: [0, 1.2, 0.3] },
      ],
    },
    systems: { electricalFlaps: true, flapRateDeg: 3.5, vacuum: true, battery: { volts: 24, ah: 35 }, alternatorAmps: 60, fuelPump: false, carbHeat: true, parkingBrake: true },
    avionics: { com: 2, nav: 2, gps: true, autopilot: 'ga', autothrottle: false, transponder: true, adf: false },
    cockpit: { layout: 'ga', panelColor: '#2d3034', panelEdge: '#3b3f44', label: 'SKYHAWK', engineGauges: 'single', switches: ['batt', 'alt', 'avionics', 'beacon', 'land', 'taxi', 'nav', 'strobe', 'pitot', 'panel'] },
    visual: { model: 'highwing', base: '#f4f4f1', stripe: '#1f3b73', stripe2: '#c19a3d', glass: '#28323c', fairings: true, tailNumber: 'CC-KMR', spinner: 0.17 },
    sound: { kind: 'piston', cylinders: 4, character: 0.9 },
    stallHornMarginDeg: 4,
  };

  /* ======================================================================= Cessna 152 */
  data.c152 = {
    id: 'c152',
    name: 'Cessna 152',
    shortName: 'C152',
    manufacturer: 'Cessna',
    role: 'TRAINER',
    category: 'Single-engine piston',
    difficulty: 1,
    capacity: '2 seats',
    description: 'Two-seat trainer with a 110 hp O-235. Light wing loading: lively in pitch, sensitive to wind and turbulence, short takeoff roll.',
    registration: 'CC-PLV',
    callsign: 'Papa Lima Victor',
    callsignFull: 'Charlie Charlie Papa Lima Victor',
    performance: { vs0: 35, vs1: 40, vr: 50, vx: 55, vy: 67, vfe: 85, vfeFirst: 85, vno: 111, vne: 149, cruise: 107, vapp: 60, vref: 54, ceiling: 14700, climbFpm: 715, rangeNm: 350, taxiKt: 15, bestGlide: 60 },
    pohTargets: { takeoffFlapIdx: 1, rotateKias: 50, stallCleanKcas: 46, stallFullKcas: 43, climbFpmSL: 715, cruiseKtas8000: 107, takeoffRollM: 221, landingRollM: 145, glideRatio: 8.5, staticRPM: [2280, 2380] },
    asiCalibration: [[40, 30], [46, 38], [52, 46], [60, 57], [70, 69], [80, 80], [100, 101], [120, 121], [150, 152]],
    mass: { empty: 512, maxTakeoff: 757, defaultPayload: 150 },
    inertia: { pitch: 1050, yaw: 1580, roll: 820 },
    geometry: { length: 7.34, height: 2.59, span: 10.17, wingArea: 14.86, eye: [-0.25, 0.56, -0.14], wingType: 'high' },
    wing: {
      airfoil: 'naca2412', y0: 0.98, dihedral: 1.0, oswald: 0.8,
      sections: [
        { y: 0, le: -0.3, chord: 1.6, twist: 1.0 },
        { y: 2.2, le: -0.3, chord: 1.6, twist: 0.6 },
        { y: 5.085, le: -0.27, chord: 1.1, twist: -1.0 },
      ],
      bodyHalfWidth: 0.52,
      flap: { y0: 0.52, y1: 2.65, chordFrac: 0.3, kind: 'slotted', gain: 1.8, clmaxShare: 0.68 },
      aileron: { y0: 2.65, y1: 4.85, chordFrac: 0.25, up: 20, down: 14 },
    },
    htail: {
      airfoil: 'naca0012', y0: 0.2, dihedral: 0, eta: 0.92, downwashGain: 1.15,
      sections: [{ y: 0, le: 3.95, chord: 1.07, twist: -2.5 }, { y: 1.525, le: 4.2, chord: 0.71, twist: -2.5 }],
      elevator: { chordFrac: 0.42, up: 25, down: 18 }, trimRange: 7,
    },
    vtail: {
      airfoil: 'naca0012', y0: 0.4,
      sections: [{ h: 0, le: 3.45, chord: 1.75 }, { h: 0.98, le: 4.55, chord: 0.72 }],
      rudder: { chordFrac: 0.45, max: 23 },
    },
    fuselage: {
      sections: [
        [-1.86, 0.56, 0.52, -0.08, 2.2], [-1.66, 0.78, 0.74, -0.04, 2.6], [-1.3, 0.9, 0.86, 0, 3], [-0.98, 0.96, 0.96, 0.05, 3.4],
        [-0.75, 1.0, 1.22, 0.17, 3.6], [-0.35, 1.04, 1.38, 0.23, 3.8], [0.35, 1.04, 1.4, 0.24, 3.8], [1.05, 0.96, 1.3, 0.22, 3.5],
        [1.55, 0.8, 1.04, 0.27, 3], [2.4, 0.58, 0.76, 0.3, 2.6], [3.3, 0.4, 0.54, 0.31, 2.4], [4.2, 0.26, 0.38, 0.31, 2.2],
        [4.95, 0.15, 0.25, 0.31, 2], [5.28, 0.05, 0.09, 0.31, 2],
      ],
      volume: 2.7,
    },
    drag: { fuselage: 0.17, gear: 0.1, struts: 0.03, cooling: 0.055, misc: 0.035 },
    struts: [{ from: [0.48, -0.42, 0.1], to: [2.35, 1.02, 0.1] }],
    aero: {
      flaps: [{ deg: 0, label: 'UP' }, { deg: 10, label: '10°' }, { deg: 20, label: '20°' }, { deg: 30, label: '30°' }],
      interferenceClBeta: -0.03,
    },
    controls: { rate: 3.6, elevatorMax: 1, aileronMax: 1, rudderMax: 1, trimRate: 0.25, steerDeg: 10, steerTaxiDeg: 30 },
    engines: [
      {
        type: 'piston', name: 'Lycoming O-235-L2C', position: [0, -0.06, -1.95], maxPower: 110 * HP, maxRPM: 2550, redline: 2550, idleRPM: 650,
        staticRPM: 2330, staticThrust: 1600, propType: 'fixed', propDiameter: 1.753, propPitchIn: 58, blades: 2, inertia: 1.4,
        cylinders: 4, carb: true, fuelFlowMax: 7, oil: { normalTemp: 80, maxTemp: 118, minPress: 25, maxPress: 100 }, rotation: 1,
      },
    ],
    fuel: { type: 'AVGAS', unit: 'gal', tanks: [{ id: 'L', name: 'LEFT', capacity: 13, x: -1.6 }, { id: 'R', name: 'RIGHT', capacity: 13, x: 1.6 }], unusable: 1.5, selector: ['OFF', 'ON'], defaultSelector: 'ON' },
    gear: {
      brakeMu: 0.3,
      retractable: false,
      points: [
        { id: 'nose', pos: [0, -1.05, -1.17], steer: true, brake: false, compression: 0.1, damping: 0.55, radius: 0.16 },
        { id: 'left', pos: [-1.155, -1.05, 0.3], steer: false, brake: true, compression: 0.07, damping: 0.6, radius: 0.18 },
        { id: 'right', pos: [1.155, -1.05, 0.3], steer: false, brake: true, compression: 0.07, damping: 0.6, radius: 0.18 },
      ],
      contacts: [
        { id: 'tail', pos: [0, 0.03, 5.15] }, { id: 'prop', pos: [0, -0.92, -1.97] },
        { id: 'ltip', pos: [-5.08, 1.1, 0.2] }, { id: 'rtip', pos: [5.08, 1.1, 0.2] },
        { id: 'belly', pos: [0, -0.48, 0.25] }, { id: 'roof', pos: [0, 1.12, 0.25] },
      ],
    },
    systems: { electricalFlaps: true, flapRateDeg: 3.5, vacuum: true, battery: { volts: 24, ah: 25 }, alternatorAmps: 60, fuelPump: false, carbHeat: true, parkingBrake: true },
    avionics: { com: 1, nav: 1, gps: true, autopilot: null, autothrottle: false, transponder: true, adf: false },
    cockpit: { layout: 'ga', panelColor: '#3a3a36', panelEdge: '#4a4a44', label: 'CESSNA 152', engineGauges: 'single', switches: ['batt', 'alt', 'avionics', 'beacon', 'land', 'nav', 'strobe', 'pitot', 'panel'] },
    visual: { model: 'highwing', base: '#f2f0ea', stripe: '#9c2f2a', stripe2: '#3d3d3d', glass: '#2b333a', fairings: false, tailNumber: 'CC-PLV', spinner: 0.15 },
    sound: { kind: 'piston', cylinders: 4, character: 1.1 },
    stallHornMarginDeg: 4,
  };

  /* ======================================================================= Piper PA-28-161 */
  data.pa28 = {
    id: 'pa28',
    name: 'Piper PA-28-161 Warrior II',
    shortName: 'PA-28',
    manufacturer: 'Piper',
    role: 'TRAINER',
    category: 'Single-engine piston',
    difficulty: 2,
    capacity: '4 seats',
    description: 'Low-wing trainer with semi-tapered laminar wing, 7° dihedral and an all-moving stabilator. Strong ground effect in the flare, LEFT/RIGHT tank management with an electric fuel pump.',
    registration: 'CC-AHW',
    callsign: 'Alfa Hotel Whiskey',
    callsignFull: 'Charlie Charlie Alfa Hotel Whiskey',
    performance: { vs0: 44, vs1: 50, vr: 55, vx: 63, vy: 79, vfe: 103, vfeFirst: 103, vno: 126, vne: 160, cruise: 115, vapp: 66, vref: 63, ceiling: 11000, climbFpm: 644, rangeNm: 510, taxiKt: 15, bestGlide: 73 },
    pohTargets: { takeoffFlapIdx: 0, rotateKias: 55, stallCleanKcas: 50, stallFullKcas: 44, climbFpmSL: 644, cruiseKtas8000: 115, takeoffRollM: 297, landingRollM: 180, glideRatio: 9.0, staticRPM: [2300, 2420] },
    asiCalibration: [[44, 40], [50, 46], [60, 58], [70, 69], [80, 80], [100, 100], [130, 131], [160, 161]],
    mass: { empty: 680, maxTakeoff: 1055, defaultPayload: 160 },
    inertia: { pitch: 1700, yaw: 2650, roll: 1250 },
    geometry: { length: 7.25, height: 2.22, span: 10.67, wingArea: 15.8, eye: [-0.27, 0.44, -0.12], wingType: 'low' },
    wing: {
      airfoil: 'naca652415', y0: -0.55, dihedral: 7, oswald: 0.72,
      sections: [
        { y: 0, le: -0.55, chord: 1.6, twist: 2.0 },
        { y: 2.67, le: -0.55, chord: 1.6, twist: 1.6 },
        { y: 5.335, le: -0.42, chord: 1.07, twist: -1.0 },
      ],
      bodyHalfWidth: 0.58,
      flap: { y0: 0.58, y1: 2.65, chordFrac: 0.22, kind: 'plain', gain: 2.1, clmaxShare: 0.85 },
      aileron: { y0: 2.75, y1: 5.1, chordFrac: 0.23, up: 30, down: 15 },
    },
    htail: {
      airfoil: 'naca0012', y0: 0.2, dihedral: 0, eta: 0.9,
      sections: [{ y: 0, le: 4.05, chord: 0.76, twist: 0 }, { y: 1.955, le: 4.05, chord: 0.76, twist: 0 }],
      stabilator: { up: 14, down: 7 }, trimRange: 3.5,
    },
    vtail: {
      airfoil: 'naca0012', y0: 0.44,
      sections: [{ h: 0, le: 2.75, chord: 2.3 }, { h: 0.78, le: 4.2, chord: 0.85 }], // incl. dorsal fillet
      rudder: { chordFrac: 0.42, max: 27 },
    },
    fuselage: {
      sections: [
        [-2.05, 0.6, 0.55, 0.1, 2.2], [-1.85, 0.82, 0.76, 0.1, 2.6], [-1.45, 0.98, 0.92, 0.09, 3], [-1.05, 1.08, 1.02, 0.09, 3.5],
        [-0.75, 1.12, 1.22, 0.14, 4], [-0.35, 1.16, 1.34, 0.18, 4.2], [0.55, 1.16, 1.36, 0.18, 4.2], [1.25, 1.06, 1.22, 0.2, 3.8],
        [1.95, 0.82, 0.96, 0.26, 3.2], [2.85, 0.58, 0.7, 0.3, 2.8], [3.75, 0.38, 0.52, 0.33, 2.4], [4.55, 0.24, 0.36, 0.35, 2.2],
        [5.0, 0.1, 0.16, 0.35, 2],
      ],
      volume: 3.2,
    },
    drag: { fuselage: 0.19, gear: 0.075, struts: 0, cooling: 0.06, misc: 0.045 },
    aero: {
      flaps: [{ deg: 0, label: 'UP' }, { deg: 10, label: '10°' }, { deg: 25, label: '25°' }, { deg: 40, label: '40°' }],
      interferenceClBeta: 0.02,
    },
    controls: { rate: 3.4, elevatorMax: 1, aileronMax: 1, rudderMax: 1, trimRate: 0.26, steerDeg: 10, steerTaxiDeg: 28 },
    engines: [
      {
        type: 'piston', name: 'Lycoming O-320-D3G', position: [0, 0.1, -2.15], maxPower: 160 * HP, maxRPM: 2700, redline: 2700, idleRPM: 650,
        staticRPM: 2360, staticThrust: 2200, propType: 'fixed', propDiameter: 1.88, propPitchIn: 60, blades: 2, inertia: 1.8,
        cylinders: 4, carb: true, fuelFlowMax: 10.5, oil: { normalTemp: 82, maxTemp: 118, minPress: 25, maxPress: 100 }, rotation: 1,
      },
    ],
    fuel: { type: 'AVGAS', unit: 'gal', tanks: [{ id: 'L', name: 'LEFT', capacity: 25, x: -1.7 }, { id: 'R', name: 'RIGHT', capacity: 25, x: 1.7 }], unusable: 2, selector: ['OFF', 'LEFT', 'RIGHT'], defaultSelector: 'LEFT' },
    gear: {
      brakeMu: 0.32,
      retractable: false,
      points: [
        { id: 'nose', pos: [0, -0.98, -1.62], steer: true, brake: false, compression: 0.11, damping: 0.55, radius: 0.17 },
        { id: 'left', pos: [-1.525, -0.98, 0.38], steer: false, brake: true, compression: 0.08, damping: 0.6, radius: 0.19 },
        { id: 'right', pos: [1.525, -0.98, 0.38], steer: false, brake: true, compression: 0.08, damping: 0.6, radius: 0.19 },
      ],
      contacts: [
        { id: 'tail', pos: [0, 0.05, 4.95] }, { id: 'prop', pos: [0, -0.84, -2.17] },
        { id: 'ltip', pos: [-5.335, 0.1, 0.1] }, { id: 'rtip', pos: [5.335, 0.1, 0.1] },
        { id: 'belly', pos: [0, -0.62, 0.2] }, { id: 'roof', pos: [0, 0.88, 0.1] },
      ],
    },
    systems: { electricalFlaps: false, flapRateDeg: 25, vacuum: true, battery: { volts: 12, ah: 35 }, alternatorAmps: 60, fuelPump: true, carbHeat: true, parkingBrake: true, lowVolts: 12 },
    avionics: { com: 2, nav: 2, gps: true, autopilot: 'ga', autothrottle: false, transponder: true, adf: false },
    cockpit: { layout: 'ga', panelColor: '#262a30', panelEdge: '#353b42', label: 'WARRIOR II', engineGauges: 'single', switches: ['batt', 'alt', 'avionics', 'pump', 'beacon', 'land', 'taxi', 'nav', 'strobe', 'pitot', 'panel'] },
    visual: { model: 'lowwing', base: '#f5f5f2', stripe: '#7a1f24', stripe2: '#2b2b2b', glass: '#25303a', fairings: true, tailNumber: 'CC-AHW', spinner: 0.17 },
    sound: { kind: 'piston', cylinders: 4, character: 0.95 },
    stallHornMarginDeg: 4,
  };

  /* ======================================================================= Beechcraft Baron 58 */
  data.be58 = {
    id: 'be58',
    name: 'Beechcraft Baron 58',
    shortName: 'BARON 58',
    manufacturer: 'Beechcraft',
    role: 'TWIN ENGINE',
    category: 'Twin-engine piston',
    difficulty: 3,
    capacity: '6 seats',
    description: 'High-performance twin: two 300 hp IO-550 with constant-speed props, retractable gear, tapered NACA 23000-series wing. An engine failure produces real asymmetric thrust — fly blue line.',
    registration: 'CC-BTN',
    callsign: 'Bravo Tango November',
    callsignFull: 'Charlie Charlie Bravo Tango November',
    performance: { vs0: 75, vs1: 84, vr: 90, vx: 98, vy: 105, vyse: 101, vmc: 84, vfe: 122, vfeFirst: 152, vle: 152, vno: 195, vne: 223, cruise: 200, vapp: 100, vref: 95, ceiling: 20000, climbFpm: 1700, rangeNm: 1000, taxiKt: 18, bestGlide: 110 },
    pohTargets: { takeoffFlapIdx: 0, rotateKias: 90, stallCleanKcas: 84, stallFullKcas: 75, climbFpmSL: 1700, cruiseKtas8000: 200, takeoffRollM: 430, landingRollM: 440, glideRatio: 11, staticRPM: [2650, 2700] },
    asiCalibration: [[70, 68], [84, 83], [100, 100], [150, 151], [200, 201], [230, 232]],
    mass: { empty: 1580, maxTakeoff: 2495, defaultPayload: 240 },
    inertia: { pitch: 6200, yaw: 10600, roll: 5600 },
    geometry: { length: 9.09, height: 2.97, span: 11.53, wingArea: 18.5, eye: [-0.3, 0.62, -1.0], wingType: 'low' },
    wing: {
      airfoil: 'naca23016', y0: -0.48, dihedral: 6, oswald: 0.7,
      sections: [
        { y: 0, le: -0.65, chord: 2.0, twist: 3.0 },
        { y: 1.7, le: -0.65, chord: 2.0, twist: 2.6 },
        { y: 5.765, le: -0.32, chord: 0.95, twist: -0.5 },
      ],
      bodyHalfWidth: 0.66,
      flap: { y0: 0.66, y1: 3.35, chordFrac: 0.25, kind: 'slotted', gain: 1.85, clmaxShare: 0.68 },
      aileron: { y0: 3.45, y1: 5.55, chordFrac: 0.24, up: 20, down: 15 },
    },
    htail: {
      airfoil: 'naca0012', y0: 0.38, dihedral: 0, eta: 0.95,
      sections: [{ y: 0, le: 4.45, chord: 1.25, twist: 0 }, { y: 2.425, le: 4.78, chord: 0.8, twist: 0 }],
      elevator: { chordFrac: 0.4, up: 20, down: 14 }, trimRange: 6,
    },
    vtail: {
      airfoil: 'naca0012', y0: 0.66,
      sections: [{ h: 0, le: 3.3, chord: 2.6 }, { h: 0.98, le: 4.9, chord: 1.05 }], // incl. dorsal fillet
      rudder: { chordFrac: 0.42, max: 25 },
    },
    fuselage: {
      sections: [
        [-3.45, 0.08, 0.08, -0.05, 2], [-3.25, 0.55, 0.5, -0.05, 2.2], [-2.6, 0.95, 0.85, 0, 2.6], [-1.9, 1.18, 1.08, 0.08, 3],
        [-1.25, 1.26, 1.32, 0.2, 3.5], [-0.6, 1.3, 1.48, 0.26, 3.8], [0.8, 1.3, 1.5, 0.27, 3.8], [1.9, 1.18, 1.34, 0.25, 3.4],
        [2.9, 0.86, 1.0, 0.3, 3], [3.9, 0.58, 0.7, 0.36, 2.6], [4.9, 0.36, 0.48, 0.42, 2.4], [5.55, 0.2, 0.3, 0.45, 2], [5.75, 0.07, 0.1, 0.45, 2],
      ],
      volume: 5.2,
    },
    nacelles: [{ x: -2.0, y: -0.2, z0: -2.05, z1: 1.3, w: 0.74, h: 0.78 }, { x: 2.0, y: -0.2, z0: -2.05, z1: 1.3, w: 0.74, h: 0.78 }],
    drag: { fuselage: 0.11, gear: 0.3, gearRetractable: true, nacelles: 0.09, cooling: 0.04, misc: 0.03 },
    aero: {
      flaps: [{ deg: 0, label: 'UP' }, { deg: 15, label: 'APPR' }, { deg: 30, label: 'DN' }],
      interferenceClBeta: 0.015,
    },
    controls: { rate: 2.8, elevatorMax: 1, aileronMax: 1, rudderMax: 1, trimRate: 0.18, steerDeg: 10, steerTaxiDeg: 26 },
    engines: [
      {
        type: 'piston', name: 'Continental IO-550-C (L)', position: [-2.0, -0.12, -2.12], maxPower: 300 * HP, maxRPM: 2700, redline: 2700, idleRPM: 700,
        staticRPM: 2690, staticThrust: 4100, propType: 'constant', featherable: true, propDiameter: 2.03, propPitchIn: 80, blades: 3, inertia: 3.2, minGovRPM: 2000,
        cylinders: 6, carb: false, fuelFlowMax: 26, oil: { normalTemp: 85, maxTemp: 116, minPress: 30, maxPress: 100 }, rotation: 1,
      },
      {
        type: 'piston', name: 'Continental IO-550-C (R)', position: [2.0, -0.12, -2.12], maxPower: 300 * HP, maxRPM: 2700, redline: 2700, idleRPM: 700,
        staticRPM: 2690, staticThrust: 4100, propType: 'constant', featherable: true, propDiameter: 2.03, propPitchIn: 80, blades: 3, inertia: 3.2, minGovRPM: 2000,
        cylinders: 6, carb: false, fuelFlowMax: 26, oil: { normalTemp: 85, maxTemp: 116, minPress: 30, maxPress: 100 }, rotation: 1,
      },
    ],
    fuel: { type: 'AVGAS', unit: 'gal', tanks: [{ id: 'L', name: 'LEFT', capacity: 68, x: -2.5 }, { id: 'R', name: 'RIGHT', capacity: 68, x: 2.5 }], unusable: 2, selector: ['OFF', 'ON'], defaultSelector: 'ON', perEngine: true },
    gear: {
      brakeMu: 0.4,
      retractable: true,
      transitTime: 6,
      points: [
        { id: 'nose', pos: [0, -1.3, -2.3], steer: true, brake: false, compression: 0.12, damping: 0.55, radius: 0.2 },
        { id: 'left', pos: [-1.46, -1.3, 0.42], steer: false, brake: true, compression: 0.1, damping: 0.6, radius: 0.24 },
        { id: 'right', pos: [1.46, -1.3, 0.42], steer: false, brake: true, compression: 0.1, damping: 0.6, radius: 0.24 },
      ],
      contacts: [
        { id: 'tail', pos: [0, -0.1, 5.7] }, { id: 'lprop', pos: [-2.0, -1.14, -2.14] }, { id: 'rprop', pos: [2.0, -1.14, -2.14] },
        { id: 'ltip', pos: [-5.765, 0.12, 0.0] }, { id: 'rtip', pos: [5.765, 0.12, 0.0] },
        { id: 'belly', pos: [0, -0.5, 0.0] }, { id: 'roof', pos: [0, 1.02, -0.2] },
      ],
    },
    systems: { electricalFlaps: true, flapRateDeg: 3.5, vacuum: true, battery: { volts: 24, ah: 35 }, alternatorAmps: 100, fuelPump: true, carbHeat: false, parkingBrake: true, gearWarning: true },
    avionics: { com: 2, nav: 2, gps: true, autopilot: 'ga', autothrottle: false, transponder: true, adf: false },
    cockpit: { layout: 'ga-twin', panelColor: '#1f2328', panelEdge: '#2e333a', label: 'BARON 58', engineGauges: 'twin', switches: ['batt', 'alt', 'avionics', 'pump', 'beacon', 'land', 'taxi', 'nav', 'strobe', 'pitot', 'panel'] },
    visual: { model: 'twin', base: '#f6f6f4', stripe: '#24456e', stripe2: '#8b96a3', glass: '#1d2731', fairings: false, tailNumber: 'CC-BTN', spinner: 0.19 },
    sound: { kind: 'piston', cylinders: 6, character: 0.8 },
    stallHornMarginDeg: 4,
  };

  /* ======================================================================= Boeing 737-800 */
  data.b738 = {
    id: 'b738',
    name: 'Boeing 737-800',
    shortName: 'B737',
    manufacturer: 'Boeing',
    role: 'AIRLINER',
    category: 'Twin-engine jet',
    difficulty: 4,
    capacity: '162–189 pax',
    description: '737-800 with blended winglets: 25° swept supercritical wing, leading-edge slats, double-slotted flaps, moving-stabiliser trim, speed brakes, reversers and slow-spooling CFM56-7B turbofans.',
    registration: 'CC-CDR',
    callsign: 'Condor Five One Two',
    callsignFull: 'Condor Five One Two',
    flightNumber: 'CDR512',
    performance: { vs0: 108, vs1: 140, vr: 145, vx: 160, vy: 220, vfe: 162, vfeFirst: 250, vle: 270, vno: 340, vne: 340, mmo: 0.82, cruise: 450, vapp: 145, vref: 140, ceiling: 41000, climbFpm: 2500, rangeNm: 2900, taxiKt: 20, bestGlide: 220 },
    // 65 t reference weight; takeoff flaps 5 at full rated thrust, landing flaps 40 with max manual braking,
    // speed brakes and reversers; climb at 220 KIAS with climb thrust (≈93 % N1)
    pohTargets: { massKg: 65000, takeoffFlapIdx: 3, rotateKias: 145, stallCleanKcas: 150, stallFullKcas: 112, climbFpmSL: 3800, climbThrottle: 0.9, cruiseKtas8000: 300, takeoffRollM: 1300, landingRollM: 700, glideRatio: 17 },
    asiCalibration: [[100, 100], [300, 300], [400, 400]],
    mass: { empty: 41400, maxTakeoff: 79000, defaultPayload: 13000 },
    inertia: { pitch: 3.1e6, yaw: 4.0e6, roll: 1.25e6 },
    geometry: { length: 39.47, height: 12.55, span: 35.79, wingArea: 124.6, eye: [-0.55, 1.15, -17.3], wingType: 'low' },
    wing: {
      airfoil: 'bac737', y0: -1.35, dihedral: 6, oswald: 0.82, sweepC4: 25,
      sections: [
        { y: 0, le: -4.35, chord: 6.75, twist: 4.0 },
        { y: 1.9, le: -3.38, chord: 6.35, twist: 3.5 },
        { y: 6.0, le: -1.3, chord: 3.95, twist: 1.5 },
        { y: 17.15, le: 4.38, chord: 1.25, twist: -1.5 },
      ],
      bodyHalfWidth: 1.88,
      winglet: { height: 2.44, cant: 20, rootChord: 1.25, tipChord: 0.6, sweep: 1.3 },
      flap: { y0: 1.9, y1: 12.6, chordFrac: 0.3, kind: 'doubleSlotted', gain: 2.4, clmaxShare: 0.85, fowler: 0.22 },
      slats: { alphaGain: 7 },
      aileron: { y0: 12.8, y1: 16.3, chordFrac: 0.24, up: 20, down: 15 },
    },
    htail: {
      airfoil: 'naca0009', y0: 1.0, dihedral: 7, eta: 0.92,
      sections: [{ y: 0, le: 14.6, chord: 3.9, twist: 0 }, { y: 7.175, le: 18.6, chord: 1.2, twist: 0 }],
      elevator: { chordFrac: 0.3, up: 22, down: 15 }, trimRange: 8, movingStab: true,
    },
    vtail: {
      airfoil: 'naca0009', y0: 1.95,
      sections: [{ h: 0, le: 12.6, chord: 6.0 }, { h: 7.2, le: 18.1, chord: 2.1 }],
      rudder: { chordFrac: 0.32, max: 20 },
    },
    fuselage: {
      sections: [
        [-19.75, 0.08, 0.08, -0.3, 2], [-19.4, 1.3, 1.25, -0.25, 2], [-18.6, 2.5, 2.45, -0.1, 2], [-17.5, 3.3, 3.4, 0.02, 2],
        [-16.0, 3.76, 3.95, 0.1, 2], [9.6, 3.76, 3.95, 0.1, 2], [13.0, 3.3, 3.2, 0.45, 2], [16.2, 2.3, 2.2, 0.95, 2],
        [18.6, 1.05, 1.1, 1.45, 2], [19.7, 0.3, 0.4, 1.65, 2],
      ],
      volume: 380,
    },
    nacelles: [{ x: -4.95, y: -1.65, z0: -6.0, z1: -1.7, w: 2.06, h: 1.96, jet: true }, { x: 4.95, y: -1.65, z0: -6.0, z1: -1.7, w: 2.06, h: 1.96, jet: true }],
    drag: { fuselage: 0.95, gear: 2.2, gearRetractable: true, nacelles: 0.32, cooling: 0, misc: 0.12, speedbrake: 3.6 },
    aero: {
      flaps: [
        { deg: 0, label: 'UP' }, { deg: 1, label: '1' }, { deg: 2, label: '2' }, { deg: 5, label: '5' }, { deg: 10, label: '10' },
        { deg: 15, label: '15' }, { deg: 25, label: '25' }, { deg: 30, label: '30' }, { deg: 40, label: '40' },
      ],
      flapSpeeds: [999, 250, 250, 250, 210, 200, 190, 175, 162],
      interferenceClBeta: 0.01,
      machCrit: 0.76,
      speedbrakeLiftLoss: 0.35,
    },
    controls: { rate: 2.2, elevatorMax: 1, aileronMax: 1, rudderMax: 1, trimRate: 0.08, steerDeg: 7, steerTaxiDeg: 60 },
    engines: [
      { type: 'turbofan', name: 'CFM56-7B26 (1)', position: [-4.95, -1.65, -5.4], maxThrust: 117000, idleN1: 21, idleN2: 60, spoolUp: 4.5, fuelFlowIdle: 360, fuelFlowMax: 3400, egtMax: 950, reverseMax: 0.32 },
      { type: 'turbofan', name: 'CFM56-7B26 (2)', position: [4.95, -1.65, -5.4], maxThrust: 117000, idleN1: 21, idleN2: 60, spoolUp: 4.5, fuelFlowIdle: 360, fuelFlowMax: 3400, egtMax: 950, reverseMax: 0.32 },
    ],
    fuel: { type: 'JET-A', unit: 'kg', tanks: [{ id: 'L', name: 'TANK 1', capacity: 3900, x: -6 }, { id: 'C', name: 'CENTER', capacity: 13000, x: 0 }, { id: 'R', name: 'TANK 2', capacity: 3900, x: 6 }], unusable: 50, selector: ['AUTO'], defaultSelector: 'AUTO', perEngine: false },
    gear: {
      brakeMu: 0.5,
      retractable: true,
      transitTime: 8,
      points: [
        { id: 'nose', pos: [0, -3.08, -14.35], steer: true, brake: false, compression: 0.2, damping: 0.6, radius: 0.36 },
        { id: 'left', pos: [-2.86, -3.08, 1.25], steer: false, brake: true, compression: 0.25, damping: 0.65, radius: 0.56 },
        { id: 'right', pos: [2.86, -3.08, 1.25], steer: false, brake: true, compression: 0.25, damping: 0.65, radius: 0.56 },
      ],
      contacts: [
        { id: 'tail', pos: [0, -0.2, 16.0] }, { id: 'leng', pos: [-4.95, -2.62, -3.6] }, { id: 'reng', pos: [4.95, -2.62, -3.6] },
        { id: 'ltip', pos: [-17.15, 0.45, 5.0] }, { id: 'rtip', pos: [17.15, 0.45, 5.0] },
        { id: 'belly', pos: [0, -1.88, -2] }, { id: 'nosecone', pos: [0, -0.3, -19.75] }, { id: 'roof', pos: [0, 2.1, 0] },
      ],
    },
    systems: { electricalFlaps: false, flapRateDeg: 2.2, vacuum: false, battery: { volts: 24, ah: 48 }, alternatorAmps: 400, fuelPump: false, carbHeat: false, parkingBrake: true, speedbrake: true, reversers: true, gearWarning: true, hydraulic: true },
    avionics: { com: 2, nav: 2, gps: true, autopilot: 'mcp', autothrottle: true, transponder: true, adf: false },
    cockpit: { layout: 'airliner', panelColor: '#4a5560', panelEdge: '#5b6672', label: '737-800', engineGauges: 'jet', switches: ['batt', 'gen', 'avionics', 'beacon', 'land', 'taxi', 'nav', 'strobe', 'logo', 'pitot', 'panel'] },
    visual: { model: 'airliner', base: '#f3f4f6', stripe: '#1c3557', stripe2: '#c8a24a', glass: '#151b22', tailNumber: 'CC-CDR', airline: 'CÓNDOR' },
    sound: { kind: 'jet' },
    stallHornMarginDeg: 2.5,
  };

  /* ---------------------------------------------------------------- derived values */
  // Mean aerodynamic chord and reference chord for every aircraft (from the wing sections).
  Object.values(data).forEach((a) => {
    const s = a.wing.sections;
    let area = 0, cBar = 0;
    for (let i = 0; i < s.length - 1; i++) {
      const dy = s[i + 1].y - s[i].y;
      const c0 = s[i].chord, c1 = s[i + 1].chord;
      area += dy * (c0 + c1) / 2;
      cBar += dy * (c0 * c0 + c0 * c1 + c1 * c1) / 3;
    }
    a.geometry.chord = cBar / area;
    a.geometry.wingAreaGeo = area * 2;
  });

  SIM.AircraftOrder = ['c172', 'c152', 'pa28', 'be58', 'b738'];
  SIM.AircraftData = data;
  SIM.Airfoils = AIRFOILS;

  /** Freezes nested config so systems cannot mutate shared data by accident. */
  function deepFreeze(o) {
    Object.values(o).forEach((v) => v && typeof v === 'object' && deepFreeze(v));
    return Object.freeze(o);
  }
  Object.values(data).forEach(deepFreeze);
  deepFreeze(AIRFOILS);
})(window.SIM);
