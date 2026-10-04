/**
 * CameraSystem — eight views: Cockpit, External (orbit), Chase, Wing, Tail, Free, Tower, Landing.
 * Handles head look, orbit, zoom, smoothing, buffet/turbulence shake, g-force head motion and the
 * cockpit projection offset that keeps the horizon above the 2D instrument panel.
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;
  const MODES = ['cockpit', 'external', 'chase', 'wing', 'tail', 'free', 'tower', 'landing'];
  const LABELS = { cockpit: 'COCKPIT', external: 'EXTERNAL', chase: 'CHASE', wing: 'WING', tail: 'TAIL', free: 'FREE CAMERA', tower: 'TOWER', landing: 'LANDING CAM' };

  class CameraSystem {
    constructor(session, render, settings) {
      this.session = session;
      this.render = render;
      this.settings = settings;
      this.camera = render ? render.camera : null;
      this.mode = settings.data.camera.defaultView === 'external' ? 'external' : 'cockpit';
      this.lastExternal = 'chase';
      this.head = { yaw: 0, pitch: -4 * M.DEG };
      this.orbit = { yaw: 200 * M.DEG, pitch: 12 * M.DEG, dist: 0 };
      this.fovZoom = 1;
      this.free = null;
      this.shake = 0;
      this.impulse = 0;
      this.panelFraction = 0;
      this.chasePos = null;
      if (!this.camera) return;
      this.tmpQ = new THREE.Quaternion();
      this.tmpQ2 = new THREE.Quaternion();
      this.tmpV = new THREE.Vector3();
      this.tmpV2 = new THREE.Vector3();
      this.euler = new THREE.Euler(0, 0, 0, 'YXZ');
      this.resetOrbit();
      session.scope.on('aircraft:touchdown', (td) => (this.impulse = Math.min(1, Math.abs(td.vsFpm) / 600)));
    }

    get label() {
      return LABELS[this.mode];
    }

    get isCockpit() {
      return this.mode === 'cockpit';
    }

    resetOrbit() {
      const L = this.session.aircraft.cfg.geometry.length;
      this.orbit.dist = Math.max(14, L * 1.9);
      this.orbit.yaw = 200 * M.DEG;
      this.orbit.pitch = 12 * M.DEG;
    }

    setMode(mode) {
      if (!MODES.includes(mode)) return;
      if (mode !== 'cockpit') this.lastExternal = mode;
      if (mode === 'free' && this.camera) {
        this.free = { pos: this.camera.position.clone(), yaw: this.euler.setFromQuaternion(this.camera.quaternion).y, pitch: this.euler.x };
      }
      this.mode = mode;
      this.fovZoom = 1;
      SIM.events.emit('camera:mode', { mode, label: LABELS[mode] });
    }

    cycle() {
      const i = MODES.indexOf(this.mode);
      this.setMode(MODES[(i + 1) % MODES.length]);
    }

    toggleCockpit() {
      this.setMode(this.mode === 'cockpit' ? this.lastExternal || 'chase' : 'cockpit');
    }

    resetView() {
      this.head.yaw = 0;
      this.head.pitch = -4 * M.DEG;
      this.fovZoom = 1;
      this.resetOrbit();
    }

    /** Look/orbit input in radians (mouse drag or arrow keys). */
    look(dx, dy) {
      const s = this.settings.data.camera.headLook;
      if (this.mode === 'cockpit') {
        this.head.yaw = M.clamp(this.head.yaw - dx * s, -2.6, 2.6);
        this.head.pitch = M.clamp(this.head.pitch - dy * s, -1.2, 1.3);
      } else if (this.mode === 'free' && this.free) {
        this.free.yaw -= dx * s;
        this.free.pitch = M.clamp(this.free.pitch - dy * s, -1.5, 1.5);
      } else {
        this.orbit.yaw -= dx * s;
        this.orbit.pitch = M.clamp(this.orbit.pitch + dy * s, -0.4, 1.45);
      }
    }

    zoom(factor) {
      if (this.mode === 'external' || this.mode === 'chase') {
        this.orbit.dist = M.clamp(this.orbit.dist * factor, 6, 600);
      } else {
        this.fovZoom = M.clamp(this.fovZoom * factor, 0.25, 1.6);
      }
    }

    /** Free camera translation in its own frame (m/s inputs). */
    moveFree(forward, right, up, dt) {
      if (this.mode !== 'free' || !this.free) return;
      const speed = 60 * dt * (1 + this.free.pos.y / 2000);
      const y = this.free.yaw;
      this.free.pos.x += (-Math.sin(y) * forward + Math.cos(y) * right) * speed;
      this.free.pos.z += (-Math.cos(y) * forward - Math.sin(y) * right) * speed;
      this.free.pos.y += up * speed;
    }

    nearestAirport() {
      const p = this.session.aircraft.fm.pos;
      let best = null, bd = Infinity;
      this.session.airports.forEach((ap) => {
        const d = Math.hypot(ap.x - p.x, ap.z - p.z);
        if (d < bd) {
          bd = d;
          best = ap;
        }
      });
      return best;
    }

    /**
     * @param {number} dt
     * @param {THREE.Vector3} pos interpolated aircraft position
     * @param {THREE.Quaternion} quat interpolated aircraft orientation
     */
    update(dt, pos, quat) {
      if (!this.camera) return;
      const cam = this.camera;
      const ac = this.session.aircraft;
      const cfg = ac.cfg;
      const camSet = this.settings.data.camera;
      const terrain = this.session.world.terrain;
      let fov = camSet.fov;

      // Shake sources: stall buffet, turbulence, rough ground, touchdown impulse
      const buffet = ac.fm.stallFactor * Math.min(1, ac.fm.qbar / 400);
      const ground = ac.onGround ? Math.min(1, ac.groundSpeed / 30) * (ac.fm.surface === 'grass' || ac.fm.surface === 'dirt' ? 0.6 : 0.12) : 0;
      const turb = this.session.world.weather.turbulenceAt(pos.y) * 0.25;
      this.impulse = Math.max(0, this.impulse - dt * 2.5);
      const shakeAmt = camSet.shake ? buffet * 0.6 + ground * 0.35 + turb + this.impulse * 0.8 : 0;
      const t = performance.now() / 1000;
      const sx = (Math.sin(t * 37.1) + Math.sin(t * 23.7)) * 0.5 * shakeAmt;
      const sy = (Math.sin(t * 41.3) + Math.sin(t * 29.9)) * 0.5 * shakeAmt;

      cam.near = this.mode === 'cockpit' ? 0.05 : 0.3;
      switch (this.mode) {
        case 'cockpit': {
          const eye = cfg.geometry.eye;
          const scale = cfg.visual.scale || 1;
          const gHead = camSet.gForceHead ? M.clamp((ac.fm.gLoad - 1) * -0.012, -0.05, 0.03) : 0;
          this.tmpV.set(eye[0] * scale, eye[1] * scale + gHead + sy * 0.004, eye[2] * scale).applyQuaternion(quat);
          cam.position.copy(pos).add(this.tmpV);
          this.euler.set(this.head.pitch + sy * 0.003, this.head.yaw + sx * 0.003, 0, 'YXZ');
          this.tmpQ.setFromEuler(this.euler);
          cam.quaternion.copy(quat).multiply(this.tmpQ);
          break;
        }
        case 'external':
        case 'chase': {
          // Offset direction theta is clockwise from north; behind the aircraft = heading + 180°
          const hpr = SIM.quatToHPR(ac.fm.quat);
          let base = hpr.heading;
          if (this.mode === 'chase') {
            const v = ac.fm.vel;
            if (v.horizontalLength() > 8) base = Math.atan2(v.x, -v.z);
            if (this.chaseYaw === undefined) this.chaseYaw = base;
            const diff = Math.atan2(Math.sin(base - this.chaseYaw), Math.cos(base - this.chaseYaw));
            this.chaseYaw += diff * (1 - Math.exp(-dt * (4 - camSet.chaseSmoothing * 3)));
            base = this.chaseYaw;
          }
          const theta = base + (this.mode === 'chase' ? Math.PI + (this.orbit.yaw - 200 * M.DEG) : this.orbit.yaw);
          const pitch = this.mode === 'chase' ? 0.08 + (this.orbit.pitch - 12 * M.DEG) : this.orbit.pitch;
          const d = this.orbit.dist * (this.mode === 'chase' ? 0.85 : 1);
          this.tmpV.set(Math.sin(theta) * Math.cos(pitch) * d, Math.sin(pitch) * d, -Math.cos(theta) * Math.cos(pitch) * d);
          const desired = this.tmpV2.copy(pos).add(this.tmpV);
          if (this.mode === 'chase') {
            if (!this.chasePos) this.chasePos = desired.clone();
            this.chasePos.lerp(desired, 1 - Math.exp(-dt * (10 - camSet.chaseSmoothing * 7)));
            cam.position.copy(this.chasePos);
          } else {
            cam.position.copy(desired);
          }
          this.clampAboveGround(cam.position, terrain);
          cam.up.set(0, 1, 0);
          cam.lookAt(pos.x, pos.y + (this.mode === 'chase' ? 1.2 : 0), pos.z);
          cam.rotateZ(sx * 0.002);
          break;
        }
        case 'wing': {
          const span = cfg.geometry.span / 2;
          const air = cfg.visual.model === 'airliner';
          const hy = cfg.geometry.wingType === 'high' ? 1.3 : air ? 0.5 : 0.1;
          this.tmpV.set(span + (air ? 1.5 : 0.8), hy, air ? 9 : 1.4).applyQuaternion(quat);
          cam.position.copy(pos).add(this.tmpV);
          this.euler.set(-0.12 + this.head.pitch * 0.3, 0.42 + this.head.yaw * 0.5, 0, 'YXZ');
          this.tmpQ.setFromEuler(this.euler);
          cam.quaternion.copy(quat).multiply(this.tmpQ);
          break;
        }
        case 'tail': {
          const air = cfg.visual.model === 'airliner';
          this.tmpV.set(0, air ? 9.5 : 2.5, air ? 22 : cfg.geometry.length * 0.62).applyQuaternion(quat);
          cam.position.copy(pos).add(this.tmpV);
          this.euler.set(-0.1 + this.head.pitch * 0.5, this.head.yaw * 0.5, 0, 'YXZ');
          this.tmpQ.setFromEuler(this.euler);
          cam.quaternion.copy(quat).multiply(this.tmpQ);
          break;
        }
        case 'free': {
          if (!this.free) this.free = { pos: cam.position.clone(), yaw: 0, pitch: 0 };
          this.clampAboveGround(this.free.pos, terrain);
          cam.position.copy(this.free.pos);
          this.euler.set(this.free.pitch, this.free.yaw, 0, 'YXZ');
          cam.quaternion.setFromEuler(this.euler);
          break;
        }
        case 'tower': {
          const ap = this.nearestAirport();
          const tw = ap.tower;
          cam.position.set(tw.x, ap.elev + tw.h + 5, tw.z);
          cam.up.set(0, 1, 0);
          cam.lookAt(pos);
          const dist = cam.position.distanceTo(pos);
          fov = M.clamp(Math.atan2(cfg.geometry.span * 2.2, dist) * 2 * M.RAD, 3, camSet.fov);
          break;
        }
        case 'landing': {
          const ap = this.nearestAirport();
          const w = this.session.world.weather.p;
          const end = SIM.Airports.activeRunway(ap, w.windDir, w.windKt);
          const side = end.runway.width / 2 + 45;
          cam.position.set(end.x + end.dirX * 380 + end.dirZ * side, ap.elev + 2.5, end.z + end.dirZ * 380 - end.dirX * side);
          cam.up.set(0, 1, 0);
          cam.lookAt(pos);
          const dist = cam.position.distanceTo(pos);
          fov = M.clamp(Math.atan2(cfg.geometry.span * 2.5, dist) * 2 * M.RAD, 2.5, camSet.fov);
          break;
        }
      }

      fov *= this.fovZoom;
      if (Math.abs(cam.fov - fov) > 0.01) cam.fov = fov;
      // Cockpit: shift the projection centre above the 2D panel
      const pf = this.mode === 'cockpit' ? this.panelFraction : 0;
      const w = this.render.width, h = this.render.height;
      if (pf > 0.02) {
        const P = Math.round(h * pf * 0.75);
        cam.setViewOffset(w, h + P, 0, P, w, h);
      } else if (cam.view && cam.view.enabled) {
        cam.clearViewOffset();
      }
      cam.updateProjectionMatrix();
    }

    clampAboveGround(p, terrain) {
      const g = terrain.heightAt(p.x, p.z) + 1.2;
      if (p.y < g) p.y = g;
    }

    /** Camera velocity for effects (rain streaks). */
    velocity() {
      return this.mode === 'free' || this.mode === 'tower' || this.mode === 'landing' ? { x: 0, y: 0, z: 0, length: () => 0 } : this.session.aircraft.fm.vel;
    }
  }

  SIM.CameraSystem = CameraSystem;
  SIM.CameraModes = MODES;
  SIM.CameraLabels = LABELS;
})(window.SIM);
