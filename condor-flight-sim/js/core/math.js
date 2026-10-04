/**
 * Math library used by the physics core. It is intentionally independent from Three.js so the
 * flight model keeps working in instrument-only mode when WebGL is unavailable.
 *
 * Frames:
 *  - World: X = east, Y = up, Z = south (north is -Z). Heading 0 = north, clockwise positive.
 *  - Body:  X = right wing, Y = up, Z = tail (nose points to -Z). Same convention as Three.js objects.
 */
(function (SIM) {
  'use strict';

  const DEG = Math.PI / 180;
  const RAD = 180 / Math.PI;

  const MathUtil = {
    DEG,
    RAD,
    clamp: (v, a, b) => (v < a ? a : v > b ? b : v),
    lerp: (a, b, t) => a + (b - a) * t,
    invLerp: (a, b, v) => (b === a ? 0 : (v - a) / (b - a)),
    remap(v, a0, a1, b0, b1, clampIt = true) {
      let t = MathUtil.invLerp(a0, a1, v);
      if (clampIt) t = MathUtil.clamp(t, 0, 1);
      return b0 + (b1 - b0) * t;
    },
    smoothstep(e0, e1, x) {
      const t = MathUtil.clamp((x - e0) / (e1 - e0), 0, 1);
      return t * t * (3 - 2 * t);
    },
    wrap360(a) {
      a %= 360;
      return a < 0 ? a + 360 : a;
    },
    wrap180(a) {
      a = MathUtil.wrap360(a);
      return a > 180 ? a - 360 : a;
    },
    /** Signed shortest difference (deg) to go from a to b. */
    angleDiff: (a, b) => MathUtil.wrap180(b - a),
    /** Frame-rate independent exponential smoothing. */
    damp: (current, target, lambda, dt) => current + (target - current) * (1 - Math.exp(-lambda * dt)),
    approach(cur, target, maxDelta) {
      if (cur < target) return Math.min(cur + maxDelta, target);
      return Math.max(cur - maxDelta, target);
    },
    sat: (v) => (v < -1 ? -1 : v > 1 ? 1 : v),
    sign: (v) => (v < 0 ? -1 : 1),
    /** Applies a dead zone then re-normalises. */
    deadzone(v, dz) {
      const a = Math.abs(v);
      if (a < dz) return 0;
      return Math.sign(v) * (a - dz) / (1 - dz);
    },
    /** Exponential response curve (k=0 linear, k=1 cubic). */
    expo: (v, k) => (1 - k) * v + k * v * v * v,
    fmt(v, digits = 0) {
      return Number.isFinite(v) ? v.toFixed(digits) : '---';
    },
    pad(v, n) {
      const s = String(Math.round(Math.abs(v)));
      return (v < 0 ? '-' : '') + s.padStart(n, '0');
    },
  };

  /** Mutable 3D vector. */
  class Vec3 {
    constructor(x = 0, y = 0, z = 0) {
      this.x = x;
      this.y = y;
      this.z = z;
    }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
    clone() { return new Vec3(this.x, this.y, this.z); }
    add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
    sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
    scale(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
    addScaled(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
    subVectors(a, b) { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; }
    dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
    crossVectors(a, b) {
      const x = a.y * b.z - a.z * b.y;
      const y = a.z * b.x - a.x * b.z;
      const z = a.x * b.y - a.y * b.x;
      this.x = x; this.y = y; this.z = z;
      return this;
    }
    length() { return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z); }
    lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
    horizontalLength() { return Math.sqrt(this.x * this.x + this.z * this.z); }
    normalize() {
      const l = this.length();
      if (l > 1e-9) this.scale(1 / l);
      return this;
    }
    distanceTo(v) {
      const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z;
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    lerp(v, t) {
      this.x += (v.x - this.x) * t;
      this.y += (v.y - this.y) * t;
      this.z += (v.z - this.z) * t;
      return this;
    }
    /** Rotates this vector by quaternion q. */
    applyQuat(q) {
      const x = this.x, y = this.y, z = this.z;
      const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
      const ix = qw * x + qy * z - qz * y;
      const iy = qw * y + qz * x - qx * z;
      const iz = qw * z + qx * y - qy * x;
      const iw = -qx * x - qy * y - qz * z;
      this.x = ix * qw + iw * -qx + iy * -qz - iz * -qy;
      this.y = iy * qw + iw * -qy + iz * -qx - ix * -qz;
      this.z = iz * qw + iw * -qz + ix * -qy - iy * -qx;
      return this;
    }
    /** Rotates by the inverse of q (world -> body). */
    applyQuatInverse(q) {
      TMP_Q.set(-q.x, -q.y, -q.z, q.w);
      return this.applyQuat(TMP_Q);
    }
    isFinite() { return Number.isFinite(this.x) && Number.isFinite(this.y) && Number.isFinite(this.z); }
  }

  /** Unit quaternion (x, y, z, w). */
  class Quat {
    constructor(x = 0, y = 0, z = 0, w = 1) {
      this.x = x; this.y = y; this.z = z; this.w = w;
    }
    set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this; }
    copy(q) { this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w; return this; }
    clone() { return new Quat(this.x, this.y, this.z, this.w); }
    setFromAxisAngle(ax, ay, az, angle) {
      const h = angle / 2, s = Math.sin(h);
      this.x = ax * s; this.y = ay * s; this.z = az * s; this.w = Math.cos(h);
      return this;
    }
    multiply(q) { return this.multiplyQuats(this, q); }
    premultiply(q) { return this.multiplyQuats(q, this); }
    multiplyQuats(a, b) {
      const ax = a.x, ay = a.y, az = a.z, aw = a.w;
      const bx = b.x, by = b.y, bz = b.z, bw = b.w;
      this.x = ax * bw + aw * bx + ay * bz - az * by;
      this.y = ay * bw + aw * by + az * bx - ax * bz;
      this.z = az * bw + aw * bz + ax * by - ay * bx;
      this.w = aw * bw - ax * bx - ay * by - az * bz;
      return this;
    }
    normalize() {
      let l = Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w);
      if (l < 1e-12) { this.set(0, 0, 0, 1); return this; }
      l = 1 / l;
      this.x *= l; this.y *= l; this.z *= l; this.w *= l;
      return this;
    }
    /**
     * Builds the orientation for heading (clockwise from north), pitch (nose up) and roll (right wing down),
     * all in radians. Intrinsic yaw -> pitch -> roll.
     */
    setFromHPR(h, p, r) {
      const qy = new Quat().setFromAxisAngle(0, 1, 0, -h);
      const qx = new Quat().setFromAxisAngle(1, 0, 0, p);
      const qz = new Quat().setFromAxisAngle(0, 0, 1, -r);
      return this.copy(qy).multiply(qx).multiply(qz);
    }
    /** Integrates a body-frame angular velocity (rad/s) over dt. */
    integrateBody(w, dt) {
      const hx = w.x * dt * 0.5, hy = w.y * dt * 0.5, hz = w.z * dt * 0.5;
      const x = this.x, y = this.y, z = this.z, qw = this.w;
      this.x += qw * hx + y * hz - z * hy;
      this.y += qw * hy + z * hx - x * hz;
      this.z += qw * hz + x * hy - y * hx;
      this.w += -x * hx - y * hy - z * hz;
      return this.normalize();
    }
    slerp(qb, t) {
      let cosHalf = this.w * qb.w + this.x * qb.x + this.y * qb.y + this.z * qb.z;
      let bx = qb.x, by = qb.y, bz = qb.z, bw = qb.w;
      if (cosHalf < 0) { cosHalf = -cosHalf; bx = -bx; by = -by; bz = -bz; bw = -bw; }
      if (cosHalf > 0.9995) {
        this.x += (bx - this.x) * t; this.y += (by - this.y) * t;
        this.z += (bz - this.z) * t; this.w += (bw - this.w) * t;
        return this.normalize();
      }
      const half = Math.acos(cosHalf);
      const sinHalf = Math.sqrt(1 - cosHalf * cosHalf);
      const ra = Math.sin((1 - t) * half) / sinHalf, rb = Math.sin(t * half) / sinHalf;
      this.x = this.x * ra + bx * rb; this.y = this.y * ra + by * rb;
      this.z = this.z * ra + bz * rb; this.w = this.w * ra + bw * rb;
      return this;
    }
  }

  const TMP_Q = new Quat();

  /** Heading/pitch/roll (radians) from a body orientation quaternion. */
  function quatToHPR(q, out = {}) {
    const f = new Vec3(0, 0, -1).applyQuat(q);
    const r = new Vec3(1, 0, 0).applyQuat(q);
    const u = new Vec3(0, 1, 0).applyQuat(q);
    out.heading = Math.atan2(f.x, -f.z);
    if (out.heading < 0) out.heading += Math.PI * 2;
    out.pitch = Math.asin(MathUtil.clamp(f.y, -1, 1));
    out.roll = Math.atan2(-r.y, u.y);
    return out;
  }

  /* ---------------------------------------------------------------- Noise */

  /** Integer hash -> [0,1). */
  function hash2(ix, iz, seed = 0) {
    let h = (ix * 374761393 + iz * 668265263 + seed * 1442695041) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  function valueNoise(x, z, seed = 0) {
    const ix = Math.floor(x), iz = Math.floor(z);
    const fx = x - ix, fz = z - iz;
    const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
    const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed);
    const c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
    return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
  }

  function fbm(x, z, octaves = 4, seed = 0, lacunarity = 2.03, gain = 0.5) {
    let sum = 0, amp = 0.5, norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += valueNoise(x, z, seed + i * 17) * amp;
      norm += amp;
      amp *= gain;
      x *= lacunarity;
      z *= lacunarity;
    }
    return sum / norm;
  }

  /** Ridged multifractal noise in [0,1], gives sharp mountain crests. */
  function ridged(x, z, octaves = 4, seed = 0) {
    let sum = 0, amp = 0.5, norm = 0, weight = 1;
    for (let i = 0; i < octaves; i++) {
      let n = 1 - Math.abs(valueNoise(x, z, seed + i * 31) * 2 - 1);
      n *= n * weight;
      weight = MathUtil.clamp(n * 1.6, 0, 1);
      sum += n * amp;
      norm += amp;
      amp *= 0.5;
      x *= 2.07;
      z *= 2.07;
    }
    return sum / norm;
  }

  /** Small fast deterministic PRNG. */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Distance from point to segment in the XZ plane. Returns {d, t}. */
  function segDistance2D(px, pz, ax, az, bx, bz) {
    const vx = bx - ax, vz = bz - az;
    const wx = px - ax, wz = pz - az;
    const len2 = vx * vx + vz * vz;
    let t = len2 > 0 ? (wx * vx + wz * vz) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = ax + vx * t - px, dz = az + vz * t - pz;
    return { d: Math.sqrt(dx * dx + dz * dz), t };
  }

  function pointInPolygon(x, z, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
  }

  SIM.MathUtil = MathUtil;
  SIM.Vec3 = Vec3;
  SIM.Quat = Quat;
  SIM.quatToHPR = quatToHPR;
  SIM.Noise = { hash2, valueNoise, fbm, ridged };
  SIM.mulberry32 = mulberry32;
  SIM.segDistance2D = segDistance2D;
  SIM.pointInPolygon = pointInPolygon;
})(window.SIM);
