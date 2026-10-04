/**
 * Terrain — procedural height, surface and land-cover functions for a region.
 *
 * Height = macro heightfield (ridges, peaks, basins, inland gradient; precomputed on a 1 km grid)
 *        + multi-octave detail noise (ridged noise in mountains)
 *        + coastline / water shaping (evaluated exactly at runtime)
 *        + airport flattening.
 *
 * Pure JavaScript (no WebGL) so the physics and the map work even without 3D rendering.
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;
  const { fbm, ridged, hash2, valueNoise } = SIM.Noise;
  const SEED = 1337;

  const SURFACES = {
    runway: { type: 'runway', roll: 0.015, brake: 0.75, lateral: 0.85, bump: 0 },
    paved: { type: 'paved', roll: 0.018, brake: 0.7, lateral: 0.8, bump: 0 },
    grass: { type: 'grass', roll: 0.05, brake: 0.38, lateral: 0.55, bump: 0 },
    dirt: { type: 'dirt', roll: 0.04, brake: 0.45, lateral: 0.6, bump: 0 },
    snow: { type: 'snow', roll: 0.06, brake: 0.2, lateral: 0.3, bump: 0 },
    water: { type: 'water', roll: 0.5, brake: 0, lateral: 0.5, bump: 0 },
  };

  const bump = (u) => (u >= 1 ? 0 : (1 - u * u) * (1 - u * u));

  class Terrain {
    /**
     * @param {object} region region definition
     * @param {GeoProjection} geo
     * @param {Array} airports runtime airport layouts
     * @param {string} season spring|summer|autumn|winter
     */
    constructor(region, geo, airports, season = 'summer') {
      this.region = region;
      this.geo = geo;
      this.airports = airports;
      this.season = season;
      const b = region.bounds;
      const a = geo.toLocal(b.latMax, b.lonMin);
      const c = geo.toLocal(b.latMin, b.lonMax);
      this.minX = a.x; this.minZ = a.z; this.maxX = c.x; this.maxZ = c.z;
      this.cell = SIM.Config.TERRAIN_MACRO_CELL;
      this.nx = Math.ceil((this.maxX - this.minX) / this.cell) + 1;
      this.nz = Math.ceil((this.maxZ - this.minZ) / this.cell) + 1;
      this.macroH = new Float32Array(this.nx * this.nz);
      this.macroR = new Float32Array(this.nx * this.nz);
      this.ready = false;

      // Pre-project features
      this.coast = region.coast.map((ll) => geo.xz(ll)).sort((p, q) => p[1] - q[1]);
      this.waterPolys = (region.water || []).map((poly) => {
        const pts = poly.map((ll) => geo.xz(ll));
        const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1]);
        return { pts, minX: Math.min(...xs) - 2000, maxX: Math.max(...xs) + 2000, minZ: Math.min(...zs) - 2000, maxZ: Math.max(...zs) + 2000 };
      });
      this.ridges = region.ridges.map((r) => ({ ...r, xz: r.pts.map((ll) => geo.xz(ll)) }));
      this.peaks = region.peaks.map((p) => ({ ...p, xz: geo.xz([p.lat, p.lon]) }));
      this.basins = region.basins.map((p) => ({ ...p, xz: geo.xz([p.lat, p.lon]) }));
      this.cities = region.cities.map((c) => ({ ...c, xz: geo.xz([c.lat, c.lon]), coreXZ: c.core ? geo.xz([c.core.lat, c.core.lon]) : null }));
      const east = region.base.east;
      if (east) {
        this.eastStart = geo.toLocal(region.origin[0], east.lonStart).x;
        this.eastEnd = geo.toLocal(region.origin[0], east.lonEnd).x;
      }
      this.snowLine = { summer: 4300, autumn: 3600, spring: 3000, winter: 2100 }[season] ?? 3500;
      if (region.hemisphere === 'N') this.snowLine += 1500;
      this._n = { x: 0, y: 1, z: 0 };
    }

    /* ------------------------------------------------------------------ macro grid */

    async buildMacro(progress) {
      const { nx, nz, cell, minX, minZ } = this;
      for (let j = 0; j < nz; j++) {
        const z = minZ + j * cell;
        for (let i = 0; i < nx; i++) {
          const x = minX + i * cell;
          const r = this.computeMacro(x, z);
          this.macroH[j * nx + i] = r.h;
          this.macroR[j * nx + i] = r.rug;
        }
        if (j % 24 === 0) {
          progress && progress(j / nz);
          await SIM.nextFrame();
        }
      }
      this.ready = true;
    }

    computeMacro(x, z) {
      const base = this.region.base;
      const L = this.landDistance(x, z);
      let h = base.inland * M.smoothstep(0, base.inlandDist, L) + base.terrace * M.smoothstep(0, base.terraceDist, L);
      if (base.east) h += base.east.height * M.smoothstep(this.eastStart, this.eastEnd, x);
      let rug = 0.05;
      const varN = 0.7 + 0.6 * fbm(x / 26000, z / 26000, 3, SEED + 5);
      for (const r of this.ridges) {
        let best = Infinity;
        for (let k = 0; k < r.xz.length - 1; k++) {
          const s = SIM.segDistance2D(x, z, r.xz[k][0], r.xz[k][1], r.xz[k + 1][0], r.xz[k + 1][1]);
          if (s.d < best) best = s.d;
        }
        const w = bump(best / r.width);
        if (w > 0) {
          h += r.height * w * varN;
          rug += r.rug * w;
        }
      }
      for (const b of this.basins) {
        const dx = x - b.xz[0], dz = z - b.xz[1];
        const d = Math.hypot(dx, dz);
        const rr = b.r * (0.85 + 0.3 * fbm(x / 9000, z / 9000, 2, SEED + 9));
        const mask = 1 - M.smoothstep(rr * 0.55, rr, d);
        if (mask > 0) {
          h = M.lerp(h, b.h + (b.tiltEast * dx) / 1000, mask);
          rug *= 1 - mask * 0.88;
        }
      }
      for (const p of this.peaks) {
        const d = Math.hypot(x - p.xz[0], z - p.xz[1]);
        const w = bump(d / p.r);
        if (w > 0) {
          h += p.h * w;
          rug += 0.4 * w;
        }
      }
      return { h, rug: M.clamp(rug, 0, 1.2) };
    }

    macroAt(x, z) {
      const fx = M.clamp((x - this.minX) / this.cell, 0, this.nx - 1.001);
      const fz = M.clamp((z - this.minZ) / this.cell, 0, this.nz - 1.001);
      const i = Math.floor(fx), j = Math.floor(fz);
      const tx = fx - i, tz = fz - j;
      const k = j * this.nx + i;
      const H = this.macroH, R = this.macroR, nx = this.nx;
      const h = (H[k] * (1 - tx) + H[k + 1] * tx) * (1 - tz) + (H[k + nx] * (1 - tx) + H[k + nx + 1] * tx) * tz;
      const r = (R[k] * (1 - tx) + R[k + 1] * tx) * (1 - tz) + (R[k + nx] * (1 - tx) + R[k + nx + 1] * tx) * tz;
      this._rug = r;
      return h;
    }

    /* ------------------------------------------------------------------ coast & water */

    coastDistance(x, z) {
      const c = this.coast;
      if (z <= c[0][1]) return x - c[0][0];
      if (z >= c[c.length - 1][1]) return x - c[c.length - 1][0];
      let lo = 0, hi = c.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (c[mid][1] <= z) lo = mid;
        else hi = mid;
      }
      const a = c[lo], b = c[hi];
      const t = (z - a[1]) / (b[1] - a[1] || 1);
      const cx = a[0] + (b[0] - a[0]) * t;
      const slope = (b[0] - a[0]) / (b[1] - a[1] || 1);
      return (x - cx) / Math.sqrt(1 + slope * slope);
    }

    /** Signed distance to water: positive on land, negative over water. */
    landDistance(x, z) {
      let L = this.coastDistance(x, z);
      for (const wp of this.waterPolys) {
        if (x < wp.minX || x > wp.maxX || z < wp.minZ || z > wp.maxZ) continue;
        let d = Infinity;
        const p = wp.pts;
        for (let k = 0, n = p.length; k < n; k++) {
          const q = p[(k + 1) % n];
          const s = SIM.segDistance2D(x, z, p[k][0], p[k][1], q[0], q[1]);
          if (s.d < d) d = s.d;
        }
        const inside = SIM.pointInPolygon(x, z, p);
        L = Math.min(L, inside ? -d : d);
      }
      return L;
    }

    /* ------------------------------------------------------------------ height */

    /** Terrain height including sea floor (used for rendering). */
    rawHeight(x, z) {
      const macro = this.macroAt(x, z);
      const rug = this._rug;
      let h = macro;
      h += (fbm(x / 3600, z / 3600, 4, SEED) - 0.5) * 2 * (16 + 240 * rug);
      if (rug > 0.08) h += ridged(x / 6800, z / 6800, 4, SEED + 3) * 1150 * Math.pow(rug, 1.35);
      h += (valueNoise(x / 700, z / 700, SEED + 7) - 0.5) * (5 + 40 * rug);
      const L = this.landDistance(x, z);
      if (L < 2200) {
        const land = Math.max(h * M.smoothstep(0, 1900, L), 0) + 1.5;
        const seabed = Math.max(-4 + L * 0.03, -220);
        h = M.lerp(seabed, land, M.smoothstep(-300, 380, L));
      }
      this._lastL = L;
      // Airports: flatten to field elevation
      for (const ap of this.airports) {
        const dx = x - ap.x, dz = z - ap.z;
        if (dx * dx + dz * dz > ap.radius * ap.radius) continue;
        let w = 0;
        for (const r of ap.flatten) {
          const d = SIM.Airports.rectDistance(r, x, z);
          const ww = 1 - M.smoothstep(0, 650, d);
          if (ww > w) w = ww;
        }
        if (w > 0) h = M.lerp(h, ap.elev, w);
      }
      return h;
    }

    /** Collision surface height (water surface counts as surface). */
    heightAt(x, z) {
      const h = this.rawHeight(x, z);
      return h < SIM.Config.WATER_LEVEL ? SIM.Config.WATER_LEVEL : h;
    }

    normalAt(x, z, out = { x: 0, y: 1, z: 0 }) {
      const e = 2;
      const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
      const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
      const nx = -hx / (2 * e), nz = -hz / (2 * e);
      const l = Math.sqrt(nx * nx + 1 + nz * nz);
      out.x = nx / l;
      out.y = 1 / l;
      out.z = nz / l;
      return out;
    }

    /* ------------------------------------------------------------------ surfaces */

    pavementAt(x, z) {
      for (const ap of this.airports) {
        const dx = x - ap.x, dz = z - ap.z;
        if (dx * dx + dz * dz > ap.radius * ap.radius) continue;
        for (const r of ap.pavement) if (SIM.Airports.rectDistance(r, x, z) <= 0) return r;
      }
      return null;
    }

    surfaceAt(x, z) {
      const pav = this.pavementAt(x, z);
      if (pav) return pav.type === 'runway' ? SURFACES.runway : pav.type === 'grass' ? SURFACES.grass : SURFACES.paved;
      const h = this.rawHeight(x, z);
      if (h < SIM.Config.WATER_LEVEL + 0.2) return SURFACES.water;
      if (h > this.snowLine) return SURFACES.snow;
      const s = this.urbanAt(x, z) > 0.5 ? SURFACES.paved : SURFACES.grass;
      if (s === SURFACES.grass) {
        // Uneven field: small bumps felt through the gear
        const g = Object.assign({}, SURFACES.grass);
        g.bump = (valueNoise(x / 3, z / 3, 99) - 0.5) * 0.08;
        return g;
      }
      return s;
    }

    /* ------------------------------------------------------------------ land cover */

    urbanAt(x, z) {
      let u = 0;
      for (const c of this.cities) {
        const dx = x - c.xz[0], dz = z - c.xz[1];
        const d2 = dx * dx + dz * dz;
        const rMax = c.r * 1.3;
        if (d2 > rMax * rMax) continue;
        const d = Math.sqrt(d2);
        const rr = c.r * (0.78 + 0.45 * fbm(x / 2600, z / 2600, 3, SEED + 21));
        const v = c.density * (1 - M.smoothstep(rr * 0.6, rr, d));
        if (v > u) u = v;
      }
      if (u > 0) {
        for (const ap of this.airports) {
          const dx = x - ap.x, dz = z - ap.z;
          if (dx * dx + dz * dz > ap.radius * ap.radius) continue;
          for (const r of ap.flatten) if (SIM.Airports.rectDistance(r, x, z) < 120) return 0;
        }
      }
      return u;
    }

    /** City core factor 0..1 (tall buildings). */
    coreAt(x, z) {
      let v = 0;
      for (const c of this.cities) {
        if (!c.coreXZ) continue;
        const d = Math.hypot(x - c.coreXZ[0], z - c.coreXZ[1]);
        v = Math.max(v, 1 - M.smoothstep(0, c.core.r, d));
      }
      return v;
    }

    /** Vertex colour for land cover. Returns [r,g,b] in 0..1. */
    colorAt(x, z, h, slope, out) {
      const rug = this._rug !== undefined ? this._rug : 0;
      const season = this.season;
      const green = this.region.climate.humidity;
      const n1 = fbm(x / 1800, z / 1800, 3, SEED + 31);
      let r, g, b;

      if (h < 0.5) {
        // shallow sea floor (seen through water) / wet sand
        r = 0.55; g = 0.52; b = 0.42;
      } else {
        // Base: dry mediterranean scrub, greener with humidity and in winter/spring
        const wet = M.clamp(green + (season === 'winter' || season === 'spring' ? 0.25 : season === 'autumn' ? 0.05 : -0.05), 0, 1);
        r = M.lerp(0.58, 0.36, wet) + (n1 - 0.5) * 0.12;
        g = M.lerp(0.52, 0.45, wet) + (n1 - 0.5) * 0.1;
        b = M.lerp(0.36, 0.26, wet) + (n1 - 0.5) * 0.06;

        // Farmland patchwork on flat, low terrain
        const flat = 1 - M.smoothstep(0.03, 0.09, slope);
        if (flat > 0 && h < 1100 && rug < 0.35) {
          const ang = 0.35;
          const u = x * Math.cos(ang) - z * Math.sin(ang), v = x * Math.sin(ang) + z * Math.cos(ang);
          const fi = Math.floor(u / 380), fj = Math.floor(v / 260);
          const k = hash2(fi, fj, SEED);
          const field = [
            [0.34, 0.44, 0.2], [0.42, 0.47, 0.22], [0.52, 0.45, 0.3], [0.38, 0.39, 0.25], [0.47, 0.5, 0.28], [0.3, 0.38, 0.19],
          ][Math.floor(k * 6)];
          const fieldMix = flat * (0.55 + 0.35 * hash2(fi + 7, fj + 3, SEED)) * (1 - M.smoothstep(0.2, 0.35, rug));
          r = M.lerp(r, field[0], fieldMix);
          g = M.lerp(g, field[1], fieldMix);
          b = M.lerp(b, field[2], fieldMix);
        }

        // Vegetation patches (darker green) on hills
        const veg = M.smoothstep(0.55, 0.75, fbm(x / 2400, z / 2400, 3, SEED + 41)) * (1 - M.smoothstep(1500, 2300, h));
        r = M.lerp(r, 0.24, veg * 0.7);
        g = M.lerp(g, 0.31, veg * 0.7);
        b = M.lerp(b, 0.18, veg * 0.7);

        // Rock on mountains and steep slopes
        const rock = M.clamp(M.smoothstep(0.35, 0.8, slope) + M.smoothstep(1700, 2900, h) * 0.85, 0, 1);
        const rn = fbm(x / 900, z / 900, 2, SEED + 51);
        r = M.lerp(r, 0.46 + rn * 0.1, rock);
        g = M.lerp(g, 0.41 + rn * 0.08, rock);
        b = M.lerp(b, 0.37 + rn * 0.07, rock);

        // Snow above the seasonal snow line (less on steep faces)
        const snowLine = this.snowLine + (n1 - 0.5) * 600;
        const snow = M.smoothstep(snowLine - 150, snowLine + 250, h) * (1 - M.smoothstep(0.75, 1.1, slope) * 0.7);
        r = M.lerp(r, 0.93, snow);
        g = M.lerp(g, 0.94, snow);
        b = M.lerp(b, 0.97, snow);

        // Beach sand
        const L = this._lastL !== undefined ? this._lastL : 1e9;
        const sand = (1 - M.smoothstep(40, 160, L)) * (1 - M.smoothstep(6, 25, h));
        r = M.lerp(r, 0.78, sand);
        g = M.lerp(g, 0.72, sand);
        b = M.lerp(b, 0.57, sand);

        // Urban areas
        const urban = this.urbanAt(x, z);
        if (urban > 0) {
          const un = hash2(Math.floor(x / 120), Math.floor(z / 120), SEED + 61);
          const ur = 0.52 + un * 0.1, ug = 0.5 + un * 0.09, ub = 0.48 + un * 0.08;
          const mix = M.clamp(urban * 1.1, 0, 0.92);
          r = M.lerp(r, ur, mix);
          g = M.lerp(g, ug, mix);
          b = M.lerp(b, ub, mix);
        }
      }
      out[0] = M.clamp(r, 0, 1);
      out[1] = M.clamp(g, 0, 1);
      out[2] = M.clamp(b, 0, 1);
      return out;
    }

    /** Tree density 0..1 for scenery placement. */
    treeDensity(x, z, h, slope) {
      if (h < 3 || h > 2200 || slope > 0.7) return 0;
      if (this.pavementAt(x, z)) return 0;
      for (const ap of this.airports) {
        const dx = x - ap.x, dz = z - ap.z;
        if (dx * dx + dz * dz < ap.radius * ap.radius * 0.6) {
          for (const r of ap.flatten) if (SIM.Airports.rectDistance(r, x, z) < 200) return 0;
        }
      }
      const urban = this.urbanAt(x, z);
      const patches = M.smoothstep(0.5, 0.72, fbm(x / 2400, z / 2400, 3, SEED + 41));
      const scattered = 0.12 * M.smoothstep(0.4, 0.7, fbm(x / 600, z / 600, 2, SEED + 71));
      return M.clamp((patches + scattered) * (1 - urban * 0.75) * (1 - M.smoothstep(1500, 2200, h)), 0, 1);
    }
  }

  SIM.Terrain = Terrain;
  SIM.Surfaces = SURFACES;
})(window.SIM);
