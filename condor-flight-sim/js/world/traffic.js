/**
 * TrafficManager — simplified living world:
 *  - AI aircraft flying left-hand traffic circuits (takeoff, crosswind, downwind, base, final,
 *    landing) and en-route flights between airports with straight-in arrivals.
 *  - Static parked aircraft on aprons.
 *  - Road vehicles moving along highways near the camera (instanced, pooled).
 * AI aircraft are kinematic (no full physics) but use the same 3D models and lights.
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;
  const KT = SIM.Units.KT;
  const FT = SIM.Units.FT;
  const NM = SIM.Units.NM;

  const DENSITY = {
    off: { pattern: 0, enroute: 0, parked: 0 },
    low: { pattern: 1, enroute: 1, parked: 2 },
    medium: { pattern: 2, enroute: 2, parked: 4 },
    high: { pattern: 3, enroute: 4, parked: 7 },
  };
  const AI_CALLSIGNS = ['CC-ABC', 'CC-PZT', 'CC-LMV', 'CC-DRA', 'CC-KJS', 'CC-TQW', 'N172SP', 'N28AW', 'CC-VYH', 'CC-NRO'];

  /** Minimal aircraft-like state so AircraftModelBuilder.animate() can drive AI models. */
  function aiProxy(cfg) {
    return {
      cfg,
      controls: { aileron: 0, elevator: 0, rudder: 0, elevatorTrim: 0, rudderTrim: 0 },
      systems: {
        flaps: { pos: 0 }, speedbrake: { pos: 0 }, gear: { pos: 1 },
        lights: { nav: true, beacon: true, strobe: false, land: false },
        lightOn(n) {
          return !!this.lights[n];
        },
      },
      engines: cfg.engines.map(() => ({ rpm: 2300, n1: 60 })),
      fm: { gear: cfg.gear.points.map(() => ({ compression: 0 })) },
    };
  }

  class AIAircraft {
    constructor(mgr, typeId, callsign) {
      this.mgr = mgr;
      this.cfg = SIM.AircraftData[typeId];
      this.type = typeId;
      this.callsign = callsign;
      this.pos = new SIM.Vec3();
      this.heading = 0; // deg true
      this.speed = 0;   // m/s
      this.vs = 0;
      this.bank = 0;
      this.pitch = 0;
      this.onGround = true;
      this.route = [];
      this.leg = 0;
      this.phase = 'idle';
      this.wait = 0;
      this.proxy = aiProxy(this.cfg);
      this.model = null;
      if (mgr.scene) {
        this.model = SIM.AircraftModelBuilder.build(this.cfg, { landingLight: false });
        this.model.traverse((o) => {
          if (o.isMesh) o.castShadow = false;
        });
        mgr.group.add(this.model);
      }
    }

    /** Builds a left-hand circuit (or straight-in when `straightIn`) for a runway end. */
    planCircuit(ap, end, { fromAir = false } = {}) {
      const perf = this.cfg.performance;
      const elev = ap.elev;
      const d = { x: end.dirX, z: end.dirZ };
      const l = { x: end.dirZ, z: -end.dirX }; // left normal
      const len = end.runway.length;
      const width = this.type === 'b738' ? 2.8 * NM : this.type === 'be58' ? 1.4 * NM : 1.0 * NM;
      const tpa = elev + (this.type === 'b738' ? 1500 : 1000) * FT;
      const P = (along, left, alt, speedKt, phase, ground = false) => ({ x: end.x + d.x * along + l.x * left, z: end.z + d.z * along + l.z * left, alt, speed: speedKt * KT, phase, ground });
      const r = [];
      if (!fromAir) {
        r.push(P(len * 0.45, 0, elev, perf.vr, 'takeoff', true));
        r.push(P(len + 900, 0, elev + 500 * FT, perf.vy, 'climb'));
        r.push(P(len + 1500, width, tpa, perf.vy * 1.1, 'crosswind'));
      } else {
        r.push(P(len + 2500, width * 1.6, tpa, perf.cruise * 0.7, 'join'));
      }
      r.push(P(len * 0.6, width, tpa, perf.vapp * 1.35, 'downwind'));
      r.push(P(-1500, width, tpa - 250 * FT, perf.vapp * 1.2, 'downwind'));
      r.push(P(-2000 - width * 0.3, width * 0.55, elev + 650 * FT, perf.vapp * 1.1, 'base'));
      r.push(P(-2400, 0, elev + 600 * FT, perf.vapp, 'final'));
      r.push(P(250, 0, elev, perf.vapp * 0.95, 'landing'));
      r.push(P(Math.min(len * 0.6, 900 + perf.vapp * 6), 0, elev, 18, 'rollout', true));
      r.push(P(Math.min(len * 0.6, 900 + perf.vapp * 6) + 60, end.runway.taxiOffset || 60, elev, 8, 'taxi', true));
      this.route = r;
      this.leg = 0;
      this.airport = ap;
      this.end = end;
    }

    spawnCircuit(ap, end, onRunway) {
      this.planCircuit(ap, end, { fromAir: !onRunway });
      const first = onRunway ? { x: end.x + end.dirX * 30, z: end.z + end.dirZ * 30, alt: ap.elev } : this.route[0];
      this.pos.set(first.x, first.alt, first.z);
      this.heading = onRunway ? end.hdg : SIM.Geo.bearing(first.x, first.z, this.route[1].x, this.route[1].z);
      this.speed = onRunway ? 0 : this.route[0].speed;
      this.onGround = onRunway;
      this.phase = onRunway ? 'takeoff' : 'join';
      if (!onRunway) this.leg = 1;
      this.visible(true);
    }

    spawnEnroute(from, to) {
      const end = SIM.Airports.activeRunway(to, this.mgr.weather.p.windDir, this.mgr.weather.p.windKt);
      this.planCircuit(to, end, { fromAir: true });
      // replace the join with a long straight-in from the origin direction
      const perf = this.cfg.performance;
      const cruiseAlt = Math.max(from.elev, to.elev) + (this.type === 'b738' ? 9000 : 5500) * FT;
      const start = { x: from.x + (to.x - from.x) * 0.15, z: from.z + (to.z - from.z) * 0.15 };
      const faf = { x: end.x - end.dirX * 9 * NM, z: end.z - end.dirZ * 9 * NM };
      this.route = [
        { x: (start.x + faf.x) / 2, z: (start.z + faf.z) / 2, alt: cruiseAlt, speed: perf.cruise * 0.85 * KT, phase: 'cruise' },
        { x: faf.x, z: faf.z, alt: to.elev + 2800 * FT, speed: perf.vapp * 1.4 * KT, phase: 'descent' },
      ].concat(this.route.filter((p) => ['final', 'landing', 'rollout', 'taxi'].includes(p.phase)));
      this.pos.set(start.x, cruiseAlt, start.z);
      this.heading = SIM.Geo.bearing(start.x, start.z, this.route[0].x, this.route[0].z);
      this.speed = perf.cruise * 0.85 * KT;
      this.onGround = false;
      this.phase = 'cruise';
      this.leg = 0;
      this.airport = to;
      this.end = end;
      this.visible(true);
    }

    visible(v) {
      if (this.model) this.model.visible = v;
      this.active = v;
    }

    update(dt) {
      if (!this.active) {
        this.wait -= dt;
        return;
      }
      const wp = this.route[this.leg];
      if (!wp) {
        this.visible(false);
        this.wait = 25 + Math.random() * 60;
        return;
      }
      this.phase = wp.phase;
      const dx = wp.x - this.pos.x, dz = wp.z - this.pos.z;
      const dist = Math.hypot(dx, dz);
      const brg = SIM.Geo.bearing(this.pos.x, this.pos.z, wp.x, wp.z);
      const perf = this.cfg.performance;
      // speed
      const accel = this.onGround ? (wp.phase === 'takeoff' ? 2.2 : -2.8) : 1.2;
      this.speed = M.approach(this.speed, wp.speed, Math.abs(accel) * dt);
      // heading (ground: follow the line exactly)
      const err = M.angleDiff(this.heading, brg);
      const maxTurn = this.onGround ? 25 : 3.2;
      this.heading = M.wrap360(this.heading + M.clamp(err, -maxTurn * dt, maxTurn * dt));
      this.bank = this.onGround ? 0 : M.damp(this.bank, M.clamp(err * 1.2, -25, 25), 2, dt);
      // altitude
      if (wp.ground) {
        if (wp.phase === 'takeoff' && this.speed < perf.vr * KT * 0.98) {
          this.pos.y = M.damp(this.pos.y, this.airport.elev, 5, dt);
        }
      }
      let targetAlt = wp.alt;
      if (wp.phase === 'takeoff' && this.speed >= perf.vr * KT * 0.98) {
        this.onGround = false;
        targetAlt = this.airport.elev + 500 * FT;
      }
      if (!this.onGround) {
        const timeTo = dist / Math.max(this.speed, 10);
        const needVs = (targetAlt - this.pos.y) / Math.max(timeTo, 1);
        const maxVs = (this.type === 'b738' ? 2200 : 800) * SIM.Units.FPM;
        this.vs = M.damp(this.vs, M.clamp(needVs, -maxVs * 1.3, maxVs), 1.5, dt);
        this.pos.y += this.vs * dt;
        if ((wp.phase === 'landing' || wp.phase === 'rollout') && this.pos.y <= this.airport.elev + 0.2) {
          this.pos.y = this.airport.elev;
          this.onGround = true;
          this.vs = 0;
        }
      } else if (wp.phase !== 'takeoff') {
        this.pos.y = this.airport.elev;
      }
      const r = this.heading * M.DEG;
      this.pos.x += Math.sin(r) * this.speed * dt;
      this.pos.z += -Math.cos(r) * this.speed * dt;
      this.pitch = this.onGround ? 0 : M.clamp(Math.atan2(this.vs, Math.max(this.speed, 1)) * M.RAD + (wp.phase === 'final' || wp.phase === 'landing' ? 3 : 2), -5, 12);
      const capture = this.onGround ? 15 : Math.max(250, this.speed * 4);
      if (dist < capture) this.leg++;

      // model state
      const pr = this.proxy;
      pr.systems.flaps.pos = ['final', 'landing', 'base'].includes(wp.phase) ? this.cfg.aero.flaps[Math.max(1, this.cfg.aero.flaps.length - 2)].deg : wp.phase === 'takeoff' || wp.phase === 'climb' ? this.cfg.aero.flaps[1]?.deg || 0 : 0;
      pr.systems.gear.pos = this.cfg.gear.retractable ? (['cruise', 'climb', 'crosswind', 'join'].includes(wp.phase) && !this.onGround ? 0 : 1) : 1;
      pr.systems.lights.land = !['cruise'].includes(wp.phase);
      pr.systems.lights.strobe = !this.onGround || wp.phase === 'takeoff';
      pr.controls.aileron = M.clamp(err / 30, -0.4, 0.4);
      const thr = wp.phase === 'takeoff' || wp.phase === 'climb' ? 1 : wp.phase === 'landing' || wp.phase === 'rollout' || wp.phase === 'taxi' ? 0.15 : 0.6;
      pr.engines.forEach((e) => {
        e.rpm = this.cfg.engines[0].type === 'turbofan' ? 0 : 900 + 1500 * thr;
        e.n1 = 25 + 70 * thr;
      });
      if (this.model) {
        this.model.position.copy(this.pos);
        this.model.position.y += -this.cfg.gear.points[1].pos[1] * (this.onGround ? 1 : 1) + 0.02;
        this.model.rotation.set(0, 0, 0);
        this.model.rotateY(-r);
        this.model.rotateX(this.pitch * M.DEG);
        this.model.rotateZ(-this.bank * M.DEG);
      }
    }
  }

  class TrafficManager {
    constructor(session, scene, scenery) {
      this.session = session;
      this.scene = scene;
      this.weather = session.world.weather;
      this.airports = session.airports;
      this.level = DENSITY[session.config.traffic] || DENSITY.medium;
      this.ai = [];
      this.parked = [];
      this.cars = null;
      if (scene) {
        this.group = new THREE.Group();
        this.group.name = 'traffic';
        scene.add(this.group);
      }
      this.scenery = scenery;
      this.groundEnabled = session.app.settings.data.gameplay.groundTraffic;
    }

    init() {
      const rnd = SIM.mulberry32(Math.floor(Math.random() * 1e9));
      const playerAp = this.session.startAirport;
      const near = this.airports
        .map((ap) => ({ ap, d: Math.hypot(ap.x - this.session.aircraft.fm.pos.x, ap.z - this.session.aircraft.fm.pos.z) }))
        .sort((a, b) => a.d - b.d);
      let cs = 0;
      // Pattern traffic at the nearest fields with GA types
      const gaTypes = ['c172', 'pa28', 'c152'];
      for (let i = 0; i < this.level.pattern && near.length; i++) {
        const ap = near[Math.min(i, near.length - 1)].ap;
        const a = new AIAircraft(this, gaTypes[i % gaTypes.length], AI_CALLSIGNS[cs++ % AI_CALLSIGNS.length]);
        const end = SIM.Airports.activeRunway(ap, this.weather.p.windDir, this.weather.p.windKt);
        a.homeAirport = ap;
        a.spawnCircuit(ap, end, false);
        // stagger along the circuit
        a.leg = 1 + Math.floor(rnd() * 3);
        const wp = a.route[a.leg];
        a.pos.set(wp.x, wp.alt, wp.z);
        a.speed = wp.speed;
        this.ai.push(a);
      }
      // En-route traffic
      const intl = this.airports.filter((ap) => ap.type === 'international');
      for (let i = 0; i < this.level.enroute && this.airports.length > 1; i++) {
        const jet = i % 2 === 0 && intl.length;
        const to = jet ? intl[i % intl.length] : this.airports[Math.floor(rnd() * this.airports.length)];
        let from = this.airports[Math.floor(rnd() * this.airports.length)];
        if (from === to) from = this.airports[(this.airports.indexOf(to) + 1) % this.airports.length];
        const a = new AIAircraft(this, jet ? 'b738' : 'be58', jet ? `CDR${300 + i * 17}` : AI_CALLSIGNS[cs++ % AI_CALLSIGNS.length]);
        a.spawnEnroute(from, to);
        a.enroute = true;
        this.ai.push(a);
      }
      // Static parked aircraft
      if (this.scene) {
        const types = ['c172', 'pa28', 'c152', 'be58'];
        this.airports.forEach((ap) => {
          const spots = ap.parking.filter((p) => p !== this.session.startParking);
          const n = Math.min(this.level.parked, spots.length - 1);
          for (let i = 0; i < n; i++) {
            const spot = spots[(i * 3 + 1) % spots.length];
            if (spot.used) continue;
            spot.used = true;
            const type = spot.heavy && ap.type === 'international' && i % 2 === 0 ? 'b738' : types[(i + ap.icao.length) % types.length];
            const cfg = SIM.AircraftData[type];
            const m = SIM.AircraftModelBuilder.build(cfg, { landingLight: false });
            m.position.set(spot.x, ap.elev - cfg.gear.points[1].pos[1] - cfg.gear.points[1].compression * 0.8, spot.z);
            m.rotation.y = -spot.hdg * M.DEG;
            m.traverse((o) => {
              if (o.isMesh) o.castShadow = false;
            });
            const pr = aiProxy(cfg);
            pr.engines.forEach((e) => {
              e.rpm = 0;
              e.n1 = 0;
            });
            pr.systems.lights.nav = false;
            pr.systems.lights.beacon = false;
            SIM.AircraftModelBuilder.animate(m, pr, 0.01, { daylight: 1, cockpitView: false });
            this.group.add(m);
            this.parked.push(m);
            this.session.buildingIndex && this.session.buildingIndex.insert({ x: spot.x, z: spot.z, w: cfg.geometry.span * 0.6, d: cfg.geometry.length * 0.7, h: 2.5, base: ap.elev, rot: spot.hdg * M.DEG });
          }
        });
      }
      if (this.scene && this.scenery && this.groundEnabled) this.initCars();
    }

    initCars() {
      const paths = this.scenery.roadPaths.filter((p) => p.pts.length > 3);
      if (!paths.length) return;
      const quality = SIM.GraphicsLevels.particles[this.session.app.settings.data.graphics.particles] ?? 0.7;
      const count = Math.round(110 * quality);
      if (!count) return;
      const carGeo = new THREE.BoxGeometry(1.8, 1.4, 4.4).translate(0, 0.7, 0);
      const truckGeo = new THREE.BoxGeometry(2.5, 3.4, 11).translate(0, 1.7, 0);
      const mat = new THREE.MeshLambertMaterial();
      this.cars = {
        paths,
        list: [],
        cars: new THREE.InstancedMesh(carGeo, mat, count),
        trucks: new THREE.InstancedMesh(truckGeo, mat, Math.ceil(count * 0.25)),
      };
      const palette = [0xd9d9d9, 0x2b2b2b, 0x8b1d1d, 0x1d3d6b, 0x9a9a9a, 0xe0e0e0, 0x3b5e3b, 0xc8a24a];
      const c = new THREE.Color();
      let ti = 0, ci = 0;
      for (let i = 0; i < count + this.cars.trucks.count; i++) {
        const truck = i >= count;
        const car = { truck, index: truck ? ti++ : ci++, path: null, s: 0, dir: 1, speed: 0, seg: 0, active: false };
        this.cars.list.push(car);
        c.setHex(truck ? 0xe8e8e8 : palette[i % palette.length]);
        (truck ? this.cars.trucks : this.cars.cars).setColorAt(car.index, c);
      }
      [this.cars.cars, this.cars.trucks].forEach((im) => {
        im.frustumCulled = false;
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.group.add(im);
      });
      this.carLightMat = SIM.RenderUtils.lightMaterial({ size: 0.5, min: 1, max: 5 });
      const lights = this.cars.list.map(() => ({ x: 0, y: -9999, z: 0, r: 1, g: 0.95, b: 0.8, s: 1 }));
      this.carLights = SIM.RenderUtils.lightPoints(lights, this.carLightMat);
      this.carLights.geometry.attributes.position.setUsage(THREE.DynamicDrawUsage);
      this.group.add(this.carLights);
    }

    placeCar(car, cam) {
      // pick a random point on any road within 6 km of the camera
      for (let tries = 0; tries < 12; tries++) {
        const path = this.cars.paths[Math.floor(Math.random() * this.cars.paths.length)];
        const k = Math.floor(Math.random() * path.pts.length);
        const p = path.pts[k];
        if (Math.hypot(p.x - cam.x, p.z - cam.z) < 6000) {
          car.path = path;
          car.seg = Math.min(k, path.pts.length - 2);
          car.s = path.cum[car.seg];
          car.dir = Math.random() < 0.5 ? 1 : -1;
          car.speed = (car.truck ? 22 : 27) + Math.random() * 8;
          car.active = true;
          return;
        }
      }
      car.active = false;
    }

    updateCars(dt, cam, night) {
      const C = this.cars;
      if (!C) return;
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
      const lp = this.carLights.geometry.attributes.position;
      const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
      C.list.forEach((car, i) => {
        const im = car.truck ? C.trucks : C.cars;
        if (!car.active || !car.path) {
          if (Math.random() < 0.05) this.placeCar(car, cam);
          im.setMatrixAt(car.index, hidden);
          lp.setXYZ(i, 0, -9999, 0);
          return;
        }
        const path = car.path;
        car.s += car.speed * dt * car.dir;
        if (car.s < 0 || car.s > path.length) {
          car.active = false;
          return;
        }
        while (car.seg < path.pts.length - 2 && path.cum[car.seg + 1] < car.s) car.seg++;
        while (car.seg > 0 && path.cum[car.seg] > car.s) car.seg--;
        const a = path.pts[car.seg], b = path.pts[car.seg + 1];
        const segLen = path.cum[car.seg + 1] - path.cum[car.seg] || 1;
        const t = M.clamp((car.s - path.cum[car.seg]) / segLen, 0, 1);
        const lane = (path.type === 'highway' ? 3.5 : 2.2) * car.dir;
        const x = a.x + (b.x - a.x) * t - a.dz * lane, z = a.z + (b.z - a.z) * t + a.dx * lane;
        const y = a.y + (b.y - a.y) * t + 0.1;
        if (Math.hypot(x - cam.x, z - cam.z) > 7500) {
          car.active = false;
          return;
        }
        const hdg = Math.atan2(a.dx * car.dir, -a.dz * car.dir);
        q.setFromAxisAngle(up, -hdg);
        p.set(x, y, z);
        m.compose(p, q, s);
        im.setMatrixAt(car.index, m);
        const fx = Math.sin(hdg), fz = -Math.cos(hdg);
        lp.setXYZ(i, x + fx * (car.truck ? 5.6 : 2.3), night > 0.2 ? y + 0.8 : -9999, z + fz * (car.truck ? 5.6 : 2.3));
      });
      C.cars.instanceMatrix.needsUpdate = true;
      C.trucks.instanceMatrix.needsUpdate = true;
      lp.needsUpdate = true;
      this.carLightMat.uniforms.uIntensity.value = M.clamp(night * 1.2, 0, 1);
    }

    update(dt, cam, daylight) {
      const playerPos = this.session.aircraft.fm.pos;
      for (const a of this.ai) {
        a.update(dt);
        if (!a.active && a.wait <= 0) {
          // respawn
          if (a.enroute) {
            const to = this.airports[Math.floor(Math.random() * this.airports.length)];
            let from = this.airports[Math.floor(Math.random() * this.airports.length)];
            if (from === to) from = this.airports[(this.airports.indexOf(to) + 1) % this.airports.length];
            a.spawnEnroute(from, to);
          } else {
            const ap = a.homeAirport;
            const end = SIM.Airports.activeRunway(ap, this.weather.p.windDir, this.weather.p.windKt);
            // don't line up on the runway if the player is on it
            const playerOnRwy = Math.hypot(playerPos.x - end.x, playerPos.z - end.z) < end.runway.length && this.session.aircraft.onGround;
            a.spawnCircuit(ap, end, !playerOnRwy);
          }
        }
        if (a.active && a.model) SIM.AircraftModelBuilder.animate(a.model, a.proxy, dt, { daylight, cockpitView: false });
        // Mid-air / ground collision with the player
        if (a.active && !this.session.aircraft.crashed) {
          const d = a.pos.distanceTo(playerPos);
          if (d < (a.cfg.geometry.span + this.session.aircraft.cfg.geometry.span) * 0.35) {
            this.session.aircraft.crash(`Collision with traffic (${a.callsign})`);
          }
        }
      }
      if (this.cars) this.updateCars(dt, cam, 1 - daylight);
    }

    /** AI aircraft on final for an airport within a distance (for ATC). */
    onFinal(ap, dist) {
      return this.ai.find((a) => a.active && a.airport === ap && (a.phase === 'final' || a.phase === 'landing') && Math.hypot(a.pos.x - ap.x, a.pos.z - ap.z) < dist + ap.radius) || null;
    }

    inPattern(ap) {
      return this.ai.filter((a) => a.active && a.airport === ap && ['crosswind', 'downwind', 'base', 'final', 'join'].includes(a.phase));
    }

    /** Positions for map/TCAS. */
    contacts() {
      return this.ai.filter((a) => a.active).map((a) => ({ x: a.pos.x, z: a.pos.z, altFt: a.pos.y / FT, hdg: a.heading, callsign: a.callsign, type: a.cfg.shortName, phase: a.phase, gsKt: a.speed / KT }));
    }

    dispose() {
      if (this.group) {
        this.scene.remove(this.group);
        SIM.RenderUtils.disposeObject(this.group);
      }
    }
  }

  SIM.TrafficManager = TrafficManager;
})(window.SIM);
