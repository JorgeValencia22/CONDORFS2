/**
 * Visual effects: pooled billboard particles (dust, smoke, tyre smoke, vapour, fire, spray) and
 * GPU-animated rain streaks around the camera. Budgets scale with the particles quality setting.
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;

  const P_VERT = `
    attribute vec3 iPos;
    attribute float iSize;
    attribute float iAlpha;
    attribute vec3 iColor;
    varying vec2 vUv;
    varying float vAlpha;
    varying vec3 vColor;
    varying float vDist;
    #include <common>
    #include <logdepthbuf_pars_vertex>
    void main() {
      vUv = uv;
      vAlpha = iAlpha;
      vColor = iColor;
      vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
      mv.xy += position.xy * iSize;
      vDist = -mv.z;
      gl_Position = projectionMatrix * mv;
      #include <logdepthbuf_vertex>
    }`;
  const P_FRAG = `
    uniform sampler2D uMap;
    uniform vec3 uLight;
    varying vec2 vUv;
    varying float vAlpha;
    varying vec3 vColor;
    varying float vDist;
    #include <logdepthbuf_pars_fragment>
    void main() {
      #include <logdepthbuf_fragment>
      vec4 t = texture2D(uMap, vUv);
      float a = t.a * vAlpha * smoothstep(0.5, 3.0, vDist);
      if (a < 0.01) discard;
      gl_FragColor = vec4(vColor * uLight, a);
    }`;

  const TYPES = {
    dust: { color: [0.62, 0.55, 0.43], life: 2.6, size0: 1.2, grow: 3.2, alpha: 0.4, drag: 1.6, rise: 0.6 },
    grass: { color: [0.55, 0.56, 0.42], life: 1.8, size0: 0.8, grow: 2.2, alpha: 0.25, drag: 2.0, rise: 0.3 },
    tyre: { color: [0.86, 0.86, 0.86], life: 2.2, size0: 0.8, grow: 2.6, alpha: 0.55, drag: 2.5, rise: 0.5 },
    smoke: { color: [0.22, 0.22, 0.24], life: 6, size0: 1.5, grow: 2.2, alpha: 0.5, drag: 0.6, rise: 2.0 },
    startSmoke: { color: [0.55, 0.57, 0.6], life: 2.5, size0: 0.6, grow: 1.6, alpha: 0.45, drag: 1.2, rise: 0.4 },
    vapor: { color: [1, 1, 1], life: 0.7, size0: 0.5, grow: 1.4, alpha: 0.35, drag: 0.2, rise: 0 },
    fire: { color: [1.6, 0.75, 0.25], life: 0.9, size0: 2.2, grow: 1.2, alpha: 0.9, drag: 0.4, rise: 4 },
    spray: { color: [0.9, 0.94, 0.98], life: 1.4, size0: 1, grow: 3, alpha: 0.5, drag: 1.2, rise: 1 },
    exhaust: { color: [0.5, 0.5, 0.52], life: 1.2, size0: 0.25, grow: 0.9, alpha: 0.18, drag: 1.2, rise: 0.2 },
  };

  class ParticleSystem {
    constructor(scene, settings, max = 900) {
      this.scene = scene;
      this.settings = settings;
      this.max = max;
      this.particles = [];
      this.free = [];
      for (let i = 0; i < max; i++) {
        this.particles.push({ alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 0, life: 1, size: 1, type: null });
        this.free.push(i);
      }
      const base = new THREE.PlaneGeometry(1, 1);
      const geo = new THREE.InstancedBufferGeometry();
      geo.setIndex(base.index);
      geo.setAttribute('position', base.attributes.position);
      geo.setAttribute('uv', base.attributes.uv);
      this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
      this.aSize = new THREE.InstancedBufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
      this.aAlpha = new THREE.InstancedBufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
      this.aColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('iPos', this.aPos);
      geo.setAttribute('iSize', this.aSize);
      geo.setAttribute('iAlpha', this.aAlpha);
      geo.setAttribute('iColor', this.aColor);
      geo.instanceCount = 0;
      this.geo = geo;
      this.material = new THREE.ShaderMaterial({
        uniforms: { uMap: { value: SIM.Textures.get('smoke') }, uLight: { value: new THREE.Color(1, 1, 1) } },
        vertexShader: P_VERT,
        fragmentShader: P_FRAG,
        transparent: true,
        depthWrite: false,
        fog: false,
      });
      this.mesh = new THREE.Mesh(geo, this.material);
      this.mesh.frustumCulled = false;
      this.mesh.renderOrder = 6;
      scene.add(this.mesh);
    }

    get budget() {
      return SIM.GraphicsLevels.particles[this.settings.data.graphics.particles] ?? 0.7;
    }

    emit(type, x, y, z, vx = 0, vy = 0, vz = 0, scale = 1) {
      if (!this.settings.data.graphics.effects && type !== 'smoke' && type !== 'fire') return;
      if (!this.free.length) return;
      if (this.max - this.free.length > this.max * this.budget) return;
      const t = TYPES[type];
      const i = this.free.pop();
      const p = this.particles[i];
      p.alive = true;
      p.type = t;
      p.x = x; p.y = y; p.z = z;
      p.vx = vx; p.vy = vy; p.vz = vz;
      p.age = 0;
      p.life = t.life * (0.75 + Math.random() * 0.5);
      p.size = t.size0 * scale;
      p.scale = scale;
    }

    update(dt, lightLevel) {
      let n = 0;
      const pos = this.aPos.array, siz = this.aSize.array, alp = this.aAlpha.array, col = this.aColor.array;
      for (let i = 0; i < this.max; i++) {
        const p = this.particles[i];
        if (!p.alive) continue;
        p.age += dt;
        if (p.age >= p.life) {
          p.alive = false;
          this.free.push(i);
          continue;
        }
        const t = p.type;
        const k = Math.exp(-t.drag * dt);
        p.vx *= k;
        p.vz *= k;
        p.vy = p.vy * k + t.rise * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z += p.vz * dt;
        const f = p.age / p.life;
        pos[n * 3] = p.x;
        pos[n * 3 + 1] = p.y;
        pos[n * 3 + 2] = p.z;
        siz[n] = (t.size0 + t.grow * p.age) * p.scale * 2;
        alp[n] = t.alpha * (1 - f) * Math.min(1, p.age * 8);
        col[n * 3] = t.color[0];
        col[n * 3 + 1] = t.color[1];
        col[n * 3 + 2] = t.color[2];
        n++;
      }
      this.geo.instanceCount = n;
      if (n) [this.aPos, this.aSize, this.aAlpha, this.aColor].forEach((a) => {
        a.needsUpdate = true;
        a.updateRange.count = n * a.itemSize;
      });
      this.material.uniforms.uLight.value.setScalar(0.25 + 0.75 * lightLevel);
    }

    clear() {
      this.particles.forEach((p, i) => {
        if (p.alive) {
          p.alive = false;
          this.free.push(i);
        }
      });
    }

    dispose() {
      this.scene.remove(this.mesh);
      this.geo.dispose();
      this.material.dispose();
    }
  }

  const R_VERT = `
    attribute vec3 aSeed;
    attribute float aEnd;
    uniform vec3 uCam;
    uniform vec3 uVel;
    uniform float uTime;
    uniform float uBox;
    uniform float uStreak;
    varying float vEnd;
    #include <common>
    #include <logdepthbuf_pars_vertex>
    void main() {
      vec3 p = aSeed * uBox + uVel * uTime;
      p = mod(p - uCam + uBox * 0.5, uBox) - uBox * 0.5 + uCam;
      p -= uVel * uStreak * aEnd;
      vEnd = aEnd;
      gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      #include <logdepthbuf_vertex>
    }`;
  const R_FRAG = `
    uniform vec3 uColor;
    uniform float uOpacity;
    varying float vEnd;
    #include <logdepthbuf_pars_fragment>
    void main() {
      #include <logdepthbuf_fragment>
      gl_FragColor = vec4(uColor, uOpacity * (1.0 - vEnd * 0.7));
    }`;

  class RainRenderer {
    constructor(scene, count = 5000) {
      this.scene = scene;
      this.count = count;
      const seeds = new Float32Array(count * 2 * 3);
      const ends = new Float32Array(count * 2);
      for (let i = 0; i < count; i++) {
        const sx = Math.random(), sy = Math.random(), sz = Math.random();
        for (let e = 0; e < 2; e++) {
          seeds.set([sx, sy, sz], (i * 2 + e) * 3);
          ends[i * 2 + e] = e;
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 2 * 3), 3));
      geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
      geo.setAttribute('aEnd', new THREE.BufferAttribute(ends, 1));
      this.geo = geo;
      this.material = new THREE.ShaderMaterial({
        uniforms: {
          uCam: { value: new THREE.Vector3() }, uVel: { value: new THREE.Vector3(0, -9, 0) }, uTime: { value: 0 },
          uBox: { value: 70 }, uStreak: { value: 0.03 }, uColor: { value: new THREE.Color(0.75, 0.8, 0.88) }, uOpacity: { value: 0.35 },
        },
        vertexShader: R_VERT,
        fragmentShader: R_FRAG,
        transparent: true,
        depthWrite: false,
        fog: false,
      });
      this.lines = new THREE.LineSegments(geo, this.material);
      this.lines.frustumCulled = false;
      this.lines.renderOrder = 7;
      scene.add(this.lines);
      this.time = 0;
    }

    update(dt, camera, weather, camVel, daylight, budget) {
      const p = weather.p.precipitation;
      const camY = camera.position.y;
      const visible = p > 0.05 && camY < weather.cloudBase + 200;
      this.lines.visible = visible;
      if (!visible) return;
      this.time += dt;
      const u = this.material.uniforms;
      const wind = weather.windAt(camera.position, { x: 0, y: 0, z: 0 });
      u.uVel.value.set(wind.x - camVel.x, -9 - p * 3 - camVel.y, wind.z - camVel.z);
      u.uCam.value.copy(camera.position);
      // Wrap time to keep float precision
      u.uTime.value = this.time % 1000;
      u.uStreak.value = 0.025 + Math.min(0.03, camVel.length() * 0.0004);
      u.uOpacity.value = (0.18 + 0.32 * p) * (0.35 + 0.65 * daylight);
      this.geo.setDrawRange(0, Math.floor(this.count * Math.min(1, p * budget * 1.2)) * 2);
    }

    dispose() {
      this.scene.remove(this.lines);
      this.geo.dispose();
      this.material.dispose();
    }
  }

  SIM.ParticleSystem = ParticleSystem;
  SIM.RainRenderer = RainRenderer;
  SIM.ParticleTypes = TYPES;
})(window.SIM);
