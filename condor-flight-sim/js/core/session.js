/**
 * FlightSession — one flight: loads the world and aircraft through the TaskLoader, places the
 * aircraft (runway, parking, in flight, final approach or a named location), runs the fixed
 * timestep physics with render interpolation, and connects navigation, ATC, traffic, missions,
 * camera, audio, effects, statistics and landing analysis.
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;
  const U = SIM.Units;
  const C = SIM.Config;

  class FlightSession {
    constructor(app, config, opts = {}) {
      this.app = app;
      this.config = config;
      this.missionDef = opts.mission || null;
      this.scope = SIM.events.scope();
      this.hour = config.time;
      this.timeRate = app.settings.data.gameplay.timeRate || 1;
      this.state = new SIM.FlightStateMachine();
      this.acc = 0;
      this.ready = false;
      this.prevPos = new SIM.Vec3();
      this.prevQuat = new SIM.Quat();
      this.effectTimer = 0;
      this.crashSite = null;
    }

    get timeOfDay() {
      return this.hour * 3600;
    }

    setHour(h) {
      this.hour = ((h % 24) + 24) % 24;
    }

    get airports() {
      return this.world.airports;
    }

    get region() {
      return this.world.region;
    }

    get buildingIndex() {
      return this.world.buildingIndex;
    }

    /* ------------------------------------------------------------------ loading */

    async load(onProgress) {
      const L = new SIM.TaskLoader();
      const app = this.app;
      const render = app.render && app.render.available ? app.render : null;
      L.onProgress(onProgress);
      L.add('LOADING WORLD', 'Region, airports and projection', () => {
        this.world = new SIM.World(this.config, render, app.settings);
        this.state.set(SIM.FlightState.LOADING);
      }, 0.3);
      L.add('LOADING WORLD', 'Terrain heightfield (ridges, basins, coast)', (p) => this.world.buildTerrainData(p), 2);
      L.add('LOADING WORLD', 'Navigation chart', (p) => {
        this.mapRenderer = new SIM.MapRenderer(this);
        return this.mapRenderer.buildBasemap(p);
      }, 1.5);
      L.add('LOADING WORLD', 'Start position', () => this.computeStart(), 0.2);
      L.add('LOADING WORLD', 'Terrain tiles, airports and cities', (p) => this.world.buildScene(new SIM.Vec3(this.start.x, this.start.y + 3, this.start.z), p), 7);
      L.add('LOADING AIRCRAFT', 'Flight model, engines and systems', () => this.createAircraft(), 0.4);
      L.add('LOADING AIRCRAFT', '3D model and cockpit', () => this.createModel(), 0.6);
      L.add('LOADING WEATHER', 'Atmosphere, sky, clouds and precipitation', () => this.world.buildAtmosphere(), 0.6);
      L.add('INITIALIZING FLIGHT SYSTEMS', 'Avionics, radios and GPS', () => this.createAvionics(), 0.3);
      L.add('INITIALIZING FLIGHT SYSTEMS', 'ATC and air traffic', () => this.createTraffic(), 0.6);
      L.add('INITIALIZING FLIGHT SYSTEMS', 'Cameras, instruments, audio', () => this.finishSetup(), 0.6);
      L.add('INITIALIZING FLIGHT SYSTEMS', 'Compiling shaders', () => this.warmUp(), 0.6);
      await L.run();
    }

    /** Computes where and how the flight starts. */
    computeStart() {
      const c = this.config;
      const world = this.world;
      const ap = world.airports.find((a) => a.icao === c.airport) || world.airports[0];
      this.startAirport = ap;
      const wx = world.weather.p;
      const end = !c.runway || c.runway === 'auto' || !ap.runways.some((r) => r.ids.includes(c.runway)) ? SIM.Airports.activeRunway(ap, wx.windDir, wx.windKt) : SIM.Airports.findRunwayEnd(ap, c.runway);
      this.startRunway = end;
      const cfg = SIM.AircraftData[c.aircraft];
      const NM = U.NM;
      const s = { type: c.start, hdg: end.hdg, x: end.x, z: end.z, y: ap.elev, ias: 0 };
      const loc = c.missionLocation || (c.start === 'location' ? world.region.locations.find((l) => l.id === c.location) || world.region.locations[0] : null);
      if (loc) {
        const p = world.geo.toLocal(loc.lat, loc.lon);
        s.type = 'air';
        s.x = p.x;
        s.z = p.z;
        s.hdg = loc.hdg;
        s.y = Math.max(loc.altFt * U.FT, world.terrain.heightAt(p.x, p.z) + 450);
        s.ias = cfg.performance.cruise * (cfg.id === 'b738' ? 0.6 : 0.85);
      } else if (c.start === 'parking') {
        const spots = ap.parking.filter((sp) => (cfg.id === 'b738' ? sp.heavy : !sp.heavy || ap.parking.every((q) => q.heavy)));
        const spot = (spots.length ? spots : ap.parking)[0];
        this.startParking = spot;
        s.x = spot.x;
        s.z = spot.z;
        s.hdg = spot.hdg;
      } else if (c.start === 'air') {
        const d = 6 * NM;
        s.x = end.x - end.dirX * d;
        s.z = end.z - end.dirZ * d;
        s.y = ap.elev + 3000 * U.FT;
        s.ias = cfg.performance.cruise * (cfg.id === 'b738' ? 0.5 : 0.8);
      } else if (c.start === 'approach') {
        const d = (c.startDistNm || (cfg.id === 'b738' ? 8 : 4)) * NM;
        s.x = end.x - end.dirX * d;
        s.z = end.z - end.dirZ * d;
        s.y = ap.elev + Math.tan(3 * M.DEG) * (d + 300) + 3;
        s.ias = cfg.performance.vapp;
        s.approach = true;
      } else {
        s.x = end.x + end.dirX * (cfg.id === 'b738' ? 60 : 35);
        s.z = end.z + end.dirZ * (cfg.id === 'b738' ? 60 : 35);
      }
      this.start = s;
    }

    createAircraft() {
      const c = this.config;
      const st = this.app.settings.data;
      const ac = new SIM.Aircraft(c.aircraft, {
        payload: c.payload, fuel: c.fuel, realism: st.gameplay.realism, failures: c.failures, customFailures: c.customFailures,
        crashDetection: st.gameplay.crashDetection, magVar: this.world.region.magVar, autoRudder: st.gameplay.autoRudder,
      });
      this.aircraft = ac;
      ac.qnh = this.world.weather.qnh;
      ac.kollsman = this.world.weather.qnh;
      this.placeAircraft();
      this.env = this.makeEnv();
    }

    placeAircraft() {
      const ac = this.aircraft;
      const s = this.start;
      const t = this.world.terrain;
      const hdg = s.hdg * M.DEG;
      if (s.type === 'parking') ac.initParked(s.x, s.z, hdg, t);
      else if (s.type === 'runway') ac.initReady(s.x, s.z, hdg, t);
      else ac.initAirborne(s.x, s.y, s.z, hdg, s.ias, this.world.weather, { approach: !!s.approach });
      if (s.approach && ac.cfg.gear.retractable) {
        ac.systems.gear.handle = 1;
        ac.systems.gear.pos = 1;
      }
      ac.autopilot.hdgBug = M.wrap360(s.hdg - this.world.region.magVar);
      ac.autopilot.altTarget = Math.round((this.startAirport.elev / U.FT + 3000) / 100) * 100;
      if (s.type === 'air') ac.autopilot.altTarget = Math.round(s.y / U.FT / 100) * 100;
      this.prevPos.copy(ac.fm.pos);
      this.prevQuat.copy(ac.fm.quat);
      ac.updateState();
    }

    makeEnv() {
      const w = this.world.weather;
      const ac = this.aircraft;
      return {
        terrain: this.world.terrain,
        atmosphereAt: (y) => w.atmosphereAt(y),
        windAt: (pos, out) => w.windAt(pos, out, ac.fm.groundHeight),
        get turbulence() {
          return w.turbulenceAt(ac.fm.pos.y) * (0.5 + ac.realismScale * 0.5);
        },
        get humidity() {
          return w.humidity;
        },
        visibleMoisture: (y) => w.visibleMoisture(y),
      };
    }

    createModel() {
      const render = this.world.render;
      if (!render) return;
      if (this.model) {
        render.scene.remove(this.model);
        SIM.RenderUtils.disposeObject(this.model);
      }
      this.model = SIM.AircraftModelBuilder.build(this.aircraft.cfg, { landingLight: true });
      render.scene.add(this.model);
      this.tmpPos = new THREE.Vector3();
      this.tmpQuat = new THREE.Quaternion();
    }

    createAvionics() {
      const ac = this.aircraft;
      const nav = new SIM.NavigationSystem({ region: this.world.region, geo: this.world.geo, airports: this.world.airports, aircraft: ac, clock: () => this.timeOfDay });
      this.nav = nav;
      ac.nav = nav;
      const r = nav.radios;
      const ap = this.startAirport;
      const f = ap.def.freqs;
      const s = this.start;
      const com1 = s.type === 'parking' ? f.gnd || f.twr || f.ctaf : f.twr || f.ctaf || f.gnd;
      if (com1) r.set('com1', com1, 'active');
      if (f.atis) r.set('com2', f.atis, 'active');
      if (f.twr) r.set('com1', f.twr, 'standby');
      const end = this.startRunway;
      if (end.ils) {
        r.set('nav1', end.ils.freq, 'active');
        r.obs.nav1 = Math.round(nav.toMag(end.hdg));
        if (s.type === 'approach') r.cdiSource = 'NAV1';
      } else {
        const vor = nav.nearest(1, 'VOR')[0];
        if (vor) {
          r.set('nav1', vor.freq, 'active');
          r.obs.nav1 = Math.round(nav.toMag(SIM.Geo.bearing(ac.fm.pos.x, ac.fm.pos.z, vor.x, vor.z)));
        }
      }
      const vors = nav.nearest(2, 'VOR');
      if (vors[1]) r.set('nav2', vors[1].freq, 'active');
      if (vors[0]) r.set('nav2', vors[0].freq, 'standby');
      const route = this.missionDef && this.missionDef.route ? this.missionDef.route : null;
      if (route) nav.setRoute(route.map((id) => nav.find(id)).filter(Boolean));
      else if (s.type === 'approach' || s.type === 'air') nav.setRoute([nav.find(ap.icao)]);
      nav.setApproachFor(nav.destination, this.world.weather);
    }

    createTraffic() {
      this.atc = new SIM.ATCSystem(this);
      const render = this.world.render;
      this.traffic = new SIM.TrafficManager(this, render ? render.scene : null, this.world.scenery);
      this.traffic.init();
    }

    finishSetup() {
      const app = this.app;
      const render = this.world.render;
      this.camera = render ? new SIM.CameraSystem(this, render, app.settings) : null;
      if (this.camera && this.start.type !== 'parking' && this.start.type !== 'runway' && app.settings.data.camera.defaultView !== 'cockpit') this.camera.setMode('chase');
      this.mission = this.missionDef ? new SIM.MissionRunner(this.missionDef, this) : null;
      this.stats = { flightTime: 0, distance: 0, maxAlt: 0, fuelStart: this.aircraft.systems.totalFuel, landings: 0, approachSamples: [], stoppedTime: 0, completedFor: null };
      this.lastLanding = null;
      app.ui.setupFlight(this);
      app.audio.startFlight(this.aircraft);
      this.bindEvents();
    }

    bindEvents() {
      const sc = this.scope;
      sc.on('aircraft:touchdown', (td) => this.onTouchdown(td));
      sc.on('aircraft:liftoff', () => {
        this.atc.onLiftoff();
        this.stats.approachSamples = [];
      });
      sc.on('aircraft:crash', () => {
        const p = this.aircraft.fm.pos;
        this.crashSite = { x: p.x, y: p.y, z: p.z, t: 0, water: this.aircraft.crashReason.includes('water') };
      });
      sc.on('engine:started', (e) => {
        const en = this.aircraft.engines[e.index];
        if (en.kind === 'piston') this.emitAtBody(en.cfg.position, 'startSmoke', 8, 2);
      });
    }

    warmUp() {
      // Let the gear settle and prime every system once before the first frame
      const h = 1 / C.PHYSICS_HZ;
      if (this.aircraft.onGround) for (let i = 0; i < 60; i++) this.aircraft.step(h, this.env);
      this.prevPos.copy(this.aircraft.fm.pos);
      this.prevQuat.copy(this.aircraft.fm.quat);
      this.aircraft.updateState();
      this.nav.update(1, this.world.weather);
      const render = this.world.render;
      if (render) {
        this.updateVisuals(0.016, 1);
        try {
          render.renderer.compile(render.scene, render.camera);
        } catch (e) {
          console.warn('[Session] shader warm-up failed', e);
        }
      }
      this.state.set(this.aircraft.onGround ? (this.aircraft.engines.some((e) => e.running) ? SIM.FlightState.TAXI : SIM.FlightState.PARKED) : SIM.FlightState.FLIGHT);
      this.ready = true;
    }

    /* ------------------------------------------------------------------ restart */

    restart() {
      this.app.ui.clearOverlay();
      this.scope.dispose();
      this.scope = SIM.events.scope();
      this.app.audio.stopFlight();
      if (this.traffic) this.traffic.dispose();
      if (this.world.particles) this.world.particles.clear();
      this.crashSite = null;
      this.acc = 0;
      this.hour = this.config.time;
      this.world.weather.set(this.config.weather, this.config.weatherCustom);
      this.state = new SIM.FlightStateMachine();
      this.computeStart();
      this.createAircraft();
      this.createModel();
      this.createAvionics();
      this.createTraffic();
      this.finishSetup();
      this.warmUp();
      this.app.input.reset();
      SIM.events.emit('notify', { text: 'FLIGHT RESTARTED', level: 'info' });
    }

    /* ------------------------------------------------------------------ actions */

    handleAction(id) {
      if (this.app.ui.handleAction(id)) return;
      if (this.state.state === 'PAUSED') return;
      const ac = this.aircraft;
      const sys = ac.systems;
      const cam = this.camera;
      switch (id) {
        case 'flapsDown': sys.flapsDown(); break;
        case 'flapsUp': sys.flapsUp(); break;
        case 'gear':
          if (!ac.cfg.gear.retractable) SIM.events.emit('notify', { text: 'FIXED LANDING GEAR', level: 'info' });
          else sys.toggleGear();
          break;
        case 'parkingBrake': sys.toggleParkingBrake(); break;
        case 'speedbrake': ac.toggleSpeedbrake(); break;
        case 'landingLight':
          sys.toggleSwitch('land');
          this.app.audio.click();
          break;
        case 'autopilot':
          if (!ac.autopilot.available) SIM.events.emit('notify', { text: 'NO AUTOPILOT INSTALLED', level: 'info' });
          else ac.autopilot.toggleAP();
          break;
        case 'autoStart': ac.autoStart(); break;
        case 'throttleFull': ac.setThrottle(1); break;
        case 'throttleIdle': ac.setThrottle(0); break;
        case 'cameraToggle': cam && cam.toggleCockpit(); break;
        case 'cameraCycle': cam && cam.cycle(); break;
        case 'resetView': cam && cam.resetView(); break;
        default:
      }
    }

    /* ------------------------------------------------------------------ frame */

    frame(rawDt) {
      if (!this.ready) return;
      const dt = Math.min(rawDt, C.MAX_FRAME_DT);
      const ac = this.aircraft;
      const paused = this.state.state === 'PAUSED';
      const crashed = this.state.state === 'CRASH' || ac.crashed;
      const h = 1 / C.PHYSICS_HZ;
      let steps = 0;
      if (!paused) this.app.input.applyToAircraft(dt, ac, this.camera);
      if (!paused && !crashed) {
        this.acc += dt;
        try {
          while (this.acc >= h && steps < C.MAX_PHYSICS_STEPS) {
            this.prevPos.copy(ac.fm.pos);
            this.prevQuat.copy(ac.fm.quat);
            ac.step(h, this.env);
            this.acc -= h;
            steps++;
          }
        } catch (e) {
          // Numerical failure: recover by re-placing the aircraft instead of freezing the app
          SIM.ErrorHandler.report(e, 'physics');
          this.placeAircraft();
          this.acc = 0;
        }
        if (steps >= C.MAX_PHYSICS_STEPS) this.acc = 0;
        ac.updateState();
        this.setHour(this.hour + (dt * this.timeRate) / 3600);
        this.nav.update(dt, this.world.weather);
        this.atc.update(dt);
        this.traffic.update(dt, this.camera ? this.camera.camera.position : ac.fm.pos, this.world.env.daylight);
        this.state.update(dt, this);
        if (this.mission) this.mission.update(dt);
        this.updateStats(dt);
        this.checkObstacles();
      } else if (crashed) {
        this.state.update(dt, this);
      }
      const alpha = crashed || paused ? 1 : M.clamp(this.acc / h, 0, 1);
      this.updateVisuals(paused ? 0 : dt, alpha, steps);
      this.app.audio.update(dt, {
        aircraft: ac,
        cockpit: !this.camera || this.camera.isCockpit,
        distance: this.camera ? this.camera.camera.position.distanceTo(ac.fm.pos) : 0,
        weather: this.world.weather,
        paused: paused || (crashed && this.crashSite && this.crashSite.t > 2),
        stallWarning: ac.systems.warnings.stall,
      });
      this.app.ui.update(dt, this.frameInfo);
    }

    updateVisuals(dt, alpha, steps = 0) {
      const ac = this.aircraft;
      const render = this.world.render;
      const fm = ac.fm;
      if (!render) {
        this.world.update(dt, this.hour, null, null, 0, null);
        this.frameInfo = { steps };
        return;
      }
      // interpolated pose
      const p = this.tmpPos.set(M.lerp(this.prevPos.x, fm.pos.x, alpha), M.lerp(this.prevPos.y, fm.pos.y, alpha), M.lerp(this.prevPos.z, fm.pos.z, alpha));
      const q = SIM.Quat.prototype.slerp.call(this.prevQuat.clone(), fm.quat, alpha);
      this.tmpQuat.set(q.x, q.y, q.z, q.w);
      this.model.position.copy(p);
      this.model.quaternion.copy(this.tmpQuat);
      const cockpit = this.camera && this.camera.isCockpit;
      SIM.AircraftModelBuilder.animate(this.model, ac, dt, { daylight: this.world.env.daylight, cockpitView: cockpit });
      if (this.camera) this.camera.update(dt, p, this.tmpQuat);
      const extent = Math.max(60, ac.cfg.geometry.span * 2.6);
      this.world.update(dt, this.hour, render.camera, p, extent, this.camera ? this.camera.velocity() : fm.vel);
      this.emitEffects(dt);
      this.frameInfo = { steps, pos: p, quat: this.tmpQuat };
    }

    /* ------------------------------------------------------------------ effects */

    emitAtBody(r, type, count, spread = 1, vel = null) {
      const ps = this.world.particles;
      if (!ps) return;
      const ac = this.aircraft;
      const w = new SIM.Vec3(r[0], r[1], r[2]).applyQuat(ac.fm.quat).add(ac.fm.pos);
      for (let i = 0; i < count; i++) {
        const v = vel || { x: 0, y: 0, z: 0 };
        ps.emit(type, w.x + (Math.random() - 0.5) * spread, w.y + (Math.random() - 0.5) * spread * 0.5, w.z + (Math.random() - 0.5) * spread, v.x + (Math.random() - 0.5) * 2, v.y + Math.random(), v.z + (Math.random() - 0.5) * 2);
      }
    }

    emitEffects(dt) {
      const ps = this.world.particles;
      if (!ps || dt <= 0) return;
      const ac = this.aircraft;
      const fm = ac.fm;
      this.effectTimer += dt;
      if (this.effectTimer < 0.05) return;
      const step = this.effectTimer;
      this.effectTimer = 0;
      const gs = ac.groundSpeed;
      // dust/grass from wheels and propwash on unpaved surfaces
      if (fm.onGround && (fm.surface === 'grass' || fm.surface === 'dirt' || fm.surface === 'snow')) {
        const n = Math.min(4, Math.floor(gs / 6 + ac.engines[0].throttle * 2));
        fm.gear.forEach((g) => g.onGround && g.id !== 'nose' && this.emitAtBody([g.r.x, g.r.y, g.r.z], fm.surface === 'grass' ? 'grass' : 'dust', n, 1));
      }
      // engine smoke when damaged or overheating
      ac.engines.forEach((e) => {
        if (e.damage > 0.3 || e._overheatFailure || (e.kind === 'piston' && e.oilTemp > e.cfg.oil.maxTemp + 5)) this.emitAtBody(e.cfg.position, 'smoke', 1, 0.5);
        if (e.kind === 'piston' && e.running && e.roughness > 0.4 && Math.random() < 0.3) this.emitAtBody(e.cfg.position, 'exhaust', 1, 0.2);
      });
      // wingtip vapour in humid air under load
      if (!fm.onGround && this.world.weather.humidity > 0.7 && fm.gLoad > 1.8 && fm.tas > 50) {
        const half = ac.cfg.geometry.span / 2 - 0.2;
        const tipY = ac.cfg.geometry.wingType === 'high' ? 1.0 : 0;
        this.emitAtBody([-half, tipY, 0.3], 'vapor', 2, 0.1);
        this.emitAtBody([half, tipY, 0.3], 'vapor', 2, 0.1);
      }
      // crash site
      if (this.crashSite) {
        const c = this.crashSite;
        c.t += step;
        if (c.t < 60) {
          if (c.water) ps.emit('spray', c.x, Math.max(c.y, 0.5), c.z, 0, 3, 0, 2);
          else {
            ps.emit('fire', c.x + (Math.random() - 0.5) * 4, c.y + 1, c.z + (Math.random() - 0.5) * 4, 0, 1, 0, 1.5);
            ps.emit('smoke', c.x, c.y + 3, c.z, (Math.random() - 0.5) * 2, 4, (Math.random() - 0.5) * 2, 3);
          }
        }
      }
    }

    /* ------------------------------------------------------------------ stats & landings */

    updateStats(dt) {
      const ac = this.aircraft;
      const st = this.stats;
      const s = ac.state;
      if (!ac.onGround || ac.groundSpeed > 1) {
        st.flightTime += dt;
        st.distance += ac.groundSpeed * dt;
      }
      st.maxAlt = Math.max(st.maxAlt, s.altFt);
      if (!s.onGround && s.aglFt > 50 && s.aglFt < 600 && s.vsFpm < -100) {
        st.approachSamples.push(s.iasKt);
        if (st.approachSamples.length > 600) st.approachSamples.shift();
      }
      if (!s.onGround && s.aglFt > 1500) st.approachSamples = [];
      // Flight complete: landed, stopped for 2 s
      if (!this.mission && this.lastLanding && s.onGround && s.gsKt < 3 && st.completedFor !== this.lastLanding) {
        st.stoppedTime += dt;
        if (st.stoppedTime > 2 && st.flightTime > 45) {
          st.completedFor = this.lastLanding;
          SIM.events.emit('flight:complete', { landing: this.lastLanding });
        }
      } else {
        st.stoppedTime = 0;
      }
    }

    onTouchdown(td) {
      const t = this.world.terrain;
      const pav = t.pavementAt(td.x, td.z);
      const st = this.stats;
      const vref = this.aircraft.cfg.performance.vref;
      const appr = st.approachSamples.length ? st.approachSamples.reduce((a, b) => a + b, 0) / st.approachSamples.length : null;
      const L = {
        vsFpm: td.vsFpm, gLoad: td.gLoad, iasKt: td.iasKt, rating: SIM.Overlays.landingRating(td.vsFpm), approachIas: appr,
        airport: null, runwayEnd: null, centerline: null, fromThreshold: null,
      };
      let ap = null;
      if (pav && pav.type === 'runway') {
        const rw = pav.runway;
        ap = rw.airport;
        const hd = td.heading * M.RAD;
        const end = rw.ends.reduce((best, e) => (Math.abs(M.angleDiff(hd, e.hdg)) < Math.abs(M.angleDiff(hd, best.hdg)) ? e : best), rw.ends[0]);
        const rx = td.x - end.x, rz = td.z - end.z;
        L.airport = ap.icao;
        L.runwayEnd = end.id;
        L.fromThreshold = rx * end.dirX + rz * end.dirZ;
        L.centerline = rx * -end.dirZ + rz * end.dirX;
      }
      // Landing score 0..100
      let score = L.rating.score * 0.5;
      if (L.centerline != null) score += Math.max(0, 20 - Math.abs(L.centerline) * 1.2);
      if (L.fromThreshold != null) score += L.fromThreshold > 100 && L.fromThreshold < 700 ? 15 : L.fromThreshold > 0 ? 7 : 0;
      if (appr) score += Math.max(0, 15 - Math.abs(appr - vref * 1.05) * 0.8);
      if (!td.gearDown) score = 0;
      L.score = Math.round(M.clamp(score, 0, 100));
      this.lastLanding = L;
      st.landings++;
      this.atc.onTouchdown();
      // tyre smoke
      if (td.gsKt > 45 && this.world.particles) {
        const n = Math.round(M.clamp(Math.abs(td.vsFpm) / 40, 3, 14));
        this.aircraft.fm.gear.forEach((g) => g.id !== 'nose' && this.emitAtBody([g.r.x, g.r.y, g.r.z], 'tyre', n, 0.6));
        this.app.audio.tyreScreech(M.clamp(Math.abs(td.vsFpm) / 600, 0, 1));
      }
    }

    computeScore() {
      const ac = this.aircraft;
      const L = this.lastLanding;
      let score = 0;
      if (L) score += 250 + L.score * 5;
      score += (1 - ac.damage) * 150;
      score += this.atc.flags.violations.length ? 0 : 100;
      if (ac.crashed) score = 0;
      return Math.round(M.clamp(score, 0, 1000));
    }

    saveLogbook(score, crashed) {
      if (this._logged) return;
      this._logged = true;
      const log = SIM.Storage.load('logbook.v1', { flights: 0, seconds: 0, landings: 0, bestLanding: null, crashes: 0, bestScore: 0 });
      log.flights++;
      log.seconds += this.stats.flightTime;
      log.landings += this.stats.landings;
      if (crashed) log.crashes++;
      if (this.lastLanding && !crashed) log.bestLanding = log.bestLanding == null ? Math.abs(this.lastLanding.vsFpm) : Math.min(log.bestLanding, Math.abs(this.lastLanding.vsFpm));
      log.bestScore = Math.max(log.bestScore || 0, score);
      SIM.Storage.save('logbook.v1', log);
    }

    checkObstacles() {
      const idx = this.buildingIndex;
      const ac = this.aircraft;
      if (!idx || ac.crashed || ac.onGround) return;
      const p = ac.fm.pos;
      if (idx.hit(p.x, p.y, p.z, ac.cfg.geometry.span * 0.25)) ac.crash('Collision with a building');
    }

    /* ------------------------------------------------------------------ dispose */

    dispose() {
      if (this.ready && this.stats && this.stats.flightTime > 30) this.saveLogbook(this.computeScore(), this.aircraft.crashed);
      this.ready = false;
      this.scope.dispose();
      this.app.audio.stopFlight();
      if (this.traffic) this.traffic.dispose();
      const render = this.world && this.world.render;
      if (render && this.model) {
        render.scene.remove(this.model);
        SIM.RenderUtils.disposeObject(this.model);
      }
      if (this.world) this.world.dispose();
    }
  }

  SIM.FlightSession = FlightSession;
})(window.SIM);
