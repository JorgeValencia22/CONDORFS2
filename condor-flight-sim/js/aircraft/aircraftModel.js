/**
 * AircraftModelBuilder — procedural 3D aircraft built from the same geometry the flight model
 * integrates (SIM.AircraftData): wing and tail planforms from their sections (span stations,
 * leading edge, chord, twist, dihedral), real airfoil thickness and camber, fuselage cross-sections,
 * nacelles, struts and landing gear points.
 *
 * Control surfaces are cut out of the lifting surfaces at their real chord fraction and span and
 * rotate about their true hinge line (which follows taper, sweep, twist and dihedral), so nothing
 * deforms or sticks out when they move: at zero deflection the surface is flush with the wing, and
 * a rounded nose stays inside the cove when it deflects. Flaps with Fowler travel slide aft.
 *
 * Body axes: x right, y up, z aft (nose -z), origin = centre of gravity.
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;
  const D2R = Math.PI / 180;
  const V3 = () => new THREE.Vector3();

  /* ------------------------------------------------------------------ geometry helpers */

  const sgnPow = (v, p) => Math.sign(v) * Math.pow(Math.abs(v), p);

  /**
   * Lofted body through cross-sections {z, w, h, y, n} (superellipse exponent n). UV: u along the
   * length, v around (bottom = 0, right side = .25, top = .5, left = .75) mapped as v_tex = 1 - a.
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

  /** Cross-section of the fuselage at z (linear between the configured stations). */
  function fuselageAt(cfg, z) {
    const fs = cfg.fuselage.sections;
    if (z <= fs[0][0]) return { w: fs[0][1], h: fs[0][2], y: fs[0][3] };
    for (let i = 0; i < fs.length - 1; i++) {
      const a = fs[i], b = fs[i + 1];
      if (z <= b[0]) {
        const f = (z - a[0]) / (b[0] - a[0]);
        return { w: M.lerp(a[1], b[1], f), h: M.lerp(a[2], b[2], f), y: M.lerp(a[3], b[3], f) };
      }
    }
    const l = fs[fs.length - 1];
    return { w: l[1], h: l[2], y: l[3] };
  }

  /* ------------------------------------------------------------------ airfoil sections */

  /** NACA-style thickness distribution (closed trailing edge) for thickness ratio t. */
  const thickness = (x, t) => 5 * t * (0.2969 * Math.sqrt(Math.max(x, 0)) - 0.126 * x - 0.3516 * x * x + 0.2843 * x * x * x - 0.1036 * x * x * x * x);
  /** Mean camber line with maximum camber m at 40 % chord. */
  const camberLine = (x, m) => (x < 0.4 ? (m / 0.16) * (0.8 * x - x * x) : (m / 0.36) * (0.2 + 0.8 * x - x * x));

  /**
   * 2D outline pieces of the chord range [c0, c1] of an airfoil (x along chord 0..1, y up, both in
   * chords). `nose` gives the piece a rounded leading edge (control surface sitting in its cove).
   * Returns { loops: [[x, y]...] polylines with smooth normals, outline: closed polygon for caps }.
   */
  function sectionPieces(af, c0, c1, nose, n = 12) {
    const t = af.t || 0.12, m = af.camber || 0;
    const up = (x) => [x, camberLine(x, m) + thickness(x, t)];
    const lo = (x) => [x, camberLine(x, m) - thickness(x, t)];
    const xs = [];
    if (c0 <= 0) for (let i = 0; i <= n; i++) xs.push(c1 * (1 - Math.cos((i / n) * Math.PI * 0.5)));
    else {
      const k = Math.max(3, Math.round(n * (c1 - c0) * 1.6));
      for (let i = 0; i <= k; i++) xs.push(c0 + ((c1 - c0) * i) / k);
    }
    const main = [];
    for (let i = xs.length - 1; i >= 0; i--) main.push(lo(xs[i]));
    if (c0 > 0 && nose) {
      const yc = camberLine(c0, m), r = thickness(c0, t);
      for (let k = 1; k < 8; k++) {
        const phi = -Math.PI / 2 + (k / 8) * Math.PI;
        main.push([c0 - r * Math.cos(phi), yc + r * Math.sin(phi)]);
      }
    }
    for (let i = c0 <= 0 ? 1 : 0; i < xs.length; i++) main.push(up(xs[i]));
    const loops = [main];
    const outline = main.slice();
    if (c1 < 0.999) loops.push([up(c1), lo(c1)]);
    if (c0 > 0 && !nose) loops.push([lo(c0), up(c0)]);
    return { loops, outline };
  }

  /** Accumulates triangles; pieces that should have hard edges never share vertices. */
  class GeoBuilder {
    constructor() {
      this.pos = [];
      this.idx = [];
    }
    v(p) {
      this.pos.push(p.x, p.y, p.z);
      return this.pos.length / 3 - 1;
    }
    p(i) {
      return new THREE.Vector3(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
    }
    /** Adds triangles, flipping all of them if most face towards `inside(point)`. */
    addOriented(tris, inside) {
      let score = 0;
      const a = V3(), b = V3(), n = V3(), c = V3();
      for (const [i, j, k] of tris) {
        const pi = this.p(i), pj = this.p(j), pk = this.p(k);
        n.crossVectors(a.subVectors(pj, pi), b.subVectors(pk, pi));
        c.copy(pi).add(pj).add(pk).multiplyScalar(1 / 3);
        score += n.dot(c.sub(inside(c)));
      }
      for (const [i, j, k] of tris) {
        if (score >= 0) this.idx.push(i, j, k);
        else this.idx.push(i, k, j);
      }
    }
    build(offset) {
      const g = new THREE.BufferGeometry();
      const pos = offset ? this.pos.map((v, i) => v - (i % 3 === 0 ? offset.x : i % 3 === 1 ? offset.y : offset.z)) : this.pos;
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(this.idx);
      g.computeVertexNormals();
      g.computeBoundingSphere();
      return g;
    }
  }

  /** Point of a station frame {P (leading edge), C (chord dir), N (thickness dir), chord}. */
  const stationPoint = (st, x, y) => st.P.clone().addScaledVector(st.C, x * st.chord).addScaledVector(st.N, y * st.chord);

  /**
   * Sweeps the outline pieces of a chord range through a sequence of span stations and caps both
   * ends. Normals point outwards (front-side rendering, no inside-out faces).
   */
  function sweepSection(gb, stations, af, c0, c1, nose, n) {
    const pieces = sectionPieces(af, c0, c1, nose, n);
    const cx = pieces.outline.reduce((s, p) => s + p[0], 0) / pieces.outline.length;
    const cy = pieces.outline.reduce((s, p) => s + p[1], 0) / pieces.outline.length;
    // inside reference: the nearest point on the centroid line of the piece
    const axisA = stationPoint(stations[0], cx, cy), axisB = stationPoint(stations[stations.length - 1], cx, cy);
    const axis = axisB.clone().sub(axisA);
    const L2 = Math.max(axis.lengthSq(), 1e-9);
    const inside = (q) => {
      const f = M.clamp(q.clone().sub(axisA).dot(axis) / L2, 0, 1);
      return axisA.clone().addScaledVector(axis, f);
    };
    for (const loop of pieces.loops) {
      const rows = stations.map((st) => loop.map(([x, y]) => gb.v(stationPoint(st, x, y))));
      const tris = [];
      for (let i = 0; i < rows.length - 1; i++) {
        for (let k = 0; k < loop.length - 1; k++) {
          const a = rows[i][k], b = rows[i][k + 1], c = rows[i + 1][k], d = rows[i + 1][k + 1];
          tris.push([a, b, c], [b, d, c]);
        }
      }
      gb.addOriented(tris, inside);
    }
    // end caps (fan from the outline centroid)
    [[0, 1], [stations.length - 1, stations.length - 2]].forEach(([si, other]) => {
      const st = stations[si];
      const out = st.P.clone().sub(stations[other].P);
      const ring = pieces.outline.map(([x, y]) => gb.v(stationPoint(st, x, y)));
      const centre = gb.v(stationPoint(st, cx, cy));
      const tris = [];
      for (let k = 0; k < ring.length; k++) tris.push([centre, ring[k], ring[(k + 1) % ring.length]]);
      const insidePt = gb.p(centre).sub(out); // a point inside the surface, behind the cap
      gb.addOriented(tris, () => insidePt);
    });
    return pieces;
  }

  /* ------------------------------------------------------------------ planform stations */

  /** Interpolated wing/tail section {le, chord, twist} at projected span y. */
  function sectionAt(sections, y) {
    for (let i = 0; i < sections.length - 1; i++) {
      const a = sections[i], b = sections[i + 1];
      if (y <= b.y + 1e-6) {
        const f = M.clamp((y - a.y) / (b.y - a.y), 0, 1);
        return { le: M.lerp(a.le, b.le, f), chord: M.lerp(a.chord, b.chord, f), twist: M.lerp(a.twist || 0, b.twist || 0, f) };
      }
    }
    const l = sections[sections.length - 1];
    return { le: l.le, chord: l.chord, twist: l.twist || 0 };
  }

  /** Station frame of a horizontal surface (wing or tailplane) at projected span y on one side. */
  function liftingStation(surf, side, y) {
    const sec = sectionAt(surf.sections, y);
    const dih = (surf.dihedral || 0) * D2R;
    const S = new THREE.Vector3(side * Math.cos(dih), Math.sin(dih), 0);
    const P = new THREE.Vector3(side * y, surf.y0 + y * Math.tan(dih), sec.le);
    const tw = sec.twist * D2R; // positive twist: leading edge up
    const C = new THREE.Vector3(0, -Math.sin(tw), Math.cos(tw));
    C.addScaledVector(S, -C.dot(S)).normalize();
    const N = new THREE.Vector3().crossVectors(S, C).normalize();
    if (N.y < 0) N.negate();
    return { P, C, N, S, chord: sec.chord, y };
  }

  /** Station frame of the fin at height h above its root. */
  function finStation(vt, h) {
    const sec = vt.sections;
    let le = sec[0].le, chord = sec[0].chord;
    for (let i = 0; i < sec.length - 1; i++) {
      if (h <= sec[i + 1].h + 1e-6) {
        const f = M.clamp((h - sec[i].h) / (sec[i + 1].h - sec[i].h), 0, 1);
        le = M.lerp(sec[i].le, sec[i + 1].le, f);
        chord = M.lerp(sec[i].chord, sec[i + 1].chord, f);
        break;
      }
      le = sec[i + 1].le;
      chord = sec[i + 1].chord;
    }
    return { P: new THREE.Vector3(0, vt.y0 + h, le), C: new THREE.Vector3(0, 0, 1), N: new THREE.Vector3(1, 0, 0), S: new THREE.Vector3(0, 1, 0), chord, y: h };
  }

  /* ------------------------------------------------------------------ surfaces with hinged parts */

  /**
   * Builds one side of a lifting surface. `segments` describe span strips [ya, yb] with the chord
   * ranges of their parts: { fixed: [c0, c1], moving: [{ kind, c0, c1, nose }] }.
   * Fixed parts are merged into one mesh; every moving part becomes a pivot group on its hinge line.
   */
  function buildSurface(o) {
    const fixed = new GeoBuilder();
    const movers = [];
    for (const seg of o.segments) {
      const stA = o.station(seg.ya), stB = o.station(seg.yb);
      for (const [c0, c1, nose] of seg.fixed) sweepSection(fixed, [stA, stB], o.af, c0, c1, nose, o.n);
      for (const mv of seg.moving) {
        const gb = new GeoBuilder();
        sweepSection(gb, [stA, stB], o.af, mv.c0, mv.c1, mv.nose, Math.max(6, Math.round(o.n * 0.6)));
        // hinge on the camber line at the hinge chord fraction (or the given pivot fraction)
        const hx = mv.hinge ?? mv.c0;
        const hy = camberLine(hx, o.af.camber || 0);
        const hA = stationPoint(stA, hx, hy), hB = stationPoint(stB, hx, hy);
        const axis = hB.clone().sub(hA).normalize();
        if (o.axisRef && axis.dot(o.axisRef) < 0) axis.negate();
        const hinge = hA.clone().add(hB).multiplyScalar(0.5);
        const mesh = new THREE.Mesh(gb.build(hinge), o.movingMat || o.mat);
        const pivot = new THREE.Group();
        pivot.position.copy(hinge);
        pivot.add(mesh);
        pivot.userData = {
          kind: mv.kind, side: o.side, axis, base: hinge.clone(),
          chordDir: stA.C.clone().add(stB.C).normalize(), normalDir: stA.N.clone().add(stB.N).normalize(),
          chord: (stA.chord + stB.chord) / 2,
        };
        movers.push(pivot);
      }
    }
    return { mesh: new THREE.Mesh(fixed.build(), o.mat), movers };
  }

  /** Sorted, de-duplicated span breakpoints inside [lo, hi]. */
  function breakpoints(list, lo, hi) {
    const v = list.filter((y) => y != null && y > lo + 1e-3 && y < hi - 1e-3).concat([lo, hi]).sort((a, b) => a - b);
    return v.filter((y, i) => i === 0 || y - v[i - 1] > 1e-3);
  }

  /** Wing: flaps, ailerons, (airliner) slats and spoiler panels at their real span and chord. */
  function buildWing(cfg, side, mat) {
    const w = cfg.wing;
    const af = SIM.Airfoils[w.airfoil];
    const semi = w.sections[w.sections.length - 1].y;
    const slats = w.slats ? { y0: 5.4, y1: semi - 0.5, c1: 0.13 } : null;
    const spoil = cfg.systems.speedbrake ? { y0: w.bodyHalfWidth + 0.4, y1: semi * 0.7 } : null;
    const ys = breakpoints([...w.sections.map((s) => s.y), w.flap && w.flap.y0, w.flap && w.flap.y1, w.aileron.y0, w.aileron.y1,
      slats && slats.y0, slats && slats.y1, spoil && spoil.y0, spoil && spoil.y1], 0, semi);
    const segments = [];
    for (let i = 0; i < ys.length - 1; i++) {
      const ya = ys[i], yb = ys[i + 1], ym = (ya + yb) / 2;
      const inR = (r) => r && ym > r.y0 && ym < r.y1;
      const isFlap = inR(w.flap), isAil = inR(w.aileron);
      const cf = isFlap ? w.flap.chordFrac : isAil ? w.aileron.chordFrac : 0;
      const hinge = 1 - cf;
      const front = inR(slats) ? slats.c1 : 0;
      const seg = { ya, yb, fixed: [[front, cf ? hinge : 1, false]], moving: [] };
      if (front) seg.moving.push({ kind: 'slat', c0: 0, c1: front, nose: false, hinge: front });
      if (cf) seg.moving.push({ kind: isFlap ? 'flap' : 'aileron', c0: hinge, c1: 1, nose: true });
      segments.push(seg);
      if (inR(spoil)) seg.spoiler = { c0: hinge - 0.17, c1: hinge - 0.01 };
    }
    const part = buildSurface({
      segments, af, n: 14, mat, side, axisRef: new THREE.Vector3(1, 0, 0),
      station: (y) => liftingStation(w, side, y),
    });
    // spoiler panels: thin plates on the upper skin, hinged at their leading edge
    segments.filter((s) => s.spoiler).forEach((s) => {
      const stA = liftingStation(w, side, s.ya), stB = liftingStation(w, side, s.yb);
      const t = af.t, m = af.camber || 0;
      const upY = (x) => camberLine(x, m) + thickness(x, t);
      const gb = new GeoBuilder();
      const k = 5;
      const pts = [];
      for (let i = 0; i <= k; i++) {
        const x = M.lerp(s.spoiler.c0, s.spoiler.c1, i / k);
        pts.push([x, upY(x) + 0.002]);
      }
      // closed thin outline swept between the two stations (top and bottom skin of the panel)
      const outline = pts.concat(pts.slice().reverse().map(([x, y]) => [x, y - 0.012]));
      const rows = [stA, stB].map((st) => outline.map(([x, y]) => gb.v(stationPoint(st, x, y))));
      const tris = [];
      for (let q = 0; q < outline.length; q++) {
        const a = rows[0][q], b = rows[0][(q + 1) % outline.length], c = rows[1][q], d = rows[1][(q + 1) % outline.length];
        tris.push([a, b, c], [b, d, c]);
      }
      const mid = stationPoint(stA, (s.spoiler.c0 + s.spoiler.c1) / 2, upY(s.spoiler.c0) - 0.004).add(stationPoint(stB, (s.spoiler.c0 + s.spoiler.c1) / 2, upY(s.spoiler.c0) - 0.004)).multiplyScalar(0.5);
      gb.addOriented(tris, () => mid);
      const hA = stationPoint(stA, s.spoiler.c0, upY(s.spoiler.c0)), hB = stationPoint(stB, s.spoiler.c0, upY(s.spoiler.c0));
      const axis = hB.clone().sub(hA).normalize();
      if (axis.x < 0) axis.negate();
      const hinge = hA.clone().add(hB).multiplyScalar(0.5);
      const pivot = new THREE.Group();
      pivot.position.copy(hinge);
      pivot.add(new THREE.Mesh(gb.build(hinge), mat));
      pivot.userData = { kind: 'spoiler', side, axis, base: hinge.clone(), chordDir: stA.C.clone(), normalDir: stA.N.clone(), chord: stA.chord };
      part.movers.push(pivot);
    });
    return part;
  }

  /** Winglet blended to the wing tip (cant from vertical, swept). */
  function buildWinglet(cfg, side, mat) {
    const wl = cfg.wing.winglet;
    const tip = liftingStation(cfg.wing, side, cfg.wing.sections[cfg.wing.sections.length - 1].y);
    const cant = wl.cant * D2R;
    const S = new THREE.Vector3(side * Math.sin(cant), Math.cos(cant), 0);
    const C = new THREE.Vector3(0, 0, 1);
    const N = new THREE.Vector3().crossVectors(S, C).normalize();
    const root = { P: tip.P.clone().addScaledVector(C, Math.max(0, tip.chord - wl.rootChord)), C, N, S, chord: wl.rootChord };
    const top = { P: root.P.clone().addScaledVector(S, wl.height).addScaledVector(C, wl.sweep), C, N, S, chord: wl.tipChord };
    const gb = new GeoBuilder();
    sweepSection(gb, [root, top], { t: 0.09, camber: 0 }, 0, 1, false, 8);
    return new THREE.Mesh(gb.build(), mat);
  }

  /** Horizontal tail: elevator, stabilator or trimmable stabiliser + elevator. */
  function buildHTail(cfg, side, mat) {
    const t = cfg.htail;
    const af = SIM.Airfoils[t.airfoil];
    const semi = t.sections[t.sections.length - 1].y;
    const station = (y) => liftingStation(t, side, y);
    if (t.stabilator) {
      // all-moving tailplane pivoting at 25 % of the root chord
      const segs = breakpoints(t.sections.map((s) => s.y), 0, semi);
      const segments = [];
      for (let i = 0; i < segs.length - 1; i++) segments.push({ ya: segs[i], yb: segs[i + 1], fixed: [[0, 1, false]], moving: [] });
      const part = buildSurface({ segments, af, n: 12, mat, side, station });
      return { fixed: null, stab: part.mesh, movers: [] };
    }
    const fus = fuselageAt(cfg, t.sections[0].le + t.sections[0].chord * (1 - t.elevator.chordFrac));
    const yEl = Math.min(semi * 0.5, fus.w / 2 + 0.02);
    const ys = breakpoints([...t.sections.map((s) => s.y), yEl], 0, semi);
    const cf = t.elevator.chordFrac;
    const segments = [];
    for (let i = 0; i < ys.length - 1; i++) {
      const ym = (ys[i] + ys[i + 1]) / 2;
      const seg = { ya: ys[i], yb: ys[i + 1], fixed: [[0, ym > yEl ? 1 - cf : 1, false]], moving: [] };
      if (ym > yEl) seg.moving.push({ kind: 'elevator', c0: 1 - cf, c1: 1, nose: true });
      segments.push(seg);
    }
    const part = buildSurface({ segments, af, n: 12, mat, side, station, axisRef: new THREE.Vector3(1, 0, 0) });
    return { fixed: part.mesh, stab: null, movers: part.movers };
  }

  function buildFin(cfg, mat, rudderMat) {
    const v = cfg.vtail;
    const af = SIM.Airfoils[v.airfoil];
    const top = v.sections[v.sections.length - 1].h;
    const cf = v.rudder.chordFrac;
    const ys = breakpoints(v.sections.map((s) => s.h), 0, top);
    const segments = [];
    for (let i = 0; i < ys.length - 1; i++) {
      segments.push({ ya: ys[i], yb: ys[i + 1], fixed: [[0, 1 - cf, false]], moving: [{ kind: 'rudder', c0: 1 - cf, c1: 1, nose: true }] });
    }
    return buildSurface({ segments, af, n: 12, mat, movingMat: rudderMat, side: 1, station: (h) => finStation(v, h), axisRef: new THREE.Vector3(0, 1, 0) });
  }

  /* ------------------------------------------------------------------ propulsion */

  /** Propeller with twisted, tapered blades at the real geometric pitch. */
  function propeller(ecfg, matBlade, matSpinner, spinnerR) {
    const R = ecfg.propDiameter / 2;
    const blades = ecfg.blades || 2;
    const pitch = (ecfg.propPitchIn || 70) * 0.0254;
    const prop = new THREE.Group();
    const bladeGroup = new THREE.Group();
    const bladeGeo = (() => {
      const gb = new GeoBuilder();
      const st = [];
      const n = 6;
      for (let i = 0; i <= n; i++) {
        const r = M.lerp(spinnerR * 0.8, R, i / n);
        const beta = Math.atan(pitch / (2 * Math.PI * Math.max(r, 0.15)));
        const chord = R * (i === n ? 0.055 : M.lerp(0.11, 0.075, i / n));
        const C = new THREE.Vector3(Math.cos(beta), 0, Math.sin(beta)); // chord line at the blade angle
        const N = new THREE.Vector3(-Math.sin(beta), 0, Math.cos(beta)).negate();
        st.push({ P: new THREE.Vector3(-chord * 0.35 * C.x, r, -chord * 0.35 * C.z), C, N, S: new THREE.Vector3(0, 1, 0), chord });
      }
      sweepSection(gb, st, { t: 0.1, camber: 0.03 }, 0, 1, false, 6);
      return gb.build();
    })();
    for (let i = 0; i < blades; i++) {
      const holder = new THREE.Group();
      holder.rotation.z = (i / blades) * Math.PI * 2;
      holder.add(new THREE.Mesh(bladeGeo, matBlade));
      bladeGroup.add(holder);
    }
    const pts = [];
    for (let i = 0; i <= 10; i++) {
      const s = i / 10;
      pts.push(new THREE.Vector2(spinnerR * Math.sqrt(Math.max(0, 1 - s * s)) + 1e-4, s * spinnerR * 2.1));
    }
    const spinner = new THREE.Mesh(new THREE.LatheGeometry(pts, 18).rotateX(-Math.PI / 2), matSpinner);
    spinner.position.z = 0.04;
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(R, 40),
      new THREE.MeshBasicMaterial({ color: 0x222222, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide })
    );
    disc.renderOrder = 8;
    prop.add(bladeGroup, spinner, disc);
    prop.userData = { blades: bladeGroup, disc };
    return prop;
  }

  function nacelle(n, mat) {
    const S = (z, w, h, y, k = 2.6) => ({ z, w, h, y, n: k });
    const len = n.z1 - n.z0;
    const secs = n.jet
      ? [S(n.z0, n.w * 0.9, n.h * 0.9, 0, 2), S(n.z0 + 0.15, n.w, n.h, 0, 2), S(n.z0 + len * 0.45, n.w * 0.98, n.h * 0.98, 0, 2),
        S(n.z1 - len * 0.12, n.w * 0.72, n.h * 0.72, 0.02, 2), S(n.z1, n.w * 0.5, n.h * 0.5, 0.03, 2)]
      : [S(n.z0, n.w * 0.32, n.h * 0.32, 0.02), S(n.z0 + 0.12, n.w * 0.78, n.h * 0.8, 0.02), S(n.z0 + 0.45, n.w, n.h, 0.0, 2.8),
        S(n.z0 + len * 0.42, n.w * 0.97, n.h * 0.95, 0.0, 2.8), S(n.z0 + len * 0.66, n.w * 0.82, n.h * 0.8, 0.03, 2.6),
        S(n.z0 + len * 0.86, n.w * 0.48, n.h * 0.5, 0.06, 2.3), S(n.z1, n.w * 0.08, n.h * 0.12, 0.09, 2)];
    const m = new THREE.Mesh(loft(secs, 24), mat);
    m.position.set(n.x, n.y, 0);
    return m;
  }

  /** Turbofan details: dark intake, spinning fan, exhaust cone and the pylon to the wing. */
  function turbofanDetails(cfg, n, mat, parts, ext) {
    const r = Math.min(n.w, n.h) * 0.42;
    const intake = new THREE.Mesh(new THREE.CircleGeometry(r * 1.05, 28), mat.dark);
    intake.position.set(n.x, n.y, n.z0 + 0.32);
    intake.rotation.y = Math.PI;
    ext.add(intake);
    const fan = new THREE.Group();
    const blade = new THREE.BoxGeometry(0.16, r * 0.82, 0.03).translate(0, r * 0.5, 0);
    for (let b = 0; b < 24; b++) {
      const m = new THREE.Mesh(blade, mat.metal);
      m.rotation.y = 0.55;
      const h = new THREE.Group();
      h.rotation.z = (b / 24) * Math.PI * 2;
      h.add(m);
      fan.add(h);
    }
    fan.add(new THREE.Mesh(new THREE.ConeGeometry(r * 0.3, r * 0.6, 14).rotateX(-Math.PI / 2), mat.metal));
    fan.position.set(n.x, n.y, n.z0 + 0.42);
    ext.add(fan);
    parts.fans.push(fan);
    const cone = new THREE.Mesh(new THREE.ConeGeometry(n.w * 0.2, 1.1, 16).rotateX(Math.PI / 2), mat.metal);
    cone.position.set(n.x, n.y + 0.03, n.z1 + 0.45);
    ext.add(cone);
    // pylon from the nacelle top to the wing lower skin
    const st = liftingStation(cfg.wing, Math.sign(n.x), Math.abs(n.x));
    const wingLow = st.P.y - thickness(0.3, SIM.Airfoils[cfg.wing.airfoil].t) * st.chord;
    const yTop = wingLow + 0.1, yBot = n.y + n.h * 0.38;
    const z0 = n.z0 + 1.0, z1 = st.P.z + st.chord * 0.35;
    const pylon = new THREE.Mesh(new THREE.BoxGeometry(0.34, Math.max(0.2, yTop - yBot), z1 - z0), mat.skin);
    pylon.position.set(n.x, (yTop + yBot) / 2, (z0 + z1) / 2);
    ext.add(pylon);
  }

  /* ------------------------------------------------------------------ landing gear */

  function wheel(mat, r, w, hubMat) {
    const g = new THREE.Group();
    const tyre = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 18), mat);
    tyre.rotation.z = Math.PI / 2;
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.5, r * 0.5, w * 1.04, 10), hubMat);
    hub.rotation.z = Math.PI / 2;
    g.add(tyre, hub);
    return g;
  }

  /** Strut between two local points (unit cylinder along y scaled and oriented each frame). */
  function orientStrut(mesh, a, b) {
    const d = b.clone().sub(a);
    const L = Math.max(0.01, d.length());
    mesh.position.copy(a).add(b).multiplyScalar(0.5);
    mesh.scale.set(1, L, 1);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.multiplyScalar(1 / L));
  }

  function buildGear(cfg, mat, parts, ext) {
    const air = cfg.visual.model === 'airliner';
    const high = cfg.geometry.wingType === 'high';
    const wingAf = SIM.Airfoils[cfg.wing.airfoil];
    cfg.gear.points.forEach((p) => {
      const [x, y, z] = p.pos;
      const r = p.radius || 0.2;
      const nose = p.id === 'nose';
      const fus = fuselageAt(cfg, z);
      let attach;
      if (nose || high) {
        // nose gear under the cowling/fuselage; Cessna spring-steel mains from the fuselage bottom
        attach = new THREE.Vector3(nose ? 0 : Math.sign(x) * fus.w * 0.36, fus.y - fus.h / 2 + 0.06, z + (nose ? 0 : -0.05));
      } else {
        const st = liftingStation(cfg.wing, Math.sign(x), Math.abs(x));
        attach = new THREE.Vector3(x, st.P.y - thickness(0.35, wingAf.t) * st.chord * 0.8, z);
      }
      const hubLocal = new THREE.Vector3(x - attach.x, y + r - attach.y, 0);
      const leg = new THREE.Group();
      leg.position.copy(attach);
      const thick = air ? 0.13 : r * 0.24;
      const strut = new THREE.Mesh(new THREE.CylinderGeometry(thick, thick * 1.1, 1, 8), mat.metal);
      if (high && !nose) strut.scale.set(1.8, 1, 0.5); // flat spring-steel leg
      leg.add(strut);
      const wg = new THREE.Group();
      const width = air ? 0.36 : r * 0.68;
      if (air) {
        [-1, 1].forEach((s) => {
          const wh = wheel(mat.tyre, r, width, mat.metal);
          wh.position.x = s * (width * 0.62 + 0.05);
          wg.add(wh);
        });
      } else {
        wg.add(wheel(mat.tyre, r, width, mat.metal));
        if (cfg.visual.fairings) {
          const fair = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), mat.skin);
          fair.scale.set(width * 0.9, r * 1.18, r * 2.3);
          fair.position.set(0, r * 0.12, r * 0.25);
          wg.add(fair);
        }
      }
      wg.position.copy(hubLocal);
      leg.add(wg);
      orientStrut(strut, new THREE.Vector3(), hubLocal);
      ext.add(leg);
      // retraction: 737 mains fold inward, nose forward; Baron mains and nose fold into nacelles/nose
      const retract = air ? (nose ? { axis: 'x', dir: 1 } : { axis: 'z', dir: -Math.sign(x) }) : (nose ? { axis: 'x', dir: -1 } : { axis: 'x', dir: 1 });
      parts.gears.push({ group: leg, wheel: wg, strut, id: p.id, steer: !!p.steer, rest: hubLocal.clone(), retract });
    });
  }

  /* ------------------------------------------------------------------ materials */

  function materials(visual, livery) {
    return {
      body: new THREE.MeshPhongMaterial({ map: livery, specular: 0x666666, shininess: 55 }),
      skin: new THREE.MeshPhongMaterial({ color: visual.base, specular: 0x555555, shininess: 50 }),
      surface: new THREE.MeshPhongMaterial({ color: new THREE.Color(visual.base).multiplyScalar(0.93), specular: 0x555555, shininess: 45 }),
      accent: new THREE.MeshPhongMaterial({ color: visual.stripe, specular: 0x444444, shininess: 40 }),
      glass: new THREE.MeshPhongMaterial({ color: visual.glass, specular: 0xbbccdd, shininess: 95, transparent: true, opacity: 0.72 }),
      dark: new THREE.MeshLambertMaterial({ color: 0x23262a }),
      tyre: new THREE.MeshLambertMaterial({ color: 0x1b1b1b }),
      metal: new THREE.MeshPhongMaterial({ color: 0xa8acb0, specular: 0x999999, shininess: 70 }),
      prop: new THREE.MeshLambertMaterial({ color: 0x2a2a2a, side: THREE.DoubleSide }),
      spinner: new THREE.MeshPhongMaterial({ color: visual.stripe, specular: 0x777777, shininess: 70 }),
      interior: new THREE.MeshLambertMaterial({ color: 0x3a3c40, side: THREE.DoubleSide }),
      interiorDark: new THREE.MeshLambertMaterial({ color: 0x1c1d20, side: THREE.DoubleSide }),
      nacelle: new THREE.MeshPhongMaterial({ color: 0xc7cacf, specular: 0x777777, shininess: 60 }),
    };
  }

  /* ------------------------------------------------------------------ livery layout */

  /** Window and registration positions (fractions of the fuselage length) from the cabin geometry. */
  function liveryLayout(cfg) {
    const kind = cfg.visual.model;
    if (kind === 'airliner') return { airliner: true };
    const fs = cfg.fuselage.sections;
    const z0 = fs[0][0], z1 = fs[fs.length - 1][0];
    const u = (z) => M.clamp((z - z0) / (z1 - z0), 0, 1);
    const eyeZ = cfg.geometry.eye[2];
    const seats = parseInt(cfg.capacity, 10) || 4;
    if (kind === 'twin') {
      return { cabin: [u(eyeZ - 0.3), u(eyeZ + 2.75)], windshield: [u(eyeZ - 0.95), u(eyeZ - 0.3)], rear: null, winA: [0.31, 0.43], reg: 0.7, ovalWindows: 5 };
    }
    const cabinEnd = eyeZ + (seats <= 2 ? 0.75 : 1.2);
    return {
      cabin: [u(eyeZ - 0.42), u(cabinEnd)], windshield: [u(eyeZ - 0.95), u(eyeZ - 0.42)],
      rear: kind === 'highwing' ? [u(cabinEnd + 0.08), u(cabinEnd + (seats <= 2 ? 0.35 : 0.55))] : [u(cabinEnd + 0.06), u(cabinEnd + 0.4)],
      winA: kind === 'highwing' ? [0.29, 0.43] : [0.31, 0.45], reg: 0.66,
    };
  }

  /* ------------------------------------------------------------------ builder */

  function build(cfg, opts = {}) {
    const v = cfg.visual;
    const kind = v.model;
    const air = kind === 'airliner';
    const livery = SIM.Textures.livery(v, liveryLayout(cfg));
    const mat = materials(v, livery);
    const root = new THREE.Group();
    root.name = cfg.id;
    const exterior = new THREE.Group();
    exterior.name = 'exterior';
    const fuselageGroup = new THREE.Group(); // hidden in cockpit view
    exterior.add(fuselageGroup);
    root.add(exterior);
    const parts = {
      props: [], fans: [], ailerons: [], flaps: [], elevators: [], rudders: [], stabs: [], slats: [], speedbrakes: [], gears: [],
      lights: { nav: [], beacon: [], strobe: [] },
    };
    const addMovers = (movers) => movers.forEach((m) => {
      exterior.add(m);
      const k = m.userData.kind;
      ({ aileron: parts.ailerons, flap: parts.flaps, elevator: parts.elevators, rudder: parts.rudders, slat: parts.slats, spoiler: parts.speedbrakes })[k].push(m);
    });

    // Fuselage
    const body = new THREE.Mesh(loft(cfg.fuselage.sections.map(([z, w, h, y, n]) => ({ z, w, h, y, n })), air ? 36 : 30), mat.body);
    fuselageGroup.add(body);

    // Wings, winglets, tail
    [1, -1].forEach((side) => {
      const wing = buildWing(cfg, side, mat.skin);
      exterior.add(wing.mesh);
      addMovers(wing.movers);
      if (cfg.wing.winglet) exterior.add(buildWinglet(cfg, side, air ? mat.accent : mat.skin));
      const ht = buildHTail(cfg, side, mat.skin);
      if (ht.fixed) {
        if (cfg.htail.movingStab) {
          // trimmable stabiliser: pivot at its rear spar, elevator rides on it
          const st = liftingStation(cfg.htail, side, 0);
          const pivotPt = stationPoint(st, 0.7, 0);
          const stab = new THREE.Group();
          stab.position.copy(pivotPt);
          ht.fixed.position.sub(pivotPt);
          stab.add(ht.fixed);
          ht.movers.forEach((m) => {
            m.position.sub(pivotPt);
            m.userData.base.sub(pivotPt); // hinge base in the stabiliser frame
            stab.add(m);
            parts.elevators.push(m);
          });
          stab.userData = { kind: 'stab', side, axis: new THREE.Vector3(1, 0, 0), base: pivotPt.clone() };
          exterior.add(stab);
          parts.stabs.push(stab);
        } else {
          exterior.add(ht.fixed);
          addMovers(ht.movers);
        }
      } else if (ht.stab) {
        // stabilator: whole surface pivots at 25 % root chord
        const st = liftingStation(cfg.htail, side, 0);
        const pivotPt = stationPoint(st, 0.25, 0);
        pivotPt.x = 0;
        const g = new THREE.Group();
        g.position.copy(pivotPt);
        ht.stab.position.sub(pivotPt);
        g.add(ht.stab);
        g.userData = { kind: 'stabilator', side, axis: new THREE.Vector3(1, 0, 0), base: pivotPt.clone() };
        exterior.add(g);
        parts.stabs.push(g);
      }
    });
    const fin = buildFin(cfg, air ? mat.accent : mat.skin, air ? mat.accent : mat.surface);
    exterior.add(fin.mesh);
    addMovers(fin.movers);

    // Wing struts (streamlined section, mirrored)
    (cfg.struts || []).forEach((s) => {
      [1, -1].forEach((side) => {
        const a = new THREE.Vector3(side * s.from[0], s.from[1], s.from[2]);
        const b = new THREE.Vector3(side * s.to[0], s.to[1], s.to[2]);
        const m = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1, 10), mat.skin);
        orientStrut(m, a, b);
        m.scale.x = 0.45; // ~0.11 m chord, 0.045 m thick fairing (chord along z)
        m.scale.z = 1.1;
        exterior.add(m);
      });
    });

    // Engines: nacelles, propellers, turbofans
    (cfg.nacelles || []).forEach((n) => {
      exterior.add(nacelle(n, mat.nacelle));
      if (n.jet) turbofanDetails(cfg, n, mat, parts, exterior);
    });
    cfg.engines.forEach((e) => {
      if (e.type !== 'piston') return;
      const prop = propeller(e, mat.prop, mat.spinner, v.spinner || 0.16);
      prop.position.set(e.position[0], e.position[1], e.position[2] - 0.02);
      exterior.add(prop);
      parts.props.push(prop);
    });

    // Landing gear
    buildGear(cfg, mat, parts, exterior);

    // Navigation lights from the real tip, tail and fin positions
    const w = cfg.wing;
    const semi = w.sections[w.sections.length - 1].y;
    const tipR = liftingStation(w, 1, semi);
    const tipPt = stationPoint(tipR, 0.3, 0);
    const fs = cfg.fuselage.sections;
    const tail = fs[fs.length - 1];
    const vt = cfg.vtail;
    const finTop = finStation(vt, vt.sections[vt.sections.length - 1].h);
    const belly = fuselageAt(cfg, air ? 1 : 0.6);
    const top = fuselageAt(cfg, 2);
    const lightList = [
      { type: 'nav', x: -tipPt.x - 0.03, y: tipPt.y, z: tipPt.z, c: [1, 0.12, 0.1] },
      { type: 'nav', x: tipPt.x + 0.03, y: tipPt.y, z: tipPt.z, c: [0.15, 1, 0.3] },
      { type: 'nav', x: 0, y: tail[3], z: tail[0] + 0.05, c: [1, 1, 1] },
      { type: 'strobe', x: -tipPt.x - 0.03, y: tipPt.y, z: tipPt.z + 0.15, c: [1, 1, 1] },
      { type: 'strobe', x: tipPt.x + 0.03, y: tipPt.y, z: tipPt.z + 0.15, c: [1, 1, 1] },
      air ? { type: 'beacon', x: 0, y: top.y + top.h / 2 + 0.08, z: 2, c: [1, 0.1, 0.05] }
        : { type: 'beacon', x: 0, y: finTop.P.y + 0.05, z: finTop.P.z + finTop.chord * 0.4, c: [1, 0.1, 0.05] },
      { type: 'beacon', x: 0, y: belly.y - belly.h / 2 - 0.05, z: air ? 1 : 0.6, c: [1, 0.1, 0.05] },
    ];
    const lm = SIM.RenderUtils.lightMaterial({ size: air ? 1.8 : 1.1, min: 2, max: 26 });
    lightList.forEach((l) => {
      const pts = SIM.RenderUtils.lightPoints([{ x: l.x, y: l.y, z: l.z, r: l.c[0], g: l.c[1], b: l.c[2], s: l.type === 'strobe' ? 1.6 : 1 }], lm.clone());
      pts.material.uniforms.uMap.value = SIM.Textures.get('glow');
      exterior.add(pts);
      parts.lights[l.type].push(pts);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(air ? 0.09 : 0.04, 6, 4), new THREE.MeshBasicMaterial({ color: new THREE.Color(l.c[0], l.c[1], l.c[2]) }));
      bulb.position.set(l.x, l.y, l.z);
      exterior.add(bulb);
    });

    // Landing light in the left wing leading edge (real spot light only for the player aircraft)
    if (opts.landingLight) {
      const st = liftingStation(w, -1, Math.min(semi * 0.3, air ? 3.2 : 1.7));
      const lp = stationPoint(st, 0.01, 0);
      const spot = new THREE.SpotLight(0xfff4e0, 0, air ? 900 : 450, 0.32, 0.5, 1.2);
      spot.position.copy(lp);
      spot.target.position.set(lp.x, lp.y - 12, lp.z - 120);
      spot.castShadow = false;
      exterior.add(spot, spot.target);
      parts.landingLight = spot;
      const glow = SIM.RenderUtils.lightPoints([{ x: lp.x, y: lp.y, z: lp.z - 0.05, r: 1, g: 0.97, b: 0.9, s: 1.8 }], SIM.RenderUtils.lightMaterial({ size: 1.4, min: 2, max: 30 }));
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
    root.scale.setScalar(v.scale || 1);
    root.userData = { parts, exterior, fuselage: fuselageGroup, cockpit, cfg, time: 0, materials: mat, slat: 0 };
    return root;
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

  let tmpQ = null; // created on first use (THREE loads after the simulator scripts)

  /** Rotates a hinged part about its hinge axis (positive = trailing edge down / right). */
  function hinge(pivot, angleRad, slide = 0, drop = 0) {
    const u = pivot.userData;
    if (!tmpQ) tmpQ = new THREE.Quaternion();
    pivot.quaternion.copy(tmpQ.setFromAxisAngle(u.axis, angleRad));
    pivot.position.copy(u.base);
    if (slide && u.chordDir) pivot.position.addScaledVector(u.chordDir, slide * u.chord);
    if (drop && u.normalDir) pivot.position.addScaledVector(u.normalDir, -drop * u.chord);
  }

  /**
   * Updates moving parts from the aircraft state. Deflections use the same travel limits and sign
   * conventions as the aerodynamic model, so what you see is what the airflow sees.
   * @param {THREE.Object3D} model
   * @param {Aircraft} ac
   * @param {number} dt
   * @param {object} env { daylight, cockpitView }
   */
  function animate(model, ac, dt, env) {
    const u = model.userData;
    const p = u.parts;
    const cfg = u.cfg;
    u.time += dt;
    const ctl = ac.controls;
    const sys = ac.systems;
    const rig = ac.fm && ac.fm.aero ? ac.fm.aero.rigging : { aileronDeg: 0, finDeg: 0 };
    // Propellers / fans
    ac.engines.forEach((e, i) => {
      const prop = p.props[i];
      if (prop) {
        const rps = e.rpm / 60;
        prop.userData.blades.rotation.z += rps * Math.PI * 2 * dt * (rps > 18 ? 0.083 : 1);
        // from the cockpit a turning propeller is already a blur at idle (persistence of vision)
        const fast = env.cockpitView ? M.smoothstep(150, 450, e.rpm) : M.smoothstep(350, 900, e.rpm);
        prop.userData.disc.material.opacity = fast * (env.cockpitView ? 0.07 : 0.3);
        prop.userData.blades.visible = !env.cockpitView || fast < 0.5;
      }
      const fan = p.fans[i];
      if (fan) fan.rotation.z += (e.n1 / 100) * 45 * dt * (e.n1 > 30 ? 0.08 : 0.4);
    });

    // Ailerons (differential travel, right roll = right aileron up)
    const ail = ctl.aileron || 0;
    const ac0 = cfg.wing.aileron;
    p.ailerons.forEach((a) => {
      const side = a.userData.side;
      const da = side > 0 ? -ail : ail;
      const defl = (da >= 0 ? da * ac0.down : da * ac0.up) + rig.aileronDeg * side;
      hinge(a, defl * D2R);
    });
    // Flaps (Fowler/slotted flaps travel aft as they extend)
    const flapDeg = sys.flaps.pos || 0;
    const fl = cfg.wing.flap;
    const travel = fl ? (fl.fowler || (fl.kind === 'slotted' ? 0.1 : fl.kind === 'doubleSlotted' ? 0.18 : 0)) * Math.min(1, flapDeg / 15) : 0;
    p.flaps.forEach((f) => hinge(f, flapDeg * D2R, travel, travel * 0.15));
    // Leading-edge slats: out with any flap selection
    u.slat = M.approach(u.slat || 0, flapDeg >= 0.5 ? 1 : 0, dt * 0.25);
    p.slats.forEach((s) => hinge(s, -18 * D2R * u.slat, -0.06 * u.slat, 0.03 * u.slat));
    // Elevator, stabiliser trim and stabilator
    const t = cfg.htail;
    const e = ctl.elevator || 0;
    const tailDeg = t.stabilator ? -(e > 0 ? e * t.stabilator.up : e * t.stabilator.down) : -(e > 0 ? e * t.elevator.up : e * t.elevator.down);
    const trimDeg = -(ctl.elevatorTrim || 0) * t.trimRange;
    p.stabs.forEach((s) => hinge(s, (s.userData.kind === 'stabilator' ? tailDeg + trimDeg : trimDeg) * D2R));
    // a tab-trimmed elevator floats to the trimmed deflection
    p.elevators.forEach((el) => hinge(el, (tailDeg + (t.movingStab || t.stabilator ? 0 : trimDeg * 0.6)) * D2R));
    // Rudder (right pedal = trailing edge right)
    const rudDeg = M.clamp((ctl.rudder || 0) + (ctl.rudderTrim || 0), -1, 1) * cfg.vtail.rudder.max - rig.finDeg;
    p.rudders.forEach((r) => hinge(r, rudDeg * D2R));
    // Spoilers / speed brakes
    const sb = (sys.speedbrake && sys.speedbrake.pos) || 0;
    p.speedbrakes.forEach((s) => hinge(s, -sb * 48 * D2R));

    // Gear: oleo compression and retraction
    const gearPos = cfg.gear.retractable ? sys.gear.pos : 1;
    p.gears.forEach((gp, i) => {
      const fg = ac.fm.gear[i];
      const comp = fg ? Math.min(fg.compression || 0, 0.3) : 0;
      gp.wheel.position.set(gp.rest.x, gp.rest.y + comp * 0.9, gp.rest.z);
      // steerable nose wheel follows the rudder pedals (same law as the ground model)
      if (gp.steer) {
        const gs = ac.groundSpeed || 0;
        const c = cfg.controls;
        const scale = M.lerp(1, c.steerDeg / c.steerTaxiDeg, M.smoothstep(3, 18, gs));
        gp.wheel.rotation.y = -(ctl.rudder || 0) * c.steerTaxiDeg * D2R * scale;
      }
      orientStrut(gp.strut, new THREE.Vector3(), gp.wheel.position);
      if (gp.id !== 'nose' && cfg.geometry.wingType === 'high') gp.strut.scale.set(1.8, gp.strut.scale.y, 0.5);
      if (cfg.gear.retractable) {
        const r = (1 - gearPos) * Math.PI * 0.5 * gp.retract.dir;
        gp.group.rotation.set(gp.retract.axis === 'x' ? r : 0, 0, gp.retract.axis === 'z' ? r : 0);
        gp.group.visible = gearPos > 0.02;
      }
    });
    // Lights
    const time = u.time;
    const night = 1 - env.daylight;
    const navOn = sys.lightOn('nav');
    const beaconOn = sys.lightOn('beacon') && (time % 1.2) < 0.15;
    const strobePhase = time % 1.3;
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

  SIM.AircraftModelBuilder = { build, animate, loft, sectionPieces, liftingStation, fuselageAt, liveryLayout };
})(window.SIM);
