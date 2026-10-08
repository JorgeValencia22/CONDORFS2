/**
 * VirtualCockpit — fully modelled, clickable 3D cockpit (the default cockpit view).
 *
 *  - Cabin shell built from the real fuselage cross-sections, with true window openings, frames,
 *    seats, floor, glareshield and the engine cowling visible over the nose.
 *  - Instrument panel per layout (GA six-pack, GA twin, 737 glass cockpit). Every instrument is the
 *    same simulation-driven canvas instrument as the 2D panel, rendered at texture resolution.
 *  - Avionics (COM/NAV, transponder, GPS, autopilot, 737 MCP, annunciators, clock) drawn live on
 *    canvas faceplates with working buttons and knobs (click, right-click, mouse wheel, drag).
 *  - Animated, interactive 3D controls: yoke (drag to fly), rudder pedals and toe brakes,
 *    throttle/propeller/mixture, carb heat, flaps, trim wheel, magneto key with spring-loaded START,
 *    fuel selector, parking brake, gear handle, speed brake, fuel-control and start switches,
 *    electrical and light switches.
 *
 * Body axes: x right, y up, z aft. The cockpit group is a child of the aircraft model.
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;
  const D2R = Math.PI / 180;
  const FONT = '"Barlow Condensed", "Arial Narrow", Arial, sans-serif';
  const MONO = '"JetBrains Mono", "Consolas", monospace';
  const SWITCH_TEXT = { batt: 'BAT', alt: 'ALT', gen: 'GEN', avionics: 'AVIONICS', beacon: 'BCN', land: 'LAND', taxi: 'TAXI', nav: 'NAV', strobe: 'STROBE', pitot: 'PITOT HT', panel: 'PANEL LT', pump: 'FUEL PUMP', logo: 'LOGO' };
  const sound = () => SIM.app && SIM.app.audio;
  const click = (v = 0.8) => sound() && sound().click && sound().click(v);

  /* ================================================================== geometry helpers */

  /**
   * Lofted fuselage between zA and zB from the configured cross-sections, scaled radially.
   * UVs: u along the whole fuselage length (same as the livery), v = 1 - a around.
   */
  function fuselageLoft(cfg, zA, zB, radial, radialScale, uvRange) {
    const fs = cfg.fuselage.sections;
    const z0 = fs[0][0], z1 = fs[fs.length - 1][0];
    const zs = [];
    const n = Math.max(2, Math.ceil((zB - zA) / 0.06));
    for (let i = 0; i <= n; i++) zs.push(M.lerp(zA, zB, i / n));
    const pos = [], uv = [], idx = [];
    const [ua, ub] = uvRange || [0, 1];
    zs.forEach((z) => {
      const s = SIM.AircraftModelBuilder.fuselageAt(cfg, z);
      const ring = fs.find((r) => r[0] >= z) || fs[fs.length - 1];
      const e = 2 / (ring[4] || 2);
      for (let k = 0; k <= radial; k++) {
        const a = k / radial;
        const t = a * Math.PI * 2;
        const x = (s.w / 2) * radialScale * Math.sign(Math.sin(t)) * Math.pow(Math.abs(Math.sin(t)), e);
        const y = -(s.h / 2) * radialScale * Math.sign(Math.cos(t)) * Math.pow(Math.abs(Math.cos(t)), e) + s.y;
        pos.push(x, y, z);
        const u = (z - z0) / (z1 - z0);
        uv.push((u - ua) / (ub - ua), 1 - a);
      }
    });
    const ring = radial + 1;
    for (let i = 0; i < zs.length - 1; i++) {
      for (let k = 0; k < radial; k++) {
        const a = i * ring + k, b = a + 1, c = a + ring, d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  function box(w, h, d, mat) {
    return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  }

  function cyl(r0, r1, h, mat, seg = 16) {
    return new THREE.Mesh(new THREE.CylinderGeometry(r0, r1, h, seg), mat);
  }

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(2, Math.round(w));
    c.height = Math.max(2, Math.round(h));
    return c;
  }

  function canvasTexture(c) {
    const t = new THREE.CanvasTexture(c);
    t.anisotropy = SIM.Textures.maxAnisotropy || 4;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    return t;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ================================================================== canvas faceplates */

  /**
   * A flat avionics unit or display with a live canvas face. Clickable regions are defined in
   * canvas pixels; the raycast UV is mapped back onto them.
   */
  class CanvasUnit {
    constructor(vc, o) {
      this.vc = vc;
      this.w = o.w;
      this.h = o.h;
      const ppm = o.ppm || vc.ppmUnit;
      this.cw = Math.round(o.w * ppm);
      this.ch = Math.round(o.h * ppm);
      this.canvas = makeCanvas(this.cw, this.ch);
      this.ctx = this.canvas.getContext('2d');
      this.tex = canvasTexture(this.canvas);
      this.drawFn = o.draw;
      this.regions = [];
      this.rate = o.rate || 0.1;
      this.t = 1e9;
      this.hover = null;
      this.lit = o.lit !== false;
      this.mat = new THREE.MeshBasicMaterial({ map: this.tex });
      this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(o.w, o.h), this.mat);
      this.mesh.userData.unit = this;
      vc.units.push(this);
      vc.pickables.push(this.mesh);
    }
    /** Region in canvas pixels: { x, y, w, h, tip, click(button), wheel(dir), hold: {down, up} } */
    region(r) {
      this.regions.push(r);
      return r;
    }
    hit(uv) {
      const px = uv.x * this.cw, py = (1 - uv.y) * this.ch;
      return this.regions.find((r) => px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) || null;
    }
    update(dt, force) {
      this.t += dt;
      if (!force && this.t < this.rate) return;
      this.t = 0;
      this.drawFn(this.ctx, this);
      // hover outline for the region under the pointer
      if (this.hover) {
        const r = this.hover;
        this.ctx.strokeStyle = 'rgba(120, 200, 255, 0.9)';
        this.ctx.lineWidth = Math.max(2, this.cw / 260);
        roundRect(this.ctx, r.x + 1, r.y + 1, r.w - 2, r.h - 2, Math.min(r.w, r.h) * 0.15);
        this.ctx.stroke();
      }
      this.tex.needsUpdate = true;
    }
  }

  /** Draws a push button with a label (and optional annunciator LED). */
  function drawButton(ctx, r, label, { lit = false, led = false, size } = {}) {
    const g = ctx.createLinearGradient(0, r.y, 0, r.y + r.h);
    g.addColorStop(0, '#3a3d42');
    g.addColorStop(1, '#202226');
    ctx.fillStyle = g;
    roundRect(ctx, r.x, r.y, r.w, r.h, Math.min(r.w, r.h) * 0.18);
    ctx.fill();
    ctx.strokeStyle = '#0c0d0f';
    ctx.lineWidth = 2;
    ctx.stroke();
    if (led) {
      ctx.fillStyle = lit ? '#7dff7a' : '#1d2a1d';
      ctx.fillRect(r.x + r.w * 0.3, r.y + r.h * 0.12, r.w * 0.4, r.h * 0.12);
    }
    ctx.fillStyle = lit && !led ? '#7dff7a' : '#e9e7e1';
    ctx.font = `700 ${size || Math.round(r.h * 0.38)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, r.x + r.w / 2, r.y + r.h * (led ? 0.62 : 0.53));
  }

  /** Draws a rotary knob (concentric) at a region. */
  function drawKnob(ctx, r, label) {
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2, rad = Math.min(r.w, r.h) * 0.42;
    const g = ctx.createRadialGradient(cx - rad * 0.3, cy - rad * 0.3, rad * 0.1, cx, cy, rad);
    g.addColorStop(0, '#5a5e65');
    g.addColorStop(1, '#141517');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#2c2e33';
    ctx.lineWidth = 2;
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * rad * 0.8, cy + Math.sin(a) * rad * 0.8);
      ctx.lineTo(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad);
      ctx.stroke();
    }
    ctx.fillStyle = '#2a2c30';
    ctx.beginPath();
    ctx.arc(cx, cy, rad * 0.55, 0, Math.PI * 2);
    ctx.fill();
    if (label) {
      ctx.fillStyle = '#cfcdc6';
      ctx.font = `700 ${Math.round(rad * 0.55)}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(label, cx, r.y + r.h - rad * 0.1 > r.y + r.h ? r.y + r.h : cy + rad * 1.02);
    }
  }

  function unitBackground(ctx, u, title) {
    const g = ctx.createLinearGradient(0, 0, 0, u.ch);
    g.addColorStop(0, '#2b2e33');
    g.addColorStop(1, '#1b1d20');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, u.cw, u.ch);
    ctx.strokeStyle = '#0b0c0d';
    ctx.lineWidth = Math.max(3, u.cw / 140);
    ctx.strokeRect(0, 0, u.cw, u.ch);
    if (title) {
      ctx.fillStyle = '#9fa3a9';
      ctx.font = `600 ${Math.round(u.ch * 0.09)}px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(title, u.cw * 0.02, u.ch * 0.03);
    }
  }

  function lcd(ctx, x, y, w, h, on) {
    ctx.fillStyle = on ? '#0b1410' : '#06080a';
    roundRect(ctx, x, y, w, h, h * 0.08);
    ctx.fill();
  }

  /* ================================================================== the cockpit */

  class VirtualCockpit {
    constructor(session, panel) {
      this.s = session;
      this.ac = session.aircraft;
      this.cfg = this.ac.cfg;
      this.panel2d = panel;
      this.layout = this.cfg.cockpit.layout;
      this.air = this.layout === 'airliner';
      this.units = [];
      this.instruments = [];
      this.pickables = [];
      this.animators = [];
      this.hover = null;
      this.drag = null;
      this.instTimer = 0;
      const mobile = SIM.MobileControls && SIM.MobileControls.isTouch && SIM.MobileControls.isTouch();
      this.texDensity = mobile ? 1.7 : 2.4;    // instrument canvas pixels per logical pixel
      this.ppmPanel = mobile ? 1000 : 1500;   // panel face texture, pixels per metre
      this.ppmUnit = mobile ? 2200 : 3200;    // avionics faceplates, pixels per metre
      this.group = new THREE.Group();
      this.group.name = 'virtual-cockpit';
      this.raycaster = new THREE.Raycaster();
      this.ndc = new THREE.Vector2();
      this.materials();
      this.geometry();
      this.buildShell();
      if (this.air) this.buildAirliner();
      else this.buildGA(this.layout === 'ga-twin');
      this.group.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = false;
          o.receiveShadow = false;
        }
      });
      // panel flood light (panel lights switch, at night)
      this.flood = new THREE.PointLight(0xffd9a8, 0, this.air ? 3.5 : 2.2, 1.6);
      this.flood.position.set(this.eye.x * 0.5, this.eye.y + 0.25, this.eye.z - 0.2);
      this.group.add(this.flood);
    }

    /* ------------------------------------------------------------------ setup */

    materials() {
      const c = this.cfg.cockpit;
      const air = this.air;
      this.mat = {
        panel: new THREE.MeshLambertMaterial({ color: 0xffffff }),
        glare: new THREE.MeshLambertMaterial({ color: air ? 0x2b2f33 : 0x1d1e20 }),
        dark: new THREE.MeshLambertMaterial({ color: 0x18191b }),
        black: new THREE.MeshPhongMaterial({ color: 0x0f1012, specular: 0x333333, shininess: 40 }),
        metal: new THREE.MeshPhongMaterial({ color: 0x9a9ea4, specular: 0x888888, shininess: 60 }),
        chrome: new THREE.MeshPhongMaterial({ color: 0xc9ccd0, specular: 0xffffff, shininess: 90 }),
        seat: new THREE.MeshLambertMaterial({ color: air ? 0x3a3f47 : 0x5a5248 }),
        seatDark: new THREE.MeshLambertMaterial({ color: air ? 0x2a2e34 : 0x3e3832 }),
        floor: new THREE.MeshLambertMaterial({ color: air ? 0x34383d : 0x3a3633 }),
        red: new THREE.MeshPhongMaterial({ color: 0xa3231b, shininess: 50 }),
        blue: new THREE.MeshPhongMaterial({ color: 0x1f4fa0, shininess: 50 }),
        white: new THREE.MeshPhongMaterial({ color: 0xe8e6e0, shininess: 30 }),
        yoke: new THREE.MeshPhongMaterial({ color: air ? 0x3b3e43 : 0x26282c, specular: 0x444444, shininess: 35 }),
        pedestal: new THREE.MeshLambertMaterial({ color: c.panelColor }),
      };
      this.panelColor = c.panelColor;
    }

    /** Key cockpit dimensions from the aircraft geometry. */
    geometry() {
      const cfg = this.cfg;
      const [ex, ey, ez] = cfg.geometry.eye;
      this.eye = new THREE.Vector3(ex, ey, ez);
      const at = (z) => SIM.AircraftModelBuilder.fuselageAt(cfg, z);
      this.panelZ = ez - (this.air ? 0.98 : 0.74);
      const fp = at(this.panelZ);
      this.halfW = fp.w / 2 * 0.93;
      const fe = at(ez);
      this.floorY = fe.y - fe.h / 2 + (this.air ? 0.42 : 0.14);
      this.panelTop = ey - (this.air ? 0.2 : 0.13);
      this.panelBottom = Math.max(this.floorY + (this.air ? 0.55 : 0.32), ey - (this.air ? 0.98 : 0.74));
      this.Hp = this.panelTop - this.panelBottom;
      this.tilt = (this.air ? 12 : 7) * D2R;
    }

    /* ------------------------------------------------------------------ cabin shell */

    /** Window openings in (z, around-fraction a) per layout; a = 0.25 right side, 0.5 top. */
    windows() {
      const ez = this.eye.z;
      const seats = parseInt(this.cfg.capacity, 10) || 4;
      switch (this.cfg.visual.model) {
        case 'highwing':
          return [
            { z0: ez - 0.98, z1: ez - 0.37, a0: 0.29, a1: 0.71, r: 0.05 },
            { z0: ez - 0.33, z1: ez + (seats <= 2 ? 0.48 : 0.62), a0: 0.27, a1: 0.44, r: 0.04, side: true },
            { z0: ez + (seats <= 2 ? 0.58 : 0.74), z1: ez + (seats <= 2 ? 0.95 : 1.22), a0: 0.3, a1: 0.425, r: 0.06, side: true },
          ];
        case 'lowwing':
          return [
            { z0: ez - 0.98, z1: ez - 0.37, a0: 0.3, a1: 0.7, r: 0.05 },
            { z0: ez - 0.33, z1: ez + 0.72, a0: 0.3, a1: 0.455, r: 0.04, side: true },
            { z0: ez + 0.82, z1: ez + 1.18, a0: 0.32, a1: 0.44, r: 0.06, side: true },
          ];
        case 'twin': {
          const list = [
            { z0: ez - 0.98, z1: ez - 0.3, a0: 0.3, a1: 0.7, r: 0.05 },
            { z0: ez - 0.26, z1: ez + 0.42, a0: 0.3, a1: 0.45, r: 0.04, side: true },
          ];
          for (let i = 0; i < 4; i++) list.push({ z0: ez + 0.75 + i * 0.62, z1: ez + 1.13 + i * 0.62, a0: 0.33, a1: 0.42, r: 0.1, side: true });
          return list;
        }
        default:
          return [
            // two front panes split by the centre post, then the side windows (No. 2 and No. 3)
            { z0: ez - 1.32, z1: ez - 0.62, a0: 0.505, a1: 0.655, r: 0.03 },
            { z0: ez - 1.32, z1: ez - 0.62, a0: 0.345, a1: 0.495, r: 0.03 },
            { z0: ez - 0.58, z1: ez - 0.05, a0: 0.335, a1: 0.43, r: 0.03, side: true },
            { z0: ez + 0.0, z1: ez + 0.32, a0: 0.335, a1: 0.425, r: 0.04, side: true },
            { z0: ez + 0.38, z1: ez + 0.82, a0: 0.34, a1: 0.42, r: 0.04, side: true },
          ];
      }
    }

    buildShell() {
      const cfg = this.cfg;
      const fs = cfg.fuselage.sections;
      const fz0 = fs[0][0], fz1 = fs[fs.length - 1][0];
      const ez = this.eye.z;
      const zA = this.panelZ - (this.air ? 0.6 : 0.35);
      const zB = Math.min(fz1 - 0.3, ez + (this.air ? 1.6 : (this.cfg.visual.model === 'twin' ? 3.3 : 2.0)));
      const ua = (zA - fz0) / (fz1 - fz0), ub = (zB - fz0) / (fz1 - fz0);
      // Interior texture: trim colours with alpha holes for the windows and dark frames
      const W = 2048, H = 1024;
      const c = makeCanvas(W, H);
      const ctx = c.getContext('2d');
      const air = this.air;
      const grad = ctx.createLinearGradient(0, 0, 0, H);
      // canvas y = a (0 bottom … 0.5 top … 1 bottom)
      const head = air ? '#c9ccd0' : '#cdc6b8';
      const wall = air ? '#a7acb2' : '#8e877b';
      const low = air ? '#5b6168' : '#4a453f';
      grad.addColorStop(0, low);
      grad.addColorStop(0.2, low);
      grad.addColorStop(0.27, wall);
      grad.addColorStop(0.4, head);
      grad.addColorStop(0.6, head);
      grad.addColorStop(0.73, wall);
      grad.addColorStop(0.8, low);
      grad.addColorStop(1, low);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
      // padded panel seams
      ctx.strokeStyle = 'rgba(0,0,0,0.12)';
      ctx.lineWidth = 2;
      for (let z = Math.ceil(zA / 0.35) * 0.35; z < zB; z += 0.35) {
        const x = ((z - zA) / (zB - zA)) * W;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H);
        ctx.stroke();
      }
      const toX = (z) => ((z - zA) / (zB - zA)) * W;
      const holes = [];
      this.windows().forEach((w) => {
        const rects = w.side ? [[w.a0, w.a1], [1 - w.a1, 1 - w.a0]] : [[w.a0, w.a1]];
        rects.forEach(([a0, a1]) => holes.push({ x0: toX(w.z0), x1: toX(w.z1), y0: a0 * H, y1: a1 * H, r: w.r * W / (zB - zA) * 0.25 }));
      });
      // frames
      ctx.fillStyle = air ? '#3d4248' : '#2d2a27';
      holes.forEach((hl) => {
        roundRect(ctx, hl.x0 - 14, hl.y0 - 14, hl.x1 - hl.x0 + 28, hl.y1 - hl.y0 + 28, hl.r + 10);
        ctx.fill();
      });
      ctx.globalCompositeOperation = 'destination-out';
      holes.forEach((hl) => {
        roundRect(ctx, hl.x0, hl.y0, hl.x1 - hl.x0, hl.y1 - hl.y0, hl.r);
        ctx.fill();
      });
      ctx.globalCompositeOperation = 'source-over';
      const tex = canvasTexture(c);
      // interior surfaces get light bounced from outside through the windows (daylight-scaled)
      const shellMat = new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.5, side: THREE.BackSide, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.3 });
      this.bounceMats = [shellMat];
      const shell = new THREE.Mesh(fuselageLoft(cfg, zA, zB, 72, 0.965, [ua, ub]), shellMat);
      this.group.add(shell);
      // windshield centre post / compass bar (GA) and glass tint
      const glassMat = new THREE.MeshPhongMaterial({ color: 0x9fb8c8, transparent: true, opacity: 0.06, specular: 0xffffff, shininess: 120, depthWrite: false, side: THREE.BackSide });
      const glass = new THREE.Mesh(fuselageLoft(cfg, zA, zB, 72, 0.985, [ua, ub]), glassMat);
      glass.renderOrder = 5;
      this.group.add(glass);
      // Rear bulkhead and firewall
      const rear = SIM.AircraftModelBuilder.fuselageAt(cfg, zB);
      const rb = new THREE.Mesh(new THREE.CircleGeometry(1, 36), new THREE.MeshLambertMaterial({ color: wall, side: THREE.DoubleSide }));
      rb.scale.set(rear.w / 2 * 0.97, rear.h / 2 * 0.97, 1);
      rb.position.set(0, rear.y, zB - 0.01);
      this.group.add(rb);
      // Floor
      const fl = box(this.halfW * 2 * 1.02, 0.03, zB - this.panelZ, this.mat.floor);
      fl.position.set(0, this.floorY - 0.015, (zB + this.panelZ) / 2);
      this.group.add(fl);
      // Engine cowling seen over the nose (the exterior fuselage is hidden in the cockpit view)
      // the cowling ends where the windshield starts
      const noseEnd = Math.min(this.panelZ - 0.05, this.windows()[0].z0 + 0.02);
      if (noseEnd > fz0 + 0.1) {
        const nose = new THREE.Mesh(fuselageLoft(cfg, fz0, noseEnd, 48, 1.0, [0, 1]), new THREE.MeshPhongMaterial({ color: this.cfg.visual.base, specular: 0x555555, shininess: 50 }));
        // keep only the part of the nose that is outside the cabin (whole nose for singles)
        this.group.add(nose);
      }
      this.buildSeats();
    }

    buildSeats() {
      const ez = this.eye.z, ex = Math.abs(this.eye.x);
      const fy = this.floorY;
      const seat = (x, z, wide = 0.48) => {
        const g = new THREE.Group();
        const cushion = box(wide, 0.1, 0.5, this.mat.seat);
        cushion.position.set(0, 0.32, 0);
        const back = box(wide, 0.68, 0.11, this.mat.seat);
        back.position.set(0, 0.7, 0.27);
        back.rotation.x = -0.18;
        const head = box(wide * 0.6, 0.18, 0.1, this.mat.seatDark);
        head.position.set(0, 1.12, 0.33);
        const base = box(wide * 0.8, 0.27, 0.42, this.mat.dark);
        base.position.set(0, 0.135, 0);
        g.add(cushion, back, head, base);
        g.position.set(x, fy, z);
        this.group.add(g);
      };
      const zSeat = ez + (this.air ? 0.36 : 0.3);
      seat(-ex, zSeat, this.air ? 0.55 : 0.46);
      seat(ex, zSeat, this.air ? 0.55 : 0.46);
      const seats = parseInt(this.cfg.capacity, 10) || 4;
      if (!this.air && seats >= 4) {
        if (this.cfg.visual.model === 'twin') {
          seat(-ex, ez + 1.4);
          seat(ex, ez + 1.4);
        } else seat(0, ez + 1.25, this.halfW * 1.7);
      }
    }

    /* ------------------------------------------------------------------ panel */

    /**
     * Panel group: local x right, y up along the panel face, z towards the pilot. The face is a
     * canvas texture where placards, sub-panels and instrument recesses are painted.
     */
    makePanel(width, height, decorate) {
      const g = new THREE.Group();
      g.position.set(0, (this.panelTop + this.panelBottom) / 2, this.panelZ);
      g.rotation.x = -this.tilt;
      this.group.add(g);
      const cw = Math.round(width * this.ppmPanel), ch = Math.round(height * this.ppmPanel);
      const c = makeCanvas(cw, ch);
      const ctx = c.getContext('2d');
      const tex = canvasTexture(c);
      const mat = new THREE.MeshLambertMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.2 });
      this.bounceMats.push(mat);
      const face = new THREE.Mesh(new THREE.PlaneGeometry(width, height), mat);
      g.add(face);
      // body of the panel (thickness) behind the face
      const back = box(width, height, 0.12, this.mat.dark);
      back.position.z = -0.061;
      g.add(back);
      const P = {
        group: g, width, height, ctx, cw, ch, tex,
        // panel metres -> canvas pixels
        px: (x) => (x / width + 0.5) * cw,
        py: (y) => (0.5 - y / height) * ch,
        labels: [],
      };
      P.label = (text, x, y, size = 0.012, color = '#e7e4dc', align = 'center') => P.labels.push({ text, x, y, size, color, align });
      P.recess = [];
      P.paint = () => {
        const bg = ctx.createLinearGradient(0, 0, 0, ch);
        bg.addColorStop(0, shade(this.panelColor, 1.08));
        bg.addColorStop(1, shade(this.panelColor, 0.86));
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, cw, ch);
        // fine texture
        for (let i = 0; i < 1800; i++) {
          ctx.fillStyle = `rgba(${Math.random() < 0.5 ? '255,255,255' : '0,0,0'},0.025)`;
          ctx.fillRect(Math.random() * cw, Math.random() * ch, 2, 2);
        }
        if (decorate) decorate(ctx, P);
        // instrument recesses (shadow rings)
        P.recess.forEach((r) => {
          ctx.fillStyle = 'rgba(0,0,0,0.55)';
          if (r.round) {
            ctx.beginPath();
            ctx.arc(P.px(r.x), P.py(r.y), (r.d / 2 + 0.004) * this.ppmPanel, 0, Math.PI * 2);
            ctx.fill();
          } else {
            roundRect(ctx, P.px(r.x - r.w / 2 - 0.004), P.py(r.y + r.h / 2 + 0.004), (r.w + 0.008) * this.ppmPanel, (r.h + 0.008) * this.ppmPanel, 0.004 * this.ppmPanel);
            ctx.fill();
          }
        });
        // screws on the panel corners
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        [[0.02, 0.02], [0.98, 0.02], [0.02, 0.98], [0.98, 0.98]].forEach(([u, v]) => {
          ctx.beginPath();
          ctx.arc(u * cw, v * ch, 0.004 * this.ppmPanel, 0, Math.PI * 2);
          ctx.fill();
        });
        P.labels.forEach((l) => {
          ctx.fillStyle = l.color;
          ctx.font = `700 ${Math.round(l.size * this.ppmPanel)}px ${FONT}`;
          ctx.textAlign = l.align;
          ctx.textBaseline = 'middle';
          ctx.fillText(l.text, P.px(l.x), P.py(l.y));
        });
        tex.needsUpdate = true;
      };
      return P;
    }

    /** Places a live instrument from the 2D panel spec on a panel. */
    instrument(P, key, x, y, d, { round = true, w, h } = {}) {
      const spec = this.panel2d && this.panel2d.spec[key];
      if (!spec) return null;
      SIM.UI.canvasPixelRatio = this.texDensity;
      let gauge;
      try {
        gauge = spec.factory();
      } finally {
        SIM.UI.canvasPixelRatio = null;
      }
      const tex = canvasTexture(gauge.canvas);
      const mat = new THREE.MeshBasicMaterial({ map: tex });
      const geo = round ? new THREE.CircleGeometry(d / 2, 48) : new THREE.PlaneGeometry(w, h);
      if (round) {
        // circle UVs cover the square canvas
        const uv = geo.attributes.uv;
        const p = geo.attributes.position;
        for (let i = 0; i < uv.count; i++) uv.setXY(i, p.getX(i) / d + 0.5, p.getY(i) / d + 0.5);
      }
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, 0.003);
      P.group.add(m);
      P.recess.push(round ? { round: true, x, y, d } : { x, y, w, h });
      this.instruments.push({ gauge, data: spec.data, tex, mat, key, t: 0, rate: /asi|ai|alt|hi|vsi|tc|pfd/.test(key) ? 0 : 0.08 });
      return m;
    }

    /** Registers a 3D interactive object. */
    hot(obj, h) {
      obj.traverse((o) => {
        if (o.isMesh) {
          o.userData.hot = h;
          this.pickables.push(o);
          if (o.material && !o.material.userData.cloned) {
            o.material = o.material.clone();
            o.material.userData.cloned = true;
          }
        }
      });
      h.root = obj;
      return obj;
    }

    /* ------------------------------------------------------------------ shared controls */

    /** Rocker/toggle switch on a panel; returns the toggle mesh. */
    toggleSwitch(P, x, y, label, get, toggle, { red = false } = {}) {
      const base = box(0.022, 0.03, 0.006, this.mat.dark);
      base.position.set(x, y, 0.003);
      P.group.add(base);
      const lever = new THREE.Group();
      const bat = box(0.012, 0.026, 0.012, red ? this.mat.red : this.mat.white);
      bat.position.set(0, 0, 0.008);
      lever.add(bat);
      lever.position.set(x, y, 0.006);
      P.group.add(lever);
      P.label(label, x, y - 0.026, 0.0085);
      this.hot(lever, { tip: () => `${label}: ${get() ? 'ON' : 'OFF'}`, click: () => {
        toggle();
        click();
      } });
      this.animators.push(() => (lever.rotation.x = get() ? -0.38 : 0.38));
      return lever;
    }

    /** Rotary knob on a panel: wheel / left / right click step a function. */
    knob(P, x, y, r, label, step, { tip } = {}) {
      const k = cyl(r, r * 1.05, 0.014, this.mat.black, 20);
      k.rotation.x = Math.PI / 2;
      k.position.set(x, y, 0.009);
      P.group.add(k);
      const cap = cyl(r * 0.55, r * 0.55, 0.004, this.mat.metal, 16);
      cap.rotation.x = Math.PI / 2;
      cap.position.set(x, y, 0.017);
      P.group.add(cap);
      if (label) P.label(label, x, y - r - 0.009, 0.0075);
      let ang = 0;
      const group = new THREE.Group();
      group.add(k, cap);
      P.group.add(group);
      this.hot(group, {
        tip: () => (tip ? tip() : label),
        click: (b, e) => {
          step(b === 2 ? -1 : 1, e && e.shiftKey);
          ang += b === 2 ? -0.3 : 0.3;
          k.rotation.y = ang;
          click(0.5);
        },
        wheel: (d, e) => {
          step(d, e && e.shiftKey);
          ang += d * 0.3;
          k.rotation.y = ang;
        },
        dragX: (n) => step(n, false),
      });
      return group;
    }

    /** Push-pull engine control knob (Cessna style): drag up/down; value 0 (out) … 1 (in). */
    pushPull(P, x, y, label, mat, get, set, { tip } = {}) {
      const g = new THREE.Group();
      const shaft = cyl(0.0045, 0.0045, 0.12, this.mat.chrome, 10);
      shaft.rotation.x = Math.PI / 2;
      shaft.position.z = -0.04;
      const knobM = cyl(0.016, 0.016, 0.02, mat, 18);
      knobM.rotation.x = Math.PI / 2;
      knobM.position.z = 0.025;
      g.add(shaft, knobM);
      g.position.set(x, y, 0);
      P.group.add(g);
      P.label(label, x, y - 0.026, 0.0085);
      this.hot(g, { tip: () => (tip ? tip() : `${label} ${Math.round(get() * 100)}%`), cursor: 'ns-resize', drag: (dx, dy) => set(M.clamp(get() - dy / 180, 0, 1)), wheel: (d) => set(M.clamp(get() + d * 0.05, 0, 1)) });
      this.animators.push(() => (g.position.z = (1 - get()) * 0.075));
      return g;
    }

    /** Quadrant lever pivoting about a horizontal axis below the panel or on a pedestal. */
    quadrantLever(parent, x, y, z, label, mat, get, set, { len = 0.12, tip, range = 50, knobShape = 'ball' } = {}) {
      const pivot = new THREE.Group();
      pivot.position.set(x, y, z);
      const arm = box(0.012, len, 0.012, this.mat.metal);
      arm.position.y = len / 2;
      const head = knobShape === 'tbar' ? box(0.06, 0.022, 0.03, mat) : knobShape === 'wheel' ? cyl(0.018, 0.018, 0.015, mat, 18) : new THREE.Mesh(new THREE.SphereGeometry(0.018, 16, 10), mat);
      head.position.y = len;
      if (knobShape === 'wheel') head.rotation.z = Math.PI / 2;
      pivot.add(arm, head);
      parent.add(pivot);
      this.hot(pivot, { tip: () => (tip ? tip() : `${label} ${Math.round(get() * 100)}%`), cursor: 'ns-resize', drag: (dx, dy) => set(M.clamp(get() - dy / 200, 0, 1)), wheel: (d) => set(M.clamp(get() + d * 0.04, 0, 1)) });
      // 0 = lever back (towards the pilot), 1 = full forward
      this.animators.push(() => (pivot.rotation.x = (-range / 2 + range * get()) * -D2R));
      return pivot;
    }

    yoke(x, panelP, { column = 'panel' } = {}) {
      const air = this.air;
      const ctl = this.ac.controls;
      const g = new THREE.Group();
      const wheel = new THREE.Group();
      const mat = this.mat.yoke;
      if (air) {
        // 737: column from the floor, wheel with two handles
        const rim = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.016, 10, 40, Math.PI * 1.25), mat);
        rim.rotation.z = -Math.PI * 0.125 + Math.PI;
        const hub = cyl(0.04, 0.04, 0.05, mat, 16);
        hub.rotation.x = Math.PI / 2;
        const bar = box(0.3, 0.03, 0.025, mat);
        bar.position.y = -0.02;
        [-1, 1].forEach((s) => {
          const grip = cyl(0.018, 0.018, 0.11, this.mat.black, 12);
          grip.position.set(s * 0.15, 0.01, 0.01);
          wheel.add(grip);
        });
        wheel.add(rim, hub, bar);
      } else {
        // GA ram's-horn / W yoke
        const bar = box(0.2, 0.026, 0.026, mat);
        const hub = box(0.07, 0.05, 0.035, mat);
        hub.position.y = -0.005;
        wheel.add(bar, hub);
        [-1, 1].forEach((s) => {
          const horn = box(0.03, 0.11, 0.03, mat);
          horn.position.set(s * 0.1, 0.035, 0);
          const grip = box(0.032, 0.07, 0.034, this.mat.black);
          grip.position.set(s * 0.1, 0.06, 0.004);
          wheel.add(horn, grip);
        });
        const badge = cyl(0.016, 0.016, 0.006, this.mat.red, 16);
        badge.rotation.x = Math.PI / 2;
        badge.position.set(0, -0.002, 0.02);
        wheel.add(badge);
      }
      g.add(wheel);
      let shaft;
      if (column === 'floor') {
        shaft = box(0.05, 1, 0.05, mat);
        g.add(shaft);
      } else {
        shaft = cyl(0.011, 0.011, 1, this.mat.metal, 10);
        shaft.rotation.x = Math.PI / 2;
        g.add(shaft);
      }
      this.group.add(g);
      const input = this.s.app.input;
      this.hot(wheel, {
        tip: () => 'Yoke — drag to fly (springs back when released)',
        cursor: 'grab',
        down: () => (input.panelYoke = { pitch: 0, roll: 0, ox: 0, oy: 0 }),
        drag: (dx, dy) => {
          const y = input.panelYoke || { pitch: 0, roll: 0, ox: 0, oy: 0 };
          y.ox += dx;
          y.oy += dy;
          y.pitch = M.clamp(y.oy / 110, -1, 1);
          y.roll = M.clamp(y.ox / 110, -1, 1);
          input.panelYoke = y;
        },
        up: () => (input.panelYoke = null),
      });
      // anchor in body coordinates
      const ey = this.eye.y;
      const rest = air
        ? new THREE.Vector3(x, ey - 0.4, this.eye.z - 0.46)
        : new THREE.Vector3(x, Math.min(ey - 0.36, this.panelBottom + 0.3), this.panelZ + 0.24);
      this.animators.push(() => {
        const e = ctl.elevator || 0, a = ctl.aileron || 0;
        // pull = towards the pilot; right roll = wheel clockwise as seen by the pilot
        const travel = air ? 0.1 : 0.085;
        if (air) {
          // column pivots at the floor; the wheel moves aft when pulled
          const top = new THREE.Vector3(x, rest.y, rest.z + e * travel);
          const pivot = new THREE.Vector3(x, this.floorY, rest.z + 0.06);
          const d = top.clone().sub(pivot);
          const L = d.length();
          shaft.position.copy(pivot).addScaledVector(d, 0.5);
          shaft.scale.set(1, L, 1);
          shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.multiplyScalar(1 / L));
          wheel.position.copy(top);
          wheel.rotation.set(0, 0, -a * 75 * D2R);
        } else {
          const z = rest.z + e * travel;
          wheel.position.set(rest.x, rest.y, z);
          wheel.rotation.set(0, 0, -a * 80 * D2R);
          const z0 = this.panelZ - 0.08;
          shaft.position.set(rest.x, rest.y, (z0 + z) / 2);
          shaft.scale.y = Math.max(0.05, z - z0);
        }
      });
      void panelP;
      return wheel;
    }

    pedals(x) {
      const ctl = this.ac.controls;
      const input = this.ac.input;
      const zBase = this.panelZ - (this.air ? 0.05 : 0.1);
      [-1, 1].forEach((side) => {
        const pivot = new THREE.Group();
        pivot.position.set(x + side * (this.air ? 0.13 : 0.1), this.floorY + (this.air ? 0.42 : 0.32), zBase);
        const arm = box(0.016, 0.26, 0.016, this.mat.metal);
        arm.position.y = -0.13;
        const pad = box(0.075, 0.11, 0.02, this.mat.black);
        pad.position.set(0, -0.24, 0.015);
        pad.rotation.x = -0.35;
        pivot.add(arm, pad);
        this.group.add(pivot);
        this.animators.push(() => {
          // right rudder: right pedal forward, left pedal back
          const r = M.clamp((ctl.rudder || 0) + (ctl.rudderTrim || 0), -1, 1);
          pivot.rotation.x = side * r * 0.32;
          const brake = side < 0 ? input.brakeL || 0 : input.brakeR || 0;
          pad.rotation.x = -0.35 - brake * 0.3;
        });
      });
    }

    trimWheel(parent, x, y, z, vertical = true) {
      const c = this.ac.controls;
      const wheel = cyl(0.075, 0.075, 0.022, this.mat.black, 28);
      wheel.rotation.z = Math.PI / 2;
      const ridges = new THREE.Group();
      for (let i = 0; i < 16; i++) {
        const rb = box(0.024, 0.006, 0.012, this.mat.dark);
        const h = new THREE.Group();
        h.rotation.x = (i / 16) * Math.PI * 2;
        rb.position.y = 0.076;
        h.add(rb);
        ridges.add(h);
      }
      const g = new THREE.Group();
      g.add(wheel, ridges);
      g.position.set(x, y, z);
      parent.add(g);
      const ind = box(0.006, 0.006, 0.02, this.mat.white);
      parent.add(ind);
      this.hot(g, {
        tip: () => `Elevator trim ${c.elevatorTrim > 0.02 ? 'NOSE UP' : c.elevatorTrim < -0.02 ? 'NOSE DN' : 'NEUTRAL'} (${Math.round(c.elevatorTrim * 100)}%)`,
        cursor: 'ns-resize',
        drag: (dx, dy) => (c.elevatorTrim = M.clamp(c.elevatorTrim + dy / 600, -1, 1)),
        wheel: (d) => (c.elevatorTrim = M.clamp(c.elevatorTrim - d * 0.02, -1, 1)),
      });
      this.animators.push(() => {
        ridges.rotation.x = c.elevatorTrim * 6;
        ind.position.set(x + 0.03, y + c.elevatorTrim * 0.05, z - 0.03);
      });
      void vertical;
    }

    /* ------------------------------------------------------------------ avionics faceplates */

    radioUnit(parent, x, y, n, w = 0.165, h = 0.052) {
      const nav = this.s.nav;
      const r = nav.radios;
      const u = new CanvasUnit(this, {
        w, h, draw: (ctx, U) => {
          unitBackground(ctx, U);
          const on = r.powered;
          const cw = U.cw, ch = U.ch;
          ['com' + n, 'nav' + n].forEach((name, i) => {
            const x0 = i * cw / 2;
            lcd(ctx, x0 + cw * 0.03, ch * 0.16, cw * 0.44, ch * 0.42, on);
            if (on) {
              ctx.font = `600 ${Math.round(ch * 0.26)}px ${MONO}`;
              ctx.textBaseline = 'middle';
              ctx.textAlign = 'left';
              ctx.fillStyle = '#9dffb0';
              ctx.fillText(r.format(name, 'active'), x0 + cw * 0.045, ch * 0.37);
              ctx.textAlign = 'right';
              ctx.fillStyle = '#6fb9ff';
              ctx.fillText(r.format(name, 'standby'), x0 + cw * 0.46, ch * 0.37);
            }
            ctx.fillStyle = '#9fa3a9';
            ctx.font = `700 ${Math.round(ch * 0.13)}px ${FONT}`;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillText(name.toUpperCase(), x0 + cw * 0.035, ch * 0.03);
          });
          U.regions.forEach((rg) => (rg.kind === 'knob' ? drawKnob(ctx, rg, '') : drawButton(ctx, rg, rg.label)));
          if (on) {
            const rx = nav.receivers['nav' + n];
            if (rx && rx.valid) {
              ctx.fillStyle = '#d7d5cf';
              ctx.font = `600 ${Math.round(ch * 0.12)}px ${MONO}`;
              ctx.textAlign = 'right';
              ctx.textBaseline = 'bottom';
              ctx.fillText(`${rx.ident} ${rx.type}`, cw * 0.97, ch * 0.99);
            }
          }
        },
      });
      const cw = u.cw, ch = u.ch;
      ['com' + n, 'nav' + n].forEach((name, i) => {
        const x0 = i * cw / 2;
        u.region({ x: x0 + cw * 0.05, y: ch * 0.63, w: cw * 0.11, h: ch * 0.3, label: '⇆', tip: `${name.toUpperCase()} swap active/standby`, click: () => {
          r.swap(name);
          click();
        } });
        u.region({ x: x0 + cw * 0.19, y: ch * 0.6, w: cw * 0.1, h: ch * 0.36, kind: 'knob', tip: `${name.toUpperCase()} MHz (wheel / click, right-click down)`, click: (b) => r.tune(name, b === 2 ? -1 : 1, true), wheel: (d) => r.tune(name, d, true) });
        u.region({ x: x0 + cw * 0.31, y: ch * 0.6, w: cw * 0.1, h: ch * 0.36, kind: 'knob', tip: `${name.toUpperCase()} kHz (wheel / click, right-click down)`, click: (b) => r.tune(name, b === 2 ? -1 : 1, false), wheel: (d) => r.tune(name, d, false) });
      });
      u.mesh.position.set(x, y, 0.004);
      parent.add(u.mesh);
      return u;
    }

    transponderUnit(parent, x, y, w = 0.165, h = 0.036) {
      const r = this.s.nav.radios;
      const u = new CanvasUnit(this, {
        w, h, draw: (ctx, U) => {
          unitBackground(ctx, U, 'XPDR');
          const on = r.powered;
          const x = r.xpdr;
          lcd(ctx, U.cw * 0.12, U.ch * 0.18, U.cw * 0.4, U.ch * 0.64, on);
          if (on) {
            const code = String(x.code).padStart(4, '0');
            ctx.font = `600 ${Math.round(U.ch * 0.42)}px ${MONO}`;
            ctx.fillStyle = '#ffcf6a';
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'center';
            for (let i = 0; i < 4; i++) ctx.fillText(code[i], U.cw * (0.16 + i * 0.085), U.ch * 0.5);
            ctx.font = `600 ${Math.round(U.ch * 0.2)}px ${MONO}`;
            ctx.fillText(x.ident > 0 ? 'IDENT' : x.mode === 'ALT' ? 'ALT R' : 'STBY', U.cw * 0.47, U.ch * 0.72);
          }
          U.regions.filter((rg) => rg.label).forEach((rg) => drawButton(ctx, rg, rg.label, { lit: rg.lit && rg.lit() }));
        },
      });
      for (let i = 0; i < 4; i++) {
        u.region({ x: u.cw * (0.125 + i * 0.085), y: u.ch * 0.2, w: u.cw * 0.07, h: u.ch * 0.6, tip: 'Squawk digit: click +, right-click −', click: (b) => {
          const s = String(r.xpdr.code).padStart(4, '0').split('').map(Number);
          s[i] = (s[i] + (b === 2 ? -1 : 1) + 8) % 8;
          r.setSquawk(s.join(''));
        }, wheel: (d) => {
          const s = String(r.xpdr.code).padStart(4, '0').split('').map(Number);
          s[i] = (s[i] + d + 8) % 8;
          r.setSquawk(s.join(''));
        } });
      }
      [['STBY', () => (r.xpdr.mode = 'STBY'), () => r.xpdr.mode === 'STBY'], ['ALT', () => (r.xpdr.mode = 'ALT'), () => r.xpdr.mode === 'ALT'], ['IDT', () => (r.xpdr.ident = 18)], ['VFR', () => r.setSquawk(1200)]].forEach(([label, fn, lit], i) => {
        u.region({ x: u.cw * (0.56 + i * 0.108), y: u.ch * 0.22, w: u.cw * 0.095, h: u.ch * 0.56, label, lit, tip: label, click: () => {
          fn();
          click();
        } });
      });
      u.mesh.position.set(x, y, 0.004);
      parent.add(u.mesh);
      return u;
    }

    apUnit(parent, x, y, w = 0.165, h = 0.044) {
      const ap = this.ac.autopilot;
      const u = new CanvasUnit(this, {
        w, h, draw: (ctx, U) => {
          unitBackground(ctx, U);
          const on = ap.powered;
          lcd(ctx, U.cw * 0.02, U.ch * 0.08, U.cw * 0.4, U.ch * 0.84, on);
          if (on) {
            const a = ap.annunciation();
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'left';
            ctx.font = `700 ${Math.round(U.ch * 0.2)}px ${MONO}`;
            const flash = ap.disconnectFlash > 0 && Math.floor(ap.disconnectFlash * 4) % 2 === 0;
            ctx.fillStyle = a.ap || flash ? '#8dff8a' : '#36533a';
            ctx.fillText('AP', U.cw * 0.04, U.ch * 0.27);
            ctx.fillStyle = '#d9ffd9';
            ctx.fillText(`${a.lat || ''}`, U.cw * 0.13, U.ch * 0.27);
            ctx.fillText(`${a.vert || ''}`, U.cw * 0.27, U.ch * 0.27);
            ctx.font = `600 ${Math.round(U.ch * 0.16)}px ${MONO}`;
            ctx.fillStyle = '#9fd9a3';
            ctx.fillText(`ARM ${a.armed || '--'}  HDG ${SIM.UI.Fmt.hdg(ap.hdgBug)}`, U.cw * 0.04, U.ch * 0.52);
            ctx.fillText(`ALT ${Math.round(ap.altTarget)}  VS ${ap.vsTarget > 0 ? '+' : ''}${ap.vsTarget}`, U.cw * 0.04, U.ch * 0.76);
          }
          U.regions.forEach((rg) => (rg.kind === 'knob' ? drawKnob(ctx, rg, rg.label) : drawButton(ctx, rg, rg.label, { led: true, lit: rg.lit && rg.lit() })));
        },
      });
      const btns = [
        ['AP', () => ap.toggleAP(), () => ap.engaged], ['HDG', () => ap.setLateral('HDG'), () => ap.engaged && ap.lateral === 'HDG'],
        ['NAV', () => ap.setLateral('NAV'), () => ap.engaged && (ap.lateral === 'NAV' || ap.armedLateral === 'NAV')], ['APR', () => ap.setLateral('APR'), () => ap.engaged && (ap.lateral === 'APR' || ap.armedLateral === 'APR')],
        ['ALT', () => ap.setVertical('ALT'), () => ap.engaged && ap.vertical === 'ALT'], ['VS', () => ap.setVertical('VS'), () => ap.engaged && ap.vertical === 'VS'],
        ['UP', () => ap.adjustVS(100)], ['DN', () => ap.adjustVS(-100)],
      ];
      btns.forEach(([label, fn, lit], i) => {
        const col = i % 4, row = Math.floor(i / 4);
        u.region({ x: u.cw * (0.44 + col * 0.095), y: u.ch * (0.08 + row * 0.45), w: u.cw * 0.085, h: u.ch * 0.4, label, lit, tip: `Autopilot ${label}`, click: () => {
          fn();
          click();
        } });
      });
      u.region({ x: u.cw * 0.825, y: u.ch * 0.05, w: u.cw * 0.08, h: u.ch * 0.9, kind: 'knob', label: 'HDG', tip: 'Heading bug (wheel / click, right-click −; shift ×10)', click: (b, e) => ap.adjustHeading((b === 2 ? -1 : 1) * (e && e.shiftKey ? 10 : 1)), wheel: (d, e) => ap.adjustHeading(d * (e && e.shiftKey ? 10 : 1)) });
      u.region({ x: u.cw * 0.91, y: u.ch * 0.05, w: u.cw * 0.08, h: u.ch * 0.9, kind: 'knob', label: 'ALT', tip: 'Altitude select (wheel / click, right-click −; shift ×1000)', click: (b, e) => ap.adjustAltitude((b === 2 ? -1 : 1) * (e && e.shiftKey ? 1000 : 100)), wheel: (d, e) => ap.adjustAltitude(d * (e && e.shiftKey ? 1000 : 100)) });
      u.mesh.position.set(x, y, 0.004);
      parent.add(u.mesh);
      return u;
    }

    gpsUnit(parent, x, y, w = 0.165, h = 0.1) {
      const s = this.s;
      const nav = s.nav;
      const NM = SIM.Units.NM;
      const st = { page: 'MAP', range: 10, sel: 0 };
      const mapPx = { w: 268, h: 108 };
      const mapCanvas = document.createElement('canvas');
      const mapCtx = SIM.UI.fitCanvas(mapCanvas, mapPx.w, mapPx.h, 1, this.texDensity);
      const u = new CanvasUnit(this, {
        w, h, rate: 0.15, draw: (ctx, U) => {
          unitBackground(ctx, U);
          const on = nav.radios.powered;
          const sx = U.cw * 0.03, sy = U.ch * 0.05, sw = U.cw * 0.76, sh = U.ch * 0.9;
          ctx.fillStyle = '#050607';
          ctx.fillRect(sx, sy, sw, sh);
          if (on) {
            const g = nav.gps;
            ctx.font = `600 ${Math.round(sh * 0.085)}px ${MONO}`;
            ctx.textBaseline = 'top';
            ctx.textAlign = 'left';
            ctx.fillStyle = '#ff5ef0';
            const items = [['GS', `${Math.round(g.gsKt || 0)}`], ['DTK', g.wp ? `${SIM.UI.Fmt.hdg(g.dtk)}°` : '___'], ['DIS', g.wp ? `${(g.dist / NM).toFixed(1)}` : '__._'], ['WPT', g.wp ? g.wp.ident : '____']];
            items.forEach(([k, v], i) => {
              ctx.fillStyle = '#9aa0a8';
              ctx.fillText(k, sx + sw * (0.01 + i * 0.25), sy + sh * 0.01);
              ctx.fillStyle = '#ff6af2';
              ctx.fillText(v, sx + sw * (0.01 + i * 0.25), sy + sh * 0.1);
            });
            const by = sy + sh * 0.22, bh = sh * 0.78;
            if (st.page === 'MAP') {
              const v = { cx: s.aircraft.fm.pos.x, cz: s.aircraft.fm.pos.z, scale: 54 / (st.range * NM), rot: s.aircraft.state.trueTrackDeg * M.DEG, w: mapPx.w, h: mapPx.h, mini: true };
              s.mapRenderer.draw(mapCtx, v);
              ctx.drawImage(mapCanvas, sx, by, sw, bh);
              ctx.fillStyle = '#e9e9e9';
              ctx.font = `600 ${Math.round(sh * 0.08)}px ${MONO}`;
              ctx.textBaseline = 'bottom';
              ctx.fillText(`${st.range}NM  TRK UP`, sx + sw * 0.02, sy + sh * 0.99);
            } else {
              const list = st.page === 'NRST' ? nav.nearest(6, 'APT') : nav.route;
              st.list = list;
              ctx.fillStyle = '#7ad7ff';
              ctx.font = `700 ${Math.round(sh * 0.09)}px ${MONO}`;
              ctx.fillText(st.page === 'NRST' ? 'NEAREST AIRPORTS' : 'FLIGHT PLAN', sx + sw * 0.02, by);
              ctx.font = `600 ${Math.round(sh * 0.085)}px ${MONO}`;
              const p = s.aircraft.fm.pos;
              if (!list.length) {
                ctx.fillStyle = '#9aa0a8';
                ctx.fillText('NO FLIGHT PLAN', sx + sw * 0.02, by + sh * 0.14);
              }
              list.slice(0, 6).forEach((wp, i) => {
                const yy = by + sh * (0.13 + i * 0.105);
                if (i === st.sel) {
                  ctx.fillStyle = '#1f4f6a';
                  ctx.fillRect(sx + sw * 0.01, yy - sh * 0.01, sw * 0.98, sh * 0.1);
                }
                const d = Math.hypot(wp.x - p.x, wp.z - p.z) / NM;
                const brg = nav.toMag(SIM.Geo.bearing(p.x, p.z, wp.x, wp.z));
                ctx.fillStyle = st.page === 'FPL' && i === nav.activeLeg ? '#ff6af2' : '#e8e8e8';
                ctx.fillText(`${wp.ident.padEnd(5)} ${SIM.UI.Fmt.hdg(brg)}° ${d.toFixed(1)}NM`, sx + sw * 0.03, yy);
              });
            }
          }
          U.regions.forEach((rg) => drawButton(ctx, rg, rg.label, { lit: rg.lit && rg.lit() }));
        },
      });
      const keys = [
        ['MAP', () => (st.page = 'MAP'), () => st.page === 'MAP'], ['NRST', () => { st.page = 'NRST'; st.sel = 0; }, () => st.page === 'NRST'],
        ['FPL', () => { st.page = 'FPL'; st.sel = 0; }, () => st.page === 'FPL'], ['▲', () => (st.sel = Math.max(0, st.sel - 1))], ['▼', () => (st.sel = Math.min(5, st.sel + 1))],
        ['D→ENT', () => {
          const l = st.list || [];
          const wp = l[st.sel];
          if (st.page !== 'MAP' && wp) {
            nav.directTo(wp);
            st.page = 'MAP';
            SIM.events.emit('notify', { text: `DIRECT TO ${wp.ident}`, level: 'info' });
          } else {
            st.page = 'NRST';
            st.sel = 0;
          }
        }],
        ['RNG+', () => (st.range = Math.min(80, st.range * 2))], ['RNG−', () => (st.range = Math.max(2.5, st.range / 2))], ['CDI', () => nav.radios.toggleCdiSource()],
      ];
      keys.forEach(([label, fn, lit], i) => {
        u.region({ x: u.cw * 0.81, y: u.ch * (0.03 + i * 0.106), w: u.cw * 0.17, h: u.ch * 0.095, label, lit, tip: `GPS ${label}`, click: () => {
          fn();
          click(0.7);
          u.update(0, true);
        } });
      });
      u.mesh.position.set(x, y, 0.004);
      parent.add(u.mesh);
      return u;
    }

    annunciatorUnit(parent, x, y, w, h) {
      const sys = this.ac.systems;
      const names = ['VOLTS', 'OIL PRESS', 'L FUEL', 'R FUEL', 'VAC', 'STALL'];
      if (this.cfg.gear.retractable) names.push('GEAR');
      const u = new CanvasUnit(this, {
        w, h, rate: 0.1, draw: (ctx, U) => {
          ctx.fillStyle = '#121315';
          ctx.fillRect(0, 0, U.cw, U.ch);
          const st = sys.annunciators();
          const n = names.length;
          const cw = (U.cw * 0.84) / n;
          names.forEach((nm, i) => {
            const on = !!st[nm];
            const red = nm === 'STALL' || nm === 'GEAR';
            ctx.fillStyle = on ? (red ? '#ff3b30' : '#ffb21f') : '#2b2420';
            roundRect(ctx, U.cw * 0.01 + i * cw, U.ch * 0.12, cw * 0.92, U.ch * 0.76, U.ch * 0.08);
            ctx.fill();
            ctx.fillStyle = on ? '#1a0d00' : '#5c5249';
            ctx.font = `700 ${Math.round(U.ch * 0.3)}px ${FONT}`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(nm, U.cw * 0.01 + i * cw + cw * 0.46, U.ch * 0.52);
          });
          U.regions.forEach((rg) => drawButton(ctx, rg, rg.label));
        },
      });
      u.region({ x: u.cw * 0.86, y: u.ch * 0.1, w: u.cw * 0.13, h: u.ch * 0.8, label: 'TEST', tip: 'Annunciator test (hold)', hold: { down: () => (sys.annunciatorTest = true), up: () => (sys.annunciatorTest = false) } });
      u.mesh.position.set(x, y, 0.004);
      parent.add(u.mesh);
      return u;
    }

    clockUnit(parent, x, y, w, h) {
      const s = this.s;
      const u = new CanvasUnit(this, {
        w, h, rate: 0.5, draw: (ctx, U) => {
          ctx.fillStyle = '#0d0e10';
          ctx.fillRect(0, 0, U.cw, U.ch);
          if (!s.aircraft.systems.elec.busPowered) return;
          const atm = s.world.weather.atmosphereAt(s.aircraft.fm.pos.y);
          ctx.fillStyle = '#ffd27a';
          ctx.font = `600 ${Math.round(U.ch * 0.36)}px ${MONO}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(`${SIM.UI.Fmt.clock(s.hour)} LCL`, U.cw / 2, U.ch * 0.3);
          ctx.fillStyle = '#c9c6bd';
          ctx.font = `600 ${Math.round(U.ch * 0.28)}px ${MONO}`;
          ctx.fillText(`OAT ${Math.round(atm.tempC)}°C ${s.aircraft.systems.elec.busVolts.toFixed(1)}V`, U.cw / 2, U.ch * 0.74);
        },
      });
      u.mesh.position.set(x, y, 0.004);
      parent.add(u.mesh);
      return u;
    }

    /* ------------------------------------------------------------------ GA cockpit */

    buildGA(twin) {
      const ac = this.ac, cfg = this.cfg, sys = ac.systems;
      const e0 = ac.engines[0];
      const W = this.halfW * 2 - 0.02, H = this.Hp;
      const ex = this.eye.x;
      const piper = cfg.visual.model !== 'highwing';
      const P = this.makePanel(W, H, (ctx, Pp) => {
        // sub-panels: pilot flight instruments, avionics stack, right panel
        ctx.fillStyle = 'rgba(0,0,0,0.12)';
        roundRect(ctx, Pp.px(ex - 0.215), Pp.py(H / 2 - 0.018), 0.43 * this.ppmPanel, (0.3) * this.ppmPanel, 10);
        ctx.fill();
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        roundRect(ctx, Pp.px(-0.03), Pp.py(H / 2 - 0.012), 0.205 * this.ppmPanel, (H - 0.14) * this.ppmPanel, 8);
        ctx.fill();
      });
      this.panelP = P;
      const dg = 0.084, gap = 0.094;
      const r1 = H / 2 - 0.065, r2 = r1 - gap, r3 = r2 - gap * 0.92;
      // Six-pack in front of the pilot
      const sx = [ex - gap, ex, ex + gap];
      this.instrument(P, 'asi', sx[0], r1, dg);
      this.instrument(P, 'ai', sx[1], r1, dg);
      this.instrument(P, 'alt', sx[2], r1, dg);
      this.instrument(P, 'tc', sx[0], r2, dg);
      this.instrument(P, 'hi', sx[1], r2, dg);
      this.instrument(P, 'vsi', sx[2], r2, dg);
      // gauge knobs
      this.knob(P, sx[2] - dg * 0.42, r1 - dg * 0.44, 0.009, 'BARO', (d, c) => (ac.kollsman = M.clamp(ac.kollsman + d * (c ? 3.39 : 1), 940, 1060)), { tip: () => `Altimeter setting ${Math.round(ac.kollsman)} hPa (${(ac.kollsman / SIM.Units.INHG).toFixed(2)} inHg)` });
      this.knob(P, sx[1] + dg * 0.42, r2 - dg * 0.44, 0.009, 'HDG', (d, c) => ac.autopilot.adjustHeading(d * (c ? 10 : 1)), { tip: () => `Heading bug ${SIM.UI.Fmt.hdg(ac.autopilot.hdgBug)}°` });
      this.knob(P, sx[1] - dg * 0.42, r2 - dg * 0.44, 0.009, 'SYNC', () => this.panel2d.im.syncHeading(), { tip: () => 'Sync heading indicator to the compass' });
      // NAV indicators to the right of the six-pack
      const nx = ex + gap * 2.05;
      this.instrument(P, 'cdi1', nx, r1, dg);
      const nav = this.s.nav;
      this.knob(P, nx - dg * 0.42, r1 - dg * 0.44, 0.009, 'OBS', (d, c) => {
        if (nav.radios.cdiSource !== 'GPS') nav.radios.adjustObs('nav1', d * (c ? 10 : 1));
      }, { tip: () => `NAV 1 course ${SIM.UI.Fmt.hdg(nav.radios.obs.nav1)}°` });
      if (cfg.avionics.nav > 1) {
        this.instrument(P, 'cdi2', nx, r2, dg);
        this.knob(P, nx - dg * 0.42, r2 - dg * 0.44, 0.009, 'OBS', (d, c) => nav.radios.adjustObs('nav2', d * (c ? 10 : 1)), { tip: () => `NAV 2 course ${SIM.UI.Fmt.hdg(nav.radios.obs.nav2)}°` });
      }
      // Avionics stack (centre)
      const ax = 0.072;
      let ay = H / 2 - 0.068;
      const units = [];
      if (cfg.avionics.gps) {
        units.push(this.gpsUnit(P.group, ax, ay - 0.03));
        ay -= 0.108;
      }
      for (let n = 1; n <= Math.max(cfg.avionics.com, cfg.avionics.nav); n++) {
        units.push(this.radioUnit(P.group, ax, ay - 0.008, n));
        ay -= 0.058;
      }
      if (cfg.avionics.autopilot) {
        units.push(this.apUnit(P.group, ax, ay - 0.005));
        ay -= 0.05;
      }
      if (cfg.avionics.transponder) units.push(this.transponderUnit(P.group, ax, ay));
      // Engine instruments on the right panel
      const rx0 = 0.2;
      if (!twin) {
        this.instrument(P, 'tach', rx0 + 0.05, r1, 0.08);
        this.instrument(P, 'cluster', rx0 + 0.14 + 0.02, r2 + 0.005, 0, { round: false, w: 0.2, h: 0.094 });
      } else {
        const keys = ['mp', 'rpm', 'ff', 'fuel', 'oil', 'egt'];
        keys.forEach((k, i) => this.instrument(P, k, rx0 + 0.05 + (i % 3) * 0.075, r1 - Math.floor(i / 3) * 0.078, 0.068));
      }
      // Glareshield, annunciators, compass and clock
      const glare = box(W + 0.04, 0.03, 0.3, this.mat.glare);
      glare.position.set(0, this.panelTop + 0.012, this.panelZ - 0.12);
      glare.rotation.x = 0.08;
      this.group.add(glare);
      const lip = box(W + 0.04, 0.05, 0.025, this.mat.glare);
      lip.position.set(0, this.panelTop - 0.005, this.panelZ + 0.03);
      this.group.add(lip);
      const ann = new THREE.Group();
      ann.position.set(0, this.panelTop + 0.03, this.panelZ + 0.0);
      ann.rotation.x = -0.6;
      this.group.add(ann);
      this.annunciatorUnit(ann, ex + 0.03, 0, 0.3, 0.028);
      this.clockUnit(ann, 0.2, 0, 0.1, 0.03);
      // wet compass on the glareshield centre
      const compassBox = box(0.08, 0.06, 0.06, this.mat.black);
      compassBox.position.set(0, this.panelTop + 0.06, this.panelZ - 0.07);
      this.group.add(compassBox);
      const cg = new THREE.Group();
      cg.position.set(0, this.panelTop + 0.06, this.panelZ - 0.039);
      this.group.add(cg);
      const comp = { group: cg };
      this.instrumentOn(comp, 'compass', 0, 0, 0.072, 0.017);
      // Lower panel: switches, magnetos, park brake
      const by = -H / 2;
      const switches = cfg.cockpit.switches;
      const swX0 = -W / 2 + 0.06, swStep = Math.min(0.042, (W / 2 - 0.02) / switches.length);
      switches.forEach((name, i) => this.toggleSwitch(P, swX0 + 0.045 + i * swStep, by + 0.06, SWITCH_TEXT[name] || name.toUpperCase(), () => sys.switches[name], () => sys.toggleSwitch(name), { red: name === 'batt' || name === 'alt' || name === 'gen' }));
      // magneto key switch(es)
      const mags = twin ? [0, 1] : [0];
      mags.forEach((i, k) => this.magnetoSwitch(P, -W / 2 + 0.06 + k * 0.07, by + 0.15, i, twin ? (i ? 'R ENG' : 'L ENG') : 'MAGNETOS'));
      // parking brake handle
      const pk = new THREE.Group();
      const pkShaft = cyl(0.004, 0.004, 0.08, this.mat.chrome, 8);
      pkShaft.rotation.x = Math.PI / 2;
      pkShaft.position.z = -0.03;
      const pkHandle = box(0.05, 0.016, 0.014, this.mat.red);
      pkHandle.position.z = 0.012;
      pk.add(pkShaft, pkHandle);
      pk.position.set(-W / 2 + 0.18 + (twin ? 0.05 : 0), by + 0.15, 0);
      P.group.add(pk);
      P.label('PARK BRK', pk.position.x, by + 0.124, 0.0085);
      this.hot(pk, { tip: () => `Parking brake ${sys.brakes.parking ? 'SET' : 'OFF'}`, click: () => {
        sys.toggleParkingBrake();
        click();
      } });
      this.animators.push(() => (pk.position.z = sys.brakes.parking ? 0.05 : 0));
      // Engine controls
      const cx = 0.072;
      if (!piper && !twin) {
        // Cessna push-pull: throttle, mixture, carb heat
        this.pushPull(P, cx - 0.04, by + 0.075, 'THROTTLE', this.mat.black, () => e0.throttle, (v) => ac.setThrottle(v));
        this.pushPull(P, cx + 0.06, by + 0.075, 'MIXTURE', this.mat.red, () => e0.mixture, (v) => ac.setMixture(v), { tip: () => `Mixture ${e0.mixture > 0.97 ? 'FULL RICH' : e0.mixture < 0.05 ? 'IDLE CUTOFF' : Math.round(e0.mixture * 100) + '%'}` });
        if (cfg.systems.carbHeat) {
          const ch = new THREE.Group();
          const chk = box(0.03, 0.022, 0.016, this.mat.dark);
          ch.add(chk);
          ch.position.set(cx - 0.11, by + 0.075, 0.01);
          P.group.add(ch);
          P.label('CARB HEAT', cx - 0.11, by + 0.05, 0.0075);
          this.hot(ch, { tip: () => `Carburettor heat ${e0.carbHeat ? 'ON' : 'OFF'}`, click: () => {
            ac.engines.forEach((e) => (e.carbHeat = !e.carbHeat));
            click();
          } });
          this.animators.push(() => (ch.position.z = e0.carbHeat ? 0.06 : 0.01));
        }
      } else {
        // Power quadrant below the avionics stack
        const q = box(0.17, 0.05, 0.06, this.mat.pedestal);
        q.position.set(cx, by + 0.03, 0.03);
        P.group.add(q);
        const qy = by + 0.05, qz = 0.05;
        this.quadrantLever(P.group, cx - 0.055, qy, qz, twin ? 'THROTTLES' : 'THROTTLE', this.mat.black, () => e0.throttle, (v) => ac.setThrottle(v), { len: 0.085, knobShape: twin ? 'tbar' : 'ball' });
        if (twin) {
          this.quadrantLever(P.group, cx, qy, qz, 'PROPS', this.mat.blue, () => e0.prop, (v) => ac.engines.forEach((e) => (e.prop = v)), { len: 0.085, knobShape: 'tbar', tip: () => (e0.prop < 0.03 ? 'Propellers FEATHER' : `Propellers ${Math.round(e0.governorTarget())} rpm`) });
        }
        this.quadrantLever(P.group, cx + 0.055, qy, qz, twin ? 'MIXTURES' : 'MIXTURE', this.mat.red, () => e0.mixture, (v) => ac.setMixture(v), { len: 0.085, knobShape: twin ? 'tbar' : 'ball', tip: () => `Mixture ${e0.mixture > 0.97 ? 'FULL RICH' : e0.mixture < 0.05 ? 'IDLE CUTOFF' : Math.round(e0.mixture * 100) + '%'}` });
        P.label(twin ? 'THR    PROP    MIX' : 'THROTTLE     MIXTURE', cx, by + 0.012, 0.0075);
        if (cfg.systems.carbHeat) {
          const ch = new THREE.Group();
          ch.add(box(0.02, 0.04, 0.012, this.mat.dark));
          ch.position.set(cx + 0.11, by + 0.07, 0.01);
          P.group.add(ch);
          this.hot(ch, { tip: () => `Carburettor heat ${e0.carbHeat ? 'ON' : 'OFF'}`, click: () => {
            ac.engines.forEach((e) => (e.carbHeat = !e.carbHeat));
            click();
          } });
          this.animators.push(() => (ch.position.y = by + (e0.carbHeat ? 0.04 : 0.07)));
        }
      }
      // Flaps selector with indicator
      const flaps = cfg.aero.flaps;
      const maxDeg = flaps[flaps.length - 1].deg;
      const fx = W / 2 - 0.2, fy = by + 0.1;
      const fslot = box(0.012, 0.075, 0.004, this.mat.black);
      fslot.position.set(fx, fy, 0.002);
      P.group.add(fslot);
      flaps.forEach((f, i) => P.label(f.label || `${f.deg}°`, fx + 0.03, fy + 0.033 - (i / (flaps.length - 1)) * 0.066, 0.0075, '#e7e4dc', 'left'));
      P.label('FLAPS', fx, fy + 0.05, 0.009);
      const flever = new THREE.Group();
      const fk = box(0.03, 0.012, 0.018, this.mat.white);
      fk.position.z = 0.012;
      flever.add(fk);
      P.group.add(flever);
      const find = box(0.005, 0.005, 0.006, this.mat.red);
      P.group.add(find);
      this.hot(flever, {
        tip: () => `Flaps ${sys.flapLabel ? sys.flapLabel() : ''} (click: down, right-click: up, drag)`,
        cursor: 'ns-resize',
        click: (b) => sys.setFlapsHandle(M.clamp(sys.flaps.handle + (b === 2 ? -1 : 1), 0, flaps.length - 1)),
        wheel: (d) => sys.setFlapsHandle(M.clamp(sys.flaps.handle - d, 0, flaps.length - 1)),
      });
      this.animators.push(() => {
        flever.position.set(fx, fy + 0.033 - (sys.flaps.handle / (flaps.length - 1)) * 0.066, 0);
        find.position.set(fx - 0.022, fy + 0.033 - (sys.flaps.pos / maxDeg) * 0.066, 0.003);
      });
      // Gear handle (retractable)
      if (cfg.gear.retractable) this.gearHandle(P, fx - 0.09, by + 0.11);
      // Fuel selector(s) on the floor between the seats
      const fuelSel = cfg.fuel.perEngine ? [0, 1] : [0];
      fuelSel.forEach((i, k) => this.fuelSelector(this.group, (k - (fuelSel.length - 1) / 2) * 0.1, this.floorY + 0.03, this.eye.z - 0.32, i));
      // Trim wheel in the centre console
      const con = box(0.12, 0.22, 0.3, this.mat.pedestal);
      con.position.set(0, this.floorY + 0.11, this.panelZ + 0.12);
      this.group.add(con);
      this.trimWheel(this.group, 0, this.floorY + 0.2, this.panelZ + 0.2);
      // Yokes and pedals for both seats
      this.yoke(ex, P);
      this.yoke(-ex, P);
      this.pedals(ex);
      this.pedals(-ex);
      P.paint();
      void units;
    }

    /** Small rectangular instrument (compass strip) on any group. */
    instrumentOn(holder, key, x, y, w, h) {
      const spec = this.panel2d && this.panel2d.spec[key];
      if (!spec) return;
      SIM.UI.canvasPixelRatio = this.texDensity;
      let gauge;
      try {
        gauge = spec.factory();
      } finally {
        SIM.UI.canvasPixelRatio = null;
      }
      const tex = canvasTexture(gauge.canvas);
      const mat = new THREE.MeshBasicMaterial({ map: tex });
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
      m.position.set(x, y, 0);
      holder.group.add(m);
      this.instruments.push({ gauge, data: spec.data, tex, mat, key, t: 0, rate: 0.05 });
    }

    magnetoSwitch(P, x, y, idx, label) {
      const e = this.ac.engines[idx];
      const MAG = SIM.MAG;
      const g = new THREE.Group();
      const ring = cyl(0.02, 0.02, 0.006, this.mat.metal, 20);
      ring.rotation.x = Math.PI / 2;
      const key = box(0.008, 0.032, 0.012, this.mat.chrome);
      key.position.z = 0.012;
      const bow = box(0.024, 0.016, 0.004, this.mat.chrome);
      bow.position.set(0, 0.022, 0.014);
      const keyG = new THREE.Group();
      keyG.add(key, bow);
      g.add(ring, keyG);
      g.position.set(x, y, 0.004);
      P.group.add(g);
      const labels = SIM.MAG_LABELS;
      labels.forEach((l, i) => {
        const a = (-100 + i * 50) * D2R;
        P.label(l, x + Math.sin(a) * 0.034, y + Math.cos(a) * 0.034, 0.0062);
      });
      P.label(label, x, y - 0.045, 0.0078);
      this.hot(g, {
        tip: () => `${label}: ${labels[e.magnetos]} — click to turn right, right-click left, hold at BOTH to START`,
        down: (b) => {
          if (b === 2) {
            e.starter = false;
            e.magnetos = Math.max(MAG.OFF, Math.min(e.magnetos, MAG.BOTH) - 1);
          } else if (e.magnetos >= MAG.BOTH) {
            e.magnetos = MAG.START;
            e.starter = true;
          } else e.magnetos += 1;
          click();
        },
        up: () => {
          if (e.magnetos === MAG.START) {
            e.starter = false;
            e.magnetos = MAG.BOTH;
          }
        },
      });
      this.animators.push(() => (keyG.rotation.z = -(-100 + e.magnetos * 50) * D2R));
    }

    fuelSelector(parent, x, y, z, i) {
      const sys = this.ac.systems;
      const opts = this.cfg.fuel.selector;
      const g = new THREE.Group();
      const plate = cyl(0.06, 0.06, 0.006, this.mat.dark, 24);
      const handle = box(0.09, 0.016, 0.022, this.mat.red);
      handle.position.y = 0.014;
      const hg = new THREE.Group();
      hg.add(handle);
      g.add(plate, hg);
      g.position.set(x, y, z);
      parent.add(g);
      const span = opts.length > 2 ? 270 : 90;
      this.hot(g, {
        tip: () => `Fuel selector${this.cfg.fuel.perEngine ? (i ? ' R' : ' L') : ''}: ${sys.fuelSelectors[i]} (click / right-click)`,
        click: (b) => {
          const k = opts.indexOf(sys.fuelSelectors[i]);
          sys.setFuelSelector(i, opts[(k + (b === 2 ? -1 : 1) + opts.length) % opts.length]);
          click();
        },
      });
      this.animators.push(() => {
        const k = Math.max(0, opts.indexOf(sys.fuelSelectors[i]));
        hg.rotation.y = -((k / Math.max(1, opts.length - 1)) * span - span / 2) * D2R;
      });
    }

    gearHandle(P, x, y) {
      const sys = this.ac.systems;
      const slot = box(0.012, 0.09, 0.004, this.mat.black);
      slot.position.set(x, y, 0.002);
      P.group.add(slot);
      const h = new THREE.Group();
      const arm = box(0.01, 0.01, 0.05, this.mat.metal);
      arm.position.z = 0.025;
      const wheel = cyl(0.016, 0.016, 0.012, this.mat.white, 18);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.z = 0.05;
      h.add(arm, wheel);
      P.group.add(h);
      P.label('GEAR', x, y + 0.062, 0.009);
      P.label('UP', x + 0.025, y + 0.04, 0.0075, '#e7e4dc', 'left');
      P.label('DN', x + 0.025, y - 0.04, 0.0075, '#e7e4dc', 'left');
      const lights = [0, 1, 2].map((i) => {
        const l = new THREE.Mesh(new THREE.CircleGeometry(0.006, 12), new THREE.MeshBasicMaterial({ color: 0x102010 }));
        l.position.set(x - 0.035, y + 0.02 - i * 0.02, 0.004);
        P.group.add(l);
        return l;
      });
      this.hot(h, { tip: () => `Landing gear handle ${sys.gear.handle ? 'DOWN' : 'UP'} (click)`, click: () => {
        sys.setGearHandle(!sys.gear.handle);
        click();
      } });
      this.animators.push(() => {
        h.position.set(x, y + (sys.gear.handle ? -0.035 : 0.035), 0);
        const p = sys.gear.pos, pw = sys.elec.busPowered;
        lights.forEach((l) => l.material.color.setHex(pw && p >= 1 ? 0x32ff4a : pw && p > 0 ? 0xff3020 : 0x102010));
      });
    }

    /* ------------------------------------------------------------------ 737 flight deck */

    buildAirliner() {
      const ac = this.ac, cfg = this.cfg, sys = ac.systems;
      const W = this.halfW * 2 - 0.04, H = this.Hp;
      const ex = this.eye.x;
      const P = this.makePanel(W, H, (ctx, Pp) => {
        ctx.fillStyle = 'rgba(0,0,0,0.15)';
        roundRect(ctx, Pp.px(-0.2), Pp.py(H / 2 - 0.02), 0.4 * this.ppmPanel, 0.5 * this.ppmPanel, 10);
        ctx.fill();
      });
      this.panelP = P;
      const dw = 0.2, dy = H / 2 - 0.14;
      // Captain: outboard PFD, inboard ND; centre: engine display; F/O: mirrored PFD/ND
      this.instrument(P, 'pfd', ex - 0.13, dy, 0, { round: false, w: dw, h: dw });
      this.instrument(P, 'nd', ex + 0.1, dy, 0, { round: false, w: dw, h: dw });
      this.instrument(P, 'eicas', 0, dy - 0.01, 0, { round: false, w: 0.16, h: 0.215 });
      // first-officer side shows its own copies of the same displays
      this.instrument(P, 'nd', -ex - 0.1, dy, 0, { round: false, w: dw, h: dw });
      this.instrument(P, 'pfd', -ex + 0.13, dy, 0, { round: false, w: dw, h: dw });
      // Gear lever right of the centre display
      this.gearHandle(P, 0.14, dy - 0.02);
      // Glareshield with the MCP
      const glare = box(W + 0.06, 0.05, 0.42, this.mat.glare);
      glare.position.set(0, this.panelTop + 0.02, this.panelZ - 0.16);
      this.group.add(glare);
      const mcpG = new THREE.Group();
      mcpG.position.set(0, this.panelTop + 0.06, this.panelZ + 0.03);
      mcpG.rotation.x = -0.55;
      this.group.add(mcpG);
      this.mcpUnit(mcpG, 0, 0, 0.9, 0.09);
      this.annunciatorUnit(mcpG, ex + 0.05, 0.002, 0.26, 0.03).mesh.position.x = ex - 0.62;
      this.clockUnit(mcpG, -ex + 0.62, 0, 0.12, 0.04);
      // Pedestal between the seats
      const ped = new THREE.Group();
      const pz0 = this.panelZ + 0.05, pz1 = this.eye.z + 0.45;
      const pedTop = this.eye.y - 0.62;
      const body = box(0.46, pedTop - this.floorY, pz1 - pz0, this.mat.pedestal);
      body.position.set(0, (pedTop + this.floorY) / 2, (pz0 + pz1) / 2);
      ped.add(body);
      this.group.add(ped);
      const top = new THREE.Group();
      top.position.set(0, pedTop + 0.001, 0);
      top.rotation.x = -Math.PI / 2;
      this.group.add(top);
      const e = ac.engines;
      // thrust levers (both engines together), speed brake and flap lever
      const tz = pz0 + 0.16;
      [-0.045, 0.045].forEach((dx) => this.quadrantLever(this.group, dx, pedTop, tz, 'THRUST', this.mat.black, () => e[0].throttle, (v) => ac.setThrottle(v), { len: 0.16, range: 60, knobShape: 'tbar', tip: () => `Thrust levers ${Math.round(e[0].throttle * 100)}%  N1 ${e[0].n1.toFixed(0)}%` }));
      this.quadrantLever(this.group, -0.17, pedTop, tz, 'SPEED BRAKE', this.mat.white, () => sys.speedbrake.lever, (v) => (sys.speedbrake.lever = v), { len: 0.13, range: 50, knobShape: 'tbar', tip: () => `Speed brake ${sys.speedbrake.lever < 0.05 ? 'DOWN' : Math.round(sys.speedbrake.lever * 100) + '%'}` });
      const flaps = cfg.aero.flaps;
      const flapLever = this.quadrantLever(this.group, 0.17, pedTop, tz, 'FLAPS', this.mat.white, () => sys.flaps.handle / (flaps.length - 1), (v) => sys.setFlapsHandle(Math.round(v * (flaps.length - 1))), { len: 0.12, range: 50, knobShape: 'tbar', tip: () => `Flaps ${flaps[sys.flaps.handle].label}` });
      void flapLever;
      // fuel control switches and engine start
      [0, 1].forEach((i) => {
        const g = new THREE.Group();
        g.add(box(0.02, 0.05, 0.02, this.mat.red));
        g.position.set(i ? 0.05 : -0.05, pedTop + 0.03, tz + 0.18);
        this.group.add(g);
        this.hot(g, { tip: () => `ENG ${i + 1} fuel control ${e[i].mixture > 0.5 ? 'RUN' : 'CUTOFF'}`, click: () => {
          e[i].mixture = e[i].mixture > 0.5 ? 0 : 1;
          click();
        } });
        this.animators.push(() => (g.rotation.x = e[i].mixture > 0.5 ? -0.5 : 0.5));
      });
      // radio panels on the aft pedestal
      this.radioUnit(top, 0, -(tz + 0.32), 1, 0.4, 0.09).mesh.position.set(0, -(tz + 0.3), 0);
      this.transponderUnit(top, 0, -(tz + 0.42), 0.4, 0.07);
      // Overhead panel: lights, start switches, parking brake
      const oh = new THREE.Group();
      oh.position.set(0, this.eye.y + 0.42, this.eye.z - 0.35);
      oh.rotation.x = Math.PI / 2 - 0.35; // faces down and aft, towards the crew
      this.group.add(oh);
      const OHP = { group: oh, label: () => {} };
      const ohW = 0.9, ohH = 0.5;
      const ohPanel = this.makeFlat(oh, ohW, ohH, (ctx, F) => {
        cfg.cockpit.switches.forEach((name, i) => F.text(SIM.UI ? (SWITCH_TEXT[name] || name.toUpperCase()) : name, -0.36 + i * 0.075, -0.05));
        F.text('ENG 1 START', -0.2, 0.12);
        F.text('ENG 2 START', 0.2, 0.12);
        F.text('LIGHTS', -0.36, -0.15, 'left');
      });
      void ohPanel;
      cfg.cockpit.switches.forEach((name, i) => this.toggleSwitch(OHP, -0.36 + i * 0.075, -0.0, '', () => sys.switches[name], () => sys.toggleSwitch(name), { red: name === 'batt' || name === 'gen' }));
      [0, 1].forEach((i) => {
        const k = this.knob(OHP, i ? 0.2 : -0.2, 0.18, 0.02, '', () => (e[i].starter = !e[i].starter), { tip: () => `ENG ${i + 1} START ${e[i].starter ? 'GRD' : 'OFF'}` });
        this.animators.push(() => (k.rotation.z = e[i].starter ? -0.8 : 0));
      });
      // Parking brake lever on the pedestal
      const pk = new THREE.Group();
      pk.add(box(0.03, 0.02, 0.05, this.mat.red));
      pk.position.set(-0.17, pedTop + 0.012, tz + 0.26);
      this.group.add(pk);
      this.hot(pk, { tip: () => `Parking brake ${sys.brakes.parking ? 'SET' : 'OFF'}`, click: () => {
        sys.toggleParkingBrake();
        click();
      } });
      this.animators.push(() => (pk.rotation.x = sys.brakes.parking ? -0.6 : 0));
      // Stabiliser trim wheels on the pedestal sides
      this.trimWheel(this.group, -0.25, pedTop - 0.12, tz + 0.05);
      this.trimWheel(this.group, 0.25, pedTop - 0.12, tz + 0.05);
      // Yokes and rudder pedals
      this.yoke(ex, P, { column: 'floor' });
      this.yoke(-ex, P, { column: 'floor' });
      this.pedals(ex);
      this.pedals(-ex);
      P.paint();
    }

    /** Flat textured plate (overhead) with painted labels in metres. */
    makeFlat(group, w, h, decorate) {
      const ppm = this.ppmPanel * 0.8;
      const c = makeCanvas(w * ppm, h * ppm);
      const ctx = c.getContext('2d');
      ctx.fillStyle = shade(this.panelColor, 1.0);
      ctx.fillRect(0, 0, c.width, c.height);
      const F = {
        text: (t, x, y, align = 'center') => {
          ctx.fillStyle = '#ecebe5';
          ctx.font = `700 ${Math.round(0.011 * ppm)}px ${FONT}`;
          ctx.textAlign = align;
          ctx.textBaseline = 'middle';
          ctx.fillText(t, (x / w + 0.5) * c.width, (0.5 - y / h) * c.height);
        },
      };
      decorate(ctx, F);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshLambertMaterial({ map: canvasTexture(c) }));
      group.add(m);
      return m;
    }

    mcpUnit(parent, x, y, w, h) {
      const ap = this.ac.autopilot, nav = this.s.nav;
      const Fmt = SIM.UI.Fmt;
      const u = new CanvasUnit(this, {
        w, h, rate: 0.1, draw: (ctx, U) => {
          unitBackground(ctx, U);
          const on = ap.powered;
          const win = (cx, txt, label) => {
            ctx.fillStyle = '#050505';
            ctx.fillRect(cx - U.cw * 0.045, U.ch * 0.2, U.cw * 0.09, U.ch * 0.26);
            ctx.fillStyle = '#ffb347';
            ctx.font = `600 ${Math.round(U.ch * 0.2)}px ${MONO}`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            if (on) ctx.fillText(txt, cx, U.ch * 0.33);
            ctx.fillStyle = '#d6d4cd';
            ctx.font = `700 ${Math.round(U.ch * 0.12)}px ${FONT}`;
            ctx.fillText(label, cx, U.ch * 0.1);
          };
          win(U.cw * 0.07, Fmt.hdg(nav.radios.obs.nav1), 'COURSE');
          win(U.cw * 0.22, String(Math.round(ap.spdTarget)), 'IAS');
          win(U.cw * 0.42, Fmt.hdg(ap.hdgBug), 'HEADING');
          win(U.cw * 0.62, String(Math.round(ap.altTarget)), 'ALTITUDE');
          win(U.cw * 0.78, ap.vertical === 'VS' && ap.engaged ? `${ap.vsTarget > 0 ? '+' : ''}${ap.vsTarget}` : '', 'V/S');
          U.regions.forEach((rg) => (rg.kind === 'knob' ? drawKnob(ctx, rg, '') : drawButton(ctx, rg, rg.label, { led: true, lit: on && rg.lit && rg.lit() })));
        },
      });
      const K = (cx, tip, fn) => u.region({ x: u.cw * cx - u.cw * 0.025, y: u.ch * 0.5, w: u.cw * 0.05, h: u.ch * 0.46, kind: 'knob', tip, click: (b, e) => fn(b === 2 ? -1 : 1, e && e.shiftKey), wheel: (d, e) => fn(d, e && e.shiftKey) });
      const B = (cx, cy, label, fn, lit) => u.region({ x: u.cw * cx - u.cw * 0.032, y: u.ch * cy, w: u.cw * 0.064, h: u.ch * 0.3, label, lit, tip: label, click: () => {
        fn();
        click();
      } });
      K(0.07, 'Course (NAV 1)', (d, c) => nav.radios.adjustObs('nav1', d * (c ? 10 : 1)));
      K(0.22, 'Speed', (d, c) => ap.adjustSpeed(d * (c ? 10 : 1)));
      B(0.3, 0.55, 'A/T', () => ap.toggleAutothrottle(), () => ap.atEngaged);
      K(0.42, 'Heading', (d, c) => ap.adjustHeading(d * (c ? 10 : 1)));
      B(0.35, 0.18, 'HDG SEL', () => ap.setLateral('HDG'), () => ap.engaged && ap.lateral === 'HDG');
      B(0.5, 0.18, 'LNAV', () => ap.setLateral('NAV'), () => ap.engaged && (ap.lateral === 'NAV' || ap.armedLateral === 'NAV'));
      B(0.5, 0.55, 'APP', () => ap.setLateral('APR'), () => ap.engaged && (ap.lateral === 'APR' || ap.armedLateral === 'APR'));
      K(0.62, 'Altitude (shift ×1000)', (d, c) => ap.adjustAltitude(d * (c ? 1000 : 100)));
      B(0.7, 0.55, 'ALT HLD', () => ap.setVertical('ALT'), () => ap.engaged && ap.vertical === 'ALT');
      K(0.78, 'Vertical speed', (d) => ap.adjustVS(d * 100));
      B(0.86, 0.55, 'V/S', () => ap.setVertical('VS'), () => ap.engaged && ap.vertical === 'VS');
      B(0.94, 0.3, 'CMD A', () => ap.toggleAP(), () => ap.engaged);
      u.mesh.position.set(x, y, 0.004);
      parent.add(u.mesh);
      return u;
    }

    /* ------------------------------------------------------------------ runtime */

    get visible() {
      return this.group.visible;
    }

    update(dt, { cockpit }) {
      if (!cockpit) return;
      for (const a of this.animators) a();
      // Instrument and display refresh (only in the cockpit view)
      const rate = 1 / (this.s.app.settings.data.graphics.instrumentRate || 30);
      this.instTimer += dt;
      const due = this.instTimer >= rate;
      if (due) {
        const step = this.instTimer;
        this.instTimer = 0;
        for (const ins of this.instruments) {
          ins.t += step;
          if (ins.t < ins.rate) continue;
          ins.t = 0;
          ins.gauge.render(ins.data());
          ins.tex.needsUpdate = true;
        }
      }
      for (const u of this.units) u.update(dt);
      // Panel lighting: instruments dim at night unless the panel lights are on
      const day = this.s.world.env.daylight;
      const lights = this.ac.systems.lightOn('panel');
      const lum = M.clamp(day * 1.0 + (lights ? 0.75 : 0.22), 0.25, 1);
      if (Math.abs((this._lum || 0) - lum) > 0.01) {
        this._lum = lum;
        this.instruments.forEach((i) => i.mat.color.setScalar(lum));
        this.units.forEach((u) => u.mat.color.setScalar(lum));
      }
      this.flood.intensity = lights && day < 0.6 ? (0.6 - day) * 1.4 : 0;
      // ambient bounce inside the cabin follows the daylight
      const bounce = 0.05 + 0.32 * day;
      if (Math.abs((this._bounce || 0) - bounce) > 0.01) {
        this._bounce = bounce;
        this.bounceMats.forEach((m, i) => (m.emissiveIntensity = i === 0 ? bounce : bounce * 0.55));
        [this.mat.seat, this.mat.seatDark, this.mat.floor, this.mat.pedestal, this.mat.glare].forEach((m) => m.emissive && m.emissive.copy(m.color).multiplyScalar(bounce * 0.8));
      }
    }

    /* ------------------------------------------------------------------ pointer interaction */

    pick(clientX, clientY, camera, rect) {
      this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      this.raycaster.setFromCamera(this.ndc, camera);
      this.raycaster.near = 0.02;
      this.raycaster.far = 3.5;
      const hits = this.raycaster.intersectObjects(this.pickables, false);
      if (!hits.length) return null;
      const h0 = hits[0];
      const o = h0.object;
      if (o.userData.unit) {
        const region = o.userData.unit.hit(h0.uv);
        return region ? { unit: o.userData.unit, region } : null;
      }
      return o.userData.hot ? { hot: o.userData.hot, object: o } : null;
    }

    /** Returns true when the press landed on a cockpit control. */
    pointerDown(e, camera, rect) {
      const p = this.pick(e.clientX, e.clientY, camera, rect);
      if (!p) return false;
      const b = e.button;
      if (p.unit) {
        const r = p.region;
        if (r.hold) {
          r.hold.down();
          this.drag = { hold: r.hold };
        } else if (r.click) {
          r.click(b, e);
          click(0.6);
          this.drag = { unit: p.unit };
        }
        p.unit.update(0, true);
        return true;
      }
      const h = p.hot;
      this.drag = { hot: h, accX: 0 };
      if (h.down) h.down(b, e);
      if (h.click) h.click(b, e);
      return true;
    }

    pointerMove(e, dx, dy, camera, rect) {
      if (this.drag) {
        const h = this.drag.hot;
        if (h) {
          if (h.drag) h.drag(dx, dy, e);
          else if (h.dragX) {
            this.drag.accX += dx;
            while (Math.abs(this.drag.accX) >= 14) {
              h.dragX(Math.sign(this.drag.accX));
              this.drag.accX -= Math.sign(this.drag.accX) * 14;
            }
          }
        }
        return true;
      }
      // hover: highlight and tooltip
      const p = this.pick(e.clientX, e.clientY, camera, rect);
      this.setHover(p);
      return false;
    }

    pointerUp() {
      const d = this.drag;
      this.drag = null;
      if (!d) return false;
      if (d.hold) d.hold.up();
      if (d.hot && d.hot.up) d.hot.up();
      return true;
    }

    wheel(e, camera, rect) {
      const p = this.pick(e.clientX, e.clientY, camera, rect);
      if (!p) return false;
      const d = e.deltaY < 0 ? 1 : -1;
      if (p.unit && p.region.wheel) {
        p.region.wheel(d, e);
        p.unit.update(0, true);
        return true;
      }
      if (p.hot && p.hot.wheel) {
        p.hot.wheel(d, e);
        return true;
      }
      return false;
    }

    setHover(p) {
      const prev = this.hover;
      const key = p ? p.hot || p.region : null;
      if (prev && prev.key === key) {
        this.tip = p ? (p.hot ? p.hot.tip && p.hot.tip() : p.region.tip) : null;
        return;
      }
      if (prev) {
        if (prev.hot) prev.hot.root.traverse((o) => o.isMesh && o.material.emissive && o.material.emissive.setHex(0x000000));
        if (prev.unit) {
          prev.unit.hover = null;
          prev.unit.update(0, true);
        }
      }
      this.hover = p ? { key, hot: p.hot, unit: p.unit } : null;
      if (p && p.hot) p.hot.root.traverse((o) => o.isMesh && o.material.emissive && o.material.emissive.setHex(0x1f3a52));
      if (p && p.unit) {
        p.unit.hover = p.region;
        p.unit.update(0, true);
      }
      this.tip = p ? (p.hot ? p.hot.tip && p.hot.tip() : p.region.tip) : null;
      this.cursor = p ? (p.hot && p.hot.cursor) || 'pointer' : null;
    }

    dispose() {
      if (this.group.parent) this.group.parent.remove(this.group);
      SIM.RenderUtils.disposeObject(this.group);
      this.instruments.forEach((i) => i.tex.dispose());
      this.units.forEach((u) => u.tex.dispose());
    }
  }

  function shade(hex, f) {
    const c = new THREE.Color(hex);
    c.multiplyScalar(f);
    return `#${c.getHexString()}`;
  }

  SIM.VirtualCockpit = VirtualCockpit;
})(window.SIM);
