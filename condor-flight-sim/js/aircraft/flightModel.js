/**
 * FlightModel — six-degree-of-freedom rigid body with coefficient-based aerodynamics.
 *
 * Implements lift (with smooth post-stall transition), drag (parasite, induced, flaps, gear,
 * speed brake, separated flow), side force, thrust (with asymmetric moments, torque and P-factor),
 * gravity, ground effect, propwash over the tail, landing gear springs/dampers with differential
 * rolling/braking/cornering friction and structural contact points used for crash detection.
 *
 * Integrated at a fixed timestep (SIM.Config.PHYSICS_HZ) with semi-implicit Euler.
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;
  const { Vec3 } = SIM;
  const G = SIM.Phys.G;

  // Scratch vectors (avoid allocations in the hot loop)
  const vAir = new Vec3(), vb = new Vec3(), dir = new Vec3(), liftDir = new Vec3(), X_AXIS = new Vec3(1, 0, 0);
  const fBody = new Vec3(), tBody = new Vec3(), fWorld = new Vec3(), tWorld = new Vec3(), tmp = new Vec3(), tmp2 = new Vec3();
  const rWorld = new Vec3(), wWorld = new Vec3(), pVel = new Vec3(), nrm = new Vec3(), fwd = new Vec3(), side = new Vec3(), cF = new Vec3();
  const Iw = new Vec3();

  class FlightModel {
    constructor(aircraft) {
      this.ac = aircraft;
      this.cfg = aircraft.cfg;
      // Rigid body state
      this.pos = new Vec3();
      this.vel = new Vec3();
      this.quat = new SIM.Quat();
      this.omega = new Vec3();   // body rates (rad/s)
      // Derived values (updated each step)
      this.alpha = 0;
      this.beta = 0;
      this.tas = 0;
      this.ias = 0;
      this.qbar = 0;
      this.mach = 0;
      this.cl = 0;
      this.cd = 0;
      this.stallFactor = 0;
      this.gLoad = 1;
      this.agl = 0;
      this.groundHeight = 0;
      this.onGround = false;
      this.wheelsOnGround = 0;
      this.gearContacts = [];
      this.groundEffect = 0;
      this.surface = 'grass';
      this.debugForces = { lift: new Vec3(), drag: new Vec3(), thrust: new Vec3(), weight: new Vec3() };
      this.time = 0;
      this.setupGear();
    }

    /** Spring and damper constants derived from mass and desired static compression. */
    setupGear() {
      const cfg = this.cfg;
      const mass = cfg.mass.maxTakeoff;
      const pts = cfg.gear.points;
      // Static load share from longitudinal geometry: nose carries less.
      const nose = pts.find((p) => p.id === 'nose');
      const mains = pts.filter((p) => p.id !== 'nose');
      const zMain = mains.reduce((s, p) => s + p.pos[2], 0) / mains.length;
      const noseShare = nose ? M.clamp(zMain / (zMain - nose.pos[2]), 0.08, 0.3) : 0;
      this.gear = pts.map((p) => {
        const share = p.id === 'nose' ? noseShare : (1 - noseShare) / mains.length;
        const load = mass * G * share;
        const k = load / p.compression;
        const c = 2 * p.damping * Math.sqrt(k * mass * share);
        return { id: p.id, r: new Vec3(p.pos[0], p.pos[1], p.pos[2]), k, c, steer: p.steer, brake: p.brake, compression: 0, onGround: false, maxCompression: p.compression * 3.5 };
      });
      this.contacts = cfg.gear.contacts.map((p) => ({ id: p.id, r: new Vec3(p.pos[0], p.pos[1], p.pos[2]), touching: false }));
      this.structK = (mass * G * 3) / 0.15;
      this.structC = 2 * 0.7 * Math.sqrt(this.structK * mass * 0.3);
      this.lowestGearY = Math.min(...pts.map((p) => p.pos[1]));
      // Cruise reference used for torque / P-factor rigging compensation
      const e0 = cfg.engines[0];
      const vC = cfg.performance.cruise * SIM.Units.KT;
      this.qCruise = 0.5 * 1.0 * vC * vC;
      const pC = e0.maxPower ? 0.7 * e0.maxPower : 0;
      this.refTorque = e0.maxPower ? pC / (0.92 * e0.maxRPM * Math.PI / 30) : 0;
      this.refPFactor = e0.maxPower ? (cfg.aero.pFactor || 0) * ((e0.propEff * pC) / vC) * cfg.geometry.span * 0.6 : 0;
    }

    /** Places the aircraft on the ground at (x, z) with heading h (rad), wheels resting on terrain. */
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
      // Velocity along the flight path (heading, small descent if pitch negative)
      this.vel.set(Math.sin(heading) * speed * Math.cos(pitch * 0.2), 0, -Math.cos(heading) * speed);
      this.omega.set(0, 0, 0);
      this.onGround = false;
    }

    /** Body axes in world coordinates. */
    forward(out = new Vec3()) {
      return out.set(0, 0, -1).applyQuat(this.quat);
    }

    /** Flap-dependent stall angle (rad). */
    stallAlpha(flap) {
      const a = this.cfg.aero;
      return a.alphaStallDeg * M.DEG - (flap.cl - flap.clmax) / a.clAlpha;
    }

    /** Lift coefficient with Beard–McLain sigmoid blending between attached and flat-plate flow. */
    liftCoefficient(alpha, flap) {
      const a = this.cfg.aero;
      const a0 = this.stallAlpha(flap);
      const a0n = a.alphaStallDeg * M.DEG * 0.85;
      const k = a.stallSharpness;
      const e1 = Math.exp(-k * (alpha - a0));
      const e2 = Math.exp(k * (alpha + a0n));
      const sigma = (1 + e1 + e2) / ((1 + e1) * (1 + e2));
      const sa = Math.sin(alpha), ca = Math.cos(alpha);
      const clAttached = a.cl0 + a.clAlpha * alpha + flap.cl;
      const clFlat = 2 * Math.sign(alpha) * sa * sa * ca * 1.1;
      this.stallFactor = M.clamp(sigma, 0, 1);
      return (1 - sigma) * clAttached + sigma * clFlat;
    }

    /**
     * Advances the simulation by dt seconds.
     * @param {number} dt
     * @param {object} env { terrain, atmosphereAt(y), windAt(pos, out), turbulence, time }
     */
    step(dt, env) {
      const ac = this.ac;
      const cfg = this.cfg;
      const a = cfg.aero;
      const geo = cfg.geometry;
      const sys = ac.systems;
      const ctl = ac.controls;
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
      const q = 0.5 * atm.rho * V * V;
      this.qbar = q;
      const S = geo.wingArea, b = geo.span, c = geo.chord;
      const Vd = Math.max(V, 4);

      let alpha = 0, beta = 0;
      if (V > 0.5) {
        alpha = Math.atan2(-vb.y, -vb.z);
        beta = Math.asin(M.clamp(vb.x / V, -1, 1));
      }
      this.alpha = alpha;
      this.beta = beta;

      /* ---------------- terrain below */
      const terrain = env.terrain;
      this.groundHeight = terrain.heightAt(this.pos.x, this.pos.z);
      this.agl = this.pos.y - this.groundHeight + this.lowestGearY;

      /* ---------------- aerodynamic coefficients */
      const flap = sys.flapAero();
      const sb = sys.speedbrake.pos;
      const gearPos = cfg.gear.retractable ? sys.gear.pos : 1;
      // Ground effect (Wieselsberger): reduces induced drag, slightly increases lift.
      let geInduced = 1, geLift = 1;
      if (a.groundEffect) {
        const hw = Math.max(0.2, this.agl + (geo.wingType === 'high' ? 1.6 : 0.6));
        const r = (16 * hw) / b;
        const phi = (r * r) / (1 + r * r);
        geInduced = phi;
        geLift = 1 + 0.12 * (1 - phi);
        this.groundEffect = 1 - phi;
      }
      let CL = this.liftCoefficient(alpha, flap) * geLift;
      if (sb > 0) CL += (a.clSpeedbrake || 0) * sb * (this.onGround ? 2.2 : 1);
      const sigma = this.stallFactor;
      const AR = (b * b) / S;
      const kInd = 1 / (Math.PI * a.oswald * AR);
      const sa = Math.sin(alpha);
      let CD = a.cd0 + (a.cdGear || 0) * gearPos + flap.cd + (a.cdSpeedbrake || 0) * sb + (1 - sigma) * kInd * CL * CL * geInduced + sigma * a.cdSeparated * sa * sa + 0.35 * beta * beta;
      if (a.machDrag && this.mach > 0.76) CD += 18 * Math.pow(this.mach - 0.76, 2);
      CD += ac.damage * 0.03;
      this.cl = CL;
      this.cd = CD;

      fBody.set(0, 0, 0);
      tBody.set(0, 0, 0);

      if (V > 0.5) {
        dir.copy(vb).scale(1 / V);
        // Drag opposes the relative wind
        fBody.addScaled(dir, -q * S * CD);
        this.debugForces.drag.copy(dir).scale(-q * S * CD);
        // Lift perpendicular to the relative wind in the symmetry plane
        liftDir.crossVectors(X_AXIS, dir);
        const ll = liftDir.length();
        if (ll > 0.05) {
          liftDir.scale(1 / ll);
          fBody.addScaled(liftDir, q * S * CL);
          this.debugForces.lift.copy(liftDir).scale(q * S * CL);
        }
        // Side force
        fBody.x += q * S * (a.cyBeta * beta + a.cyDr * (ctl.rudder + ctl.rudderTrim));
      }

      /* ---------------- thrust */
      let totalThrust = 0;
      const realism = ac.realismScale;
      for (const en of ac.engines) {
        const T = en.thrust * (1 - ac.damage * 0.2);
        totalThrust += Math.max(0, T);
        const p = en.cfg.position;
        // Force along -Z body at engine position: moment = r x F
        fBody.z -= T;
        tBody.x += p[1] * -T;          // r.y * Fz
        tBody.y -= p[0] * -T;          // -(r.x * Fz)
        if (en.kind === 'piston' && a.torqueRoll > 0) {
          // Reaction torque rolls left; wing rigging cancels it at cruise (scales with dynamic pressure)
          const rig = this.refTorque * Math.min(q / this.qCruise, 1.6);
          tBody.z += (en.torque - rig) * (en.cfg.rotation || 1) * realism;
        }
      }
      this.debugForces.thrust.set(0, 0, -totalThrust);

      /* ---------------- aerodynamic moments */
      if (V > 0.5) {
        const pRate = -this.omega.z;   // roll right positive
        const qRate = this.omega.x;    // pitch up positive
        const rRate = -this.omega.y;   // yaw right positive
        const qTail = q + (a.propwashTail * totalThrust) / S;
        const eff = 1 - ac.damage * 0.4;
        const de = ctl.elevator * eff, da = ctl.aileron * eff, dr = (ctl.rudder + ctl.rudderTrim) * eff;
        const flapFrac = sys.flaps.pos / Math.max(1, cfg.aero.flaps[cfg.aero.flaps.length - 1].deg);
        const turb = env.turbulence || 0;
        const tn = (o) => (SIM.Noise.valueNoise(this.time * 1.3 + o, o * 3.1) - 0.5) * 2 * turb;

        let Cm = a.cm0 + a.cmAlpha * Math.sin(alpha) + a.cmq * (qRate * c) / (2 * Vd) + a.cmFlap * flapFrac + tn(11) * 0.02;
        if (sb > 0) Cm += 0.01 * sb;
        // Post-stall pitch break and reduced tail authority when the flow separates
        Cm -= 0.12 * sigma * Math.sign(alpha);
        const tailEff = 1 - 0.5 * sigma;
        const pitchMoment = q * S * c * Cm + qTail * S * c * (a.cmDe * de * tailEff + a.cmTrim * ctl.elevatorTrim);

        const clP = a.clP * (1 - 1.15 * sigma);
        const wingDrop = sigma * (0.03 * Math.sign(beta + 1e-4) + tn(37) * 0.05);
        const Cl = a.clBeta * beta + (clP * pRate * b) / (2 * Vd) + (a.clR * rRate * b) / (2 * Vd) + wingDrop + tn(23) * 0.006;
        const rollMoment = q * S * b * (Cl + a.clDa * da) + qTail * S * b * a.clDr * dr;

        const Cn = a.cnBeta * beta + (a.cnR * rRate * b) / (2 * Vd) + (a.cnP * pRate * b) / (2 * Vd) + a.cnDa * da + tn(53) * 0.004;
        let yawMoment = q * S * b * Cn + qTail * S * b * a.cnDr * dr;
        // P-factor / slipstream: left-turning tendency of a clockwise propeller
        if (a.pFactor > 0) {
          // Fixed rudder tab offsets the left-turning tendency at cruise
          const pf = a.pFactor * totalThrust * b * (0.6 + 4 * Math.max(alpha, 0));
          yawMoment -= (pf - this.refPFactor * Math.min(q / this.qCruise, 1.6)) * realism;
        }

        tBody.x += pitchMoment;
        tBody.y -= yawMoment;
        tBody.z -= rollMoment;
      }

      /* ---------------- to world: aero + thrust + gravity */
      fWorld.copy(fBody).applyQuat(this.quat);
      fWorld.y -= mass * G;
      this.debugForces.weight.set(0, -mass * G, 0);
      tWorld.set(0, 0, 0);

      /* ---------------- ground contact */
      this.groundContacts(dt, env, fWorld, tWorld, gearPos);

      /* ---------------- load factor (non-gravitational accel along body up) */
      tmp.copy(fWorld);
      tmp.y += mass * G;
      tmp.applyQuatInverse(this.quat);
      this.gLoad = M.damp(this.gLoad, tmp.y / (mass * G), 20, dt);
      this.lateralG = tmp.x / (mass * G);

      /* ---------------- integrate linear motion */
      this.vel.addScaled(fWorld, dt / mass);
      this.pos.addScaled(this.vel, dt);

      /* ---------------- integrate rotation */
      tmp2.copy(tWorld).applyQuatInverse(this.quat);
      tBody.add(tmp2);
      const I = ac.inertia;
      const w = this.omega;
      // Euler's equations: I*dw = T - w x (I*w)
      Iw.set(I.pitch * w.x, I.yaw * w.y, I.roll * w.z);
      tmp.crossVectors(w, Iw);
      w.x += ((tBody.x - tmp.x) / I.pitch) * dt;
      w.y += ((tBody.y - tmp.y) / I.yaw) * dt;
      w.z += ((tBody.z - tmp.z) / I.roll) * dt;
      // Safety clamp (prevents numeric blow-ups in extreme crashes)
      const wl = w.length();
      if (wl > 8) w.scale(8 / wl);
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
        if (surf.type === 'water') {
          ac.registerImpact('water', Math.max(-vn, 0), pVel.length(), true);
          continue;
        }
        let Fn = g.k * pen - g.c * vn;
        if (Fn < 0) Fn = 0;
        g.compression = pen;
        g.onGround = true;
        wheels++;
        if (pen > g.maxCompression) ac.registerImpact('gear', Math.max(-vn, 0), pVel.length(), false);

        // Wheel heading: steerable nose wheel follows the rudder pedals
        tmp.copy(fwd);
        if (g.steer) {
          const cs = Math.cos(steerAngle), sn = Math.sin(steerAngle);
          // rotate forward around world up (approximation valid for small bank)
          const fx = tmp.x * cs - tmp.z * sn, fz = tmp.x * sn + tmp.z * cs;
          tmp.x = fx;
          tmp.z = fz;
        }
        // project onto ground plane
        tmp.addScaled(nrm, -tmp.dot(nrm)).normalize();
        side.crossVectors(nrm, tmp).normalize();
        const vt = pVel.clone().addScaled(nrm, -vn);
        const vLong = vt.dot(tmp);
        const vLat = vt.dot(side);

        let brake = 0;
        if (g.brake && !brakesFailed) {
          brake = parking ? 1 : g.r.x < 0 ? sys.brakes.left : sys.brakes.right;
        }
        const muLong = surf.roll + brake * surf.brake;
        const Flong = -M.sat(vLong / (brake > 0.9 && parking ? 0.08 : 0.35)) * muLong * Fn;
        const Flat = -M.sat(vLat / 0.45) * surf.lateral * Fn;

        cF.copy(nrm).scale(Fn).addScaled(tmp, Flong).addScaled(side, Flat);
        fWorld.add(cF);
        tWorld.add(tmp2.crossVectors(rWorld, cF));
      }

      // Structural contact points: fuselage, wingtips, propeller, tail
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
        const vt = pVel.clone().addScaled(nrm, -vn);
        const vtl = vt.length();
        cF.copy(nrm).scale(Fn);
        if (vtl > 0.01) cF.addScaled(vt, (-0.55 * Fn * M.sat(vtl / 0.5)) / vtl);
        fWorld.add(cF);
        tWorld.add(tmp2.crossVectors(rWorld, cF));
      }

      const wasOnGround = this.onGround;
      this.wheelsOnGround = wheels;
      this.onGround = wheels > 0 || this.contacts.some((c) => c.touching);
      if (surface) this.surface = surface.type;
      if (!wasOnGround && this.onGround) ac.onTouchdown();
      if (wasOnGround && !this.onGround) ac.onLiftoff();
      // Extra rolling damping when stopped to avoid creep (static friction)
      if (this.onGround && this.vel.length() < 0.05 && (parking || sys.brakes.left > 0.5)) {
        fWorld.x -= this.vel.x * mass * 4;
        fWorld.z -= this.vel.z * mass * 4;
      }
    }

    /** Heading, pitch and roll in radians. */
    attitude(out) {
      return SIM.quatToHPR(this.quat, out);
    }
  }

  SIM.FlightModel = FlightModel;
})(window.SIM);
