/**
 * Missions — definitions and the MissionRunner that evaluates objectives against the real
 * simulation state (position, altitude, touchdowns, crashes) and computes a score.
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;
  const NM = SIM.Units.NM;
  const FT = SIM.Units.FT;

  /* ---------------------------------------------------------------- objective factories */

  const Obj = {
    liftoff: () => ({ label: 'Lift off', check: (c) => !c.s.onGround && c.s.aglFt > 30 }),

    climb: (ftAgl) => ({ label: `Climb to ${ftAgl} ft AGL`, check: (c) => c.s.aglFt >= ftAgl }),

    altitude: (ftMsl, label) => ({ label: label || `Reach ${ftMsl} ft`, check: (c) => c.s.altFt >= ftMsl }),

    /** Keeps track within tolerance of the runway heading until a height. */
    runwayHeading: (icao, rwId, tol, untilFt) => ({
      label: `Hold runway heading ±${tol}° until ${untilFt} ft AGL`,
      check: (c) => !c.s.onGround && c.s.aglFt >= untilFt,
      fail: (c) => {
        if (c.s.onGround || c.s.aglFt < 50) return null;
        const end = c.runwayEnd(icao, rwId);
        const dev = Math.abs(M.angleDiff(c.s.trueTrackDeg, end.hdg));
        return dev > tol ? `Track deviated ${dev.toFixed(0)}° from runway heading` : null;
      },
      penalty: (c) => {
        const end = c.runwayEnd(icao, rwId);
        return Math.abs(M.angleDiff(c.s.trueTrackDeg, end.hdg));
      },
    }),

    /** Overfly a named waypoint/fix within a radius (nm), optional altitude window. */
    pass: (ident, radiusNm = 1, minFt = null, maxFt = null) => ({
      label: `Overfly ${ident}${minFt ? ` above ${minFt} ft` : ''}`,
      ident,
      check: (c) => {
        const w = c.point(ident);
        if (!w) return false;
        const d = Math.hypot(w.x - c.pos.x, w.z - c.pos.z);
        if (d > radiusNm * NM) return false;
        if (minFt != null && c.s.altFt < minFt) return false;
        if (maxFt != null && c.s.altFt > maxFt) return false;
        return true;
      },
    }),

    /** Pattern leg defined relative to a runway end (left traffic). */
    patternPoint: (label, icao, rwId, alongM, leftM, minAgl, maxAgl) => ({
      label,
      check: (c) => {
        const e = c.runwayEnd(icao, rwId);
        const lx = e.dirZ, lz = -e.dirX; // left normal
        const x = e.x + e.dirX * alongM + lx * leftM, z = e.z + e.dirZ * alongM + lz * leftM;
        const d = Math.hypot(x - c.pos.x, z - c.pos.z);
        return d < 700 && (minAgl == null || c.s.aglFt >= minAgl) && (maxAgl == null || c.s.aglFt <= maxAgl);
      },
      target: (c) => {
        const e = c.runwayEnd(icao, rwId);
        return { x: e.x + e.dirX * alongM + e.dirZ * leftM, z: e.z + e.dirZ * alongM - e.dirX * leftM };
      },
    }),

    /** Land on a runway of the airport (any if icao null) and come to a stop. */
    landAt: (icao, label) => ({
      label: label || (icao ? `Land at ${icao} and stop` : 'Land at an airport and stop'),
      check: (c) => {
        const td = c.session.lastLanding;
        if (!td || !td.runwayEnd) return false;
        if (icao && td.airport !== icao) return false;
        return c.s.onGround && c.s.gsKt < 3;
      },
    }),

    /** Off-field landing accepted (engine failure), as long as nobody crashes. */
    safeStop: () => ({ label: 'Bring the aircraft to a safe stop', check: (c) => c.session.lastLanding && c.s.onGround && c.s.gsKt < 2 }),
  };

  /* ---------------------------------------------------------------- definitions */

  const MISSIONS = [
    {
      id: 'takeoff', title: 'Takeoff', subtitle: 'SCEL runway 17L', difficulty: 1, aircraft: 'c172', region: 'chile', airport: 'SCEL', runway: '17L', start: 'runway',
      weather: 'clear', time: 9.5, season: 'summer', timeLimit: 300,
      briefing: 'Lined up on runway 17L at Santiago. Apply full power, keep the centreline with the rudder (Q/E), rotate at 55 KIAS (S) and climb at 74 KIAS (Vy) on runway heading to 1000 ft above the ground.',
      objectives: () => [Obj.liftoff(), Obj.runwayHeading('SCEL', '17L', 15, 1000), Obj.climb(1000)],
    },
    {
      id: 'circuit', title: 'Traffic circuit', subtitle: 'SCEL 17L left pattern', difficulty: 2, aircraft: 'c172', region: 'chile', airport: 'SCEL', runway: '17L', start: 'runway',
      weather: 'partly', time: 11, season: 'spring', timeLimit: 900,
      briefing: 'Fly a complete left-hand circuit at 1000 ft AGL: upwind, crosswind, downwind abeam the threshold, base and final, then land on runway 17L and stop. Pattern width about 1 NM.',
      objectives: () => [
        Obj.liftoff(),
        Obj.patternPoint('Crosswind turn', 'SCEL', '17L', 4600, 1850, 600, null),
        Obj.patternPoint('Downwind abeam threshold, 1000 ft AGL', 'SCEL', '17L', 0, 1850, 750, 1350),
        Obj.patternPoint('Base leg', 'SCEL', '17L', -1700, 1850, 400, 1300),
        Obj.patternPoint('Final', 'SCEL', '17L', -1800, 0, 200, 1000),
        Obj.landAt('SCEL'),
      ],
    },
    {
      id: 'landing', title: 'Landing', subtitle: '3 NM final SCEL 17L', difficulty: 2, aircraft: 'c172', region: 'chile', airport: 'SCEL', runway: '17L', start: 'approach', startDistNm: 3,
      weather: 'clear', time: 17.5, season: 'autumn', timeLimit: 400,
      briefing: 'You are established on a 3 NM final for runway 17L, flaps 20. Fly 65 KIAS, aim for the touchdown zone markings, flare and land smoothly on the centreline, then brake to a stop.',
      objectives: () => [Obj.landAt('SCEL')],
    },
    {
      id: 'short', title: 'Short flight', subtitle: 'Tobalaba → Arturo Merino Benítez', difficulty: 2, aircraft: 'c172', region: 'chile', airport: 'SCTB', runway: '01', start: 'runway',
      weather: 'clear', time: 10, season: 'summer', timeLimit: 1500, route: ['SCEL'],
      briefing: 'Depart Tobalaba (eastern Santiago), cross the city westbound at 3500–4500 ft and land at Santiago International. The GPS has SCEL as destination. Tune Santiago Tower 118.1 to request landing.',
      objectives: () => [Obj.liftoff(), Obj.altitude(3500, 'Climb to 3500 ft'), Obj.landAt('SCEL')],
    },
    {
      id: 'crosscountry', title: 'Cross-country', subtitle: 'Santiago → Viña del Mar', difficulty: 3, aircraft: 'c172', region: 'chile', airport: 'SCEL', runway: '17L', start: 'runway',
      weather: 'partly', time: 9, season: 'spring', timeLimit: 3000, route: ['LPRAD', 'CRV', 'CBLNC', 'SCVM'],
      briefing: 'VFR along the Ruta 68 corridor: Lo Prado tunnel, Curacaví VOR and Casablanca, then land at Viña del Mar (SCVM, runway 05/23). Keep at least 4500 ft over the coastal range. Route loaded in the GPS.',
      objectives: () => [Obj.liftoff(), Obj.pass('LPRAD', 1.5), Obj.pass('CRV', 1.5), Obj.pass('CBLNC', 1.5), Obj.landAt('SCVM')],
    },
    {
      id: 'enginefail', title: 'Engine failure', subtitle: 'Glide to Curacaví', difficulty: 3, aircraft: 'c172', region: 'chile', airport: 'SCCV', runway: '20', start: 'air', location: { lat: -33.36, lon: -71.13, altFt: 3800, hdg: 200 },
      weather: 'clear', time: 13, season: 'summer', timeLimit: 600, failures: [{ id: 'engine', minutes: 0.25 }], route: ['SCCV'],
      briefing: 'Cruising over the Curacaví valley when the engine quits. Pitch for best glide (68 KIAS), run the checklist and land at Curacaví airfield (SCCV) or bring the aircraft to a safe stop.',
      objectives: () => [Obj.safeStop()],
    },
    {
      id: 'navigation', title: 'Navigation', subtitle: 'Coastal VOR/GPS route', difficulty: 3, aircraft: 'pa28', region: 'chile', airport: 'SCVM', runway: '05', start: 'runway',
      weather: 'clear', time: 15, season: 'summer', timeLimit: 2400, route: ['CONCN', 'QLOTA', 'VLP', 'SCQN'],
      briefing: 'From Viña del Mar fly Concón, Quillota and the Valparaíso VOR (VLP 112.7), then land at Quintero (SCQN). Use the GPS or tune NAV1 and fly the VOR radials with the OBS.',
      objectives: () => [Obj.liftoff(), Obj.pass('CONCN', 1), Obj.pass('QLOTA', 1), Obj.pass('VLP', 1), Obj.landAt('SCQN')],
    },
    {
      id: 'ils', title: 'Airliner ILS', subtitle: 'B737 ILS 17L Santiago', difficulty: 4, aircraft: 'b738', region: 'chile', airport: 'SCEL', runway: '17L', start: 'approach', startDistNm: 10,
      weather: 'overcast', time: 20, season: 'winter', timeLimit: 900,
      briefing: 'Boeing 737 established on the localizer 10 NM from runway 17L, flaps 15 and gear down. NAV1 is tuned to the ILS (109.90). Use APR mode or fly it by hand at about 145 KIAS, then land and stop.',
      objectives: () => [Obj.landAt('SCEL')],
    },
    {
      id: 'andes', title: 'Crossing the Andes', subtitle: 'Baron 58 to Mendoza', difficulty: 4, aircraft: 'be58', region: 'chile', airport: 'SCEL', runway: '35R', start: 'runway',
      weather: 'clear', time: 8.5, season: 'summer', timeLimit: 4200, route: ['COLNA', 'LIBRT', 'USPLT', 'SAME'],
      briefing: 'Climb north-east via Colina and cross the Andes at Paso Los Libertadores above 14,500 ft (Aconcagua stands nearly 23,000 ft to the north). Descend over Uspallata and land at Mendoza El Plumerillo (SAME).',
      objectives: () => [Obj.liftoff(), Obj.pass('COLNA', 2), Obj.pass('LIBRT', 3, 14500), Obj.pass('USPLT', 3), Obj.landAt('SAME')],
    },
  ];

  /* ---------------------------------------------------------------- runner */

  class MissionRunner {
    constructor(def, session) {
      this.def = def;
      this.s = session;
      this.objectives = def.objectives();
      this.index = 0;
      this.time = 0;
      this.done = false;
      this.success = false;
      this.reason = '';
      this.penalties = [];
      this.ctx = this.buildContext();
    }

    buildContext() {
      const session = this.s;
      const cache = new Map();
      return {
        session,
        get ac() {
          return session.aircraft;
        },
        get s() {
          return session.aircraft.state;
        },
        get pos() {
          return session.aircraft.fm.pos;
        },
        runwayEnd(icao, id) {
          const ap = session.airports.find((a) => a.icao === icao);
          return SIM.Airports.findRunwayEnd(ap, id);
        },
        point(ident) {
          if (!cache.has(ident)) cache.set(ident, session.nav.find(ident));
          return cache.get(ident);
        },
      };
    }

    get current() {
      return this.objectives[this.index] || null;
    }

    update(dt) {
      if (this.done) return;
      this.time += dt;
      const ac = this.s.aircraft;
      if (ac.crashed) return this.finish(false, `Crash: ${ac.crashReason}`);
      if (this.def.timeLimit && this.time > this.def.timeLimit) return this.finish(false, 'Time limit exceeded');
      const obj = this.current;
      if (!obj) return this.finish(true);
      if (obj.fail) {
        const r = obj.fail(this.ctx);
        if (r) return this.finish(false, r);
      }
      if (obj.check(this.ctx)) {
        SIM.events.emit('mission:objective', { index: this.index, label: obj.label });
        this.index++;
        if (this.index >= this.objectives.length) this.finish(true);
      }
    }

    finish(success, reason = '') {
      if (this.done) return;
      this.done = true;
      this.success = success;
      this.reason = reason;
      this.score = this.computeScore();
      const progress = SIM.Storage.load('progress.v1', { missions: {} });
      const rec = progress.missions[this.def.id] || { attempts: 0, completed: false, bestScore: 0, bestTime: null };
      rec.attempts++;
      if (success) {
        rec.completed = true;
        rec.bestScore = Math.max(rec.bestScore, this.score);
        rec.bestTime = rec.bestTime == null ? this.time : Math.min(rec.bestTime, this.time);
      }
      rec.lastScore = this.score;
      rec.lastDate = new Date().toISOString();
      progress.missions[this.def.id] = rec;
      SIM.Storage.save('progress.v1', progress);
      SIM.events.emit('mission:complete', { success, reason, score: this.score, time: this.time, mission: this.def, record: rec });
    }

    computeScore() {
      const completed = this.index / this.objectives.length;
      let score = Math.round(completed * 500);
      if (!this.success) return Math.round(score * 0.5);
      const landing = this.s.lastLanding;
      if (landing && landing.score != null) score += Math.round(landing.score * 4);
      else score += 300;
      if (this.def.timeLimit) score += Math.round(M.clamp(1 - this.time / this.def.timeLimit, 0, 1) * 150);
      score -= Math.round(this.s.aircraft.damage * 300);
      score -= (this.s.atc ? this.s.atc.flags.violations.length : 0) * 50;
      return Math.max(0, score);
    }
  }

  SIM.Missions = MISSIONS;
  SIM.MissionRunner = MissionRunner;
  SIM.MissionObjectives = Obj;
})(window.SIM);
