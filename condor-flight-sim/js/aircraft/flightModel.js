/**
 * FlightModel — six-degree-of-freedom rigid body.
 *
 * Forces and moments:
 *  - aerodynamics from AeroModel (strip build-up of wing, tail and fin from the real geometry),
 *  - propeller/jet thrust at the engine positions (asymmetric thrust for twins),
 *  - propeller torque reaction, P-factor (thrust offset with angle of attack) and gyroscopic
 *    precession of the rotating propeller,
 *  - gravity,
 *  - landing gear: oleo/spring struts with asymmetric damping, tyre cornering force from slip
 *    angle, rolling resistance, differential and parking brakes, nose-wheel steering,
 *  - structural contact points (crash detection, belly landings, tail strikes).
 * Integrated at a fixed timestep (SIM.Config.PHYSICS_HZ) with semi-implicit Euler.
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;
  const { Vec3 } = SIM;
  const G = SIM.Phys.G;

  const vAir = new Vec3(), vb = new Vec3();
  const fBody = new Vec3(), tBody = new Vec3(), fWorld = new Vec3(), tWorld = new Vec3(), tmp = new Vec3(), tmp2 = new Vec3();
  const rWorld = new Vec3(), wWorld = new Vec3(), pVel = new Vec3(), nrm = new Vec3(), fwd = new Vec3(), side = new Vec3(), cF = new Vec3(), vt = new Vec3();
  const Iw = new Vec3(), H = new Vec3();

  class FlightModel {
    constructor(aircraft) {
      this.ac = aircraft;
      this.cfg = aircraft.cfg;
      this.aero = new SIM.AeroModel(aircraft.cfg);
      this.pos = new Vec3();
      this.vel = new Vec3();
      this.quat = new SIM.Quat();
      this.omega = new Vec3();
      this.alpha = 0;
      this.beta = 0;
      this.tas = 0;
      this.ias = 0;
      this.qbar = 0;
      this.mach = 0;
      this.rho = SIM.Phys.RHO0;
      this.cl = 0;
      this.cd = 0;
      this.stallFactor = 0;
      this.stallMarginDeg = 99;
      this.stallAlphaDeg = 15;
      this.gLoad = 1;
      this.lateralG = 0;
      this.agl = 0;
      this.groundHeight = 0;
      this.onGround = false;
      this.wheelsOnGround = 0;
      this.groundEffect = 0;
      this.surface = 'grass';
      this.debugForces = { lift: new Vec3(), drag: new Vec3(), thrust: new Vec3(), weight: new Vec3() };
      this.time = 0;
      this.props = [];
      this.setupGear();
    }

    /** Spring/damper constants from mass and static compression of each leg. */
    setupGear() {
      const cfg = this.cfg;
      const mass = cfg.mass.maxTakeoff;
      const pts = cfg.gear.points;
      const nose = pts.find((p) => p.id === 'nose');
      const mains = pts.filter((p) => p.id !== 'nose');
      const zMain = mains.reduce((s, p) => s + p.pos[2], 0) / mains.length;
      const noseShare = nose ? M.clamp(zMain / (zMain - nose.pos[2]), 0.06, 0.3) : 0;
      this.gear = pts.map((p) => {
        const share = p.id === 'nose' ? noseShare : (1 - noseShare) / mains.length;
        const load = mass * G * share;
        const k = load / p.compression;
        const c = 2 * p.damping * Math.sqrt(k * mass * share);
        return { id: p.id, r: new Vec3(p.pos[0], p.pos[1], p.pos[2]), k, c, steer: p.steer, brake: p.brake, compression: 0, onGround: false, maxCompression: p.compression * 3.5, load: 0, spin: 0, radius: p.radius || 0.2 };
      });
      this.contacts = cfg.gear.contacts.map((p) => ({ id: p.id, r: new Vec3(p.pos[0], p.pos[1], p.pos[2]), touching: false }));
      this.structK = (mass * G * 3) / 0.15;
      this.structC = 2 * 0.7 * Math.sqrt(this.structK * mass * 0.3);
      this.lowestGearY = Math.min(...pts.map((p) => p.pos[1]));
      this.props = cfg.engines.map((e) => ({ x: e.position[0], y: e.position[1], z: e.position[2], radius: (e.propDiameter || 0) / 2, blades: e.blades || 2, vi: 0, swirl: 0, rot: e.rotation || 1 }));
    }

    placeOnGround(x, z, heading, terrain) {
      const h = terrain.heightAt(x, z);
      const gearComp = this.cfg.gear.points[1].compression * 0.85;
      this.pos.set(x, h - this.lowestGearY - gearComp, z);
      this.quat.setFromHPR(heading, 0, 0);
      this.vel.set(0, 0, 0);
      this.omega.set(0, 0, 0);
      this.onGround = true;
    }

    placeInAir(x, y, z, heading, speed, pitch = 0) {
      this.pos.set(x, y, z);
      this.quat.setFromHPR(heading, pitch, 0);
      this.vel.set(Math.sin(heading) * speed, 0, -Math.cos(heading) * speed);
      this.omega.set(0, 0, 0);
      this.onGround = false;
    }

    forward(out = new Vec3()) {
      return out.set(0, 0, -1).applyQuat(this.quat);
    }

    /** Builds the AeroModel input for the current (or a hypothetical) state. */
    aeroInput(vbody, omega, rho, dt) {
      const ac = this.ac;
      const sys = ac.systems;
      this.props.forEach((p, i) => {
        const e = ac.engines[i];
        p.vi = e && e.kind === 'piston' ? e.propeller.vi : 0;
        p.swirl = e && e.kind === 'piston' ? e.propeller.swirl : 0;
      });
      return {
        vb: vbody, omega, rho, dt,
        controls: ac.controls,
        flapDeg: sys.flaps.pos,
        gearPos: this.cfg.gear.retractable ? sys.gear.pos : 1,
        speedbrake: sys.speedbrake.pos,
        props: this.props,
        agl: this.agl + (this.cfg.geometry.wingType === 'high' ? 2.1 : 0.55),
        mach: this.mach,
        onGround: this.onGround,
        damage: ac.damage,
      };
    }

    /**
     * Advances the simulation by dt seconds.
     * @param {number} dt
     * @param {object} env { terrain, atmosphereAt(y), windAt(pos, out), turbulence }
     */
    step(dt, env) {
      const ac = this.ac;
      const cfg = this.cfg;
      const mass = ac.mass;
      this.time += dt;

      /* ---------------- atmosphere and relative wind */
      const atm = env.atmosphereAt(this.pos.y);
      this.rho = atm.rho;
      env.windAt(this.pos, tmp);
      vAir.copy(this.vel).sub(tmp);
      vb.copy(vAir).applyQuatInverse(this.quat);
      const V = vb.length();
      this.tas = V;
      this.ias = V * Math.sqrt(atm.rho / SIM.Phys.RHO0);
      this.mach = V / atm.soundSpeed;
      this.qbar = 0.5 * atm.rho * V * V;
      this.vAxial = -vb.z;

      /* ---------------- terrain below */
      this.groundHeight = env.terrain.heightAt(this.pos.x, this.pos.z);
      this.agl = this.pos.y - this.groundHeight + this.lowestGearY;

      /* ---------------- turbulence: rotational gust field */
      const turb = env.turbulence || 0;
      let wGust = null;
      if (turb > 0) {
        const n = SIM.Noise.valueNoise;
        const t = this.time;
        const k = turb * 0.06;
        wGust = new Vec3((n(t * 1.7, 3) - 0.5) * k, (n(t * 1.3, 7) - 0.5) * k * 0.6, (n(t * 2.1, 11) - 0.5) * k * 1.4);
      }

      /* ---------------- aerodynamics */
      const omegaAir = wGust ? tmp2.copy(this.omega).sub(wGust) : this.omega;
      const aero = this.aero.compute(this.aeroInput(vb, omegaAir, atm.rho, dt));
      this.alpha = aero.alpha;
      this.beta = aero.beta;
      this.cl = aero.CL;
      this.cd = aero.CD;
      this.stallFactor = aero.stallFactor;
      this.stallMarginDeg = aero.stallMarginDeg;
      this.stallAlphaDeg = aero.stallAlphaDeg;
      this.groundEffect = aero.groundEffect;
      fBody.copy(aero.force);
      tBody.copy(aero.moment);
      this.debugForces.lift.copy(aero.lift);
      this.debugForces.drag.copy(aero.drag);

      /* ---------------- thrust, torque reaction, P-factor, gyroscopic precession */
      let totalThrust = 0;
      const realism = ac.realismScale;
      ac.engines.forEach((en) => {
        const T = en.thrust;
        totalThrust += T;
        const p = en.cfg.position;
        fBody.z -= T;
        tBody.x += p[1] * -T;
        tBody.y -= p[0] * -T;
        if (en.kind === 'piston') {
          const rot = en.cfg.rotation || 1;
          // reaction to the torque turning the propeller (clockwise seen from the cockpit → rolls left)
          tBody.z += en.torque * rot;
          // P-factor: descending blade at angle of attack carries more thrust → thrust line offset
          const e = 0.22 * en.cfg.propDiameter * Math.sin(M.clamp(this.alpha, -0.5, 0.5)) * realism;
          tBody.y += e * T * rot;
          // gyroscopic moment of the spinning propeller: M = -ω × H
          const Ip = 0.3 * en.cfg.inertia;
          H.set(0, 0, -rot * Ip * en.omega);
          tmp.crossVectors(this.omega, H);
          tBody.sub(tmp);
        }
      });
      this.debugForces.thrust.set(0, 0, -totalThrust);

      /* ---------------- to world, gravity */
      fWorld.copy(fBody).applyQuat(this.quat);
      fWorld.y -= mass * G;
      this.debugForces.weight.set(0, -mass * G, 0);
      tWorld.set(0, 0, 0);

      /* ---------------- ground */
      this.groundContacts(dt, env, fWorld, tWorld, cfg.gear.retractable ? ac.systems.gear.pos : 1);

      /* ---------------- load factor */
      tmp.copy(fWorld);
      tmp.y += mass * G;
      tmp.applyQuatInverse(this.quat);
      this.gLoad = M.damp(this.gLoad, tmp.y / (mass * G), 20, dt);
      this.lateralG = M.damp(this.lateralG || 0, tmp.x / (mass * G), 12, dt);

      /* ---------------- integrate translation */
      this.vel.addScaled(fWorld, dt / mass);
      this.pos.addScaled(this.vel, dt);

      /* ---------------- integrate rotation (Euler's equations) */
      tmp2.copy(tWorld).applyQuatInverse(this.quat);
      tBody.add(tmp2);
      const I = ac.inertia;
      const w = this.omega;
      Iw.set(I.pitch * w.x, I.yaw * w.y, I.roll * w.z);
      tmp.crossVectors(w, Iw);
      w.x += ((tBody.x - tmp.x) / I.pitch) * dt;
      w.y += ((tBody.y - tmp.y) / I.yaw) * dt;
      w.z += ((tBody.z - tmp.z) / I.roll) * dt;
      const wl = w.length();
      if (wl > 9) w.scale(9 / wl);
      this.quat.integrateBody(w, dt);

      if (!this.pos.isFinite() || !this.vel.isFinite() || !Number.isFinite(this.quat.w)) {
        throw new Error('Flight model diverged (non-finite state)');
      }
    }

    groundContacts(dt, env, fWorld, tWorld, gearPos) {
      const ac = this.ac;
      const sys = ac.systems;
      const ctl = ac.controls;
      const terrain = env.terrain;
      const mass = ac.mass;
      wWorld.copy(this.omega).applyQuat(this.quat);
      fwd.set(0, 0, -1).applyQuat(this.quat);

      let wheels = 0;
      const gearDown = gearPos > 0.98;
      const brakesFailed = sys.failures.brakes;
      const parking = sys.brakes.parking;
      const gs = this.vel.horizontalLength();
      const steerScale = M.lerp(1, this.cfg.controls.steerDeg / this.cfg.controls.steerTaxiDeg, M.smoothstep(3, 18, gs));
      const steerAngle = ctl.rudder * this.cfg.controls.steerTaxiDeg * M.DEG * steerScale;
      let surface = null;

      for (const g of this.gear) {
        g.onGround = false;
        g.load = 0;
        g.compression = Math.max(0, g.compression - dt * 2);
        if (!gearDown) continue;
        rWorld.copy(g.r).applyQuat(this.quat);
        const px = this.pos.x + rWorld.x, py = this.pos.y + rWorld.y, pz = this.pos.z + rWorld.z;
        const surf = terrain.surfaceAt(px, pz);
        const h = terrain.heightAt(px, pz) + surf.bump;
        const pen = h - py;
        if (pen <= 0) continue;
        surface = surf;
        terrain.normalAt(px, pz, nrm);
        pVel.crossVectors(wWorld, rWorld).add(this.vel);
        const vn = pVel.dot(nrm);
        if (surf.type === 'water' && ac.crashEnabled) {
          ac.registerImpact('water', Math.max(-vn, 0), pVel.length(), true);
          continue;
        }
        // oleo: stiffer damping in compression than in rebound
        const damping = vn < 0 ? g.c * 1.25 : g.c * 0.7;
        let Fn = g.k * pen + g.k * pen * pen * 6 - damping * vn;
        if (Fn < 0) Fn = 0;
        g.compression = pen;
        g.onGround = true;
        g.load = Fn;
        wheels++;
        if (pen > g.maxCompression) ac.registerImpact('gear', Math.max(-vn, 0), pVel.length(), false);

        // wheel heading (steerable nose wheel follows the pedals)
        cF.copy(fwd);
        if (g.steer) {
          const cs = Math.cos(steerAngle), sn = Math.sin(steerAngle);
          const fx = cF.x * cs - cF.z * sn, fz = cF.x * sn + cF.z * cs;
          cF.x = fx;
          cF.z = fz;
        }
        cF.addScaled(nrm, -cF.dot(nrm)).normalize();
        side.crossVectors(nrm, cF).normalize();
        vt.copy(pVel).addScaled(nrm, -vn);
        const vLong = vt.dot(cF);
        const vLat = vt.dot(side);
        g.spin = vLong / g.radius;

        let brake = 0;
        if (g.brake && !brakesFailed) brake = parking ? 1 : g.r.x < 0 ? sys.brakes.left : sys.brakes.right;
        // brake torque limit of the aircraft (light aircraft cannot use the full tyre friction)
        const muLong = surf.roll + brake * Math.min(surf.brake, this.cfg.gear.brakeMu || surf.brake);
        const Flong = -M.sat(vLong / (brake > 0.9 && parking ? 0.08 : 0.35)) * muLong * Fn;
        // tyre cornering force from slip angle (linear then saturating)
        const slip = Math.atan2(vLat, Math.max(Math.abs(vLong), 1.5));
        const Flat = -M.sat(slip / 0.14) * surf.lateral * Fn;

        tmp.copy(nrm).scale(Fn).addScaled(cF, Flong).addScaled(side, Flat);
        fWorld.add(tmp);
        tWorld.add(tmp2.crossVectors(rWorld, tmp));
      }

      for (const cp of this.contacts) {
        const wasTouching = cp.touching;
        cp.touching = false;
        rWorld.copy(cp.r).applyQuat(this.quat);
        const px = this.pos.x + rWorld.x, py = this.pos.y + rWorld.y, pz = this.pos.z + rWorld.z;
        const h = terrain.heightAt(px, pz);
        const pen = h - py;
        if (pen <= 0) continue;
        cp.touching = true;
        const surf = terrain.surfaceAt(px, pz);
        surface = surface || surf;
        terrain.normalAt(px, pz, nrm);
        pVel.crossVectors(wWorld, rWorld).add(this.vel);
        const vn = pVel.dot(nrm);
        const speed = pVel.length();
        if (!wasTouching) ac.registerImpact(cp.id, Math.max(-vn, 0), speed, surf.type === 'water');
        else ac.scrape(cp.id, speed, dt);
        let Fn = this.structK * pen - this.structC * vn;
        if (Fn < 0) Fn = 0;
        vt.copy(pVel).addScaled(nrm, -vn);
        const vtl = vt.length();
        tmp.copy(nrm).scale(Fn);
        if (vtl > 0.01) tmp.addScaled(vt, (-0.55 * Fn * M.sat(vtl / 0.5)) / vtl);
        fWorld.add(tmp);
        tWorld.add(tmp2.crossVectors(rWorld, tmp));
      }

      const wasOnGround = this.onGround;
      this.wheelsOnGround = wheels;
      this.onGround = wheels > 0 || this.contacts.some((c) => c.touching);
      if (surface) this.surface = surface.type;
      if (!wasOnGround && this.onGround) ac.onTouchdown();
      if (wasOnGround && !this.onGround) ac.onLiftoff();
      if (this.onGround && this.vel.length() < 0.05 && (parking || sys.brakes.left > 0.5)) {
        fWorld.x -= this.vel.x * mass * 4;
        fWorld.z -= this.vel.z * mass * 4;
      }
    }

    attitude(out) {
      return SIM.quatToHPR(this.quat, out);
    }
  }

  SIM.FlightModel = FlightModel;
})(window.SIM);
