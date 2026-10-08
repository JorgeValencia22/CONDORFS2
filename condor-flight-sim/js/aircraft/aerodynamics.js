/**
 * AeroModel — component build-up aerodynamics (strip theory).
 *
 * Each lifting surface (wing halves, horizontal tail/stabilator halves, fin) is split into
 * spanwise strips built from the real planform: chord, leading-edge position, twist (washout),
 * dihedral and sweep. For every strip the local air velocity is computed including the aircraft
 * rotation (ω × r), propeller slipstream and swirl, and downwash at the tail. The local angle of
 * attack drives a section model of the real airfoil (lift slope, zero-lift angle, cl_max, smooth
 * post-stall to flat plate, profile drag polar, pitching moment), corrected to 3D lift slope and
 * induced drag with aspect ratio and ground effect. Flaps, ailerons, elevator/stabilator, trim and
 * rudder change the strips they cover.
 *
 * Consequently pitch/roll/yaw stability and damping, adverse yaw, dihedral effect, root-first
 * stall, wing drop, spin autorotation and elevator authority in propwash all emerge from geometry.
 * The fuselage adds drag, side force and destabilising Munk moments; gear, struts, nacelles and
 * cooling add parasite drag areas; jets add transonic wave drag.
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;
  const { Vec3 } = SIM;
  const D2R = Math.PI / 180;

  // Scratch
  const X_AXIS = new Vec3(1, 0, 0);
  const u = new Vec3(), up = new Vec3(), tmp = new Vec3(), tmp2 = new Vec3(), wr = new Vec3(), Ldir = new Vec3(), F = new Vec3();

  function rotateAbout(v, axis, angle) {
    // Rodrigues rotation of v about unit axis
    const c = Math.cos(angle), s = Math.sin(angle);
    const d = v.dot(axis);
    const cx = axis.y * v.z - axis.z * v.y, cy = axis.z * v.x - axis.x * v.z, cz = axis.x * v.y - axis.y * v.x;
    return new Vec3(v.x * c + cx * s + axis.x * d * (1 - c), v.y * c + cy * s + axis.y * d * (1 - c), v.z * c + cz * s + axis.z * d * (1 - c));
  }

  /** Thin-airfoil control-surface effectiveness τ for a chord fraction (with viscous correction). */
  function flapEffectiveness(cf) {
    const th = Math.acos(2 * cf - 1);
    return 0.82 * (1 - (th - Math.sin(th)) / Math.PI);
  }

  class AeroModel {
    constructor(cfg) {
      this.cfg = cfg;
      this.S = cfg.geometry.wingArea;
      this.b = cfg.geometry.span;
      this.c = cfg.geometry.chord;
      this.strips = [];
      this.wingCLlag = 0;
      this.rigging = { finDeg: 0, aileronDeg: 0 };
      this.buildWing();
      this.buildHTail();
      this.buildFin();
      this.buildBody();
      this.clmaxCache = new Map();
      // outputs
      this.out = {
        force: new Vec3(), moment: new Vec3(), alpha: 0, beta: 0, CL: 0, CD: 0, wingCL: 0,
        stallFactor: 0, stallMarginDeg: 99, stallAlphaDeg: 15, groundEffect: 0,
        lift: new Vec3(), drag: new Vec3(),
      };
    }

    /* ------------------------------------------------------------------ construction */

    /**
     * Builds strips for a planform given by sections [{y, le, chord, twist}] (projected span).
     * @param {object} o {kind, sections, y0, dihedral, airfoil, side, nPerPanel, eta, sweep}
     */
    addSurface(o) {
      const af = SIM.Airfoils[o.airfoil];
      const sec = o.sections;
      const semi = sec[sec.length - 1].y;
      const dih = (o.dihedral || 0) * D2R;
      let area = 0;
      for (let i = 0; i < sec.length - 1; i++) area += (sec[i + 1].y - sec[i].y) * (sec[i].chord + sec[i + 1].chord) / 2;
      const AR = (4 * semi * semi) / (2 * area);
      const e = o.oswald || 0.8;
      const sweep = (o.sweep || 0) * D2R;
      const a0 = af.a0 * Math.cos(sweep);
      for (const side of [1, -1]) {
        for (let i = 0; i < sec.length - 1; i++) {
          const A = sec[i], B = sec[i + 1];
          const n = o.nPerPanel || 3;
          for (let k = 0; k < n; k++) {
            const f0 = k / n, f1 = (k + 1) / n, fm = (f0 + f1) / 2;
            const y = M.lerp(A.y, B.y, fm);
            const dy = (B.y - A.y) / n;
            const chord = M.lerp(A.chord, B.chord, fm);
            const le = M.lerp(A.le, B.le, fm);
            const twist = M.lerp(A.twist || 0, B.twist || 0, fm) * D2R;
            const s = new Vec3(side * Math.cos(dih), Math.sin(dih), 0).normalize();
            const c = rotateAbout(new Vec3(0, 0, 1), s, twist * side).normalize();
            const nrm = new Vec3().crossVectors(c, s).scale(side).normalize();
            const pAxis = new Vec3().crossVectors(nrm, c).normalize();
            const strip = {
              kind: o.kind, side, y, yFrac: y / semi, dy, chord, area: chord * dy,
              r: new Vec3(side * y, o.y0 + y * Math.tan(dih), le + 0.25 * chord),
              s, c, n: nrm, pAxis, af, a0, AR, e, eta: o.eta || 1,
              inBody: o.bodyHalfWidth ? y < o.bodyHalfWidth : false,
              flapFrac: 0, ailFrac: 0, ctrlFrac: 0,
              stall: 0, cl: 0, alphaEff: 0, marginRad: 1,
            };
            const overlap = (span) => (span ? Math.max(0, Math.min(span.y1, y + dy / 2) - Math.max(span.y0, y - dy / 2)) / dy : 0);
            if (o.kind === 'wing') {
              strip.flapFrac = overlap(o.flap);
              strip.ailFrac = overlap(o.aileron);
              strip.spoilerFrac = o.speedbrake ? overlap({ y0: o.bodyHalfWidth, y1: semi * 0.7 }) : 0;
            }
            this.strips.push(strip);
          }
        }
      }
      return { area: area * 2, AR, semi };
    }

    buildWing() {
      const w = this.cfg.wing;
      const sweep = w.sweepC4 || 0;
      this.wingInfo = this.addSurface({
        kind: 'wing', sections: w.sections, y0: w.y0, dihedral: w.dihedral, airfoil: w.airfoil, oswald: w.oswald,
        flap: w.flap, aileron: w.aileron, bodyHalfWidth: w.bodyHalfWidth, nPerPanel: 3, sweep: sweep * 0.9,
        speedbrake: !!this.cfg.systems.speedbrake,
      });
      this.flapTau = w.flap ? flapEffectiveness(w.flap.chordFrac) : 0;
      this.ailTau = flapEffectiveness(w.aileron.chordFrac);
    }

    buildHTail() {
      const t = this.cfg.htail;
      const info = this.addSurface({
        kind: 'htail', sections: t.sections, y0: t.y0, dihedral: t.dihedral, airfoil: t.airfoil, oswald: 0.75,
        nPerPanel: 2, eta: t.eta, sweep: this.cfg.wing.sweepC4 ? 30 : 0,
      });
      this.htailInfo = info;
      this.elevTau = t.elevator ? flapEffectiveness(t.elevator.chordFrac) : 1;
      // tail arm (wing a.c. to tail a.c.) for downwash lag
      const wingAc = this.strips.find((s) => s.kind === 'wing').r.z;
      const tailAc = this.strips.find((s) => s.kind === 'htail').r.z;
      this.tailArm = Math.max(1, tailAc - wingAc);
    }

    buildFin() {
      const v = this.cfg.vtail;
      const af = SIM.Airfoils[v.airfoil];
      const sec = v.sections;
      const h = sec[sec.length - 1].h;
      let area = 0;
      for (let i = 0; i < sec.length - 1; i++) area += (sec[i + 1].h - sec[i].h) * (sec[i].chord + sec[i + 1].chord) / 2;
      const AR = Math.max(1.5, (2 * h * h) / area); // end-plated by the fuselage/tail: effective AR ≈ 1.6–2× geometric
      const n = 3;
      for (let i = 0; i < sec.length - 1; i++) {
        const A = sec[i], B = sec[i + 1];
        for (let k = 0; k < n; k++) {
          const fm = (k + 0.5) / n;
          const hh = M.lerp(A.h, B.h, fm);
          const dh = (B.h - A.h) / n;
          const chord = M.lerp(A.chord, B.chord, fm);
          const le = M.lerp(A.le, B.le, fm);
          this.strips.push({
            kind: 'fin', side: 0, y: hh, dy: dh, chord, area: chord * dh,
            r: new Vec3(0, v.y0 + hh, le + 0.25 * chord),
            s: new Vec3(0, 1, 0), c: new Vec3(0, 0, 1), n: new Vec3(1, 0, 0), pAxis: new Vec3(0, -1, 0),
            af, a0: af.a0 * Math.cos(this.cfg.wing.sweepC4 ? 35 * D2R : 25 * D2R), AR, e: 0.75, eta: 0.95,
            stall: 0, cl: 0, alphaEff: 0, marginRad: 1, ctrlFrac: 1,
          });
        }
      }
      this.rudderTau = flapEffectiveness(v.rudder.chordFrac);
    }

    buildBody() {
      const fs = this.cfg.fuselage.sections;
      let side = 0, len = fs[fs.length - 1][0] - fs[0][0];
      for (let i = 0; i < fs.length - 1; i++) side += (fs[i + 1][0] - fs[i][0]) * (fs[i][2] + fs[i + 1][2]) / 2;
      this.bodySideArea = side;
      this.bodyLength = len;
      this.bodyVolume = this.cfg.fuselage.volume;
    }

    /* ------------------------------------------------------------------ section model */

    /**
     * Section coefficients for a strip at geometric angle `alpha` (rad).
     * @returns {number} cl (also stores cd, cm and stall info on the strip)
     */
    section(st, alpha, ctrlAlpha, dclFlap, dclmaxFlap, slat, geFactor) {
      const af = st.af;
      const a0 = st.a0;
      const alpha0 = af.alpha0 * D2R;
      // 3D lift-slope reduction (induced angle) — ground effect reduces the induced part
      const k3 = 1 / (1 + (a0 * geFactor) / (Math.PI * st.e * st.AR));
      const ae = alpha0 + (alpha - alpha0) * k3 + ctrlAlpha;
      // section limits: flaps and slats raise cl_max; the stall angle follows from cl_max
      const clmax = af.clmax + dclmaxFlap + slat * a0 * 0.5;
      const clmin = -af.clmax * 0.8 + dclFlap * 0.3;
      const clLin = a0 * (ae - alpha0) + dclFlap;
      const aStall = alpha0 + (1.25 * clmax - dclFlap) / a0;
      const aStallNeg = alpha0 + (1.25 * clmin - dclFlap) / a0;
      // soft rounding of the lift curve as the boundary layer approaches separation
      let clPre = clLin;
      const s0 = 0.72 * clmax;
      if (clLin > s0) clPre = s0 + (clmax - s0) * (1 - Math.exp(-(clLin - s0) / (clmax - s0)));
      const n0 = 0.72 * clmin;
      if (clLin < n0) clPre = n0 + (clmin - n0) * (1 - Math.exp(-(clLin - n0) / (clmin - n0)));
      // stall break: smooth transition to flat-plate flow
      const kS = 45;
      const e1 = Math.exp(Math.min(60, -kS * (ae - aStall)));
      const e2 = Math.exp(Math.min(60, kS * (ae - aStallNeg)));
      const sigma = (1 + e1 + e2) / ((1 + e1) * (1 + e2));
      const sa = Math.sin(ae), ca = Math.cos(ae);
      const clFlat = 2 * sa * ca * 1.05;
      const cl = (1 - sigma) * clPre + sigma * clFlat;
      const clp = M.clamp(clPre, -1.6, 2.4);
      const cdProfile = af.cd0 + af.kcd * (clp - af.clCdMin) * (clp - af.clCdMin);
      const cdInduced = (1 - sigma) * (cl * cl) / (Math.PI * st.e * st.AR) * geFactor;
      const cdSep = sigma * 1.25 * sa * sa;
      st.cd = cdProfile + cdInduced + cdSep;
      st.cm = (1 - sigma) * af.cm - sigma * 0.45 * sa - 0.2 * dclFlap;
      st.stall = sigma;
      st.cl = cl;
      st.alphaEff = ae;
      // margin measured to the start of the break (where the lift curve peaks)
      st.marginRad = aStall - 0.06 - ae;
      st.k3 = k3;
      return cl;
    }

    /* ------------------------------------------------------------------ main computation */

    /**
     * Aerodynamic forces and moments in the body frame about the CG.
     * @param {object} p {
     *   vb: Vec3 air-relative velocity of the CG (body), omega: Vec3 body rates, rho,
     *   controls {elevator, aileron, rudder, elevatorTrim, rudderTrim}, flapDeg, gearPos, speedbrake,
     *   props: [{x, y, z, radius, vi, swirl, rot}], agl (m, wing height above ground), mach, dt (0 = steady)
     * }
     */
    compute(p) {
      const cfg = this.cfg;
      const out = this.out;
      const vb = p.vb, w = p.omega, rho = p.rho;
      const V = vb.length();
      out.force.set(0, 0, 0);
      out.moment.set(0, 0, 0);
      out.lift.set(0, 0, 0);
      out.drag.set(0, 0, 0);
      const alpha = V > 0.3 ? Math.atan2(-vb.y, -vb.z) : 0;
      const beta = V > 0.3 ? Math.asin(M.clamp(vb.x / V, -1, 1)) : 0;
      out.alpha = alpha;
      out.beta = beta;
      if (V < 0.3) {
        out.CL = out.CD = 0;
        out.stallFactor = 0;
        return out;
      }
      const qInf = 0.5 * rho * V * V;
      const ctl = p.controls;
      const wingCfg = cfg.wing, tailCfg = cfg.htail, finCfg = cfg.vtail;

      // Flap section increments
      const flapRad = (p.flapDeg || 0) * D2R;
      let dclFlap = 0, dclmaxFlap = 0, dcdFlap = 0;
      if (wingCfg.flap && flapRad > 0) {
        dclFlap = wingCfg.flap.gain * Math.sin(flapRad) * (1 - 0.15 * Math.sin(flapRad));
        dclmaxFlap = dclFlap * wingCfg.flap.clmaxShare;
        dcdFlap = 1.1 * Math.pow(Math.sin(flapRad), 2) * wingCfg.flap.chordFrac + 0.002;
      }
      const slat = wingCfg.slats && p.flapDeg >= 0.5 ? wingCfg.slats.alphaGain * D2R : 0;
      // Fowler flaps travel aft before they droop: extra wing chord (most of it by flaps 15)
      const fowlerExt = wingCfg.flap && wingCfg.flap.fowler ? wingCfg.flap.fowler * Math.min(1, (p.flapDeg || 0) / 15) : 0;

      // Control deflections (rad)
      const ail = ctl.aileron;
      const ailUp = wingCfg.aileron.up * D2R, ailDown = wingCfg.aileron.down * D2R;
      const rig = this.rigging.aileronDeg * D2R;
      let tailDeflect, tailIsStab = false;
      if (tailCfg.stabilator) {
        tailIsStab = true;
        const e = ctl.elevator;
        tailDeflect = -(e > 0 ? e * tailCfg.stabilator.up : e * tailCfg.stabilator.down) * D2R;
      } else {
        const e = ctl.elevator;
        tailDeflect = -(e > 0 ? e * tailCfg.elevator.up : e * tailCfg.elevator.down) * D2R;
      }
      const trimAlpha = -(ctl.elevatorTrim || 0) * tailCfg.trimRange * D2R;
      const rudderRad = -(M.clamp(ctl.rudder + (ctl.rudderTrim || 0), -1, 1)) * finCfg.rudder.max * D2R + this.rigging.finDeg * D2R;

      // Ground effect factor from wing height (Wieselsberger)
      const hw = Math.max(0.15, p.agl === undefined ? 1e4 : p.agl);
      const rr = (16 * hw) / this.b;
      const ge = (rr * rr) / (1 + rr * rr);
      out.groundEffect = 1 - ge;

      // Downwash at the tail: computed once the wing strips are done. In dynamic mode it uses the
      // wing CL lagged by the time the flow needs to reach the tail (α-dot effect).
      let eps = null;
      const downwash = (wingCLnow) => (2 * (p.dt > 0 ? this.wingCLlag : wingCLnow)) / (Math.PI * this.wingInfo.AR) * (tailCfg.downwashGain || 1) * (0.6 + 0.4 * ge);

      const props = p.props || [];
      let wingLift = 0, wingQA = 0, stallSum = 0, stallArea = 0, margin = 99;
      let marginAlpha = 0;
      const sb = p.speedbrake || 0;

      for (const st of this.strips) {
        // local air velocity relative to the strip
        wr.crossVectors(w, st.r).add(vb);
        u.copy(wr).scale(-1);
        // propeller slipstream and swirl
        for (const pr of props) {
          if (pr.vi <= 0 || st.r.z < pr.z) continue;
          const dx = st.r.x - pr.x, dy = st.r.y - pr.y;
          const d2 = dx * dx + dy * dy;
          const R = pr.radius * 1.05;
          if (d2 > R * R) continue;
          const dev = st.r.z - pr.z;
          const growth = Math.min(1, 0.55 + dev / (2 * pr.radius)); // slipstream accelerates behind the disk
          u.z += 2 * pr.vi * growth;
          if (st.kind === 'fin') u.x += pr.swirl * pr.rot;
          else if (st.kind === 'htail') u.y += -pr.swirl * pr.rot * Math.sign(dx) * 0.6;
        }
        // spanwise component removed
        const us = u.dot(st.s);
        up.copy(u).addScaled(st.s, -us);
        const Vl = up.length();
        if (Vl < 0.3) continue;
        const ucn = up.dot(st.n), ucc = up.dot(st.c);
        let a = Math.atan2(ucn, ucc);
        let ctrlAlpha = 0, dcl = 0, dclmax = 0, dcd = 0, slatA = 0;
        let geF = 1;
        if (st.kind === 'wing') {
          geF = ge;
          if (st.flapFrac > 0) {
            dcl = dclFlap * st.flapFrac;
            dclmax = dclmaxFlap * st.flapFrac;
            dcd = dcdFlap * st.flapFrac;
          }
          if (st.ailFrac > 0) {
            // right roll: right aileron up (negative), left aileron down (positive); differential travel
            const da = st.side > 0 ? -ail : ail;
            const defl = (da >= 0 ? da * ailDown : da * ailUp) + rig * st.side;
            ctrlAlpha += this.ailTau * defl * (1 - 0.25 * Math.min(1, Math.abs(defl) / (20 * D2R))) * st.ailFrac;
            dcd += 0.6 * defl * defl * st.ailFrac * 0.25;
          }
          slatA = slat;
          if (sb > 0 && st.spoilerFrac) {
            dcl -= (cfg.aero.speedbrakeLiftLoss || 0.3) * sb * st.spoilerFrac * (p.onGround ? 2.4 : 1);
            dcd += 0.06 * sb * st.spoilerFrac;
          }
          if (st.inBody) {
            // fuselage carry-through: reduced effectiveness, no profile drag of its own
            geF = ge;
          }
        } else if (st.kind === 'htail') {
          if (eps === null) eps = downwash(wingQA > 0 ? wingLift / wingQA : 0);
          a -= eps;
          const tauE = tailIsStab ? 1 : this.elevTau * (1 - 0.3 * Math.min(1, Math.abs(tailDeflect) / (25 * D2R)));
          ctrlAlpha += tailDeflect * tauE + trimAlpha * (tailIsStab || tailCfg.movingStab ? 1 : this.elevTau);
          dcd += 0.4 * tailDeflect * tailDeflect * 0.15;
        } else if (st.kind === 'fin') {
          ctrlAlpha += rudderRad * this.rudderTau * (1 - 0.3 * Math.min(1, Math.abs(rudderRad) / (20 * D2R)));
          dcd += 0.4 * rudderRad * rudderRad * 0.15;
        }
        const cl = this.section(st, a, ctrlAlpha, dcl, dclmax, slatA, geF);
        let cd = st.cd + dcd;
        if (st.inBody) cd = st.cd - st.af.cd0 - st.af.kcd * 0.05; // profile drag accounted in fuselage drag
        const q = 0.5 * rho * Vl * Vl * st.eta;
        const A = st.area * (st.inBody ? 0.82 : 1) * (st.kind === 'wing' && st.flapFrac > 0 ? 1 + fowlerExt * st.flapFrac : 1);
        // lift perpendicular to the local flow, in the plane of the section
        tmp.copy(up).scale(1 / Vl);
        Ldir.copy(st.n).addScaled(tmp, -st.n.dot(tmp));
        const ll = Ldir.length();
        if (ll > 1e-4) Ldir.scale(1 / ll);
        F.copy(Ldir).scale(q * A * cl).addScaled(tmp, q * A * cd);
        out.force.add(F);
        out.moment.add(tmp2.crossVectors(st.r, F));
        // section pitching moment about c/4
        if (st.kind !== 'fin') out.moment.addScaled(st.pAxis, q * A * st.chord * st.cm);
        if (st.kind === 'wing') {
          wingLift += q * A * cl;
          wingQA += q * A;
          stallSum += st.stall * A;
          stallArea += A;
          if (!st.inBody && st.marginRad < margin) {
            margin = st.marginRad;
            marginAlpha = st.k3;
          }
        }
      }

      // Wing CL (for downwash) with a transport lag of tailArm / V (α-dot effect)
      const wingCL = wingQA > 0 ? wingLift / wingQA : 0;
      if (p.dt > 0) this.wingCLlag += (wingCL - this.wingCLlag) * Math.min(1, (p.dt * V) / this.tailArm);
      else this.wingCLlag = wingCL;
      out.wingCL = wingCL;

      /* ---- fuselage, gear, nacelles, struts: parasite drag and body moments */
      const dragCfg = cfg.drag;
      let dragArea = dragCfg.fuselage + (dragCfg.struts || 0) + (dragCfg.cooling || 0) + (dragCfg.misc || 0) + (dragCfg.nacelles || 0);
      dragArea += dragCfg.gear * (dragCfg.gearRetractable ? (p.gearPos ?? 1) : 1);
      if (sb > 0 && dragCfg.speedbrake) dragArea += dragCfg.speedbrake * sb;
      dragArea *= 1 + 1.4 * (Math.sin(alpha) ** 2 + Math.sin(beta) ** 2); // body at incidence
      if (cfg.aero.machCrit && p.mach > cfg.aero.machCrit) {
        dragArea += this.S * 22 * Math.pow(p.mach - cfg.aero.machCrit, 2.6);
      }
      dragArea += (p.damage || 0) * 0.04 * this.S;
      const vhat = tmp.copy(vb).scale(-1 / V); // direction of the relative wind (towards the tail)
      out.force.addScaled(vhat, qInf * dragArea);
      // fuselage side force
      out.force.x += -qInf * this.bodySideArea * 0.45 * Math.sin(beta) * Math.cos(beta);
      // Munk moments (destabilising in pitch and yaw)
      const kM = 1.6; // Multhopp-type fuselage destabilisation
      out.moment.x += qInf * this.bodyVolume * kM * 0.5 * Math.sin(2 * alpha);
      out.moment.y += qInf * this.bodyVolume * kM * 0.5 * Math.sin(2 * beta);
      // propeller normal force (a propeller at incidence acts like a forward fin: destabilising)
      for (const pr of props) {
        if (!pr.radius) continue;
        const A = Math.PI * pr.radius * pr.radius;
        // Ribner: normal-force slope per unit disk area ≈ 0.1 per blade, augmented by the slipstream
        const kN = 0.1 * (pr.blades || 2) * (1 + Math.min(1, pr.vi / Math.max(V, 5)));
        const fy = qInf * A * kN * Math.sin(alpha) * Math.cos(alpha);
        const fx = -qInf * A * kN * Math.sin(beta);
        out.force.y += fy;
        out.force.x += fx;
        tmp2.set(fx, fy, 0);
        out.moment.add(F.crossVectors(new Vec3(pr.x, pr.y, pr.z), tmp2));
      }
      // wing–body interference dihedral effect (high wing stabilising)
      const clBetaWB = cfg.aero.interferenceClBeta || 0;
      out.moment.z -= qInf * this.S * this.b * clBetaWB * beta;

      /* ---- summary coefficients */
      const qS = qInf * this.S;
      tmp.copy(vb).scale(1 / V); // direction of motion
      const dragN = -out.force.dot(tmp);
      // lift direction: perpendicular to motion within the symmetry plane
      Ldir.crossVectors(X_AXIS, tmp).normalize();
      out.CL = out.force.dot(Ldir) / qS;
      out.CD = dragN / qS;
      out.lift.copy(Ldir).scale(out.force.dot(Ldir));
      out.drag.copy(tmp).scale(-dragN);
      out.stallFactor = stallArea > 0 ? stallSum / stallArea : 0;
      out.stallMarginDeg = margin * 57.2958;
      out.stallAlphaDeg = (alpha + margin / Math.max(0.3, marginAlpha)) * 57.2958;
      return out;
    }

    /**
     * Maximum trimmed-ish lift coefficient for a flap setting (sweep of α at 1 g, elevator neutral),
     * used for stall-speed displays.
     */
    clmax(flapDeg) {
      const key = Math.round(flapDeg);
      if (this.clmaxCache.has(key)) return this.clmaxCache.get(key);
      const saveLag = this.wingCLlag;
      let best = 0;
      const V = 40;
      const zero = new Vec3();
      for (let a = 0; a <= 28; a += 0.5) {
        const r = a * D2R;
        const vb = new Vec3(0, -V * Math.sin(r), -V * Math.cos(r));
        const o = this.compute({ vb, omega: zero, rho: 1.225, controls: { elevator: 0, aileron: 0, rudder: 0, elevatorTrim: 0, rudderTrim: 0 }, flapDeg, gearPos: 1, props: [], dt: 0, mach: 0.1 });
        if (o.CL > best) best = o.CL;
      }
      this.wingCLlag = saveLag;
      this.clmaxCache.set(key, best);
      return best;
    }

    /** 1-g stall speed (KCAS) at a mass and flap setting. */
    stallSpeedKt(mass, flapDeg) {
      const cl = this.clmax(flapDeg);
      return Math.sqrt((2 * mass * SIM.Phys.G) / (SIM.Phys.RHO0 * this.S * cl)) / SIM.Units.KT;
    }
  }

  SIM.AeroModel = AeroModel;
})(window.SIM);
