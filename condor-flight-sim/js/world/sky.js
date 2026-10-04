/**
 * SkySystem — time of day and atmosphere rendering: solar position (latitude, season, hour),
 * sky dome shader, sun/moon/stars, sun + hemisphere lighting with a shadow camera that follows
 * the aircraft, fog from visibility, lightning flashes and the ocean surface.
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;

  const SEASON_DOY = { S: { summer: 15, autumn: 105, winter: 196, spring: 288 }, N: { summer: 196, autumn: 288, winter: 15, spring: 105 } };

  /** Solar elevation/azimuth (degrees) for latitude, day-of-year and local solar hour. */
  function sunPosition(latDeg, doy, hour) {
    const decl = -23.44 * Math.cos(((2 * Math.PI) / 365) * (doy + 10)) * M.DEG;
    const lat = latDeg * M.DEG;
    const H = (hour - 12) * 15 * M.DEG;
    const sinEl = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(H);
    const el = Math.asin(M.clamp(sinEl, -1, 1));
    const az = Math.atan2(-Math.sin(H), Math.tan(decl) * Math.cos(lat) - Math.sin(lat) * Math.cos(H));
    return { elevation: el * M.RAD, azimuth: M.wrap360(az * M.RAD) };
  }

  const SKY_VERT = `
    varying vec3 vDir;
    #include <common>
    #include <logdepthbuf_pars_vertex>
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vDir = wp.xyz - cameraPosition;
      gl_Position = projectionMatrix * viewMatrix * wp;
      #include <logdepthbuf_vertex>
    }`;
  const SKY_FRAG = `
    uniform vec3 uZenith;
    uniform vec3 uHorizon;
    uniform vec3 uGround;
    uniform vec3 uSunDir;
    uniform vec3 uSunColor;
    uniform float uSunDisk;
    uniform float uFlash;
    varying vec3 vDir;
    #include <logdepthbuf_pars_fragment>
    void main() {
      #include <logdepthbuf_fragment>
      vec3 d = normalize(vDir);
      float t = max(d.y, 0.0);
      vec3 col = mix(uHorizon, uZenith, pow(t, 0.45));
      col = mix(col, uGround, smoothstep(0.0, -0.08, d.y));
      float s = max(dot(d, uSunDir), 0.0);
      col += uSunColor * (pow(s, 7.0) * 0.28 + pow(s, 60.0) * 0.35) * (0.3 + 0.7 * uSunDisk);
      col += uSunColor * smoothstep(0.9994, 0.9997, s) * 3.0 * uSunDisk;
      col += vec3(0.75, 0.8, 1.0) * uFlash;
      gl_FragColor = vec4(col, 1.0);
    }`;

  const c3 = (hex) => new THREE.Color(hex);
  let KEYS_CACHE = null;
  const KEYS_DEF = () => [
    // elevation, zenith, horizon, sun colour, light intensity
    { e: -18, zen: c3(0x02040a), hor: c3(0x070b16), sun: c3(0x223355) },
    { e: -8, zen: c3(0x0b1430), hor: c3(0x2a2f4a), sun: c3(0x553344) },
    { e: -2, zen: c3(0x1d3060), hor: c3(0xb06a4f), sun: c3(0xff7a40) },
    { e: 4, zen: c3(0x34558f), hor: c3(0xe9a978), sun: c3(0xffa35c) },
    { e: 14, zen: c3(0x3c67a6), hor: c3(0xb7cde3), sun: c3(0xffe2b8) },
    { e: 40, zen: c3(0x2f62a8), hor: c3(0xadc9e6), sun: c3(0xfff6ea) },
  ];

  function sampleKeys(e) {
    const KEYS = KEYS_CACHE || (KEYS_CACHE = KEYS_DEF());
    let a = KEYS[0], b = KEYS[KEYS.length - 1];
    for (let i = 0; i < KEYS.length - 1; i++) {
      if (e >= KEYS[i].e && e <= KEYS[i + 1].e) {
        a = KEYS[i];
        b = KEYS[i + 1];
        break;
      }
    }
    if (e < KEYS[0].e) b = a;
    if (e > b.e) a = b;
    const t = a === b ? 0 : (e - a.e) / (b.e - a.e);
    return { zen: a.zen.clone().lerp(b.zen, t), hor: a.hor.clone().lerp(b.hor, t), sun: a.sun.clone().lerp(b.sun, t) };
  }

  class SkySystem {
    constructor(scene, renderer, region, settings) {
      this.scene = scene;
      this.renderer = renderer;
      this.region = region;
      this.settings = settings;
      this.doy = 15;
      this.sun = { elevation: 45, azimuth: 0 };
      this.daylight = 1;
      this.sunDir = new THREE.Vector3(0, 1, 0);

      this.dome = new THREE.Mesh(
        new THREE.SphereGeometry(1, 32, 16),
        new THREE.ShaderMaterial({
          uniforms: {
            uZenith: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uGround: { value: new THREE.Color() },
            uSunDir: { value: this.sunDir }, uSunColor: { value: new THREE.Color() }, uSunDisk: { value: 1 }, uFlash: { value: 0 },
          },
          vertexShader: SKY_VERT,
          fragmentShader: SKY_FRAG,
          side: THREE.BackSide,
          depthWrite: false,
          fog: false,
        })
      );
      this.dome.renderOrder = -10;
      this.dome.frustumCulled = false;
      scene.add(this.dome);

      // Stars
      const rnd = SIM.mulberry32(7);
      const starPos = [];
      for (let i = 0; i < 1800; i++) {
        const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2;
        const r = Math.sqrt(1 - u * u);
        starPos.push(r * Math.cos(th), Math.abs(u) * 0.98 + 0.02, r * Math.sin(th));
      }
      const sg = new THREE.BufferGeometry();
      sg.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
      this.stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, fog: false }));
      this.stars.renderOrder = -9;
      this.stars.frustumCulled = false;
      scene.add(this.stars);

      // Moon
      this.moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: SIM.Textures.get('glow'), color: 0xe8ecff, transparent: true, depthWrite: false, fog: false }));
      this.moon.renderOrder = -8;
      scene.add(this.moon);

      // Lights
      this.sunLight = new THREE.DirectionalLight(0xffffff, 1);
      this.sunLight.target = new THREE.Object3D();
      scene.add(this.sunLight, this.sunLight.target);
      this.hemi = new THREE.HemisphereLight(0xbfd8ff, 0x5a5444, 0.6);
      scene.add(this.hemi);
      this.ambient = new THREE.AmbientLight(0x404a60, 0.05);
      scene.add(this.ambient);
      this.applyShadowQuality();

      // Fog
      scene.fog = new THREE.FogExp2(0xadc9e6, 0.00003);

      // Ocean
      const waterTex = SIM.Textures.get('waterNormal');
      waterTex.repeat.set(400, 400);
      this.water = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
        new THREE.MeshPhongMaterial({ color: 0x1d4a6b, specular: 0x8899aa, shininess: 90, normalMap: waterTex, normalScale: new THREE.Vector2(0.35, 0.35) })
      );
      this.water.receiveShadow = false;
      this.water.frustumCulled = false;
      scene.add(this.water);

      SIM.events.on('settings:changed', ({ path }) => {
        if (path.startsWith('graphics.shadows') || path === 'graphics.preset') this.applyShadowQuality();
      });
    }

    applyShadowQuality() {
      const q = this.settings.data.graphics.shadows;
      const size = SIM.GraphicsLevels.shadows[q] || 0;
      this.sunLight.castShadow = size > 0;
      if (size > 0) {
        this.sunLight.shadow.mapSize.set(size, size);
        if (this.sunLight.shadow.map) {
          this.sunLight.shadow.map.dispose();
          this.sunLight.shadow.map = null;
        }
        const cam = this.sunLight.shadow.camera;
        cam.near = 1;
        cam.far = 3000;
        this.sunLight.shadow.bias = -0.0004;
        this.sunLight.shadow.normalBias = 0.04;
      }
    }

    setSeason(season) {
      this.doy = (SEASON_DOY[this.region.hemisphere] || SEASON_DOY.S)[season] || 15;
    }

    /**
     * @param {number} hour local solar time (0..24)
     * @param {Weather} weather
     * @param {THREE.Camera} camera
     * @param {THREE.Vector3} focus point the shadow camera follows (aircraft)
     * @param {number} shadowExtent half-size (m) of the shadow box
     */
    update(hour, weather, camera, focus, shadowExtent, renderDistance) {
      const lat = this.region.origin[0];
      this.sun = sunPosition(lat, this.doy, hour);
      const el = this.sun.elevation, az = this.sun.azimuth;
      const er = el * M.DEG, ar = az * M.DEG;
      this.sunDir.set(Math.cos(er) * Math.sin(ar), Math.sin(er), -Math.cos(er) * Math.cos(ar)).normalize();

      const cover = weather.p.cloudCover;
      const keys = sampleKeys(el);
      const grey = new THREE.Color().setRGB(0.62, 0.65, 0.69).multiplyScalar(M.clamp((el + 8) / 30, 0.05, 1));
      const overcast = M.clamp(cover * 0.9 - 0.15, 0, 0.85);
      const zen = keys.zen.clone().lerp(grey, overcast);
      const hor = keys.hor.clone().lerp(grey.clone().multiplyScalar(1.1), overcast);
      // Precipitation and fog darken and flatten the sky
      const precip = weather.p.precipitation;
      if (precip > 0) {
        zen.multiplyScalar(1 - precip * 0.35);
        hor.multiplyScalar(1 - precip * 0.3);
      }
      const flash = weather.flash;
      const u = this.dome.material.uniforms;
      u.uZenith.value.copy(zen);
      u.uHorizon.value.copy(hor);
      u.uGround.value.copy(hor).multiplyScalar(0.72);
      u.uSunColor.value.copy(keys.sun);
      u.uSunDisk.value = M.clamp(1 - cover * 1.05, 0, 1) * M.smoothstep(-3, 1, el);
      u.uFlash.value = flash * 0.6;

      const dist = renderDistance * 0.95;
      this.dome.scale.setScalar(dist);
      this.dome.position.copy(camera.position);
      this.stars.scale.setScalar(dist * 0.9);
      this.stars.position.copy(camera.position);
      const night = 1 - M.smoothstep(-12, -2, el);
      this.stars.material.opacity = night * (1 - cover * 0.95);
      // Moon roughly opposite the sun
      const mel = M.clamp(-el * 0.8 + 18, 5, 60) * M.DEG, maz = (az + 170) * M.DEG;
      this.moon.position.set(Math.cos(mel) * Math.sin(maz), Math.sin(mel), -Math.cos(mel) * Math.cos(maz)).multiplyScalar(dist * 0.85).add(camera.position);
      this.moon.scale.setScalar(dist * 0.035);
      this.moon.material.opacity = night * (1 - cover * 0.9);

      // Lighting
      this.daylight = M.smoothstep(-6, 8, el);
      const sunVis = M.smoothstep(-2, 10, el) * (1 - cover * 0.7) * (1 - precip * 0.3);
      this.sunLight.intensity = sunVis * 0.95;
      this.sunLight.color.copy(keys.sun);
      this.sunLight.position.copy(focus).addScaledVector(this.sunDir, 1500);
      this.sunLight.target.position.copy(focus);
      this.sunLight.target.updateMatrixWorld();
      const sc = this.sunLight.shadow.camera;
      if (this.sunLight.castShadow && Math.abs(sc.right - shadowExtent) > 1) {
        sc.left = -shadowExtent;
        sc.right = shadowExtent;
        sc.top = shadowExtent;
        sc.bottom = -shadowExtent;
        sc.updateProjectionMatrix();
      }
      const hemiI = 0.18 + 0.55 * this.daylight * (1 - cover * 0.25) + flash * 1.6;
      this.hemi.intensity = hemiI;
      this.hemi.color.copy(zen).lerp(new THREE.Color(0xffffff), 0.45);
      this.hemi.groundColor.setRGB(0.35, 0.32, 0.27).multiplyScalar(0.3 + 0.7 * this.daylight);
      this.ambient.intensity = 0.06 + 0.1 * night;
      this.ambient.color.setRGB(0.32, 0.38, 0.55);

      // Fog follows visibility; inside cloud it becomes dense and white
      const vis = Math.max(150, Math.min(weather.visibility, renderDistance * 1.15));
      let density = 1.85 / vis;
      const fogColor = hor.clone();
      const camY = camera.position.y;
      if (cover > 0.6 && camY > weather.cloudBase && camY < weather.cloudTop) {
        density = Math.max(density, 1.6 / 140);
        fogColor.copy(grey).multiplyScalar(1.15);
      }
      this.scene.fog.density = density;
      this.scene.fog.color.copy(fogColor);
      if (this.renderer) this.renderer.setClearColor(fogColor);

      // Ocean follows the camera
      const ws = renderDistance * 2.2;
      this.water.scale.set(ws, 1, ws);
      this.water.position.set(camera.position.x, 0, camera.position.z);
      const wm = this.water.material;
      wm.color.setRGB(0.1, 0.27, 0.38).multiplyScalar(0.25 + 0.75 * this.daylight).lerp(grey, overcast * 0.35);
      wm.normalMap.offset.set((camera.position.x / ws) * 400 + weather.time * 0.004, (camera.position.z / ws) * 400 + weather.time * 0.003);
      wm.specular.setRGB(0.55, 0.55, 0.5).multiplyScalar(sunVis);
    }

    /** 0..1 how strongly artificial lights should glow. */
    lightsFactor(weather) {
      const lowVis = weather.visibility < 5000 ? 0.7 : 0;
      return M.clamp((1 - this.daylight) * 1.3 + lowVis, 0, 1);
    }

    dispose() {
      [this.dome, this.stars, this.moon, this.sunLight, this.sunLight.target, this.hemi, this.ambient, this.water].forEach((o) => this.scene.remove(o));
      SIM.RenderUtils.disposeObject(this.dome);
      SIM.RenderUtils.disposeObject(this.stars);
      SIM.RenderUtils.disposeObject(this.water);
      this.scene.fog = null;
    }
  }

  SIM.SkySystem = SkySystem;
  SIM.sunPosition = sunPosition;
})(window.SIM);
