/**
 * App — application bootstrap and main loop. Owns settings, renderer, audio, input, UI, menu and
 * the active FlightSession. Handles flight start/restart/exit, pause-on-blur and accessibility.
 */
(function (SIM) {
  'use strict';

  class App {
    constructor() {
      SIM.app = this;
      this.session = null;
      this.lastTime = performance.now();
      this.loading = false;
    }

    async init(bootStatus) {
      const status = (t) => bootStatus && bootStatus(t);
      this.settings = new SIM.SettingsManager();
      this.applyAccessibility();
      SIM.events.on('settings:changed', ({ path }) => {
        if (path.startsWith('accessibility') || path === '*') this.applyAccessibility();
      });

      status('Initialising graphics…');
      this.render = new SIM.RenderSystem(document.getElementById('viewport'), this.settings);
      if (this.settings.data.graphics.preset === 'auto') {
        const p = this.settings.detectGraphicsPreset(this.render.gpuName);
        this.settings.applyGraphicsPreset(p);
        this.settings.set('graphics.preset', 'auto', { silent: true });
      }
      this.audio = new SIM.AudioManager(this.settings);
      this.input = new SIM.InputManager(this.settings);
      this.ui = new SIM.UIManager(this);

      status('Rendering aircraft…');
      await SIM.ThumbnailRenderer.renderAll(SIM.AircraftOrder);

      this.menu = new SIM.MainMenu(this);
      document.getElementById('menu-root').append(this.menu.el);

      SIM.events.on('action', ({ id }) => {
        if (this.session && this.session.ready) this.session.handleAction(id);
      });
      const unlock = () => this.audio.unlock();
      window.addEventListener('pointerdown', unlock, { passive: true });
      window.addEventListener('keydown', unlock);
      window.addEventListener('blur', () => {
        if (this.session && this.session.ready && this.settings.data.gameplay.pauseOnBlur && this.session.state.isFlying) this.ui.pause();
      });
      document.addEventListener('visibilitychange', () => {
        if (document.hidden && this.session && this.session.ready && this.session.state.isFlying) this.ui.pause();
      });

      if (!this.render.available) {
        SIM.events.emit('notify', { text: 'WebGL unavailable: instrument-only mode', level: 'warn' });
        console.warn('[App] 3D disabled:', this.render.error);
      }
      this.settings.data.meta.firstRun = false;
      this.settings.save();
      this.menu.open();
      requestAnimationFrame((t) => this.loop(t));
    }

    applyAccessibility() {
      const a = this.settings.data.accessibility;
      const root = document.documentElement;
      root.style.setProperty('--ui-scale', a.uiScale);
      root.classList.toggle('large-text', !!a.largeText);
      root.classList.toggle('high-contrast', !!a.highContrast);
      root.classList.toggle('reduce-motion', !!a.reduceMotion);
    }

    loop(t) {
      const dt = Math.min(0.25, (t - this.lastTime) / 1000);
      this.lastTime = t;
      try {
        const s = this.session;
        if (s && s.ready) {
          s.frame(dt);
          if (this.render.available) {
            this.render.render();
            this.render.trackFrame(dt);
          }
        }
      } catch (e) {
        SIM.ErrorHandler.report(e, 'frame');
      }
      requestAnimationFrame((tt) => this.loop(tt));
    }

    async startFlight(config, opts = {}) {
      if (this.loading) return;
      this.loading = true;
      this.audio.unlock();
      if (this.session) this.endSession();
      this.menu.close();
      const ac = SIM.AircraftData[config.aircraft];
      const ap = SIM.AirportDB[config.airport];
      this.ui.loading.show(opts.mission ? `Mission · ${opts.mission.title}` : ac.name, `${ap ? `${ap.icao} ${ap.name}` : ''} · ${SIM.WeatherPresets[config.weather].label} · ${SIM.UI.Fmt.clock(config.time)}`);
      document.body.classList.add('in-flight');
      const session = new SIM.FlightSession(this, config, opts);
      this.session = session;
      try {
        await session.load((info) => this.ui.loading.set(info));
        this.ui.loading.hide();
        this.input.enabled = true;
        this.input.reset();
        this.lastTime = performance.now();
      } catch (e) {
        console.error(e);
        this.ui.loading.hide();
        this.endSession();
        document.body.classList.remove('in-flight');
        SIM.ErrorHandler.show('The flight could not be started', 'An error occurred while preparing the world or the aircraft. Try lower graphics settings or another airport.', {
          detail: e.stack || String(e),
          actions: [{ label: 'Return to menu', fn: () => this.menu.open() }],
        });
      } finally {
        this.loading = false;
      }
    }

    restartFlight() {
      if (!this.session || !this.session.ready) return;
      this.session.restart();
    }

    endSession() {
      if (!this.session) return;
      try {
        this.session.dispose();
      } catch (e) {
        console.warn('[App] dispose error', e);
      }
      this.session = null;
      this.ui.teardown();
      this.input.enabled = false;
      this.input.reset();
      if (this.render.available) {
        // remove leftovers, keep the camera
        const scene = this.render.scene;
        scene.children.filter((o) => o !== this.render.camera).forEach((o) => scene.remove(o));
        this.render.camera.clearViewOffset();
      }
    }

    returnToMenu() {
      this.endSession();
      document.body.classList.remove('in-flight');
      this.menu.open();
    }
  }

  SIM.App = App;
})(window.SIM);
