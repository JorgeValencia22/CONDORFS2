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
      // Ground, runway and cockpit textures use the best anisotropic filtering the GPU offers
      SIM.Textures.maxAnisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy() || 4);
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
        if (path === 'graphics.preset' || path === '*') this.autoBase = null;
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

    /** Device pixel ratio actually rendered (screen density capped by the preset). */
    basePixelRatio() {
      const g = this.settings.data.graphics;
      const dpr = window.devicePixelRatio || 1;
      return Math.min(dpr, g.pixelRatioCap || 2);
    }

    resize() {
      if (!this.renderer) return;
      const w = this.container.clientWidth || window.innerWidth;
      const h = this.container.clientHeight || window.innerHeight;
      const g = this.settings.data.graphics;
      const dpr = window.devicePixelRatio || 1;
      let ratio = this.basePixelRatio() * (g.resolutionScale || 1) * this.dynamicScale;
      // Never render below the screen's own CSS pixel grid in automatic mode: that is what makes a
      // 3D view look pixelated. Only an explicit custom resolution scale below 100 % may go lower.
      const floor = g.preset === 'custom' && (g.resolutionScale || 1) < 1 ? 0.5 : Math.min(dpr, 1);
      ratio = M.clamp(ratio, floor, 3);
      this.pixelRatio = ratio;
      this.renderer.setPixelRatio(ratio);
      this.renderer.setSize(w, h, false);
      this.renderer.domElement.style.width = w + 'px';
      this.renderer.domElement.style.height = h + 'px';
      this.width = w;
      this.height = h;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      SIM.events.emit('render:resize', { width: w, height: h });
    }

    /**
     * Frame time bookkeeping and automatic quality adaptation (AUTO preset). When the frame rate is
     * too low the governor first sheds the expensive effects that do not affect sharpness — shadow
     * resolution, then draw distance — and only then lowers the render resolution, never below the
     * screen's CSS pixel grid. When there is headroom again it restores them in reverse order.
     */
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
      if (this.autoTimer < 2.5) return;
      this.autoTimer = 0;
      const st = this.settings;
      const setQuiet = (k, v) => {
        st._applyingPreset = true;
        st.set('graphics.' + k, v);
        st._applyingPreset = false;
      };
      const SH = ['off', 'low', 'medium', 'high'];
      if (!this.autoBase) this.autoBase = { shadows: g.shadows, renderDistance: g.renderDistance };
      const base = this.autoBase;
      const minScale = Math.min(1, Math.max(0.6, 1 / this.basePixelRatio()) + 0.05);
      if (this.fpsAvg < 30) {
        const si = SH.indexOf(g.shadows);
        if (si > 0) setQuiet('shadows', SH[si - 1]);
        else if (g.renderDistance > 45) setQuiet('renderDistance', Math.max(45, g.renderDistance - 15));
        else if (this.dynamicScale > minScale) {
          this.dynamicScale = Math.max(minScale, this.dynamicScale - 0.1);
          this.resize();
        }
      } else if (this.fpsAvg > 56) {
        if (this.dynamicScale < 1) {
          this.dynamicScale = Math.min(1, this.dynamicScale + 0.05);
          this.resize();
        } else if (g.renderDistance < base.renderDistance) setQuiet('renderDistance', Math.min(base.renderDistance, g.renderDistance + 10));
        else if (SH.indexOf(g.shadows) < SH.indexOf(base.shadows)) setQuiet('shadows', SH[SH.indexOf(g.shadows) + 1]);
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
