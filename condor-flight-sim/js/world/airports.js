/**
 * Airport database and layout generator.
 *
 * Data are approximations of the real fields (position, elevation, runway orientation and length).
 * The generator builds, in local coordinates: runway ends with thresholds, parallel taxiways and
 * connectors, aprons with parking positions, buildings, lights and the terrain flattening zone.
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;
  const FT = SIM.Units.FT;

  const DB = {
    SCEL: {
      icao: 'SCEL', name: 'Arturo Merino Benítez Intl.', city: 'Santiago', country: 'CL', region: 'chile', type: 'international',
      lat: -33.393, lon: -70.7858, elevFt: 1555,
      runways: [
        { ids: ['17L', '35R'], lat: -33.3925, lon: -70.7765, hdg: 176, length: 3748, width: 55, surface: 'asphalt', ils: { '17L': { freq: 109.9, ident: 'IAMB' }, '35R': { freq: 111.5, ident: 'IMBA' } }, taxiSide: 'left' },
        { ids: ['17R', '35L'], lat: -33.3955, lon: -70.7935, hdg: 176, length: 3800, width: 45, surface: 'asphalt', ils: { '17R': { freq: 110.7, ident: 'ISTG' } }, taxiSide: 'left' },
      ],
      apron: { runway: 0, side: 'left', width: 1150, depth: 280, terminal: true, hangars: 4, cargo: true },
      freqs: { atis: 132.1, gnd: 121.9, twr: 118.1, app: 119.7 },
      preferred: '17L',
    },
    SCTB: {
      icao: 'SCTB', name: 'Eulogio Sánchez (Tobalaba)', city: 'Santiago', country: 'CL', region: 'chile', type: 'regional',
      lat: -33.4558, lon: -70.5481, elevFt: 2129,
      runways: [{ ids: ['01', '19'], lat: -33.4558, lon: -70.5481, hdg: 9, length: 1060, width: 23, surface: 'asphalt', taxiSide: 'right' }],
      apron: { runway: 0, side: 'right', width: 380, depth: 120, terminal: false, hangars: 6 },
      freqs: { twr: 118.3, gnd: 121.75 },
      preferred: '01',
    },
    SCBQ: {
      icao: 'SCBQ', name: 'El Bosque', city: 'Santiago', country: 'CL', region: 'chile', type: 'military',
      lat: -33.5618, lon: -70.6885, elevFt: 1844,
      runways: [{ ids: ['01', '19'], lat: -33.5618, lon: -70.6885, hdg: 3, length: 2280, width: 45, surface: 'asphalt', taxiSide: 'left' }],
      apron: { runway: 0, side: 'left', width: 520, depth: 170, terminal: false, hangars: 5 },
      freqs: { twr: 118.8 },
      preferred: '01',
    },
    SCCV: {
      icao: 'SCCV', name: 'Curacaví', city: 'Curacaví', country: 'CL', region: 'chile', type: 'airfield',
      lat: -33.4097, lon: -71.1544, elevFt: 650,
      runways: [{ ids: ['02', '20'], lat: -33.4097, lon: -71.1544, hdg: 22, length: 950, width: 18, surface: 'asphalt', taxiSide: 'right' }],
      apron: { runway: 0, side: 'right', width: 180, depth: 70, terminal: false, hangars: 3 },
      freqs: { ctaf: 122.8 },
      preferred: '20',
    },
    SCVM: {
      icao: 'SCVM', name: 'Viña del Mar (Torquemada)', city: 'Viña del Mar', country: 'CL', region: 'chile', type: 'regional',
      lat: -32.9496, lon: -71.4786, elevFt: 461,
      runways: [{ ids: ['05', '23'], lat: -32.9496, lon: -71.4786, hdg: 52, length: 1750, width: 45, surface: 'asphalt', ils: { '05': { freq: 109.5, ident: 'IVMR' } }, taxiSide: 'left' }],
      apron: { runway: 0, side: 'left', width: 360, depth: 130, terminal: true, hangars: 3 },
      freqs: { twr: 118.6, gnd: 121.8 },
      preferred: '05',
    },
    SCQN: {
      icao: 'SCQN', name: 'Quintero', city: 'Quintero', country: 'CL', region: 'chile', type: 'military',
      lat: -32.7906, lon: -71.5216, elevFt: 12,
      runways: [{ ids: ['11', '29'], lat: -32.7906, lon: -71.5216, hdg: 112, length: 1500, width: 30, surface: 'asphalt', taxiSide: 'left' }],
      apron: { runway: 0, side: 'left', width: 300, depth: 110, terminal: false, hangars: 4 },
      freqs: { twr: 119.4 },
      preferred: '29',
    },
    SCSN: {
      icao: 'SCSN', name: 'Santo Domingo', city: 'Santo Domingo', country: 'CL', region: 'chile', type: 'airfield',
      lat: -33.6564, lon: -71.6144, elevFt: 246,
      runways: [{ ids: ['02', '20'], lat: -33.6564, lon: -71.6144, hdg: 20, length: 1500, width: 30, surface: 'asphalt', taxiSide: 'right' }],
      apron: { runway: 0, side: 'right', width: 220, depth: 90, terminal: false, hangars: 3 },
      freqs: { ctaf: 122.7 },
      preferred: '20',
    },
    SAME: {
      icao: 'SAME', name: 'El Plumerillo Intl.', city: 'Mendoza', country: 'AR', region: 'chile', type: 'international',
      lat: -32.8317, lon: -68.7929, elevFt: 2310,
      runways: [{ ids: ['18', '36'], lat: -32.8317, lon: -68.7929, hdg: 179, length: 2835, width: 54, surface: 'asphalt', ils: { '36': { freq: 110.3, ident: 'IMDZ' } }, taxiSide: 'right' }],
      apron: { runway: 0, side: 'right', width: 650, depth: 200, terminal: true, hangars: 3 },
      freqs: { atis: 127.65, twr: 118.3, gnd: 121.9 },
      preferred: '36',
    },
    KSFO: {
      icao: 'KSFO', name: 'San Francisco Intl.', city: 'San Francisco', country: 'US', region: 'sfbay', type: 'international',
      lat: 37.6189, lon: -122.375, elevFt: 13,
      runways: [
        { ids: ['28R', '10L'], lat: 37.6142, lon: -122.3815, hdg: 298, length: 3618, width: 61, surface: 'asphalt', ils: { '28R': { freq: 109.55, ident: 'ISFO' } }, taxiSide: 'right' },
        { ids: ['28L', '10R'], lat: 37.6118, lon: -122.3785, hdg: 298, length: 3469, width: 61, surface: 'asphalt', ils: { '28L': { freq: 108.9, ident: 'IGWQ' } }, taxiSide: 'left' },
      ],
      apron: { runway: 0, side: 'right', width: 1300, depth: 320, terminal: true, hangars: 4, cargo: true },
      freqs: { atis: 135.45, gnd: 121.8, twr: 120.5, app: 135.65 },
      preferred: '28R',
    },
    KOAK: {
      icao: 'KOAK', name: 'Oakland Intl.', city: 'Oakland', country: 'US', region: 'sfbay', type: 'international',
      lat: 37.7213, lon: -122.2208, elevFt: 9,
      runways: [{ ids: ['30', '12'], lat: 37.7105, lon: -122.2135, hdg: 310, length: 3048, width: 46, surface: 'asphalt', ils: { '30': { freq: 108.7, ident: 'IINB' } }, taxiSide: 'right' }],
      apron: { runway: 0, side: 'right', width: 800, depth: 250, terminal: true, hangars: 3 },
      freqs: { atis: 133.775, gnd: 121.9, twr: 118.3 },
      preferred: '30',
    },
    KHAF: {
      icao: 'KHAF', name: 'Half Moon Bay', city: 'Half Moon Bay', country: 'US', region: 'sfbay', type: 'airfield',
      lat: 37.5134, lon: -122.5011, elevFt: 66,
      runways: [{ ids: ['30', '12'], lat: 37.5134, lon: -122.5011, hdg: 318, length: 1524, width: 46, surface: 'asphalt', taxiSide: 'right' }],
      apron: { runway: 0, side: 'right', width: 260, depth: 90, terminal: false, hangars: 4 },
      freqs: { ctaf: 122.85 },
      preferred: '30',
    },
    KPAO: {
      icao: 'KPAO', name: 'Palo Alto', city: 'Palo Alto', country: 'US', region: 'sfbay', type: 'airfield',
      lat: 37.4611, lon: -122.115, elevFt: 7,
      runways: [{ ids: ['31', '13'], lat: 37.4611, lon: -122.115, hdg: 326, length: 745, width: 21, surface: 'asphalt', taxiSide: 'left' }],
      apron: { runway: 0, side: 'left', width: 260, depth: 100, terminal: false, hangars: 6 },
      freqs: { twr: 118.6, gnd: 125.0 },
      preferred: '31',
    },
  };

  /** Oriented rectangle helper used for pavement and flatten zones. */
  function orientedRect(cx, cz, dx, dz, halfLen, halfWid, type, extra = {}) {
    return Object.assign({ cx, cz, dx, dz, halfLen, halfWid, type }, extra);
  }

  /** Signed outside distance of a point to an oriented rectangle (<=0 inside). */
  function rectDistance(r, x, z) {
    const px = x - r.cx, pz = z - r.cz;
    const u = px * r.dx + pz * r.dz;          // along
    const v = -px * r.dz + pz * r.dx;         // across
    const ou = Math.abs(u) - r.halfLen, ov = Math.abs(v) - r.halfWid;
    const outside = Math.hypot(Math.max(ou, 0), Math.max(ov, 0));
    return outside > 0 ? outside : Math.max(ou, ov);
  }

  /**
   * Builds the runtime layout of an airport in local coordinates of `geo`.
   */
  function buildLayout(def, geo) {
    const ap = { def, icao: def.icao, name: def.name, elev: def.elevFt * FT, type: def.type, freqs: def.freqs };
    const c = geo.toLocal(def.lat, def.lon);
    ap.x = c.x;
    ap.z = c.z;
    ap.runways = [];
    ap.pavement = [];
    ap.flatten = [];
    ap.taxiways = [];
    ap.parking = [];
    ap.buildings = [];
    const big = def.type === 'international';

    def.runways.forEach((rw, ri) => {
      const cc = geo.toLocal(rw.lat, rw.lon);
      const d = SIM.Geo.dir(rw.hdg);
      const half = rw.length / 2;
      const ends = rw.ids.map((id, k) => {
        const sgn = k === 0 ? -1 : 1; // first id threshold is at the start of the heading direction
        const hdg = k === 0 ? rw.hdg : M.wrap360(rw.hdg + 180);
        const ilsDef = rw.ils && rw.ils[id];
        return {
          id, hdg, x: cc.x + d.x * half * sgn, z: cc.z + d.z * half * sgn,
          dirX: k === 0 ? d.x : -d.x, dirZ: k === 0 ? d.z : -d.z,
          ils: ilsDef ? { freq: ilsDef.freq, ident: ilsDef.ident, gs: 3 } : null,
        };
      });
      const runway = { index: ri, ids: rw.ids, cx: cc.x, cz: cc.z, dx: d.x, dz: d.z, hdg: rw.hdg, length: rw.length, width: rw.width, surface: rw.surface, ends, airport: ap };
      ends.forEach((e) => {
        e.runway = runway;
        e.opposite = null;
      });
      ends[0].opposite = ends[1];
      ends[1].opposite = ends[0];
      ap.runways.push(runway);
      ap.pavement.push(orientedRect(cc.x, cc.z, d.x, d.z, half + 30, rw.width / 2 + 4, rw.surface === 'grass' ? 'grass' : 'runway', { runway }));
      ap.flatten.push(orientedRect(cc.x, cc.z, d.x, d.z, half + 250, rw.width / 2 + (big ? 260 : 120), 'flat'));

      // Parallel taxiway with connectors at both ends and in the middle
      const sideSign = rw.taxiSide === 'left' ? -1 : 1; // right of heading = (-dz, dx) rotated -> use (−d.z, d.x)
      const nx = -d.z * sideSign, nz = d.x * sideSign; // unit normal toward taxi side (right side when sign=+1)
      const twWidth = big ? 23 : rw.width > 25 ? 15 : 10;
      const offset = rw.width / 2 + (big ? 180 : rw.length > 1400 ? 110 : 55);
      const tl = half * 0.92;
      const tcx = cc.x + nx * offset, tcz = cc.z + nz * offset;
      const parallel = { x1: tcx - d.x * tl, z1: tcz - d.z * tl, x2: tcx + d.x * tl, z2: tcz + d.z * tl, width: twWidth };
      ap.taxiways.push(parallel);
      ap.pavement.push(orientedRect(tcx, tcz, d.x, d.z, tl + twWidth / 2, twWidth / 2 + 2, 'taxi'));
      [-1, 0, 1].forEach((f) => {
        const along = f * tl;
        const sx = cc.x + d.x * along + nx * (rw.width / 2), sz = cc.z + d.z * along + nz * (rw.width / 2);
        const ex = tcx + d.x * along, ez = tcz + d.z * along;
        ap.taxiways.push({ x1: sx, z1: sz, x2: ex, z2: ez, width: twWidth });
        const mx = (sx + ex) / 2, mz = (sz + ez) / 2;
        const len = Math.hypot(ex - sx, ez - sz);
        ap.pavement.push(orientedRect(mx, mz, nx, nz, len / 2 + twWidth / 2, twWidth / 2 + 2, 'taxi'));
      });
      runway.taxiNormal = { x: nx, z: nz };
      runway.taxiOffset = offset;
    });

    // Apron next to the parallel taxiway of the reference runway
    const a = def.apron;
    const rw = ap.runways[a.runway];
    const n = rw.taxiNormal;
    const apronDist = rw.taxiOffset + 25 + a.depth / 2;
    const ax = rw.cx + n.x * apronDist, az = rw.cz + n.z * apronDist;
    ap.apron = orientedRect(ax, az, rw.dx, rw.dz, a.width / 2, a.depth / 2, 'apron');
    ap.pavement.push(ap.apron);
    ap.flatten.push(orientedRect(ax, az, rw.dx, rw.dz, a.width / 2 + 160, a.depth / 2 + 200, 'flat'));
    // Short link from apron to parallel taxiway
    const lx = rw.cx + n.x * (rw.taxiOffset + 12), lz = rw.cz + n.z * (rw.taxiOffset + 12);
    ap.pavement.push(orientedRect(lx, lz, rw.dx, rw.dz, a.width / 2, 16, 'taxi'));

    // Parking positions along the apron front, nose facing away from the taxiway (pushback not needed: we face the taxiway)
    const spotSpacing = big ? 70 : 24;
    const count = Math.max(3, Math.floor((a.width - 40) / spotSpacing));
    const frontDist = apronDist - a.depth / 2 + (big ? 45 : 18);
    const faceHdg = M.wrap360(Math.atan2(-n.x, n.z) * M.RAD); // facing toward the taxiway (−n)
    for (let i = 0; i < count; i++) {
      const along = (i - (count - 1) / 2) * spotSpacing;
      ap.parking.push({
        id: `${big ? 'G' : 'P'}${i + 1}`,
        x: rw.cx + rw.dx * along + n.x * (frontDist + (big ? 25 : 8)),
        z: rw.cz + rw.dz * along + n.z * (frontDist + (big ? 25 : 8)),
        hdg: faceHdg,
        heavy: big && i < count * 0.6,
      });
    }

    // Buildings behind the apron
    const backDist = apronDist + a.depth / 2 + 30;
    const bx = (along, dist) => ({ x: rw.cx + rw.dx * along + n.x * dist, z: rw.cz + rw.dz * along + n.z * dist });
    if (a.terminal) {
      const p = bx(0, backDist + 25);
      ap.buildings.push({ kind: 'terminal', x: p.x, z: p.z, w: a.width * 0.55, d: 50, h: big ? 22 : 10, hdg: rw.hdg });
    }
    for (let i = 0; i < a.hangars; i++) {
      const along = a.width * 0.5 - 30 - i * (big ? 75 : 34);
      const p = bx(along, backDist + 10);
      ap.buildings.push({ kind: 'hangar', x: p.x, z: p.z, w: big ? 60 : 26, d: big ? 50 : 22, h: big ? 18 : 8, hdg: rw.hdg });
    }
    if (a.cargo) {
      const p = bx(-a.width * 0.42, backDist + 20);
      ap.buildings.push({ kind: 'cargo', x: p.x, z: p.z, w: 120, d: 45, h: 14, hdg: rw.hdg });
    }
    const tw = bx(-a.width * 0.5 - 40, apronDist);
    ap.tower = { x: tw.x, z: tw.z, h: big ? 52 : def.type === 'airfield' ? 0 : 20 };
    if (ap.tower.h > 0) ap.buildings.push({ kind: 'tower', x: tw.x, z: tw.z, w: 10, d: 10, h: ap.tower.h, hdg: rw.hdg });
    else ap.tower.h = 8; // fixed camera mast for small fields

    // Bounding radius for fast rejection tests
    let r = 0;
    ap.flatten.forEach((f) => (r = Math.max(r, Math.hypot(f.cx - ap.x, f.cz - ap.z) + Math.hypot(f.halfLen, f.halfWid))));
    ap.radius = r + 900;
    return ap;
  }

  /** Finds a runway end by id ("17L"). */
  function findRunwayEnd(ap, id) {
    for (const rw of ap.runways) for (const e of rw.ends) if (e.id === id) return e;
    return ap.runways[0].ends[0];
  }

  /** Runway end most aligned into the wind (wind FROM direction, true deg). */
  function activeRunway(ap, windFromDeg, windKt) {
    if (windKt < 3) return findRunwayEnd(ap, ap.def.preferred);
    let best = null, bestScore = -Infinity;
    ap.runways.forEach((rw) => rw.ends.forEach((e) => {
      const headwind = Math.cos((windFromDeg - e.hdg) * M.DEG);
      const score = headwind + (e.id === ap.def.preferred ? 0.05 : 0) + (e.ils ? 0.02 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = e;
      }
    }));
    return best;
  }

  SIM.AirportDB = DB;
  SIM.Airports = { buildLayout, findRunwayEnd, activeRunway, rectDistance, orientedRect };
})(window.SIM);
