/**
 * Shared rendering helpers: light-point material (distance-scaled glowing points used for runway,
 * city and aircraft lights), flat oriented quads and small geometry utilities.
 */
(function (SIM) {
  'use strict';

  const LIGHT_VERT = `
    attribute vec3 color;
    attribute float lsize;
    uniform float uSize;
    uniform float uMin;
    uniform float uMax;
    uniform float uPixelRatio;
    varying vec3 vColor;
    varying float vFade;
    #include <common>
    #include <logdepthbuf_pars_vertex>
    void main() {
      vColor = color;
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      float dist = -mvPosition.z;
      float s = uSize * lsize * 400.0 / max(dist, 1.0);
      vFade = clamp(1.6 - dist / 45000.0, 0.0, 1.0);
      gl_PointSize = clamp(s, uMin, uMax * lsize) * uPixelRatio;
      gl_Position = projectionMatrix * mvPosition;
      #include <logdepthbuf_vertex>
    }`;

  const LIGHT_FRAG = `
    uniform sampler2D uMap;
    uniform float uIntensity;
    varying vec3 vColor;
    varying float vFade;
    #include <logdepthbuf_pars_fragment>
    void main() {
      #include <logdepthbuf_fragment>
      vec4 t = texture2D(uMap, gl_PointCoord);
      float a = t.a * uIntensity * vFade;
      if (a < 0.01) discard;
      gl_FragColor = vec4(vColor * a, a);
    }`;

  const RenderUtils = {
    /** Glowing point material; `intensity` uniform is driven by time of day / visibility. */
    lightMaterial({ size = 1, min = 1.5, max = 14 } = {}) {
      return new THREE.ShaderMaterial({
        uniforms: {
          uMap: { value: SIM.Textures.get('glow') },
          uSize: { value: size },
          uMin: { value: min },
          uMax: { value: max },
          uIntensity: { value: 1 },
          uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
        },
        vertexShader: LIGHT_VERT,
        fragmentShader: LIGHT_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      });
    },

    /** Builds a Points object from [{x,y,z,r,g,b,s}] */
    lightPoints(list, material) {
      const pos = new Float32Array(list.length * 3);
      const col = new Float32Array(list.length * 3);
      const siz = new Float32Array(list.length);
      list.forEach((l, i) => {
        pos[i * 3] = l.x;
        pos[i * 3 + 1] = l.y;
        pos[i * 3 + 2] = l.z;
        col[i * 3] = l.r;
        col[i * 3 + 1] = l.g;
        col[i * 3 + 2] = l.b;
        siz[i] = l.s || 1;
      });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.setAttribute('lsize', new THREE.BufferAttribute(siz, 1));
      g.computeBoundingSphere();
      const pts = new THREE.Points(g, material);
      pts.frustumCulled = false;
      return pts;
    },

    /** Matrix for a flat quad (unit PlaneGeometry laid on XZ) at a position, heading and size. */
    flatMatrix(out, x, y, z, headingDeg, width, length) {
      const q = RenderUtils._q.setFromAxisAngle(RenderUtils._up, -headingDeg * Math.PI / 180);
      out.compose(RenderUtils._p.set(x, y, z), q, RenderUtils._s.set(width, 1, length));
      return out;
    },

    flatQuadGeometry() {
      if (!RenderUtils._flat) RenderUtils._flat = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
      return RenderUtils._flat;
    },

    /** Merges simple non-indexed geometries into one (positions, normals, optional uvs). */
    merge(geoms) {
      const parts = geoms.map((g) => (g.index ? g.toNonIndexed() : g));
      let n = 0;
      parts.forEach((g) => (n += g.attributes.position.count));
      const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
      let o = 0;
      parts.forEach((g) => {
        if (!g.attributes.normal) g.computeVertexNormals();
        pos.set(g.attributes.position.array, o * 3);
        nor.set(g.attributes.normal.array, o * 3);
        if (g.attributes.uv) uv.set(g.attributes.uv.array, o * 2);
        o += g.attributes.position.count;
      });
      const out = new THREE.BufferGeometry();
      out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      out.computeBoundingSphere();
      return out;
    },

    disposeObject(obj) {
      obj.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
      });
    },
  };

  // lazily created scratch objects (THREE may not exist when this file is parsed)
  Object.defineProperty(RenderUtils, '_q', { get() { return this.__q || (this.__q = new THREE.Quaternion()); } });
  Object.defineProperty(RenderUtils, '_p', { get() { return this.__p || (this.__p = new THREE.Vector3()); } });
  Object.defineProperty(RenderUtils, '_s', { get() { return this.__s || (this.__s = new THREE.Vector3()); } });
  Object.defineProperty(RenderUtils, '_up', { get() { return this.__up || (this.__up = new THREE.Vector3(0, 1, 0)); } });

  SIM.RenderUtils = RenderUtils;
})(window.SIM);
