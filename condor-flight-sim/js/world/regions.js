/**
 * Region definitions. A region is a self-contained flyable area with its own projection origin,
 * coastline, mountain ridges, basins, cities, roads, start locations and airports.
 *
 * Geography is a stylised approximation built from real coordinates (lat, lon) — convincing for
 * VFR flying, NOT suitable for real-world navigation.
 */
(function (SIM) {
  'use strict';

  const regions = {};

  /* ======================================================================= CHILE */
  regions.chile = {
    id: 'chile',
    name: 'Chile — Zona Central',
    country: 'CHILE',
    description: 'Santiago basin, the Andes, the coastal range, Curacaví, Valparaíso, Viña del Mar and across the Andes to Mendoza.',
    origin: [-33.393, -70.7858],
    magVar: 1,
    hemisphere: 'S',
    bounds: { latMin: -34.25, latMax: -32.15, lonMin: -72.05, lonMax: -68.55 },
    climate: { baseTempC: 22, humidity: 0.45 },
    // Pacific coastline, north -> south. Ocean lies to the west.
    coast: [
      [-32.10, -71.52], [-32.40, -71.44], [-32.52, -71.46], [-32.62, -71.44], [-32.74, -71.50], [-32.78, -71.555],
      [-32.86, -71.52], [-32.93, -71.535], [-33.00, -71.555], [-33.03, -71.60], [-33.05, -71.645], [-33.10, -71.675],
      [-33.20, -71.70], [-33.30, -71.69], [-33.37, -71.68], [-33.48, -71.64], [-33.56, -71.615], [-33.65, -71.635],
      [-33.80, -71.74], [-33.93, -71.83], [-34.10, -71.93], [-34.30, -72.02],
    ],
    water: [],
    base: { inland: 230, inlandDist: 26000, terrace: 120, terraceDist: 2500, east: { lonStart: -69.75, lonEnd: -69.3, height: 620 } },
    ridges: [
      { name: 'Andes (main range)', height: 3700, width: 42000, rug: 1, pts: [[-32.0, -70.15], [-32.65, -70.02], [-33.0, -69.95], [-33.4, -69.84], [-33.8, -69.9], [-34.3, -70.02]] },
      { name: 'Precordillera de Santiago', height: 2100, width: 16000, rug: 0.85, pts: [[-32.85, -70.45], [-33.15, -70.36], [-33.45, -70.37], [-33.75, -70.42], [-34.1, -70.45]] },
      { name: 'Precordillera de Mendoza', height: 1600, width: 15000, rug: 0.7, pts: [[-32.2, -69.2], [-32.6, -69.15], [-33.0, -69.17], [-33.5, -69.3]] },
      { name: 'Cordón de Chacabuco', height: 1150, width: 9000, rug: 0.7, pts: [[-33.08, -71.0], [-33.06, -70.8], [-33.03, -70.6], [-32.98, -70.48]] },
      { name: 'Altos de Lo Prado', height: 880, width: 7000, rug: 0.65, pts: [[-33.15, -70.95], [-33.32, -70.94], [-33.48, -70.96], [-33.7, -70.99]] },
      { name: 'Cordillera de la Costa', height: 900, width: 12000, rug: 0.6, pts: [[-32.4, -71.3], [-32.75, -71.27], [-33.05, -71.27], [-33.3, -71.3], [-33.6, -71.36], [-34.0, -71.45]] },
      { name: 'La Campana massif', height: 900, width: 9000, rug: 0.75, pts: [[-32.85, -71.15], [-32.97, -71.1], [-33.08, -71.05]] },
      { name: 'Angostura de Paine', height: 600, width: 7000, rug: 0.5, pts: [[-33.86, -70.95], [-33.84, -70.75], [-33.86, -70.55]] },
    ],
    peaks: [
      { name: 'Aconcagua', lat: -32.653, lon: -70.011, h: 2600, r: 9000 },
      { name: 'Tupungato', lat: -33.358, lon: -69.77, h: 2200, r: 8000 },
      { name: 'Cerro El Plomo', lat: -33.235, lon: -70.214, h: 1500, r: 6000 },
      { name: 'Volcán San José', lat: -33.787, lon: -69.897, h: 1700, r: 6500 },
      { name: 'Cerro La Campana', lat: -32.955, lon: -71.118, h: 700, r: 3500 },
      { name: 'Cerro Manquehue', lat: -33.354, lon: -70.581, h: 950, r: 2600 },
      { name: 'Cerro San Cristóbal', lat: -33.425, lon: -70.633, h: 330, r: 1300 },
      { name: 'Cerro Renca', lat: -33.392, lon: -70.712, h: 380, r: 1500 },
      { name: 'Cerro Chena', lat: -33.61, lon: -70.73, h: 280, r: 1500 },
    ],
    basins: [
      { name: 'Santiago basin', lat: -33.47, lon: -70.69, r: 27000, h: 478, tiltEast: 7.0 },
      { name: 'Curacaví valley', lat: -33.405, lon: -71.135, r: 6500, h: 195, tiltEast: 3 },
      { name: 'Casablanca valley', lat: -33.31, lon: -71.41, r: 8000, h: 235, tiltEast: 0 },
      { name: 'Aconcagua valley', lat: -32.86, lon: -71.2, r: 9000, h: 140, tiltEast: 9 },
      { name: 'Los Andes valley', lat: -32.84, lon: -70.6, r: 7500, h: 820, tiltEast: 0 },
      { name: 'Talagante valley', lat: -33.66, lon: -70.95, r: 9000, h: 330, tiltEast: 6 },
      { name: 'Mendoza plain', lat: -32.9, lon: -68.8, r: 26000, h: 720, tiltEast: -4 },
      { name: 'Melipilla valley', lat: -33.69, lon: -71.2, r: 8000, h: 175, tiltEast: 4 },
    ],
    cities: [
      { name: 'Santiago', lat: -33.45, lon: -70.655, r: 13500, density: 1.0, maxH: 140, core: { lat: -33.418, lon: -70.6, r: 2600, maxH: 230 } },
      { name: 'Maipú', lat: -33.51, lon: -70.76, r: 5000, density: 0.85, maxH: 45 },
      { name: 'Puente Alto', lat: -33.61, lon: -70.58, r: 5200, density: 0.8, maxH: 40 },
      { name: 'Quilicura', lat: -33.36, lon: -70.73, r: 3200, density: 0.7, maxH: 30 },
      { name: 'Valparaíso', lat: -33.045, lon: -71.615, r: 4200, density: 0.9, maxH: 60 },
      { name: 'Viña del Mar', lat: -33.02, lon: -71.545, r: 4200, density: 0.95, maxH: 95 },
      { name: 'Quilpué – Villa Alemana', lat: -33.05, lon: -71.4, r: 4800, density: 0.7, maxH: 30 },
      { name: 'Concón', lat: -32.93, lon: -71.515, r: 2300, density: 0.65, maxH: 70 },
      { name: 'Quintero', lat: -32.785, lon: -71.535, r: 1600, density: 0.6, maxH: 18 },
      { name: 'Curacaví', lat: -33.403, lon: -71.137, r: 1500, density: 0.55, maxH: 14 },
      { name: 'Casablanca', lat: -33.32, lon: -71.41, r: 1500, density: 0.55, maxH: 14 },
      { name: 'San Antonio', lat: -33.59, lon: -71.6, r: 3200, density: 0.7, maxH: 30 },
      { name: 'Talagante', lat: -33.665, lon: -70.93, r: 2200, density: 0.6, maxH: 18 },
      { name: 'Melipilla', lat: -33.69, lon: -71.215, r: 2400, density: 0.6, maxH: 18 },
      { name: 'Colina', lat: -33.2, lon: -70.675, r: 2600, density: 0.55, maxH: 18 },
      { name: 'Los Andes', lat: -32.833, lon: -70.6, r: 2600, density: 0.6, maxH: 20 },
      { name: 'Quillota', lat: -32.88, lon: -71.25, r: 2600, density: 0.6, maxH: 20 },
      { name: 'Mendoza', lat: -32.89, lon: -68.84, r: 8000, density: 0.85, maxH: 70 },
    ],
    landmarks: [
      { name: 'Gran Torre Santiago', lat: -33.4172, lon: -70.6065, height: 300, width: 48, kind: 'tower' },
      { name: 'Torre Entel', lat: -33.4445, lon: -70.6575, height: 127, width: 14, kind: 'mast' },
    ],
    roads: [
      { name: 'Ruta 68', type: 'highway', pts: [[-33.45, -70.66], [-33.445, -70.74], [-33.44, -70.84], [-33.43, -70.93], [-33.405, -71.05], [-33.40, -71.14], [-33.375, -71.25], [-33.32, -71.41], [-33.22, -71.5], [-33.12, -71.56], [-33.05, -71.6]] },
      { name: 'Ruta 5 Norte', type: 'highway', pts: [[-33.45, -70.66], [-33.36, -70.69], [-33.2, -70.7], [-33.06, -70.79], [-32.95, -70.95], [-32.83, -71.15], [-32.78, -71.22], [-32.55, -71.3], [-32.15, -71.45]] },
      { name: 'Ruta 5 Sur', type: 'highway', pts: [[-33.45, -70.66], [-33.55, -70.69], [-33.68, -70.72], [-33.85, -70.74], [-34.0, -70.74], [-34.22, -70.74]] },
      { name: 'Ruta 78', type: 'highway', pts: [[-33.47, -70.7], [-33.52, -70.78], [-33.6, -70.86], [-33.665, -70.93], [-33.69, -71.06], [-33.69, -71.21], [-33.64, -71.4], [-33.59, -71.6]] },
      { name: 'Ruta 57 / 60 / RN7', type: 'highway', pts: [[-33.36, -70.69], [-33.2, -70.66], [-33.0, -70.65], [-32.84, -70.6], [-32.82, -70.4], [-32.82, -70.12], [-32.78, -69.85], [-32.6, -69.4], [-32.75, -69.1], [-32.89, -68.85]] },
      { name: 'Ruta 60 CH', type: 'road', pts: [[-33.02, -71.55], [-33.05, -71.4], [-32.95, -71.3], [-32.88, -71.25], [-32.79, -71.2], [-32.84, -70.95], [-32.84, -70.6]] },
      { name: 'Camino costero', type: 'road', pts: [[-33.02, -71.555], [-32.95, -71.53], [-32.88, -71.52], [-32.785, -71.53], [-32.7, -71.47], [-32.52, -71.44]] },
      { name: 'Ruta F-90 / Algarrobo', type: 'road', pts: [[-33.32, -71.41], [-33.36, -71.55], [-33.36, -71.67]] },
      { name: 'Américo Vespucio', type: 'road', loop: true, pts: [[-33.37, -70.72], [-33.38, -70.6], [-33.43, -70.55], [-33.52, -70.56], [-33.56, -70.63], [-33.53, -70.73], [-33.46, -70.76]] },
      { name: 'Costanera Norte', type: 'road', pts: [[-33.39, -70.78], [-33.415, -70.68], [-33.42, -70.62], [-33.395, -70.55]] },
    ],
    locations: [
      { id: 'santiago', name: 'Santiago', lat: -33.44, lon: -70.66, altFt: 4500, hdg: 270, desc: 'Over downtown Santiago, westbound.' },
      { id: 'maipu', name: 'Maipú', lat: -33.51, lon: -70.76, altFt: 3500, hdg: 0, desc: 'Southwest Santiago, near Templo Votivo.' },
      { id: 'cordillera', name: 'Cordillera de los Andes', lat: -33.3, lon: -70.25, altFt: 13500, hdg: 90, desc: 'Above the high Andes near El Plomo.' },
      { id: 'curacavi', name: 'Curacaví', lat: -33.40, lon: -71.05, altFt: 3500, hdg: 270, desc: 'Ruta 68 corridor between the coastal ranges.' },
      { id: 'valparaiso', name: 'Valparaíso', lat: -33.08, lon: -71.55, altFt: 2500, hdg: 315, desc: 'Approaching the port city from the southeast.' },
      { id: 'vina', name: 'Viña del Mar', lat: -32.98, lon: -71.62, altFt: 1500, hdg: 180, desc: 'Along the beaches of Viña del Mar.' },
      { id: 'costa', name: 'Costa central', lat: -33.35, lon: -71.75, altFt: 2000, hdg: 0, desc: 'Off the coast of Algarrobo, northbound.' },
      { id: 'mendoza', name: 'Mendoza (Argentina)', lat: -32.95, lon: -69.2, altFt: 9000, hdg: 90, desc: 'East of the Andes descending to Mendoza.' },
    ],
    airports: ['SCEL', 'SCTB', 'SCBQ', 'SCCV', 'SCVM', 'SCQN', 'SCSN', 'SAME'],
    defaultAirport: 'SCEL',
  };

  /* ======================================================================= SAN FRANCISCO BAY */
  regions.sfbay = {
    id: 'sfbay',
    name: 'San Francisco Bay Area',
    country: 'USA',
    description: 'International example: San Francisco Bay, the Peninsula hills and four airports including KSFO and KOAK.',
    origin: [37.6189, -122.375],
    magVar: 13,
    hemisphere: 'N',
    bounds: { latMin: 37.05, latMax: 38.2, lonMin: -123.1, lonMax: -121.6 },
    climate: { baseTempC: 17, humidity: 0.7 },
    coast: [
      [38.25, -123.05], [38.0, -123.0], [37.92, -122.73], [37.86, -122.6], [37.81, -122.52], [37.78, -122.512],
      [37.7, -122.502], [37.6, -122.5], [37.5, -122.49], [37.4, -122.42], [37.25, -122.41], [37.1, -122.3], [36.95, -122.1],
    ],
    // San Francisco Bay and San Pablo Bay
    water: [[
      [37.81, -122.478], [37.83, -122.47], [37.87, -122.47], [37.92, -122.43], [37.96, -122.42], [38.03, -122.42], [38.08, -122.35],
      [38.08, -122.25], [38.04, -122.2], [37.98, -122.32], [37.92, -122.33], [37.87, -122.31], [37.82, -122.3], [37.79, -122.285],
      [37.76, -122.255], [37.72, -122.21], [37.66, -122.17], [37.6, -122.14], [37.53, -122.08], [37.47, -122.02], [37.44, -122.06],
      [37.46, -122.12], [37.5, -122.2], [37.55, -122.24], [37.585, -122.29], [37.625, -122.365], [37.66, -122.375], [37.71, -122.385],
      [37.75, -122.38], [37.79, -122.385], [37.808, -122.41], [37.808, -122.45],
    ]],
    base: { inland: 60, inlandDist: 15000, terrace: 25, terraceDist: 1500 },
    ridges: [
      { name: 'Santa Cruz Mountains', height: 620, width: 7000, rug: 0.7, pts: [[37.72, -122.47], [37.6, -122.43], [37.45, -122.33], [37.3, -122.16], [37.1, -121.95]] },
      { name: 'Berkeley Hills', height: 450, width: 4500, rug: 0.6, pts: [[37.98, -122.27], [37.88, -122.23], [37.78, -122.15], [37.65, -122.03], [37.5, -121.9]] },
      { name: 'Diablo Range', height: 700, width: 14000, rug: 0.6, pts: [[37.85, -121.75], [37.6, -121.7], [37.35, -121.6]] },
      { name: 'Marin Hills', height: 380, width: 6000, rug: 0.6, pts: [[37.85, -122.53], [37.95, -122.6], [38.05, -122.68]] },
    ],
    peaks: [
      { name: 'Mount Diablo', lat: 37.882, lon: -121.914, h: 900, r: 6000 },
      { name: 'Mount Tamalpais', lat: 37.923, lon: -122.597, h: 480, r: 3500 },
      { name: 'San Bruno Mountain', lat: 37.688, lon: -122.434, h: 300, r: 2000 },
      { name: 'Twin Peaks', lat: 37.752, lon: -122.447, h: 220, r: 1200 },
    ],
    basins: [
      { name: 'Santa Clara Valley', lat: 37.36, lon: -121.95, r: 16000, h: 25, tiltEast: 1 },
    ],
    cities: [
      { name: 'San Francisco', lat: 37.765, lon: -122.44, r: 5800, density: 1, maxH: 60, core: { lat: 37.792, lon: -122.4, r: 1300, maxH: 250 } },
      { name: 'Oakland', lat: 37.8, lon: -122.25, r: 5000, density: 0.85, maxH: 45, core: { lat: 37.805, lon: -122.27, r: 800, maxH: 120 } },
      { name: 'Berkeley', lat: 37.87, lon: -122.28, r: 3000, density: 0.75, maxH: 25 },
      { name: 'San Mateo', lat: 37.56, lon: -122.31, r: 4000, density: 0.75, maxH: 25 },
      { name: 'Palo Alto', lat: 37.44, lon: -122.15, r: 4500, density: 0.7, maxH: 25 },
      { name: 'San Jose', lat: 37.34, lon: -121.89, r: 10000, density: 0.85, maxH: 40, core: { lat: 37.335, lon: -121.89, r: 900, maxH: 90 } },
      { name: 'Hayward', lat: 37.66, lon: -122.08, r: 5000, density: 0.75, maxH: 22 },
      { name: 'Fremont', lat: 37.55, lon: -121.98, r: 5000, density: 0.7, maxH: 20 },
      { name: 'Richmond', lat: 37.94, lon: -122.35, r: 3500, density: 0.7, maxH: 20 },
      { name: 'Half Moon Bay', lat: 37.46, lon: -122.43, r: 1600, density: 0.5, maxH: 12 },
    ],
    landmarks: [
      { name: 'Salesforce Tower', lat: 37.7897, lon: -122.3972, height: 326, width: 36, kind: 'tower' },
      { name: 'Sutro Tower', lat: 37.7552, lon: -122.4528, height: 298, width: 10, kind: 'mast' },
    ],
    roads: [
      { name: 'US-101', type: 'highway', pts: [[37.8, -122.405], [37.74, -122.405], [37.66, -122.4], [37.6, -122.36], [37.55, -122.3], [37.48, -122.21], [37.42, -122.1], [37.37, -121.95], [37.3, -121.85]] },
      { name: 'I-280', type: 'highway', pts: [[37.77, -122.4], [37.7, -122.47], [37.6, -122.44], [37.47, -122.3], [37.37, -122.08], [37.32, -121.92]] },
      { name: 'I-880', type: 'highway', pts: [[37.81, -122.29], [37.75, -122.22], [37.66, -122.13], [37.55, -122.03], [37.43, -121.92], [37.35, -121.9]] },
      { name: 'Bay Bridge', type: 'highway', bridge: true, pts: [[37.788, -122.392], [37.81, -122.36], [37.82, -122.32], [37.83, -122.29]] },
      { name: 'San Mateo Bridge', type: 'highway', bridge: true, pts: [[37.58, -122.27], [37.59, -122.2], [37.61, -122.12]] },
      { name: 'Golden Gate', type: 'highway', bridge: true, pts: [[37.805, -122.47], [37.82, -122.478], [37.835, -122.48], [37.86, -122.49]] },
      { name: 'CA-1', type: 'road', pts: [[37.7, -122.49], [37.6, -122.49], [37.5, -122.47], [37.4, -122.41]] },
    ],
    locations: [
      { id: 'goldengate', name: 'Golden Gate', lat: 37.8, lon: -122.55, altFt: 1500, hdg: 90, desc: 'Inbound over the Golden Gate.' },
      { id: 'downtown', name: 'Downtown San Francisco', lat: 37.79, lon: -122.36, altFt: 2500, hdg: 270, desc: 'Over the Bay Bridge westbound.' },
      { id: 'southbay', name: 'South Bay', lat: 37.5, lon: -122.1, altFt: 3000, hdg: 315, desc: 'Above the salt ponds near Palo Alto.' },
    ],
    airports: ['KSFO', 'KOAK', 'KHAF', 'KPAO'],
    defaultAirport: 'KSFO',
  };

  SIM.Regions = regions;
  SIM.RegionOrder = ['chile', 'sfbay'];
})(window.SIM);
