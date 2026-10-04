/**
 * ThumbnailRenderer — renders each aircraft's procedural 3D model into an image for the menu cards.
 * Uses a temporary WebGL context that is released afterwards. Falls back to an SVG silhouette.
 */
(function (SIM) {
  'use strict';

  const cache = new Map();

  const SILHOUETTE = (color) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 220"><rect width="400" height="220" fill="#1a2028"/><path d="M200 40l14 60 120 30v14l-118-14-6 46 26 14v10l-36-8-36 8v-10l26-14-6-46-118 14v-14l120-30z" fill="${color}" opacity=".85"/></svg>`)}`;

  const ThumbnailRenderer = {
    async renderAll(ids, w = 480, h = 270) {
      if (!window.THREE || !SIM.RenderSystem.webglSupported()) {
        ids.forEach((id) => cache.set(id, SILHOUETTE('#c9ced6')));
        return cache;
      }
      let renderer;
      try {
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
        renderer.setPixelRatio(1);
        renderer.setSize(w, h, false);
        renderer.shadowMap.enabled = true;
        for (const id of ids) {
          if (cache.has(id)) continue;
          cache.set(id, this.renderOne(renderer, id, w, h));
          await SIM.nextFrame();
        }
      } catch (e) {
        console.warn('[Thumbnails] fallback', e);
        ids.forEach((id) => !cache.has(id) && cache.set(id, SILHOUETTE('#c9ced6')));
      } finally {
        if (renderer) {
          renderer.dispose();
          renderer.forceContextLoss && renderer.forceContextLoss();
        }
      }
      return cache;
    },

    renderOne(renderer, id, w, h) {
      const cfg = SIM.AircraftData[id];
      const scene = new THREE.Scene();
      const model = SIM.AircraftModelBuilder.build(cfg, { landingLight: false });
      // fixed gear down, props still
      scene.add(model);
      const hemi = new THREE.HemisphereLight(0xdfe9ff, 0x45403a, 0.75);
      const sun = new THREE.DirectionalLight(0xfff1dd, 0.9);
      sun.position.set(-30, 40, -20);
      sun.castShadow = true;
      sun.shadow.mapSize.set(1024, 1024);
      const L = cfg.geometry.length * (cfg.visual.scale || 1);
      const sc = sun.shadow.camera;
      sc.left = sc.bottom = -L * 1.2;
      sc.right = sc.top = L * 1.2;
      scene.add(hemi, sun);
      const floor = new THREE.Mesh(new THREE.CircleGeometry(L * 2, 48).rotateX(-Math.PI / 2), new THREE.ShadowMaterial({ opacity: 0.35 }));
      floor.position.y = cfg.gear.points[1].pos[1] - 0.25 * (cfg.visual.model === 'airliner' ? 2 : 1);
      floor.receiveShadow = true;
      scene.add(floor);
      model.traverse((o) => o.isMesh && (o.castShadow = true));
      const cam = new THREE.PerspectiveCamera(30, w / h, 0.1, 1000);
      const span = cfg.geometry.span;
      const d = Math.max(L, span) * 1.55;
      cam.position.set(-d * 0.75, d * 0.32, -d * 0.62);
      cam.lookAt(0, 0, L * 0.05);
      renderer.setClearColor(0x000000, 0);
      renderer.render(scene, cam);
      const url = renderer.domElement.toDataURL('image/png');
      SIM.RenderUtils.disposeObject(scene);
      return url;
    },

    get(id) {
      return cache.get(id) || SILHOUETTE('#c9ced6');
    },
  };

  SIM.ThumbnailRenderer = ThumbnailRenderer;
})(window.SIM);
