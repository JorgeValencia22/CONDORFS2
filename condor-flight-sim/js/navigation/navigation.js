/**
 * NavigationSystem — GPS flight plan (direct-to, route legs, DTK/XTK/ETE/ETA), VOR and ILS
 * receivers for NAV1/NAV2 and lateral/vertical guidance for the autopilot and CDI.
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;
  const NM = SIM.Units.NM;
  const FT = SIM.Units.FT;
  const KT = SIM.Units.KT;

  class NavigationSystem {
    /**
     * @param {object} ctx { region, geo, airports, aircraft, clock: () => seconds of day }
     */
    constructor(ctx) {
      this.region = ctx.region;
      this.geo = ctx.geo;
      this.airports = ctx.airports;
      this.ac = ctx.aircraft;
      this.clock = ctx.clock || (() => 0);
      this.magVar = ctx.region.magVar || 0;
      this.radios = new SIM.RadioStack(this.ac.cfg.avionics);
      this.route = [];
      this.activeLeg = 0;
      this.legFrom = null;
      this.approachRunway = null; // runway end for GPS approach guidance
      this.gps = { valid: false };
      this.receivers = { nav1: { valid: false }, nav2: { valid: false } };
      this.timer = 0;
      this.buildDatabase();
    }

    toMag(trueDeg) {
      return M.wrap360(trueDeg - this.magVar);
    }

    toTrue(magDeg) {
      return M.wrap360(magDeg + this.magVar);
    }

    buildDatabase() {
      const nd = SIM.NavData[this.region.id] || { vors: [], fixes: [] };
      const geo = this.geo;
      const db = [];
      this.airports.forEach((ap) => {
        const g = geo.toGeo(ap.x, ap.z);
        db.push({ ident: ap.icao, name: ap.name, type: 'APT', x: ap.x, z: ap.z, lat: g.lat, lon: g.lon, airport: ap, elevFt: ap.def.elevFt });
      });
      nd.vors.forEach((v) => {
        const p = geo.toLocal(v.lat, v.lon);
        db.push({ ident: v.ident, name: v.name, type: 'VOR', x: p.x, z: p.z, lat: v.lat, lon: v.lon, freq: v.freq });
      });
      nd.fixes.forEach((f) => {
        const p = geo.toLocal(f.lat, f.lon);
        db.push({ ident: f.ident, name: f.name, type: 'FIX', x: p.x, z: p.z, lat: f.lat, lon: f.lon });
      });
      this.db = db;
      this.centers = (nd.centers || []).map((c) => Object.assign({}, c, geo.toLocal(c.lat, c.lon)));

      // Radio stations (VOR + localizers)
      this.stations = [];
      db.filter((w) => w.type === 'VOR').forEach((v) => this.stations.push({ type: 'VOR', ident: v.ident, name: v.name, freq: v.freq, x: v.x, z: v.z }));
      this.airports.forEach((ap) => ap.runways.forEach((rw) => rw.ends.forEach((e) => {
        if (!e.ils) return;
        // Localizer antenna beyond the far end; glideslope ~300 m past the threshold
        const far = e.opposite;
        this.stations.push({
          type: 'ILS', ident: e.ils.ident, name: `${ap.icao} ${e.id}`, freq: e.ils.freq,
          x: far.x + e.dirX * 300, z: far.z + e.dirZ * 300, course: e.hdg, end: e, airport: ap,
          gsX: e.x + e.dirX * 300, gsZ: e.z + e.dirZ * 300, elev: ap.elev,
        });
      })));
    }

    find(ident) {
      const id = String(ident).toUpperCase().trim();
      return this.db.find((w) => w.ident === id) || null;
    }

    search(text, limit = 12) {
      const t = String(text).toUpperCase().trim();
      if (!t) return this.nearest(limit);
      return this.db.filter((w) => w.ident.startsWith(t) || w.name.toUpperCase().includes(t)).slice(0, limit);
    }

    nearest(limit = 6, type = null) {
      const p = this.ac.fm.pos;
      return this.db
        .filter((w) => !type || w.type === type)
        .map((w) => ({ w, d: Math.hypot(w.x - p.x, w.z - p.z) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, limit)
        .map((o) => o.w);
    }

    /* ------------------------------------------------------------------ flight plan */

    directTo(wp) {
      if (!wp) return;
      let idx = this.route.indexOf(wp);
      if (idx < 0) {
        this.route.splice(Math.min(this.activeLeg, this.route.length), 0, wp);
        idx = this.route.indexOf(wp);
      }
      this.activeLeg = idx;
      this.legFrom = { x: this.ac.fm.pos.x, z: this.ac.fm.pos.z };
      this.setApproachFor(this.destination);
      SIM.events.emit('nav:changed', { reason: 'direct', wp });
      SIM.events.emit('notify', { text: `DIRECT TO ${wp.ident}`, level: 'info' });
    }

    addToRoute(wp, index = this.route.length) {
      if (!wp) return;
      this.route.splice(index, 0, wp);
      if (this.route.length === 1) this.directTo(wp);
      this.setApproachFor(this.destination);
      SIM.events.emit('nav:changed', { reason: 'add', wp });
    }

    removeFromRoute(index) {
      if (index < 0 || index >= this.route.length) return;
      this.route.splice(index, 1);
      if (this.activeLeg >= this.route.length) this.activeLeg = Math.max(0, this.route.length - 1);
      if (index <= this.activeLeg) this.legFrom = null;
      this.setApproachFor(this.destination);
      SIM.events.emit('nav:changed', { reason: 'remove' });
    }

    moveInRoute(index, dir) {
      const j = index + dir;
      if (j < 0 || j >= this.route.length) return;
      [this.route[index], this.route[j]] = [this.route[j], this.route[index]];
      SIM.events.emit('nav:changed', { reason: 'move' });
    }

    clearRoute() {
      this.route = [];
      this.activeLeg = 0;
      this.legFrom = null;
      this.approachRunway = null;
      SIM.events.emit('nav:changed', { reason: 'clear' });
    }

    setRoute(wps) {
      this.route = wps.filter(Boolean);
      this.activeLeg = 0;
      this.legFrom = null;
      this.setApproachFor(this.destination);
      SIM.events.emit('nav:changed', { reason: 'set' });
    }

    get destination() {
      return this.route.length ? this.route[this.route.length - 1] : null;
    }

    get activeWaypoint() {
      return this.route[this.activeLeg] || null;
    }

    setApproachFor(wp, weather) {
      if (!wp || wp.type !== 'APT') {
        this.approachRunway = null;
        return;
      }
      const w = weather || this._weather;
      this.approachRunway = w ? SIM.Airports.activeRunway(wp.airport, w.p.windDir, w.p.windKt) : SIM.Airports.findRunwayEnd(wp.airport, wp.airport.def.preferred);
    }

    /* ------------------------------------------------------------------ update */

    update(dt, weather) {
      this._weather = weather;
      this.radios.powered = this.ac.systems.elec.avionicsPowered;
      this.timer -= dt;
      if (this.timer > 0) return;
      this.timer = 0.1;
      this.updateGps();
      this.receivers.nav1 = this.computeReceiver('nav1');
      this.receivers.nav2 = this.computeReceiver('nav2');
    }

    updateGps() {
      const ac = this.ac;
      const p = ac.fm.pos;
      const g = this.gps;
      const pos = this.geo.toGeo(p.x, p.z);
      g.lat = pos.lat;
      g.lon = pos.lon;
      g.gsKt = ac.state.gsKt || 0;
      g.trk = ac.state.trackDeg || 0;
      g.altFt = ac.state.altFtTrue || 0;
      g.valid = this.radios.powered && this.ac.cfg.avionics.gps;
      const wp = this.activeWaypoint;
      g.wp = wp;
      if (!wp) {
        g.dist = null;
        return;
      }
      const from = this.legFrom || (this.activeLeg > 0 ? this.route[this.activeLeg - 1] : { x: p.x, z: p.z });
      if (!this.legFrom && this.activeLeg === 0) this.legFrom = { x: p.x, z: p.z };
      g.from = from;
      const dist = Math.hypot(wp.x - p.x, wp.z - p.z);
      const legLen = Math.hypot(wp.x - from.x, wp.z - from.z) || 1;
      const ux = (wp.x - from.x) / legLen, uz = (wp.z - from.z) / legLen;
      const rx = p.x - from.x, rz = p.z - from.z;
      const along = rx * ux + rz * uz;
      // Right of course positive: right normal of (ux,uz) is (-uz, ux)
      g.xtk = rx * -uz + rz * ux;
      g.dtk = this.toMag(SIM.Geo.bearing(from.x, from.z, wp.x, wp.z));
      g.brg = this.toMag(SIM.Geo.bearing(p.x, p.z, wp.x, wp.z));
      g.dist = dist;
      const gs = Math.max(g.gsKt * KT, 1);
      g.ete = dist / gs;
      g.eta = this.clock() + g.ete;
      // Distance to destination along the remaining route
      let rem = dist;
      for (let i = this.activeLeg; i < this.route.length - 1; i++) rem += Math.hypot(this.route[i + 1].x - this.route[i].x, this.route[i + 1].z - this.route[i].z);
      g.distDest = rem;
      g.eteDest = rem / gs;
      // Auto sequencing (turn anticipation scales with ground speed)
      const anticipation = Math.max(0.25 * NM, gs * 12);
      if (this.activeLeg < this.route.length - 1 && (dist < anticipation || along > legLen)) {
        this.legFrom = { x: wp.x, z: wp.z };
        this.activeLeg++;
        SIM.events.emit('nav:sequence', { wp: this.activeWaypoint });
        SIM.events.emit('notify', { text: `WAYPOINT ${wp.ident} — NEXT ${this.activeWaypoint.ident}`, level: 'info' });
      }
    }

    computeReceiver(name) {
      const out = { valid: false, ident: '', type: '', needle: 0, toFrom: '', gsValid: false, gsNeedle: 0, dist: null };
      if (!this.radios.powered || !this.radios.has(name)) return out;
      const freq = this.radios.units[name].active;
      const p = this.ac.fm.pos;
      const altFt = this.ac.state.altFtTrue || 0;
      const aglFt = this.ac.state.aglFt || 0;
      let best = null, bestD = Infinity;
      for (const s of this.stations) {
        if (Math.abs(s.freq - freq) > 0.004) continue;
        const d = Math.hypot(s.x - p.x, s.z - p.z);
        if (d < bestD) {
          best = s;
          bestD = d;
        }
      }
      if (!best) return out;
      const range = best.type === 'ILS' ? 27 * NM : Math.min(160, 20 + 1.25 * Math.sqrt(Math.max(aglFt, 200))) * NM;
      if (bestD > range) return out;
      const obs = this.radios.obs[name];
      out.ident = best.ident;
      out.type = best.type;
      out.name = best.name;
      out.dist = bestD;
      out.station = best;
      const brgTo = this.toMag(SIM.Geo.bearing(p.x, p.z, best.x, best.z));
      out.bearingTo = brgTo;
      out.radial = M.wrap360(brgTo + 180);
      if (best.type === 'VOR') {
        const toSide = Math.abs(M.angleDiff(obs, brgTo)) < 90;
        out.toFrom = toSide ? 'TO' : 'FROM';
        const devDeg = toSide ? M.angleDiff(obs, brgTo) : -M.angleDiff(obs, out.radial);
        out.devDeg = devDeg;
        out.needle = M.clamp(devDeg / 2, -2.5, 2.5);
        out.course = obs;
        out.valid = true;
      } else {
        const course = this.toMag(best.course);
        const ang = M.angleDiff(course, brgTo);
        if (Math.abs(ang) > 40) return Object.assign(out, { valid: false });
        out.course = course;
        out.devDeg = ang;
        out.needle = M.clamp(ang / 1, -2.5, 2.5); // 2.5 dots = 2.5°
        out.toFrom = 'TO';
        out.valid = true;
        // Glideslope
        const dGs = Math.hypot(best.gsX - p.x, best.gsZ - p.z);
        const hAbove = p.y - best.elev;
        const angle = Math.atan2(hAbove, dGs) * M.RAD;
        out.gsAngle = angle;
        out.gsValid = dGs < 18 * NM && Math.abs(ang) < 15 && hAbove > -20;
        out.gsNeedle = M.clamp((3 - angle) / 0.28, -2.5, 2.5);
        out.gsDist = dGs;
        out.pathAltFt = (best.elev + Math.tan(3 * M.DEG) * dGs) / FT;
        out.xtk = Math.sin(ang * M.DEG) * bestD * -1;
      }
      if (best.type === 'VOR') out.xtk = -Math.sin(out.devDeg * M.DEG) * bestD;
      out.altFt = altFt;
      return out;
    }

    /** CDI data for the selected source (GPS or NAV1). */
    cdi() {
      if (this.radios.cdiSource === 'GPS') {
        const g = this.gps;
        if (!g.valid || g.dist == null) return { valid: false, source: 'GPS' };
        const fullScale = this.approachActive() ? 0.3 * NM : 1 * NM;
        return { valid: true, source: 'GPS', needle: M.clamp((-g.xtk / fullScale) * 2.5, -2.5, 2.5), course: g.dtk, toFrom: 'TO', ident: g.wp.ident, dist: g.dist, gsValid: false };
      }
      const r = this.receivers.nav1;
      return Object.assign({ source: 'NAV1' }, r);
    }

    approachActive() {
      const dest = this.destination;
      return !!(dest && dest.type === 'APT' && this.gps.distDest != null && this.gps.distDest < 30 * NM && this.activeWaypoint === dest);
    }

    /**
     * Lateral guidance: {valid, course (mag deg), xtk (m, +right of course), isLoc}
     * @param {'NAV'|'APR'} mode
     */
    guidance(mode) {
      if (mode === 'APR') {
        const r = this.receivers.nav1;
        if (r.valid && r.type === 'ILS') return { valid: true, course: r.course, xtk: r.xtk, isLoc: true };
        const rw = this.approachRunway;
        if (rw && this.gps.valid) {
          const p = this.ac.fm.pos;
          const rx = p.x - rw.x, rz = p.z - rw.z;
          const along = rx * rw.dirX + rz * rw.dirZ; // negative before threshold
          if (along < 300 && along > -25 * NM) {
            const xtk = rx * -rw.dirZ + rz * rw.dirX;
            return { valid: true, course: this.toMag(rw.hdg), xtk, isLoc: true };
          }
        }
        return { valid: false };
      }
      if (this.radios.cdiSource === 'GPS') {
        const g = this.gps;
        if (!g.valid || g.dist == null) return { valid: false };
        return { valid: true, course: g.dtk, xtk: g.xtk, isLoc: false };
      }
      const r = this.receivers.nav1;
      if (!r.valid) return { valid: false };
      if (r.type === 'ILS') return { valid: true, course: r.course, xtk: r.xtk, isLoc: true };
      // VOR: when FROM the station the desired track is the OBS course outbound
      return { valid: true, course: r.course, xtk: r.xtk, isLoc: false };
    }

    /** Vertical guidance for APR: ILS glideslope or GPS 3° path to the destination runway. */
    verticalGuidance() {
      const r = this.receivers.nav1;
      if (r.valid && r.type === 'ILS' && r.gsValid) return { valid: true, pathAltFt: r.pathAltFt, distNm: r.gsDist / NM, needle: r.gsNeedle };
      const rw = this.approachRunway;
      if (rw && this.gps.valid) {
        const p = this.ac.fm.pos;
        const gx = rw.x + rw.dirX * 300, gz = rw.z + rw.dirZ * 300;
        const d = Math.hypot(gx - p.x, gz - p.z);
        const along = (p.x - rw.x) * rw.dirX + (p.z - rw.z) * rw.dirZ;
        if (along < 250 && d < 20 * NM) {
          const pathAltFt = (rw.runway.airport.elev + Math.tan(3 * M.DEG) * d) / FT;
          const fullScaleFt = Math.max(75, (d * Math.tan(0.7 * M.DEG)) / FT);
          return { valid: true, pathAltFt, distNm: d / NM, needle: M.clamp(((pathAltFt - this.ac.state.altFtTrue) / fullScaleFt) * 2.5, -2.5, 2.5) };
        }
      }
      return { valid: false };
    }

    /** Formats seconds as H:MM or MM:SS. */
    static formatTime(sec) {
      if (!Number.isFinite(sec)) return '--:--';
      sec = Math.max(0, Math.round(sec));
      const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
      return h > 0 ? `${h}:${String(m).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }

    static formatClock(sec) {
      sec = ((sec % 86400) + 86400) % 86400;
      const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
  }

  SIM.NavigationSystem = NavigationSystem;
})(window.SIM);
