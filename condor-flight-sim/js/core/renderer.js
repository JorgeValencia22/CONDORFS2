/**
 * RenderSystem — owns the WebGL renderer and scene. Handles resize, quality settings, dynamic
 * resolution (automatic mode keeps the frame rate playable on modest hardware) and stats.
 * If WebGL is unavailable the simulator runs in instrument-only mode (no 3D view).
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;

  class RenderSystem {
    constructor(container, settings) {
      this.container = container;
      this.settings = settings;
      this.available = false;
      this.error = null;
      this.dynamicScale = 1;
      this.fpsAvg = 60;
      this.frameMs = 16;
      this.autoTimer = 0;
      this.gpuName = '';
      if (!window.THREE) {
        this.error = 'Three.js could not be loaded (no internet connection and no local copy in js/vendor/).';
        return;
      }
      try {
        this.create();
        this.available = true;
      } catch (e) {
        console.error('[Render] WebGL init failed', e);
        this.error = e.message || String(e);
      }
    }

    static webglSupported() {
      try {
        const c = document.createElement('canvas');
        return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
      } catch (e) {
        return false;
      }
    }

    create() {
      if (!RenderSystem.webglSupported()) throw new Error('WebGL is not supported or is disabled in this browser.');
      const g = this.settings.data.graphics;
      const renderer = new THREE.WebGLRenderer({
        antialias: !!g.antialias,
        logarithmicDepthBuffer: true,
        powerPreference: 'high-performance',
        stencil: false,
      });
      renderer.setClearColor(0x8fb4d8);
      renderer.shadowMap.enabled = g.shadows !== 'off';
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.domElement.id = 'gl-canvas';
      renderer.domElement.setAttribute('aria-label', '3D flight view');
      this.container.appendChild(renderer.domElement);
      this.renderer = renderer;
      this.antialiasAtCreate = !!g.antialias;
      const gl = renderer.getContext();
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      this.gpuName = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'WebGL';
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(65, 1, 0.15, 200000);
      this.scene.add(this.camera);
      renderer.domElement.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        SIM.ErrorHandler.show('Graphics context lost', 'The GPU reset the WebGL context (driver crash or too many tabs using 3D). Reload the simulator to continue.', {});
      });
      this.resize();
      window.addEventListener('resize', () => this.resize());
      SIM.events.on('settings:changed', ({ path }) => {
        if (path.startsWith('graphics') || path === '*') this.applySettings();
      });
    }

    applySettings() {
      if (!this.renderer) return;
      const g = this.settings.data.graphics;
      const wantShadows = g.shadows !== 'off';
      if (this.renderer.shadowMap.enabled !== wantShadows) {
        this.renderer.shadowMap.enabled = wantShadows;
        this.scene.traverse((o) => {
          if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => (m.needsUpdate = true));
        });
      }
      this.resize();
    }

    get needsRestartForAA() {
      return this.renderer && this.antialiasAtCreate !== !!this.settings.data.graphics.antialias;
    }

    resize() {
      if (!this.renderer) return;
      const w = this.container.clientWidth || window.innerWidth;
      const h = this.container.clientHeight || window.innerHeight;
      const g = this.settings.data.graphics;
      const ratio = Math.min(window.devicePixelRatio || 1, 2) * (g.resolutionScale || 1) * this.dynamicScale;
      this.renderer.setPixelRatio(M.clamp(ratio, 0.4, 2.5));
      this.renderer.setSize(w, h, false);
      this.renderer.domElement.style.width = w + 'px';
      this.renderer.domElement.style.height = h + 'px';
      this.width = w;
      this.height = h;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      SIM.events.emit('render:resize', { width: w, height: h });
    }

    /** Frame time bookkeeping and automatic quality adaptation. */
    trackFrame(dt) {
      if (dt <= 0) return;
      this.fpsAvg = M.lerp(this.fpsAvg, 1 / dt, 0.05);
      const g = this.settings.data.graphics;
      if (g.preset !== 'auto') {
        if (this.dynamicScale !== 1) {
          this.dynamicScale = 1;
          this.resize();
        }
        return;
      }
      this.autoTimer += dt;
      if (this.autoTimer < 2) return;
      this.autoTimer = 0;
      let next = this.dynamicScale;
      if (this.fpsAvg < 28) next = Math.max(0.55, this.dynamicScale - 0.1);
      else if (this.fpsAvg > 55 && this.dynamicScale < 1) next = Math.min(1, this.dynamicScale + 0.05);
      if (Math.abs(next - this.dynamicScale) > 0.001) {
        this.dynamicScale = next;
        this.resize();
      }
      // If even reduced resolution is not enough, drop the render distance too.
      if (this.fpsAvg < 22 && this.dynamicScale <= 0.56 && g.renderDistance > 35) {
        this.settings.set('graphics.renderDistance', Math.max(35, g.renderDistance - 15), { silent: true });
        g.preset = 'auto';
      }
    }

    render() {
      if (!this.renderer) return;
      this.renderer.render(this.scene, this.camera);
    }

    info() {
      if (!this.renderer) return { calls: 0, triangles: 0 };
      return this.renderer.info.render;
    }

    dispose() {
      if (this.renderer) {
        this.renderer.dispose();
        this.renderer.domElement.remove();
      }
    }
  }

  SIM.RenderSystem = RenderSystem;
})(window.SIM);
