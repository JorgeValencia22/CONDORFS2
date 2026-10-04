/**
 * InputManager — keyboard (remappable, with modifiers), mouse (head look, orbit, zoom, mouse yoke),
 * gamepads and HID joysticks through the Gamepad API (configurable axes), and virtual touch controls.
 *
 * Discrete actions are broadcast as `action` events; continuous controls are applied to the
 * aircraft every frame through `applyToAircraft()`.
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;

  const PREVENT = new Set(['Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'F1', 'F3', 'F4', 'Backspace', 'Slash', 'Quote', 'Home', 'End', 'Backquote']);

  class InputManager {
    constructor(settings) {
      this.settings = settings;
      this.down = new Set();
      this.mods = { shift: false, ctrl: false, alt: false };
      this.enabled = false;        // flight input active
      this.axes = { pitch: 0, roll: 0, yaw: 0 };
      this.keyAxes = { pitch: 0, roll: 0, yaw: 0 };
      this.mouseYoke = { active: false, x: 0, y: 0 };
      this.panelYoke = null;       // {pitch, roll} while dragging the cockpit yoke
      this.virtual = { pitch: 0, roll: 0, yaw: 0, active: false };
      this.gamepad = { connected: false, id: '', axes: [], buttons: [], prevButtons: [] };
      this.listening = null;       // {resolve} for axis detection in the controls screen
      this.camera = null;
      this.rebuildShiftCodes();
      this.bind();
      SIM.events.on('settings:changed', ({ path }) => {
        if (path.startsWith('controls') || path === '*') this.rebuildShiftCodes();
      });
    }

    rebuildShiftCodes() {
      this.shiftCodes = new Set();
      const b = this.settings.data.controls.bindings;
      Object.values(b).forEach((list) => list.forEach((c) => c.shift && this.shiftCodes.add(c.code)));
    }

    isTyping() {
      const el = document.activeElement;
      return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
    }

    bind() {
      window.addEventListener('keydown', (e) => this.onKey(e, true));
      window.addEventListener('keyup', (e) => this.onKey(e, false));
      window.addEventListener('blur', () => {
        this.down.clear();
        this.mods = { shift: false, ctrl: false, alt: false };
        SIM.events.emit('input:blur');
      });
      window.addEventListener('gamepadconnected', (e) => {
        this.gamepad.connected = true;
        this.gamepad.id = e.gamepad.id;
        SIM.events.emit('notify', { text: `CONTROLLER CONNECTED`, level: 'info' });
        SIM.events.emit('input:gamepad', { connected: true, id: e.gamepad.id });
      });
      window.addEventListener('gamepaddisconnected', () => {
        this.gamepad.connected = false;
        SIM.events.emit('input:gamepad', { connected: false });
      });
    }

    onKey(e, pressed) {
      this.mods.shift = e.shiftKey;
      this.mods.ctrl = e.ctrlKey || e.metaKey;
      this.mods.alt = e.altKey;
      if (this.capture && pressed) {
        e.preventDefault();
        const fn = this.capture;
        this.capture = null;
        if (e.code !== 'Escape') fn({ code: e.code, shift: e.shiftKey || undefined, ctrl: e.ctrlKey || undefined, alt: e.altKey || undefined });
        else fn(null);
        return;
      }
      if (this.isTyping()) return;
      if (pressed) this.down.add(e.code);
      else this.down.delete(e.code);
      if (!this.enabled) {
        if (pressed && !e.repeat) SIM.events.emit('menu:key', { code: e.code });
        return;
      }
      if (PREVENT.has(e.code) || (e.ctrlKey && e.code === 'KeyE')) e.preventDefault();
      if (pressed && !e.repeat) {
        const b = this.settings.data.controls.bindings;
        for (const action of SIM.InputActions) {
          if (action.hold) continue;
          const list = b[action.id] || [];
          if (list.some((c) => this.exact(c, e))) SIM.events.emit('action', { id: action.id });
        }
      }
    }

    exact(c, e) {
      return c.code === e.code && !!c.shift === e.shiftKey && !!c.ctrl === (e.ctrlKey || e.metaKey) && !!c.alt === e.altKey;
    }

    /** True while any combo of a hold action is pressed. */
    held(id) {
      const list = this.settings.data.controls.bindings[id] || [];
      for (const c of list) {
        if (!this.down.has(c.code)) continue;
        if (!!c.ctrl !== this.mods.ctrl || !!c.alt !== this.mods.alt) continue;
        if (c.shift && !this.mods.shift) continue;
        if (!c.shift && this.mods.shift && this.shiftCodes.has(c.code)) continue;
        return true;
      }
      return false;
    }

    /** Waits for the next key combo (controls screen remapping). */
    captureKey(fn) {
      this.capture = fn;
    }

    /** Waits until a gamepad axis moves strongly and returns its index. */
    listenAxis() {
      return new Promise((resolve) => {
        const pads = this.pads();
        const pad = pads[0];
        if (!pad) return resolve(-1);
        const base = pad.axes.slice();
        const t0 = performance.now();
        const poll = () => {
          const p = this.pads()[0];
          if (!p) return resolve(-1);
          for (let i = 0; i < p.axes.length; i++) {
            if (Math.abs(p.axes[i] - base[i]) > 0.5) return resolve(i);
          }
          if (performance.now() - t0 > 8000) return resolve(-1);
          requestAnimationFrame(poll);
        };
        poll();
      });
    }

    pads() {
      const list = navigator.getGamepads ? Array.from(navigator.getGamepads()).filter(Boolean) : [];
      return list;
    }

    /* ------------------------------------------------------------------ per frame */

    pollGamepad() {
      const cfg = this.settings.data.controls.gamepad;
      const pad = cfg.enabled ? this.pads()[0] : null;
      const gp = this.gamepad;
      gp.connected = !!pad;
      if (!pad) {
        gp.axes = [];
        gp.buttons = [];
        return null;
      }
      gp.id = pad.id;
      gp.prevButtons = gp.buttons;
      gp.axes = pad.axes.slice();
      gp.buttons = pad.buttons.map((b) => b.value);
      // Discrete buttons (standard mapping)
      const pressed = (i) => gp.buttons[i] > 0.5 && !(gp.prevButtons[i] > 0.5);
      if (this.enabled) {
        const map = { 1: 'flapsDown', 2: 'flapsUp', 3: 'cameraCycle', 8: 'map', 9: 'pause', 10: 'parkingBrake', 11: 'cameraToggle', 14: 'gear', 15: 'autopilot' };
        Object.entries(map).forEach(([i, id]) => pressed(Number(i)) && SIM.events.emit('action', { id }));
      }
      return pad;
    }

    readAxis(def) {
      const cfg = this.settings.data.controls.gamepad;
      if (!def || def.index < 0) return 0;
      const v = this.gamepad.axes[def.index];
      if (v === undefined) return 0;
      return M.deadzone(def.invert ? -v : v, cfg.deadzone);
    }

    /** Mouse yoke: pointer position relative to the 3D view centre. */
    setMouseYoke(x, y) {
      this.mouseYoke.x = M.clamp(x, -1, 1);
      this.mouseYoke.y = M.clamp(y, -1, 1);
    }

    /**
     * Continuous flight controls applied to the aircraft.
     * @param {number} dt
     * @param {Aircraft} ac
     * @param {CameraSystem} camera
     */
    applyToAircraft(dt, ac, camera) {
      const s = this.settings.data;
      const sens = s.sensitivity;
      this.pollGamepad();
      if (!this.enabled) return;
      const rate = 2.4 * s.controls.keyboardRate;
      const center = 4.5;
      const trimMod = this.held('trimModifier');

      const ramp = (cur, neg, pos) => {
        const target = (pos ? 1 : 0) - (neg ? 1 : 0);
        if (target === 0) return M.approach(cur, 0, center * dt);
        if (Math.sign(target) !== Math.sign(cur) && cur !== 0) return M.approach(cur, 0, center * 1.5 * dt);
        return M.approach(cur, target, rate * dt);
      };
      const up = this.held('pitchUp'), dn = this.held('pitchDown');
      const yl = this.held('yawLeft'), yr = this.held('yawRight');
      if (trimMod) {
        if (up) ac.adjustElevatorTrim(1, dt);
        if (dn) ac.adjustElevatorTrim(-1, dt);
        if (yr) ac.adjustRudderTrim(1, dt);
        if (yl) ac.adjustRudderTrim(-1, dt);
        this.keyAxes.pitch = ramp(this.keyAxes.pitch, false, false);
        this.keyAxes.yaw = ramp(this.keyAxes.yaw, false, false);
      } else {
        this.keyAxes.pitch = ramp(this.keyAxes.pitch, dn, up);
        this.keyAxes.yaw = ramp(this.keyAxes.yaw, yl, yr);
      }
      this.keyAxes.roll = ramp(this.keyAxes.roll, this.held('rollLeft'), this.held('rollRight'));
      if (this.held('trimUp')) ac.adjustElevatorTrim(1, dt);
      if (this.held('trimDown')) ac.adjustElevatorTrim(-1, dt);

      // Gamepad / joystick
      const ax = s.controls.gamepad.axes;
      const curve = sens.curve;
      let gPitch = -this.readAxis(ax.pitch), gRoll = this.readAxis(ax.roll), gYaw = this.readAxis(ax.yaw);
      gPitch = M.expo(gPitch, curve);
      gRoll = M.expo(gRoll, curve);
      gYaw = M.expo(gYaw, curve);
      const gp = this.gamepad;
      if (gp.connected) {
        // Standard mapping: triggers adjust throttle, A = brakes, D-pad up/down = trim, shoulders = rudder
        const lt = gp.buttons[6] || 0, rt = gp.buttons[7] || 0;
        if (ax.throttle.index >= 0 && gp.axes[ax.throttle.index] !== undefined) {
          const raw = gp.axes[ax.throttle.index];
          const thr = ((ax.throttle.invert ? -raw : raw) + 1) / 2;
          if (Math.abs(thr - (this._lastThrAxis ?? -1)) > 0.004) {
            ac.setThrottle(thr);
            this._lastThrAxis = thr;
          }
        } else if (rt > 0.05 || lt > 0.05) {
          ac.adjustThrottle((rt - lt) * 0.5 * dt);
        }
        if (gp.buttons[12] > 0.5) ac.adjustElevatorTrim(1, dt);
        if (gp.buttons[13] > 0.5) ac.adjustElevatorTrim(-1, dt);
        if (gp.buttons[4] > 0.5) gYaw = Math.min(gYaw, -gp.buttons[4]);
        if (gp.buttons[5] > 0.5) gYaw = Math.max(gYaw, gp.buttons[5]);
      }

      let pitch = this.keyAxes.pitch + gPitch;
      let roll = this.keyAxes.roll + gRoll;
      let yaw = this.keyAxes.yaw + gYaw;
      if (this.virtual.active) {
        pitch += this.virtual.pitch;
        roll += this.virtual.roll;
      }
      yaw += this.virtual.yaw || 0;
      if (this.panelYoke) {
        pitch += this.panelYoke.pitch;
        roll += this.panelYoke.roll;
      } else if (s.controls.mouseYoke && this.mouseYoke.active) {
        pitch += M.expo(M.deadzone(-this.mouseYoke.y, 0.04), 0.3);
        roll += M.expo(M.deadzone(this.mouseYoke.x, 0.04), 0.3);
      }
      if (s.controls.invertPitch) pitch = -pitch;
      ac.input.pitch = M.clamp(pitch * sens.pitch, -1, 1);
      ac.input.roll = M.clamp(roll * sens.roll, -1, 1);
      ac.input.yaw = M.clamp(yaw * sens.yaw, -1, 1);

      // Brakes
      const both = this.held('brakes') || (gp.connected && gp.buttons[0] > 0.5) || this.virtual.brakes;
      ac.input.brakeL = both || this.held('brakeLeft') ? 1 : 0;
      ac.input.brakeR = both || this.held('brakeRight') ? 1 : 0;

      // Throttle / mixture / prop
      if (this.held('throttleUp')) ac.adjustThrottle(0.45 * dt);
      if (this.held('throttleDown')) ac.adjustThrottle(-0.45 * dt);
      if (this.virtual.throttle !== undefined && this.virtual.active) ac.setThrottle(this.virtual.throttle);
      if (this.held('mixtureRich')) ac.adjustMixture(0.3 * dt);
      if (this.held('mixtureLean')) ac.adjustMixture(-0.3 * dt);
      if (this.held('propUp')) ac.adjustProp(0.4 * dt);
      if (this.held('propDown')) ac.adjustProp(-0.4 * dt);
      ac.setReverse(this.held('reverse'));

      // View keys
      if (camera) {
        const lr = (this.held('lookRight') ? 1 : 0) - (this.held('lookLeft') ? 1 : 0);
        const ud = (this.held('lookUp') ? 1 : 0) - (this.held('lookDown') ? 1 : 0);
        if (camera.mode === 'free') {
          camera.moveFree(this.mods.shift ? 0 : ud, lr, this.mods.shift ? ud : 0, dt);
        } else if (lr || ud) {
          camera.look(lr * 1.6 * dt, -ud * 1.2 * dt);
        }
        if (this.held('zoomIn')) camera.zoom(1 - dt * 1.2);
        if (this.held('zoomOut')) camera.zoom(1 + dt * 1.2);
        // Right stick of a gamepad looks around
        if (gp.connected && ax.yaw.index !== 3 && gp.axes.length > 3) {
          const lx = M.deadzone(gp.axes[3] || 0, 0.2);
          if (lx) camera.look(0, lx * 1.2 * dt);
        }
      }
    }

    /** Throws away held keys when leaving the flight (prevents stuck controls). */
    reset() {
      this.down.clear();
      this.keyAxes = { pitch: 0, roll: 0, yaw: 0 };
      this.panelYoke = null;
    }
  }

  SIM.InputManager = InputManager;
})(window.SIM);
