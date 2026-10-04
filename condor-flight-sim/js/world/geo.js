/**
 * Local tangent-plane projection (equirectangular around the region origin). Accurate enough for
 * regions of a few hundred kilometres. World X = east, Z = south (north = -Z).
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;
  const M_PER_DEG_LAT = 110540;
  const M_PER_DEG_LON = 111320;

  class GeoProjection {
    constructor(lat0, lon0) {
      this.lat0 = lat0;
      this.lon0 = lon0;
      this.kx = M_PER_DEG_LON * Math.cos(lat0 * M.DEG);
    }

    toLocal(lat, lon, out = {}) {
      out.x = (lon - this.lon0) * this.kx;
      out.z = -(lat - this.lat0) * M_PER_DEG_LAT;
      return out;
    }

    /** Convenience: [lat, lon] -> [x, z] */
    xz(ll) {
      return [(ll[1] - this.lon0) * this.kx, -(ll[0] - this.lat0) * M_PER_DEG_LAT];
    }

    toGeo(x, z, out = {}) {
      out.lat = this.lat0 - z / M_PER_DEG_LAT;
      out.lon = this.lon0 + x / this.kx;
      return out;
    }
  }

  const Geo = {
    /** True bearing (deg) from point a to point b in local coordinates. */
    bearing(ax, az, bx, bz) {
      return M.wrap360(Math.atan2(bx - ax, -(bz - az)) * M.RAD);
    },
    distance(ax, az, bx, bz) {
      return Math.hypot(bx - ax, bz - az);
    },
    /** Unit direction (x,z) for a true heading in degrees. */
    dir(headingDeg) {
      const r = headingDeg * M.DEG;
      return { x: Math.sin(r), z: -Math.cos(r) };
    },
    formatLat(lat) {
      const h = lat < 0 ? 'S' : 'N';
      const a = Math.abs(lat);
      const d = Math.floor(a);
      const m = (a - d) * 60;
      return `${h}${String(d).padStart(2, '0')}°${m.toFixed(2).padStart(5, '0')}'`;
    },
    formatLon(lon) {
      const h = lon < 0 ? 'W' : 'E';
      const a = Math.abs(lon);
      const d = Math.floor(a);
      const m = (a - d) * 60;
      return `${h}${String(d).padStart(3, '0')}°${m.toFixed(2).padStart(5, '0')}'`;
    },
  };

  SIM.GeoProjection = GeoProjection;
  SIM.Geo = Geo;
})(window.SIM);
