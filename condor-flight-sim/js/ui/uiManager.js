/**
 * UIManager — flight user interface orchestration: HUD, cockpit panel, side panel, map, ATC
 * window, debug overlay, notifications, pause/results/crash/mission overlays, mobile controls,
 * windshield rain and pointer interaction with the 3D view.
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;
  const { h, icon } = SIM.UI;

  /** Rain drops running over the windshield in cockpit view. */
  class WindshieldRain {
    constructor() {
      this.canvas = h('canvas.windshield-rain', { 'aria-hidden': 'true' });
      this.drops = [];
      this.resize();
      window.addEventListener('resize', () => this.resize());
    }
    resize() {
      this.w = window.innerWidth;
      this.h = window.innerHeight;
      this.ctx = SIM.UI.fitCanvas(this.canvas, this.w, this.h, 0.6);
    }
    update(dt, intensity, airspeed, active, panelFrac) {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.w, this.h);
      this.canvas.style.display = active || this.drops.length ? 'block' : 'none';
      const visibleH = this.h * (1 - panelFrac);
      if (active) {
        const spawn = intensity * 70 * dt * (1 + airspeed / 40);
        for (let i = 0; i < spawn; i++) {
          if (this.drops.length > 260) break;
          this.drops.push({ x: Math.random() * this.w, y: Math.random() * visibleH, r: 1 + Math.random() * 2.6, life: 1.5 + Math.random() * 3 });
        }
      }
      const flow = airspeed / 25; // drops are pushed up and outward by the airflow
      ctx.lineCap = 'round';
      for (let i = this.drops.length - 1; i >= 0; i--) {
        const d = this.drops[i];
        d.life -= dt;
        const outward = (d.x - this.w / 2) / this.w;
        if (flow > 0.6) {
          d.y -= flow * 90 * dt * (0.6 + d.r * 0.2);
          d.x += outward * flow * 60 * dt;
        } else {
          d.y += 10 * dt * d.r;
        }
        if (d.life <= 0 || d.y < -10 || d.y > visibleH) {
          this.drops.splice(i, 1);
          continue;
        }
        const a = Math.min(1, d.life) * 0.5;
        ctx.strokeStyle = `rgba(210,225,240,${a})`;
        ctx.lineWidth = d.r;
        ctx.beginPath();
        ctx.moveTo(d.x, d.y);
        ctx.lineTo(d.x - outward * flow * 4, d.y + (flow > 0.6 ? flow * 3 + 1 : 0.5));
        ctx.stroke();
      }
    }
  }

  class UIManager {
    constructor(app) {
      this.app = app;
      this.root = document.getElementById('flight-ui');
      this.viewport = document.getElementById('viewport');
      this.notifications = new SIM.Notifications();
      this.loading = new SIM.LoadingScreen();
      document.getElementById('app').append(this.loading.el);
      this.overlayLayer = h('div.overlay-layer');
      this.bindViewport();
    }

    /* ------------------------------------------------------------------ flight setup */

    setupFlight(session) {
      this.teardown();
      this.session = session;
      const r = this.root;
      r.innerHTML = '';
      this.hud = new SIM.Hud(session);
      this.panel = new SIM.CockpitPanel(session);
      this.side = new SIM.SidePanel(session);
      this.atcWin = new SIM.ATCWindow(session);
      this.map = new SIM.MapOverlay(this);
      this.debug = new SIM.DebugOverlay(session);
      this.rain = new WindshieldRain();
      this.camLabel = h('div.cam-label');
      this.fps = h('div.fps-counter.mono');
      this.noGl = !this.app.render || !this.app.render.available ? h('div.nogl-banner', icon('warning'), h('span', 'Instrument-only mode: WebGL is unavailable, the 3D view is disabled. All systems, instruments, map and ATC remain fully functional.')) : null;
      this.flags = { hud: this.app.settings.data.gameplay.showHud, side: false, atc: false, map: false, debug: false };
      r.append(this.rain.canvas, this.hud.el, this.camLabel, this.fps, this.notifications.el, this.side.el, this.atcWin.el, this.debug.el, this.map.root, this.panel.root, this.overlayLayer);
      if (this.noGl) r.append(this.noGl);
      if (session.mission) {
        this.missionHud = new SIM.Overlays.MissionHud(session.mission);
        r.append(this.missionHud.el);
      }
      if (SIM.MobileControls.isTouch()) {
        this.mobile = new SIM.MobileControls(this.app.input, session.aircraft);
        r.append(this.mobile.el);
        r.classList.add('touch');
      }
      this.applyFlags();
      this.panel.setVisible(!this.noGl || true);
      this.bindEvents(session);
      r.classList.add('visible');
      this.sideTimer = 0;
      this.layout();
      window.addEventListener('resize', (this._onResize = () => this.layout()));
    }

    teardown() {
      if (this._onResize) window.removeEventListener('resize', this._onResize);
      if (this.debug) this.debug.dispose();
      this.overlayLayer.innerHTML = '';
      this.notifications.clear();
      this.root.classList.remove('visible', 'touch');
      this.root.innerHTML = '';
      this.session = null;
      this.mobile = null;
      this.missionHud = null;
      this.results = null;
    }

    layout() {
      if (!this.panel) return;
      const frac = this.panel.fit();
      if (this.session && this.session.camera) this.session.camera.panelFraction = frac;
      this.root.style.setProperty('--panel-h', `${frac * 100}vh`);
    }

    applyFlags() {
      const f = this.flags;
      const cockpit = !this.session.camera || this.session.camera.isCockpit;
      const panelOn = cockpit && this.panelWanted !== false;
      this.panel.setVisible(panelOn);
      this.hud.el.classList.toggle('show', f.hud && (!cockpit || !panelOn));
      this.side.el.classList.toggle('open', f.side);
      this.atcWin.el.classList.toggle('open', f.atc);
      this.map.root.classList.toggle('open', f.map);
      this.debug.el.classList.toggle('open', f.debug);
      this.root.classList.toggle('panel-on', panelOn);
      this.layout();
    }

    toggleMap(v) {
      this.flags.map = v === undefined ? !this.flags.map : v;
      if (this.flags.map) this.map.open();
      this.applyFlags();
    }

    /* ------------------------------------------------------------------ events */

    bindEvents(session) {
      const sc = session.scope;
      const n = (text, level, dur) => this.notifications.show(text, level, dur);
      const audio = this.app.audio;
      sc.on('notify', (e) => n(e.text, e.level || 'info'));
      sc.on('system:flaps', (e) => n(`FLAPS ${e.label}`, 'info'));
      sc.on('system:gear', (e) => n(e.down ? 'GEAR DOWN' : 'GEAR UP', 'info'));
      sc.on('system:gearLocked', (e) => {
        n(e.down ? 'GEAR DOWN — 3 GREEN' : 'GEAR UP AND LOCKED', 'success');
        audio.thump(0.25, 80);
      });
      sc.on('system:switch', (e) => {
        if (['parking', 'speedbrake', 'fuelSelector'].includes(e.name) || e.name === 'land') n(e.label, 'info', 1600);
      });
      sc.on('warning', (e) => {
        if (!e.active) return;
        const map = { stall: ['STALL WARNING', 'danger'], lowFuel: ['LOW FUEL', 'warn'], overspeed: ['OVERSPEED', 'danger'], gear: ['GEAR NOT DOWN', 'danger'], flapOverspeed: ['FLAP OVERSPEED', 'warn'] };
        if (map[e.id] && session.state.isFlying && !session.aircraft.onGround) {
          n(...map[e.id]);
          if (e.id === 'lowFuel') audio.beep(900, 0.18, 0.05, 2);
        }
      });
      sc.on('failure', (e) => {
        n(e.label, 'danger', 5000);
        audio.beep(700, 0.25, 0.08, 3, 0.1);
      });
      sc.on('engine:stopped', (e) => {
        if (session.state.isFlying && session.aircraft.engines.length && !session.aircraft.procedure) {
          n(e.reason === 'failure' ? 'ENGINE FAILURE' : e.reason === 'fuel' ? 'ENGINE STOPPED — FUEL STARVATION' : `ENGINE STOPPED${e.reason ? ' — ' + e.reason.toUpperCase() : ''}`, 'danger', 4500);
        }
      });
      sc.on('engine:started', (e) => n(`ENGINE ${session.aircraft.engines.length > 1 ? e.index + 1 + ' ' : ''}STARTED`, 'success'));
      sc.on('engine:damaged', () => n('ENGINE DAMAGED', 'danger', 4000));
      sc.on('autopilot', (e) => {
        if (e.engaged === false && e.reason) {
          n(e.reason === 'override' ? 'AUTOPILOT DISCONNECT — OVERRIDE' : 'AUTOPILOT DISCONNECT', 'warn');
          audio.apDisconnect(session.aircraft.isJet);
        } else if (e.engaged && e.reason === undefined && e.at === undefined) {
          audio.beep(1200, 0.08, 0.04);
        }
      });
      sc.on('camera:mode', (e) => {
        this.camLabel.textContent = e.label;
        this.camLabel.classList.remove('show');
        void this.camLabel.offsetWidth;
        this.camLabel.classList.add('show');
        this.applyFlags();
      });
      sc.on('atc:message', (m) => {
        audio.radioSquelch();
        if (m.from !== 'PILOT') audio.speak(m.speech, m.from);
        if (this.app.settings.data.accessibility.subtitles && !this.flags.atc) n(`${m.from === 'PILOT' ? 'YOU' : m.facility}: ${m.text}`, m.from === 'PILOT' ? 'info' : 'radio', Math.min(9000, 2500 + m.text.length * 45));
      });
      sc.on('aircraft:touchdown', (td) => n(`TOUCHDOWN ${Math.round(td.vsFpm)} FPM · ${td.gLoad.toFixed(2)} G`, Math.abs(td.vsFpm) > 400 ? 'warn' : 'success', 3500));
      sc.on('aircraft:crash', (e) => {
        audio.crash();
        this.showCrash(e.reason);
      });
      sc.on('mission:objective', (e) => n(`OBJECTIVE COMPLETE — ${e.label.toUpperCase()}`, 'success', 3200));
      sc.on('mission:complete', (e) => this.showOverlay(new SIM.Overlays.MissionResult(this, e).el));
      sc.on('flight:complete', () => this.showResults(false));
      sc.on('weather:lightning', (e) => audio.thunder(e.distance));
    }

    /** UI-level actions (keyboard / gamepad / buttons). */
    handleAction(id) {
      const s = this.session;
      if (!s) return;
      switch (id) {
        case 'pause':
          if (this.flags.map) return this.toggleMap(false);
          if (this.results) return;
          if (s.state.state === 'PAUSED') this.resume();
          else this.pause();
          break;
        case 'map':
          this.toggleMap();
          break;
        case 'hud':
          this.flags.hud = !this.flags.hud;
          this.app.settings.set('gameplay.showHud', this.flags.hud);
          if (s.camera && s.camera.isCockpit && this.panelWanted !== false) this.panelWanted = false;
          this.applyFlags();
          break;
        case 'panel':
          this.panelWanted = this.panelWanted === false;
          if (s.camera && !s.camera.isCockpit) s.camera.setMode('cockpit');
          this.applyFlags();
          break;
        case 'sidePanel':
          this.flags.side = !this.flags.side;
          if (this.flags.side) this.side.update(true);
          this.applyFlags();
          break;
        case 'atc':
          this.flags.atc = !this.flags.atc;
          this.atcWin.lastKey = '';
          this.applyFlags();
          break;
        case 'debug':
          this.flags.debug = !this.flags.debug;
          this.applyFlags();
          break;
        default:
          return false;
      }
      return true;
    }

    pause() {
      const s = this.session;
      if (!s || s.state.state === 'CRASH') return;
      s.state.pause();
      this.pauseMenu = new SIM.Overlays.PauseMenu(this);
      this.showOverlay(this.pauseMenu.el);
    }

    resume() {
      const s = this.session;
      if (!s) return;
      this.clearOverlay();
      this.pauseMenu = null;
      s.state.resume();
      this.app.input.reset();
    }

    showOverlay(el) {
      this.overlayLayer.innerHTML = '';
      this.overlayLayer.append(el);
      this.overlayLayer.classList.add('open');
    }

    clearOverlay() {
      this.overlayLayer.innerHTML = '';
      this.overlayLayer.classList.remove('open');
    }

    showCrash(reason) {
      setTimeout(() => {
        if (!this.session) return;
        this.showOverlay(new SIM.Overlays.CrashOverlay(this, reason).el);
      }, 1400);
    }

    showResults(crashed) {
      if (!this.session) return;
      this.results = new SIM.Overlays.ResultsScreen(this, null, { crashed });
      this.showOverlay(this.results.el);
      if (!crashed) this.session.state.pause();
    }

    closeResults() {
      this.results = null;
      this.clearOverlay();
      if (this.session.state.state === 'PAUSED') this.session.state.resume();
    }

    /* ------------------------------------------------------------------ pointer on 3D view */

    bindViewport() {
      const vp = this.viewport;
      let drag = null;
      vp.addEventListener('contextmenu', (e) => e.preventDefault());
      vp.addEventListener('pointerdown', (e) => {
        if (!this.session || !this.session.camera) return;
        this.app.audio.unlock();
        drag = { x: e.clientX, y: e.clientY, button: e.button };
        vp.setPointerCapture(e.pointerId);
      });
      vp.addEventListener('pointermove', (e) => {
        const s = this.session;
        if (!s) return;
        const input = this.app.input;
        input.mouseYoke.active = true;
        input.setMouseYoke((e.clientX / window.innerWidth) * 2 - 1, (e.clientY / (window.innerHeight * (1 - (s.camera ? s.camera.panelFraction : 0)))) * 2 - 1);
        if (!drag || !s.camera) return;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        drag.x = e.clientX;
        drag.y = e.clientY;
        const cockpit = s.camera.isCockpit;
        if (drag.button === 2 || (!cockpit && drag.button === 0) || (cockpit && drag.button === 0 && !this.app.settings.data.controls.mouseYoke)) {
          s.camera.look(dx * 0.005, dy * 0.005);
        }
      });
      const end = () => (drag = null);
      vp.addEventListener('pointerup', end);
      vp.addEventListener('pointercancel', end);
      vp.addEventListener('pointerleave', () => (this.app.input.mouseYoke.active = false));
      vp.addEventListener('wheel', (e) => {
        if (!this.session || !this.session.camera) return;
        e.preventDefault();
        this.session.camera.zoom(e.deltaY > 0 ? 1.1 : 1 / 1.1);
      }, { passive: false });
      vp.addEventListener('dblclick', () => this.session && this.session.camera && this.session.camera.resetView());
    }

    /* ------------------------------------------------------------------ per frame */

    update(dt, frameInfo) {
      const s = this.session;
      if (!s) return;
      if (this.hud.el.classList.contains('show')) this.hud.update();
      this.panel.update(dt);
      this.sideTimer -= dt;
      if (this.flags.side && this.sideTimer <= 0) {
        this.sideTimer = 0.25;
        this.side.update();
      }
      if (this.flags.atc) this.atcWin.update(dt);
      if (this.flags.map) this.map.update();
      if (this.flags.debug) {
        this.debug.update(dt, frameInfo);
        if (frameInfo.pos) this.debug.updateVectors(frameInfo.pos, frameInfo.quat);
      }
      if (this.missionHud) this.missionHud.update();
      if (this.mobile) this.mobile.update();
      const showFps = this.app.settings.data.graphics.showFps;
      this.fps.style.display = showFps ? 'block' : 'none';
      if (showFps) this.fps.textContent = `${Math.round(this.app.render && this.app.render.available ? this.app.render.fpsAvg : 1 / Math.max(dt, 0.001))} FPS`;
      // Windshield rain (cockpit view, below the cloud base)
      const w = s.world.weather;
      const cockpit = s.camera && s.camera.isCockpit;
      const raining = cockpit && w.p.precipitation > 0.05 && s.aircraft.fm.pos.y < w.cloudBase + 200 && s.state.state !== 'PAUSED';
      this.rain.update(dt, w.p.precipitation, s.aircraft.fm.ias, raining, s.camera ? s.camera.panelFraction : 0);
    }
  }

  SIM.UIManager = UIManager;
})(window.SIM);
