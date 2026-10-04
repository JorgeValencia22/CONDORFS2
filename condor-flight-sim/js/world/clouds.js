/**
 * CloudRenderer — cumulus fields built from instanced, camera-facing puffs placed deterministically
 * in world cells (stable while flying), plus stratus/overcast layers for heavy cover.
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;

  const VERT = `
    attribute vec3 iOffset;
    attribute float iScale;
    attribute float iShade;
    attribute float iRot;
    uniform vec3 uSunDir;
    varying vec2 vUv;
    varying float vShade;
    varying float vDist;
    varying float vSunFacing;
    #include <common>
    #include <logdepthbuf_pars_vertex>
    void main() {
      vUv = uv;
      vShade = iShade;
      vec4 mv = modelViewMatrix * vec4(iOffset, 1.0);
      float c = cos(iRot), s = sin(iRot);
      vec2 p = vec2(position.x * c - position.y * s, position.x * s + position.y * c);
      mv.xy += p * iScale;
      vDist = -mv.z;
      vec3 toCam = normalize(cameraPosition - iOffset);
      vSunFacing = dot(toCam, -uSunDir);
      gl_Position = projectionMatrix * mv;
      #include <logdepthbuf_vertex>
    }`;
  const FRAG = `
    uniform sampler2D uMap;
    uniform vec3 uLit;
    uniform vec3 uDark;
    uniform vec3 uFogColor;
    uniform float uFogDensity;
    uniform float uOpacity;
    varying vec2 vUv;
    varying float vShade;
    varying float vDist;
    varying float vSunFacing;
    #include <logdepthbuf_pars_fragment>
    void main() {
      #include <logdepthbuf_fragment>
      vec4 t = texture2D(uMap, vUv);
      float a = t.a * uOpacity * smoothstep(20.0, 160.0, vDist);
      if (a < 0.01) discard;
      vec3 col = mix(uDark, uLit, clamp(vShade * (0.6 + 0.4 * t.r), 0.0, 1.0));
      col += uLit * 0.25 * pow(max(vSunFacing, 0.0), 6.0);
      float f = 1.0 - exp(-pow(vDist * uFogDensity * 0.6, 2.0));
      col = mix(col, uFogColor, clamp(f, 0.0, 1.0));
      gl_FragColor = vec4(col, a);
    }`;

  class CloudRenderer {
    constructor(scene, settings) {
      this.scene = scene;
      this.settings = settings;
      this.maxPuffs = 2600;
      this.cellSize = 4000;
      this.center = { x: Infinity, z: Infinity };
      this.key = '';
      const base = new THREE.PlaneGeometry(1, 1);
      const geo = new THREE.InstancedBufferGeometry();
      geo.setIndex(base.index);
      geo.setAttribute('position', base.attributes.position);
      geo.setAttribute('uv', base.attributes.uv);
      this.aOffset = new THREE.InstancedBufferAttribute(new Float32Array(this.maxPuffs * 3), 3);
      this.aScale = new THREE.InstancedBufferAttribute(new Float32Array(this.maxPuffs), 1);
      this.aShade = new THREE.InstancedBufferAttribute(new Float32Array(this.maxPuffs), 1);
      this.aRot = new THREE.InstancedBufferAttribute(new Float32Array(this.maxPuffs), 1);
      geo.setAttribute('iOffset', this.aOffset);
      geo.setAttribute('iScale', this.aScale);
      geo.setAttribute('iShade', this.aShade);
      geo.setAttribute('iRot', this.aRot);
      geo.instanceCount = 0;
      this.geo = geo;
      this.material = new THREE.ShaderMaterial({
        uniforms: {
          uMap: { value: SIM.Textures.get('cloud') },
          uLit: { value: new THREE.Color(1, 1, 1) },
          uDark: { value: new THREE.Color(0.6, 0.63, 0.68) },
          uFogColor: { value: new THREE.Color() },
          uFogDensity: { value: 0 },
          uOpacity: { value: 0.92 },
          uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        },
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        fog: false,
      });
      this.mesh = new THREE.Mesh(geo, this.material);
      this.mesh.frustumCulled = false;
      this.mesh.renderOrder = 5;
      scene.add(this.mesh);

      // Stratus layer (overcast/fog/rain)
      const layerTex = SIM.Textures.get('cloudLayer');
      this.layerTex = layerTex;
      this.layerMat = new THREE.MeshBasicMaterial({ map: layerTex, transparent: true, depthWrite: false, side: THREE.DoubleSide, color: 0xffffff, opacity: 0.9 });
      this.layerBottom = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), this.layerMat);
      this.layerTop = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), this.layerMat);
      [this.layerBottom, this.layerTop].forEach((m) => {
        m.frustumCulled = false;
        m.renderOrder = 4;
        scene.add(m);
      });
      this.particlesLevel = SIM.GraphicsLevels.clouds[settings.data.graphics.clouds] ?? 0.7;
      SIM.events.on('settings:changed', ({ path }) => {
        if (path.startsWith('graphics')) {
          this.particlesLevel = SIM.GraphicsLevels.clouds[settings.data.graphics.clouds] ?? 0.7;
          this.key = '';
        }
      });
    }

    rebuild(cx, cz, weather, radius) {
      const p = weather.p;
      const cover = p.cloudCover;
      const base = weather.cloudBase;
      const storm = weather.preset === 'storm';
      const cell = this.cellSize;
      const n = Math.ceil(radius / cell);
      const i0 = Math.floor(cx / cell), j0 = Math.floor(cz / cell);
      const maxPuffs = Math.floor(this.maxPuffs * this.particlesLevel);
      const clouds = [];
      // Cumulus amount: scattered for partly cloudy, embedded towers for storms; overcast relies on layers
      const cumulusCover = cover > 0.9 ? (storm ? 0.5 : 0.25) : cover;
      for (let j = -n; j <= n; j++) {
        for (let i = -n; i <= n; i++) {
          const ci = i0 + i, cj = j0 + j;
          const rnd = SIM.mulberry32((ci * 92837111) ^ (cj * 689287499) ^ 0x5bd1e995);
          const count = Math.floor(cumulusCover * 3.2 + rnd() * cumulusCover * 2);
          for (let k = 0; k < count; k++) {
            const x = (ci + rnd()) * cell, z = (cj + rnd()) * cell;
            const d = Math.hypot(x - cx, z - cz);
            if (d > radius) continue;
            const size = (storm ? 700 : 380) + rnd() * (storm ? 900 : 520);
            clouds.push({ x, z, y: base + rnd() * 120, size, d, rnd, tall: storm ? 3 + rnd() * 4 : 0.6 + rnd() * 0.7 });
          }
        }
      }
      clouds.sort((a, b) => a.d - b.d);
      let n2 = 0;
      const off = this.aOffset.array, sc = this.aScale.array, sh = this.aShade.array, ro = this.aRot.array;
      for (const c of clouds) {
        const puffs = 6 + Math.floor(c.rnd() * 7);
        for (let k = 0; k < puffs && n2 < maxPuffs; k++) {
          const ang = c.rnd() * Math.PI * 2;
          const rr = c.rnd() * c.size * 0.55;
          const hy = Math.pow(c.rnd(), 1.5) * c.size * 0.55 * c.tall;
          off[n2 * 3] = c.x + Math.cos(ang) * rr;
          off[n2 * 3 + 1] = c.y + hy;
          off[n2 * 3 + 2] = c.z + Math.sin(ang) * rr * 0.8;
          sc[n2] = c.size * (0.55 + c.rnd() * 0.5) * (1 - (hy / (c.size * c.tall + 1)) * 0.35);
          sh[n2] = M.clamp(0.35 + hy / (c.size * 0.6 * c.tall + 1) * 0.65, 0, 1);
          ro[n2] = c.rnd() * Math.PI * 2;
          n2++;
        }
        if (n2 >= maxPuffs) break;
      }
      // Draw far-to-near for correct blending
      const order = [];
      for (let k = 0; k < n2; k++) order.push({ k, d: Math.hypot(off[k * 3] - cx, off[k * 3 + 2] - cz) });
      order.sort((a, b) => b.d - a.d);
      const o2 = new Float32Array(n2 * 3), s2 = new Float32Array(n2), h2 = new Float32Array(n2), r2 = new Float32Array(n2);
      order.forEach((e, idx) => {
        o2.set(off.subarray(e.k * 3, e.k * 3 + 3), idx * 3);
        s2[idx] = sc[e.k];
        h2[idx] = sh[e.k];
        r2[idx] = ro[e.k];
      });
      off.set(o2);
      sc.set(s2);
      sh.set(h2);
      ro.set(r2);
      this.geo.instanceCount = n2;
      [this.aOffset, this.aScale, this.aShade, this.aRot].forEach((a) => (a.needsUpdate = true));
    }

    update(camera, weather, sky, renderDistance) {
      const cp = camera.position;
      const radius = Math.min(renderDistance, 42000);
      const key = `${weather.preset}|${weather.p.cloudCover}|${weather.p.cloudBaseFt}|${this.particlesLevel}`;
      if (key !== this.key || Math.hypot(cp.x - this.center.x, cp.z - this.center.z) > 2500) {
        this.key = key;
        this.center = { x: cp.x, z: cp.z };
        this.rebuild(cp.x, cp.z, weather, radius);
      }
      const u = this.material.uniforms;
      const dl = sky.daylight;
      const sunCol = sky.sunLight.color;
      const lit = new THREE.Color(1, 1, 1).lerp(sunCol, 0.35).multiplyScalar(0.25 + 0.75 * dl);
      lit.add(new THREE.Color(0.7, 0.75, 0.9).multiplyScalar(weather.flash));
      u.uLit.value.copy(lit);
      u.uDark.value.setRGB(0.48, 0.52, 0.58).multiplyScalar(0.2 + 0.7 * dl).multiplyScalar(weather.preset === 'storm' ? 0.6 : 1);
      u.uFogColor.value.copy(this.scene.fog.color);
      u.uFogDensity.value = this.scene.fog.density;
      u.uSunDir.value.copy(sky.sunDir);

      // Layers
      const cover = weather.p.cloudCover;
      const layered = cover >= 0.68;
      this.layerBottom.visible = this.layerTop.visible = layered;
      if (layered) {
        const size = radius * 2.4;
        this.layerBottom.scale.set(size, 1, size);
        this.layerTop.scale.set(size, 1, size);
        this.layerBottom.position.set(cp.x, weather.cloudBase, cp.z);
        this.layerTop.position.set(cp.x, Math.min(weather.cloudTop, weather.cloudBase + 1600), cp.z);
        const rep = size / 6000;
        this.layerTex.repeat.set(rep, rep);
        this.layerTex.offset.set((cp.x / size) * rep, (-cp.z / size) * rep);
        this.layerMat.opacity = M.clamp((cover - 0.6) * 2.5, 0, 0.97);
        const shade = (0.22 + 0.78 * dl) * (weather.preset === 'storm' ? 0.55 : weather.p.precipitation > 0 ? 0.75 : 0.95);
        this.layerMat.color.setRGB(shade, shade * 1.01, shade * 1.04).add(new THREE.Color(0.5, 0.55, 0.7).multiplyScalar(weather.flash));
      }
    }

    dispose() {
      [this.mesh, this.layerBottom, this.layerTop].forEach((m) => this.scene.remove(m));
      this.geo.dispose();
      this.material.dispose();
      this.layerMat.dispose();
    }
  }

  SIM.CloudRenderer = CloudRenderer;
})(window.SIM);
