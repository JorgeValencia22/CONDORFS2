/**
 * AircraftModelBuilder — procedural 3D aircraft (no external model files):
 * lofted fuselage with livery texture, airfoil wings/tails with moving ailerons, flaps, elevator
 * and rudder, propellers or turbofans, landing gear (fixed or retractable), navigation/beacon/strobe
 * lights, landing light and a cockpit interior frame for the cockpit camera.
 *
 * Body axes: x right, y up, z aft (nose -z), origin = centre of gravity.
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;

  /* ------------------------------------------------------------------ geometry helpers */

  const sgnPow = (v, p) => Math.sign(v) * Math.pow(Math.abs(v), p);

  /**
   * Lofted body through cross-sections {z, w, h, y, n}. UV: u along the length, v around
   * (bottom = 0, right side = .25, top = .5, left = .75) mapped as v_tex = 1 - a.
   */
  function loft(sections, radial = 28) {
    const pos = [], uv = [], idx = [];
    const z0 = sections[0].z, z1 = sections[sections.length - 1].z;
    sections.forEach((s) => {
      const e = 2 / (s.n || 2);
      for (let k = 0; k <= radial; k++) {
        const a = k / radial;
        const t = a * Math.PI * 2;
        const x = (s.w / 2) * sgnPow(Math.sin(t), e);
        const y = -(s.h / 2) * sgnPow(Math.cos(t), e) + (s.y || 0);
        pos.push(x, y, s.z);
        uv.push((s.z - z0) / (z1 - z0), 1 - a);
      }
    });
    const ring = radial + 1;
    for (let i = 0; i < sections.length - 1; i++) {
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

  /** Normalised airfoil loop (TE upper -> LE -> TE lower). z: 0 (LE) .. 1 (TE), y thickness. */
  function airfoil(thick = 0.12, camber = 0.02, n = 10) {
    const pts = [];
    const yt = (x) => 5 * thick * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x * x * x - 0.1036 * x * x * x * x);
    const yc = (x) => (x < 0.4 ? (camber / 0.16) * (0.8 * x - x * x) : (camber / 0.36) * (0.2 + 0.8 * x - x * x));
    for (let i = n; i >= 0; i--) {
      const x = 0.5 - 0.5 * Math.cos((i / n) * Math.PI);
      pts.push([x, yc(x) + yt(x)]);
    }
    for (let i = 1; i <= n; i++) {
      const x = 0.5 - 0.5 * Math.cos((i / n) * Math.PI);
      pts.push([x, yc(x) - yt(x)]);
    }
    return pts;
  }

  /**
   * Wing panel from root to tip. All lengths in metres.
   * opts: {span, rootChord, tipChord, sweep, dihedral(deg), thick, camber, side(+1/-1), x0, y0, z0, vertical}
   */
  function wingPanel(o) {
    const prof = airfoil(o.thick || 0.12, o.camber ?? 0.02, 8);
    const stations = o.stations || 2;
    const pos = [], idx = [];
    const side = o.side || 1;
    const dih = Math.tan((o.dihedral || 0) * M.DEG);
    for (let s = 0; s < stations; s++) {
      const f = s / (stations - 1);
      const c = M.lerp(o.rootChord, o.tipChord, f);
      const span = o.span * f;
      const zLE = (o.z0 || 0) + (o.sweep || 0) * f;
      const yOff = (o.y0 || 0) + dih * span;
      prof.forEach(([pz, py]) => {
        if (o.vertical) pos.push((o.x0 || 0) + py * c, yOff + span, zLE + pz * c);
        else pos.push((o.x0 || 0) + side * span, yOff + py * c, zLE + pz * c);
      });
    }
    const n = prof.length;
    for (let s = 0; s < stations - 1; s++) {
      for (let k = 0; k < n - 1; k++) {
        const a = s * n + k, b = a + 1, c = a + n, d = c + 1;
        if (side > 0 && !o.vertical) idx.push(a, c, b, b, c, d);
        else idx.push(a, b, c, b, d, c);
      }
    }
    // tip cap
    const t = (stations - 1) * n;
    for (let k = 1; k < n - 1; k++) {
      if (side > 0 && !o.vertical) idx.push(t, t + k, t + k + 1);
      else idx.push(t, t + k + 1, t + k);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  /** Thin movable surface hinged along its leading edge; returns {pivot, mesh}. */
  function controlSurface(mat, { x0, x1, y, z, chord, thick = 0.04, dihedralY = 0 }) {
    const pivot = new THREE.Group();
    const w = Math.abs(x1 - x0);
    const geo = new THREE.BoxGeometry(w, thick, chord);
    geo.translate(0, 0, chord / 2);
    const mesh = new THREE.Mesh(geo, mat);
    pivot.position.set((x0 + x1) / 2, y + dihedralY, z);
    pivot.add(mesh);
    mesh.castShadow = true;
    return pivot;
  }

  function wheel(mat, r, w, hubMat) {
    const g = new THREE.Group();
    const tyre = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 16), mat);
    tyre.rotation.z = Math.PI / 2;
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.45, r * 0.45, w * 1.05, 10), hubMat);
    hub.rotation.z = Math.PI / 2;
    g.add(tyre, hub);
    tyre.castShadow = true;
    return g;
  }

  function propeller(blades, radius, matBlade, matSpinner, spinnerR = 0.16) {
    const prop = new THREE.Group();
    const bladeGroup = new THREE.Group();
    for (let i = 0; i < blades; i++) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.13, radius, 0.035), matBlade);
      b.position.y = radius / 2;
      b.rotation.y = 0.35;
      const holder = new THREE.Group();
      holder.rotation.z = (i / blades) * Math.PI * 2;
      holder.add(b);
      bladeGroup.add(holder);
    }
    const spinner = new THREE.Mesh(new THREE.ConeGeometry(spinnerR, spinnerR * 2.6, 16).rotateX(-Math.PI / 2), matSpinner);
    spinner.position.z = -spinnerR * 1.1;
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(radius, 32),
      new THREE.MeshBasicMaterial({ color: 0x222222, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide })
    );
    disc.renderOrder = 8;
    prop.add(bladeGroup, spinner, disc);
    prop.userData = { blades: bladeGroup, disc };
    return prop;
  }

  /* ------------------------------------------------------------------ materials */

  function materials(visual, livery) {
    const side = THREE.DoubleSide;
    return {
      body: new THREE.MeshPhongMaterial({ map: livery, specular: 0x666666, shininess: 55 }),
      skin: new THREE.MeshPhongMaterial({ color: visual.base, specular: 0x555555, shininess: 50, side }),
      accent: new THREE.MeshPhongMaterial({ color: visual.stripe, specular: 0x444444, shininess: 40, side }),
      glass: new THREE.MeshPhongMaterial({ color: visual.glass, specular: 0xbbccdd, shininess: 95, transparent: true, opacity: 0.72, side }),
      dark: new THREE.MeshLambertMaterial({ color: 0x23262a }),
      tyre: new THREE.MeshLambertMaterial({ color: 0x1b1b1b }),
      metal: new THREE.MeshPhongMaterial({ color: 0xa8acb0, specular: 0x999999, shininess: 70 }),
      prop: new THREE.MeshLambertMaterial({ color: 0x2a2a2a }),
      spinner: new THREE.MeshPhongMaterial({ color: visual.stripe, specular: 0x777777, shininess: 70 }),
      interior: new THREE.MeshLambertMaterial({ color: 0x3a3c40, side }),
      interiorDark: new THREE.MeshLambertMaterial({ color: 0x1c1d20, side }),
      nacelle: new THREE.MeshPhongMaterial({ color: 0xc7cacf, specular: 0x777777, shininess: 60, side }),
    };
  }

  /* ------------------------------------------------------------------ builder */

  const LAYOUT = {
    highwing: { cabin: [0.2, 0.47], windshield: [0.17, 0.25], rear: [0.47, 0.56], winA: [0.29, 0.43], reg: 0.66 },
    lowwing: { cabin: [0.2, 0.46], windshield: [0.17, 0.24], rear: [0.46, 0.52], winA: [0.31, 0.45], reg: 0.66 },
    twin: { cabin: [0.2, 0.55], windshield: [0.15, 0.22], rear: null, winA: [0.31, 0.43], reg: 0.7, ovalWindows: 5 },
    airliner: { airliner: true },
  };

  function build(cfg, opts = {}) {
    const v = cfg.visual;
    const kind = v.model;
    const livery = SIM.Textures.livery(v, LAYOUT[kind]);
    const mat = materials(v, livery);
    const root = new THREE.Group();
    root.name = cfg.id;
    const exterior = new THREE.Group();
    exterior.name = 'exterior';
    const fuselageGroup = new THREE.Group(); // hidden in cockpit view
    exterior.add(fuselageGroup);
    root.add(exterior);
    const parts = {
      props: [], fans: [], ailerons: [], flaps: [], elevators: [], rudders: [], gears: [], gearDoors: [],
      lights: { nav: [], beacon: [], strobe: [] }, speedbrakes: [],
    };
    const g = cfg.geometry;
    const scale = v.scale || 1;

    if (kind === 'airliner') buildAirliner(cfg, mat, fuselageGroup, exterior, parts);
    else buildGA(cfg, mat, fuselageGroup, exterior, parts, kind);

    // Navigation lights
    const span = g.span / 2;
    const tipZ = kind === 'airliner' ? 5.6 : 0.4;
    const tipY = kind === 'airliner' ? 1.9 : g.wingType === 'high' ? 1.02 : kind === 'twin' ? -0.1 : -0.05;
    const lightList = [
      { type: 'nav', x: -span, y: tipY, z: tipZ, c: [1, 0.12, 0.1] },
      { type: 'nav', x: span, y: tipY, z: tipZ, c: [0.15, 1, 0.3] },
      { type: 'nav', x: 0, y: kind === 'airliner' ? 1.9 : 0.6, z: kind === 'airliner' ? 19.5 : g.length * 0.58, c: [1, 1, 1] },
      { type: 'strobe', x: -span, y: tipY, z: tipZ + 0.1, c: [1, 1, 1] },
      { type: 'strobe', x: span, y: tipY, z: tipZ + 0.1, c: [1, 1, 1] },
      { type: 'beacon', x: 0, y: kind === 'airliner' ? 2.15 : kind === 'highwing' ? 1.95 : 1.6, z: kind === 'airliner' ? 2 : g.length * 0.5, c: [1, 0.1, 0.05] },
      { type: 'beacon', x: 0, y: kind === 'airliner' ? -2.05 : -0.7, z: kind === 'airliner' ? 1 : 0.6, c: [1, 0.1, 0.05] },
    ];
    const lm = SIM.RenderUtils.lightMaterial({ size: kind === 'airliner' ? 1.8 : 1.1, min: 2, max: 26 });
    lightList.forEach((l) => {
      const pts = SIM.RenderUtils.lightPoints([{ x: l.x, y: l.y, z: l.z, r: l.c[0], g: l.c[1], b: l.c[2], s: l.type === 'strobe' ? 1.6 : 1 }], lm.clone());
      pts.material.uniforms.uMap.value = SIM.Textures.get('glow');
      exterior.add(pts);
      parts.lights[l.type].push(pts);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(kind === 'airliner' ? 0.09 : 0.05, 6, 4), new THREE.MeshBasicMaterial({ color: new THREE.Color(l.c[0], l.c[1], l.c[2]) }));
      bulb.position.set(l.x, l.y, l.z);
      exterior.add(bulb);
    });

    // Landing light (real spot light only for the player aircraft)
    if (opts.landingLight) {
      const spot = new THREE.SpotLight(0xfff4e0, 0, kind === 'airliner' ? 900 : 450, 0.32, 0.5, 1.2);
      const lz = kind === 'airliner' ? -2 : -0.8;
      spot.position.set(kind === 'highwing' ? -1.5 : 0, kind === 'highwing' ? 0.95 : -0.3, lz);
      spot.target.position.set(0, -12, -120);
      spot.castShadow = false;
      exterior.add(spot, spot.target);
      parts.landingLight = spot;
      const glow = SIM.RenderUtils.lightPoints([{ x: spot.position.x, y: spot.position.y, z: spot.position.z - 0.3, r: 1, g: 0.97, b: 0.9, s: 1.8 }], SIM.RenderUtils.lightMaterial({ size: 1.4, min: 2, max: 30 }));
      exterior.add(glow);
      parts.landingGlow = glow;
    }

    // Cockpit interior (cockpit camera only)
    const cockpit = buildCockpit(cfg, mat);
    cockpit.visible = false;
    root.add(cockpit);

    exterior.traverse((o) => {
      if (o.isMesh && !o.material.transparent) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    root.scale.setScalar(scale);
    root.userData = { parts, exterior, fuselage: fuselageGroup, cockpit, cfg, time: 0, materials: mat };
    return root;
  }

  /* ------------------------------------------------------------------ general aviation */

  function buildGA(cfg, mat, fus, ext, parts, kind) {
    const g = cfg.geometry;
    const high = kind === 'highwing';
    const twin = kind === 'twin';
    const L = g.length;
    const nz = twin ? -3.4 : -2.3; // nose
    const tz = L + nz;              // tail end
    const S = (z, w, h, y, n = 2.6) => ({ z, w, h, y, n });
    const sections = twin
      ? [S(nz, 0.05, 0.05, -0.05, 2), S(nz + 0.25, 0.6, 0.55, -0.05), S(nz + 1.0, 1.05, 0.95, 0.0), S(-1.6, 1.25, 1.3, 0.1, 3), S(-0.9, 1.32, 1.5, 0.22, 3), S(0.6, 1.32, 1.52, 0.24, 3), S(2.0, 1.15, 1.35, 0.22, 3), S(3.3, 0.72, 0.95, 0.3), S(4.6, 0.36, 0.55, 0.42), S(tz, 0.12, 0.3, 0.5)]
      : [S(nz, 0.66, 0.66, -0.06, 2.4), S(nz + 0.5, 0.96, 0.94, -0.02, 3), S(-1.15, 1.08, 1.18, 0.06, 3.2), S(-0.75, 1.12, 1.5, 0.24, 3.4), S(0.2, 1.12, 1.6, 0.3, 3.4), S(1.1, 1.0, 1.42, 0.28, 3), S(2.1, 0.74, 1.04, 0.3, 2.6), S(3.3, 0.42, 0.66, 0.4, 2.4), S(tz - 0.25, 0.2, 0.42, 0.5, 2.2), S(tz, 0.1, 0.2, 0.52, 2)];
    const body = new THREE.Mesh(loft(sections), mat.body);
    fus.add(body);

    // Wings
    const wy = high ? 1.0 : twin ? -0.42 : -0.5;
    const rootChord = g.wingArea / g.span * (high ? 1.1 : 1.0);
    const tipChord = high ? rootChord * 0.7 : twin ? rootChord * 0.6 : rootChord;
    const fixedFrac = 0.76;
    const dihedral = high ? 1.7 : twin ? 6 : 7;
    const halfSpan = g.span / 2;
    const zLE = high ? -0.85 : twin ? -0.95 : -0.75;
    [1, -1].forEach((side) => {
      const wing = new THREE.Mesh(wingPanel({ span: halfSpan, rootChord: rootChord * fixedFrac, tipChord: tipChord * fixedFrac, sweep: (rootChord - tipChord) * 0.25, dihedral, thick: 0.15, camber: 0.025, side, x0: side * 0.45, y0: wy, z0: zLE }), mat.skin);
      ext.add(wing);
      const dihY = (x) => Math.tan(dihedral * M.DEG) * Math.abs(x);
      // flap inner, aileron outer
      const chordAt = (f) => M.lerp(rootChord, tipChord, f);
      const teAt = (f) => zLE + (rootChord - tipChord) * 0.25 * f + chordAt(f) * fixedFrac;
      const flapX0 = 0.5, flapX1 = halfSpan * 0.5, ailX0 = halfSpan * 0.55, ailX1 = halfSpan * 0.95;
      const flap = controlSurface(mat.skin, { x0: side * flapX0, x1: side * flapX1, y: wy, z: teAt(0.25), chord: chordAt(0.25) * (1 - fixedFrac), dihedralY: dihY(flapX1 * 0.5) });
      const ail = controlSurface(mat.skin, { x0: side * ailX0, x1: side * ailX1, y: wy, z: teAt(0.75), chord: chordAt(0.75) * (1 - fixedFrac), dihedralY: dihY(ailX1 * 0.8) });
      ail.userData.side = side;
      ext.add(flap, ail);
      parts.flaps.push(flap);
      parts.ailerons.push(ail);
      if (high) {
        // wing struts
        const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1, 6), mat.skin);
        const a = new THREE.Vector3(side * 0.55, -0.5, -0.15), b = new THREE.Vector3(side * 2.65, wy + 0.02, -0.35);
        strut.position.copy(a).add(b).multiplyScalar(0.5);
        strut.scale.y = a.distanceTo(b);
        strut.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
        ext.add(strut);
      }
    });

    // Tail
    const tailZ = tz - 1.15;
    const hsY = high ? 0.55 : 0.6;
    [1, -1].forEach((side) => {
      const hs = new THREE.Mesh(wingPanel({ span: twin ? 2.3 : 1.75, rootChord: 0.62, tipChord: 0.45, sweep: 0.12, dihedral: 0, thick: 0.1, camber: 0, side, x0: side * 0.08, y0: hsY, z0: tailZ }), mat.skin);
      ext.add(hs);
      const el = controlSurface(mat.skin, { x0: side * 0.12, x1: side * (twin ? 2.25 : 1.7), y: hsY, z: tailZ + 0.6, chord: 0.38 });
      ext.add(el);
      parts.elevators.push(el);
    });
    const fin = new THREE.Mesh(wingPanel({ span: twin ? 1.55 : 1.35, rootChord: 1.25, tipChord: 0.7, sweep: 0.75, thick: 0.1, camber: 0, vertical: true, x0: 0, y0: 0.62, z0: tailZ - 0.4 }), mat.skin);
    ext.add(fin);
    const rud = new THREE.Group();
    rud.position.set(0, 0.62, tailZ + 0.85);
    const rudMesh = new THREE.Mesh(new THREE.BoxGeometry(0.05, twin ? 1.5 : 1.3, 0.42).translate(0, (twin ? 1.5 : 1.3) / 2, 0.21), mat.accent);
    rud.add(rudMesh);
    ext.add(rud);
    parts.rudders.push(rud);

    // Windscreen glass (subtle reflection over the painted windows)
    const ws = new THREE.Mesh(new THREE.SphereGeometry(0.62, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2.4), mat.glass);
    ws.scale.set(0.9, 0.7, 0.9);
    ws.position.set(0, high ? 0.62 : 0.55, twin ? -1.15 : -0.82);
    ws.rotation.x = -0.45;
    fus.add(ws);

    // Engines and propellers
    const radius = cfg.engines[0].propDiameter / 2;
    if (twin) {
      [-1, 1].forEach((side) => {
        const ex = side * 2.1;
        const nac = new THREE.Mesh(loft([S(-2.2, 0.08, 0.08, 0.05, 2), S(-2.05, 0.55, 0.55, 0.05), S(-1.4, 0.72, 0.75, 0.05), S(0.2, 0.66, 0.7, 0.0), S(1.4, 0.2, 0.28, -0.05)], 16), mat.nacelle);
        nac.position.set(ex, 0.08, 0);
        ext.add(nac);
        const prop = propeller(3, radius, mat.prop, mat.spinner, 0.17);
        prop.position.set(ex, 0.13, -2.25);
        ext.add(prop);
        parts.props.push(prop);
      });
    } else {
      const prop = propeller(2, radius, mat.prop, mat.spinner, 0.16);
      prop.position.set(0, -0.05, nz - 0.08);
      ext.add(prop);
      parts.props.push(prop);
    }

    // Landing gear
    const gp = cfg.gear.points;
    const tyreR = twin ? 0.22 : 0.2;
    gp.forEach((p) => {
      const leg = new THREE.Group();
      const [x, y, z] = p.pos;
      const attachY = p.id === 'nose' ? -0.25 : twin ? -0.45 : -0.5;
      const len = attachY - (y + tyreR);
      const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, Math.abs(len), 6), mat.metal);
      strut.position.set(0, -Math.abs(len) / 2, 0);
      const w = wheel(mat.tyre, tyreR, p.id === 'nose' ? 0.12 : 0.15, mat.metal);
      w.position.set(0, -Math.abs(len), 0);
      leg.add(strut, w);
      if (cfg.visual.fairings) {
        const fair = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 8), mat.skin);
        fair.scale.set(0.45, 0.8, 1.6);
        fair.position.copy(w.position);
        leg.add(fair);
      }
      leg.position.set(x, attachY, z);
      if (!cfg.gear.retractable && p.id !== 'nose') {
        // spring-steel legs lean outwards
        strut.rotation.z = Math.sign(x) * 0.0;
      }
      ext.add(leg);
      parts.gears.push({ group: leg, wheel: w, id: p.id, rest: w.position.y, retractAxis: p.id === 'nose' ? 'x' : 'z', side: Math.sign(x) || 1 });
    });
  }

  /* ------------------------------------------------------------------ airliner */

  function buildAirliner(cfg, mat, fus, ext, parts) {
    const S = (z, w, h, y, n = 2) => ({ z, w, h, y, n });
    const body = new THREE.Mesh(loft([
      S(-20.2, 0.1, 0.1, -0.4), S(-19.8, 1.3, 1.25, -0.3), S(-18.9, 2.6, 2.6, -0.1), S(-17.6, 3.4, 3.55, 0.05), S(-15.5, 3.76, 4.0, 0.1),
      S(9.5, 3.76, 4.0, 0.1), S(13.5, 3.2, 3.3, 0.4), S(17.0, 2.0, 2.2, 0.95), S(19.4, 0.8, 1.1, 1.45), S(20.2, 0.2, 0.3, 1.6),
    ], 32), mat.body);
    fus.add(body);
    // cockpit glass highlight
    const glass = new THREE.Mesh(new THREE.SphereGeometry(1.0, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2.6), mat.glass);
    glass.scale.set(1.45, 0.55, 1.1);
    glass.position.set(0, 1.0, -18.1);
    glass.rotation.x = -0.6;
    fus.add(glass);

    // Wings (swept), centre box under fuselage
    const wy = -1.25;
    const root = 7.0, tip = 1.6, half = 17.2, sweep = 9.0, dih = 6;
    [1, -1].forEach((side) => {
      const w = new THREE.Mesh(wingPanel({ span: half - 1.6, rootChord: root * 0.8, tipChord: tip * 0.82, sweep, dihedral: dih, thick: 0.13, camber: 0.02, side, x0: side * 1.6, y0: wy, z0: -4.6, stations: 3 }), mat.skin);
      ext.add(w);
      // winglet
      const wl = new THREE.Mesh(wingPanel({ span: 2.4, rootChord: 1.5, tipChord: 0.6, sweep: 1.3, thick: 0.08, camber: 0, vertical: true, x0: side * (half + 0.0), y0: wy + Math.tan(dih * M.DEG) * (half - 1.6), z0: -4.6 + sweep + 0.2 }), mat.accent);
      ext.add(wl);
      const dy = (x) => Math.tan(dih * M.DEG) * (Math.abs(x) - 1.6);
      const teZ = (f) => -4.6 + sweep * f + M.lerp(root, tip, f) * 0.8;
      // flaps (inner) and ailerons (outer)
      const flap = controlSurface(mat.skin, { x0: side * 2.2, x1: side * 9.5, y: wy, z: teZ(0.27), chord: 1.3, thick: 0.12, dihedralY: dy(6) });
      flap.rotation.y = side * -0.18;
      const ail = controlSurface(mat.skin, { x0: side * 11, x1: side * 15.5, y: wy, z: teZ(0.78), chord: 0.7, thick: 0.08, dihedralY: dy(13.5) });
      ail.rotation.y = side * -0.3;
      ail.userData.side = side;
      ext.add(flap, ail);
      parts.flaps.push(flap);
      parts.ailerons.push(ail);
      // speed brake panels on top of the wing
      const sb = controlSurface(mat.skin, { x0: side * 4, x1: side * 10, y: wy + 0.42, z: teZ(0.4) - 1.6, chord: 1.1, thick: 0.05, dihedralY: dy(7) });
      sb.rotation.y = side * -0.2;
      ext.add(sb);
      parts.speedbrakes.push(sb);
      // Engine
      const ex = side * 4.9;
      const nac = new THREE.Mesh(loft([S(-5.6, 1.92, 1.82, 0, 2), S(-5.0, 2.06, 1.95, 0), S(-3.0, 1.98, 1.9, 0.0), S(-1.4, 1.4, 1.4, 0.1), S(-0.6, 0.8, 0.8, 0.15)], 24), mat.nacelle);
      nac.position.set(ex, -2.1, 0.5);
      ext.add(nac);
      const intake = new THREE.Mesh(new THREE.CircleGeometry(0.88, 24), mat.dark);
      intake.position.set(ex, -2.1, -5.05 + 0.5);
      intake.rotation.y = Math.PI;
      ext.add(intake);
      const fan = new THREE.Group();
      for (let b = 0; b < 9; b++) {
        const blade = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.8, 0.03), mat.metal);
        blade.position.y = 0.42;
        const h = new THREE.Group();
        h.rotation.z = (b / 9) * Math.PI * 2;
        blade.rotation.y = 0.5;
        h.add(blade);
        fan.add(h);
      }
      const hub = new THREE.Mesh(new THREE.ConeGeometry(0.25, 0.5, 12).rotateX(-Math.PI / 2), mat.metal);
      fan.add(hub);
      fan.position.set(ex, -2.1, -4.85 + 0.5);
      ext.add(fan);
      parts.fans.push(fan);
      const pylon = new THREE.Mesh(new THREE.BoxGeometry(0.35, 1.0, 3.6), mat.skin);
      pylon.position.set(ex, -1.35, -2.3);
      ext.add(pylon);
    });

    // Tail surfaces
    [1, -1].forEach((side) => {
      const hs = new THREE.Mesh(wingPanel({ span: 6.6, rootChord: 3.9, tipChord: 1.3, sweep: 3.9, dihedral: 7, thick: 0.1, camber: 0, side, x0: side * 0.6, y0: 1.05, z0: 14.2 }), mat.skin);
      ext.add(hs);
      const el = controlSurface(mat.skin, { x0: side * 1.2, x1: side * 6.2, y: 1.05, z: 17.6, chord: 1.0, thick: 0.08, dihedralY: Math.tan(7 * M.DEG) * 3.5 });
      el.rotation.y = side * -0.42;
      ext.add(el);
      parts.elevators.push(el);
    });
    const fin = new THREE.Mesh(wingPanel({ span: 7.0, rootChord: 6.2, tipChord: 2.0, sweep: 5.6, thick: 0.1, camber: 0, vertical: true, x0: 0, y0: 1.6, z0: 12.2 }), mat.accent);
    ext.add(fin);
    const rud = new THREE.Group();
    rud.position.set(0, 1.7, 18.0);
    const rudMesh = new THREE.Mesh(new THREE.BoxGeometry(0.12, 6.4, 1.3).translate(0, 3.2, 0.65), mat.accent);
    rudMesh.rotation.x = 0.55;
    rud.add(rudMesh);
    ext.add(rud);
    parts.rudders.push(rud);

    // Gear: nose (2 wheels) and mains (2x2)
    cfg.gear.points.forEach((p) => {
      const [x, y, z] = p.pos;
      const leg = new THREE.Group();
      const attachY = p.id === 'nose' ? -1.6 : -1.3;
      const len = attachY - (y + 0.55);
      const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, Math.abs(len), 8), mat.metal);
      strut.position.y = -Math.abs(len) / 2;
      leg.add(strut);
      const wg = new THREE.Group();
      const r = p.id === 'nose' ? 0.38 : 0.56;
      const offsets = p.id === 'nose' ? [[-0.25, 0]] : [[-0.32, -0.6], [-0.32, 0.6]];
      offsets.forEach(([dx, dz]) => {
        [-1, 1].forEach((s) => {
          const w = wheel(mat.tyre, r, 0.36, mat.metal);
          w.position.set(s * Math.abs(dx) * (p.id === 'nose' ? 1 : 1.3), 0, dz);
          wg.add(w);
        });
      });
      wg.position.y = -Math.abs(len);
      leg.add(wg);
      leg.position.set(x, attachY, z);
      ext.add(leg);
      parts.gears.push({ group: leg, wheel: wg, id: p.id, rest: wg.position.y, retractAxis: p.id === 'nose' ? 'x' : 'z', side: Math.sign(x) || 1 });
    });
  }

  /* ------------------------------------------------------------------ cockpit interior */

  function buildCockpit(cfg, mat) {
    const g = new THREE.Group();
    const [ex, ey, ez] = cfg.geometry.eye;
    const air = cfg.visual.model === 'airliner';
    const panelZ = ez - (air ? 1.05 : 0.78);
    // Glareshield + panel body (mostly hidden by the 2D panel, visible when it is closed)
    const shield = new THREE.Mesh(new THREE.BoxGeometry(air ? 3.2 : 1.25, 0.08, air ? 0.5 : 0.32), mat.interiorDark);
    shield.position.set(air ? 0.55 + ex : 0, ey - (air ? 0.22 : 0.2), panelZ + 0.05);
    const panel = new THREE.Mesh(new THREE.BoxGeometry(air ? 3.2 : 1.25, air ? 0.9 : 0.55, 0.05), mat.interior);
    panel.position.set(shield.position.x, shield.position.y - (air ? 0.45 : 0.3), panelZ + 0.12);
    g.add(shield, panel);
    // Window pillars
    const pillarMat = mat.interior;
    const mk = (x0, y0, z0, x1, y1, z1, r = 0.022) => {
      const a = new THREE.Vector3(x0, y0, z0), b = new THREE.Vector3(x1, y1, z1);
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, a.distanceTo(b), 6), pillarMat);
      m.position.copy(a).add(b).multiplyScalar(0.5);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      g.add(m);
    };
    if (air) {
      const cx = 0;
      mk(cx - 1.3, ey - 0.15, panelZ - 0.2, cx - 1.2, ey + 0.55, panelZ + 0.1, 0.06);
      mk(cx + 1.3, ey - 0.15, panelZ - 0.2, cx + 1.2, ey + 0.55, panelZ + 0.1, 0.06);
      mk(cx - 0.02, ey - 0.15, panelZ - 0.45, cx, ey + 0.5, panelZ - 0.1, 0.05);
      mk(cx - 1.6, ey + 0.55, panelZ + 0.1, cx + 1.6, ey + 0.55, panelZ + 0.1, 0.08);
      const overhead = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.06, 1.4), mat.interior);
      overhead.position.set(cx, ey + 0.62, ez + 0.1);
      overhead.rotation.x = -0.25;
      g.add(overhead);
    } else {
      const w = 0.64;
      const topY = ey + 0.45;
      mk(-w, ey - 0.18, panelZ, -w * 0.92, topY, panelZ + 0.45);
      mk(w, ey - 0.18, panelZ, w * 0.92, topY, panelZ + 0.45);
      mk(-w * 0.92, topY, panelZ + 0.45, w * 0.92, topY, panelZ + 0.45, 0.04);
      mk(0, ey - 0.15, panelZ + 0.02, 0, topY, panelZ + 0.45, 0.012); // centre divider
      // door posts
      mk(-w, ey - 0.4, ez + 0.75, -w, topY, ez + 0.75, 0.04);
      mk(w, ey - 0.4, ez + 0.75, w, topY, ez + 0.75, 0.04);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.03, 1.4), mat.interior);
      roof.position.set(0, topY + 0.02, ez + 0.6);
      g.add(roof);
      // compass on the glareshield
      const comp = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.08, 0.08), mat.interiorDark);
      comp.position.set(0, topY - 0.05, panelZ + 0.42);
      g.add(comp);
    }
    return g;
  }

  /* ------------------------------------------------------------------ animation */

  /**
   * Updates moving parts from the aircraft state.
   * @param {THREE.Object3D} model
   * @param {Aircraft} ac
   * @param {number} dt
   * @param {object} env { daylight, cockpitView }
   */
  function animate(model, ac, dt, env) {
    const u = model.userData;
    const p = u.parts;
    u.time += dt;
    const ctl = ac.controls;
    const sys = ac.systems;
    // Propellers / fans
    ac.engines.forEach((e, i) => {
      const prop = p.props[i];
      if (prop) {
        const rps = e.rpm / 60;
        prop.userData.blades.rotation.z += rps * Math.PI * 2 * dt * (rps > 18 ? 0.083 : 1);
        const fast = M.smoothstep(350, 900, e.rpm);
        prop.userData.disc.material.opacity = fast * (env.cockpitView ? 0.05 : 0.3);
        prop.userData.blades.visible = !env.cockpitView || fast < 0.7;
      }
      const fan = p.fans[i];
      if (fan) fan.rotation.z += (e.n1 / 100) * 45 * dt * (e.n1 > 30 ? 0.08 : 0.4);
    });
    // Control surfaces
    p.ailerons.forEach((a) => (a.rotation.x = ctl.aileron * a.userData.side * 0.35));
    const flapRad = sys.flaps.pos * M.DEG * (ac.cfg.visual.model === 'airliner' ? 1 : 1);
    p.flaps.forEach((f) => (f.rotation.x = flapRad));
    p.elevators.forEach((e) => (e.rotation.x = -(ctl.elevator + ctl.elevatorTrim * 0.15) * 0.4));
    p.rudders.forEach((r) => (r.rotation.y = -(ctl.rudder + ctl.rudderTrim) * 0.45));
    p.speedbrakes.forEach((s) => (s.rotation.x = -sys.speedbrake.pos * 0.75));
    // Gear: compression and retraction
    const gearPos = ac.cfg.gear.retractable ? sys.gear.pos : 1;
    p.gears.forEach((gp, i) => {
      const fg = ac.fm.gear[i];
      const comp = fg ? Math.min(fg.compression, 0.3) : 0;
      gp.wheel.position.y = gp.rest + comp * 0.9;
      if (ac.cfg.gear.retractable) {
        const r = (1 - gearPos) * Math.PI * 0.5;
        if (gp.retractAxis === 'x') gp.group.rotation.x = -r;
        else gp.group.rotation.z = -gp.side * r;
        gp.group.visible = gearPos > 0.02;
      }
    });
    // Lights
    const t = u.time;
    const night = 1 - env.daylight;
    const navOn = sys.lightOn('nav');
    const beaconOn = sys.lightOn('beacon') && (t % 1.2) < 0.15;
    const strobePhase = t % 1.3;
    const strobeOn = sys.lightOn('strobe') && (strobePhase < 0.05 || (strobePhase > 0.12 && strobePhase < 0.17));
    const vis = 0.35 + 0.65 * night;
    p.lights.nav.forEach((l) => (l.material.uniforms.uIntensity.value = navOn ? vis : 0));
    p.lights.beacon.forEach((l) => (l.material.uniforms.uIntensity.value = beaconOn ? 0.6 + 0.4 * night : 0));
    p.lights.strobe.forEach((l) => (l.material.uniforms.uIntensity.value = strobeOn ? 1 : 0));
    if (p.landingLight) {
      const on = sys.lightOn('land') || sys.lightOn('taxi');
      p.landingLight.intensity = on ? (sys.lightOn('land') ? 3.2 : 1.6) * (0.25 + night) : 0;
      p.landingGlow.material.uniforms.uIntensity.value = on ? 0.5 + 0.5 * night : 0;
    }
    u.fuselage.visible = !env.cockpitView;
    u.cockpit.visible = !!env.cockpitView;
  }

  SIM.AircraftModelBuilder = { build, animate, loft, wingPanel };
})(window.SIM);
