/**
 * MobileControls — virtual joystick (pitch/roll), throttle slider, rudder buttons and quick actions
 * for touch devices. Feeds InputManager.virtual.
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;
  const { h } = SIM.UI;

  class MobileControls {
    constructor(input, aircraft) {
      this.input = input;
      this.ac = aircraft;
      this.el = h('div.mobile-controls');
      // joystick
      this.knob = h('div.mc-knob');
      this.stick = h('div.mc-stick', { 'aria-label': 'Virtual flight stick' }, this.knob);
      // throttle
      this.thrFill = h('div.mc-thr-fill');
      this.thr = h('div.mc-throttle', { 'aria-label': 'Throttle' }, this.thrFill, h('span', 'THR'));
      const btn = (label, fn, hold) => {
        const b = h('button.mc-btn', { type: 'button' }, label);
        if (hold) {
          b.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            fn(true);
          });
          ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => b.addEventListener(ev, () => fn(false)));
        } else b.addEventListener('click', fn);
        return b;
      };
      const v = input.virtual;
      const act = (id) => () => SIM.events.emit('action', { id });
      this.el.append(
        this.stick,
        h('div.mc-right',
          this.thr,
          h('div.mc-grid',
            btn('◀ RUD', (on) => (v.yaw = on ? -1 : 0), true),
            btn('RUD ▶', (on) => (v.yaw = on ? 1 : 0), true),
            btn('BRAKE', (on) => (v.brakes = on), true),
            btn('FLAPS ▼', act('flapsDown')),
            btn('FLAPS ▲', act('flapsUp')),
            btn('GEAR', act('gear')),
            btn('VIEW', act('cameraCycle')),
            btn('START', act('autoStart')),
            btn('II', act('pause')))));
      this.bindStick();
      this.bindThrottle();
    }

    bindStick() {
      const v = this.input.virtual;
      let id = null;
      const move = (e) => {
        const r = this.stick.getBoundingClientRect();
        const x = M.clamp((e.clientX - r.left - r.width / 2) / (r.width / 2), -1, 1);
        const y = M.clamp((e.clientY - r.top - r.height / 2) / (r.height / 2), -1, 1);
        v.roll = x;
        v.pitch = y; // pull down = nose up
        this.knob.style.transform = `translate(${x * 38}px, ${y * 38}px)`;
      };
      this.stick.addEventListener('pointerdown', (e) => {
        id = e.pointerId;
        this.stick.setPointerCapture(id);
        v.active = true;
        move(e);
      });
      this.stick.addEventListener('pointermove', (e) => e.pointerId === id && move(e));
      const end = () => {
        id = null;
        v.pitch = 0;
        v.roll = 0;
        this.knob.style.transform = '';
      };
      this.stick.addEventListener('pointerup', end);
      this.stick.addEventListener('pointercancel', end);
    }

    bindThrottle() {
      const v = this.input.virtual;
      const set = (e) => {
        const r = this.thr.getBoundingClientRect();
        v.throttle = M.clamp(1 - (e.clientY - r.top) / r.height, 0, 1);
        v.active = true;
      };
      this.thr.addEventListener('pointerdown', (e) => {
        this.thr.setPointerCapture(e.pointerId);
        set(e);
      });
      this.thr.addEventListener('pointermove', (e) => e.buttons && set(e));
    }

    update() {
      const t = this.input.virtual.throttle ?? this.ac.engines[0].throttle;
      this.thrFill.style.height = `${t * 100}%`;
    }

    static isTouch() {
      return 'ontouchstart' in window || navigator.maxTouchPoints > 1;
    }
  }

  SIM.MobileControls = MobileControls;
})(window.SIM);
