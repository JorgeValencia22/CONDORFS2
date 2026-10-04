/**
 * Interactive cockpit widgets. Every widget reads its state from the simulation through a getter
 * and writes through a setter — nothing here is decorative.
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;
  const { h } = SIM.UI;

  const sound = () => SIM.app && SIM.app.audio;

  /** Rocker switch. */
  class Switch {
    constructor(label, get, toggle, opts = {}) {
      this.get = get;
      this.el = h('button.cw-switch', { type: 'button', title: opts.title || label, 'aria-label': label, 'aria-pressed': 'false', onclick: () => {
        toggle();
        sound() && sound().click();
      } },
      h('span.cw-switch-label', label), h('span.cw-rocker', h('span.cw-rocker-on', opts.onText || 'ON'), h('span.cw-rocker-off', opts.offText || 'OFF')));
      if (opts.color) this.el.style.setProperty('--sw-color', opts.color);
      if (opts.wide) this.el.classList.add('wide');
    }
    update() {
      const on = !!this.get();
      if (on !== this._on) {
        this._on = on;
        this.el.classList.toggle('on', on);
        this.el.setAttribute('aria-pressed', String(on));
      }
    }
  }

  /** Rotary knob: click left/right half or use the mouse wheel. Shift = coarse. */
  class Knob {
    constructor(label, onStep, opts = {}) {
      this.onStep = onStep;
      this.el = h('div.cw-knob', { role: 'spinbutton', tabIndex: 0, title: `${label}: click left/right or scroll (Shift = coarse)`, 'aria-label': label },
        h('span.cw-knob-cap', h('span.cw-knob-mark')), opts.noLabel ? null : h('span.cw-knob-label', label));
      if (opts.small) this.el.classList.add('small');
      this.angle = 0;
      const step = (dir, coarse) => {
        this.onStep(dir, coarse);
        this.angle += dir * 15;
        this.el.querySelector('.cw-knob-cap').style.transform = `rotate(${this.angle}deg)`;
        sound() && sound().uiTick();
      };
      this.el.addEventListener('click', (e) => {
        const r = this.el.querySelector('.cw-knob-cap').getBoundingClientRect();
        step(e.clientX < r.left + r.width / 2 ? -1 : 1, e.shiftKey);
      });
      this.el.addEventListener('wheel', (e) => {
        e.preventDefault();
        step(e.deltaY < 0 ? 1 : -1, e.shiftKey);
      }, { passive: false });
      this.el.addEventListener('keydown', (e) => {
        if (e.code === 'ArrowUp' || e.code === 'ArrowRight') {
          e.preventDefault();
          step(1, e.shiftKey);
        }
        if (e.code === 'ArrowDown' || e.code === 'ArrowLeft') {
          e.preventDefault();
          step(-1, e.shiftKey);
        }
      });
    }
    update() {}
  }

  /** Vertical lever / push-pull control (throttle, mixture, prop, speed brake). Drag, wheel or click. */
  class Lever {
    constructor(label, get, set, opts = {}) {
      this.get = get;
      this.set = set;
      this.handle = h('div.cw-lever-handle', h('span.cw-lever-knob'));
      this.track = h('div.cw-lever-track', this.handle, opts.marks ? h('div.cw-lever-marks', opts.marks.map((m) => h('span', { style: { bottom: m.v * 100 + '%' } }, m.label))) : null);
      this.value = h('span.cw-lever-value.mono');
      this.el = h('div.cw-lever', { title: `${label}: drag, scroll or click`, role: 'slider', tabIndex: 0, 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': 100 }, this.track, h('span.cw-lever-label', label), this.value);
      this.el.style.setProperty('--knob', opts.color || '#1d1f22');
      if (opts.tall) this.el.classList.add('tall');
      this.format = opts.format || ((v) => `${Math.round(v * 100)}%`);
      let dragging = false;
      const fromEvent = (e) => {
        const r = this.track.getBoundingClientRect();
        return M.clamp(1 - (e.clientY - r.top) / r.height, 0, 1);
      };
      this.track.addEventListener('pointerdown', (e) => {
        dragging = true;
        this.track.setPointerCapture(e.pointerId);
        this.set(fromEvent(e));
      });
      this.track.addEventListener('pointermove', (e) => dragging && this.set(fromEvent(e)));
      this.track.addEventListener('pointerup', () => (dragging = false));
      this.el.addEventListener('wheel', (e) => {
        e.preventDefault();
        this.set(M.clamp(this.get() + (e.deltaY < 0 ? 0.04 : -0.04), 0, 1));
      }, { passive: false });
      this.el.addEventListener('keydown', (e) => {
        if (e.code === 'ArrowUp') this.set(M.clamp(this.get() + 0.05, 0, 1));
        if (e.code === 'ArrowDown') this.set(M.clamp(this.get() - 0.05, 0, 1));
      });
    }
    update() {
      const v = this.get();
      if (Math.abs(v - (this._v ?? -1)) < 0.002) return;
      this._v = v;
      this.handle.style.bottom = `calc(${v * 100}% - 14px)`;
      this.value.textContent = this.format(v);
      this.el.setAttribute('aria-valuenow', Math.round(v * 100));
    }
  }

  /** Multi-position selector (flaps, fuel selector, ignition, etc.). */
  class Selector {
    /**
     * @param {string} label
     * @param {string[]} options
     * @param {Function} getIndex
     * @param {Function} setIndex
     * @param {object} opts {kind:'flap'|'rotary', hold:{index, onDown, onUp}, indicator: () => fraction}
     */
    constructor(label, options, getIndex, setIndex, opts = {}) {
      this.options = options;
      this.getIndex = getIndex;
      this.setIndex = setIndex;
      this.opts = opts;
      const kind = opts.kind || 'rotary';
      this.el = h(`div.cw-selector.${kind}`, { title: label, 'aria-label': label, role: 'radiogroup' });
      this.buttons = options.map((o, i) => {
        const b = h('button.cw-sel-opt', { type: 'button', role: 'radio', 'aria-label': `${label} ${o}` }, o);
        if (opts.hold && opts.hold.index === i) {
          b.addEventListener('pointerdown', () => {
            this.setIndex(i);
            opts.hold.onDown();
            sound() && sound().click();
          });
          const up = () => opts.hold.onUp();
          b.addEventListener('pointerup', up);
          b.addEventListener('pointerleave', up);
        } else {
          b.addEventListener('click', () => {
            this.setIndex(i);
            sound() && sound().click(1.3);
          });
        }
        return b;
      });
      if (kind === 'rotary') {
        this.dial = h('div.cw-rotary', h('span.cw-rotary-pointer'));
        this.dial.addEventListener('click', (e) => {
          e.preventDefault();
          const i = this.getIndex();
          this.setIndex((i + 1) % options.length);
          sound() && sound().click(1.3);
        });
        this.dial.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          const i = this.getIndex();
          this.setIndex((i - 1 + options.length) % options.length);
        });
        this.el.append(this.dial, h('div.cw-sel-opts', this.buttons));
      } else {
        this.indicator = h('div.cw-flap-ind', h('span.cw-flap-needle'));
        this.el.append(h('div.cw-flap-slot', this.buttons.slice()), this.indicator);
      }
      this.el.append(h('span.cw-sel-label', label));
    }
    update() {
      const i = this.getIndex();
      if (i !== this._i) {
        this._i = i;
        this.buttons.forEach((b, k) => {
          b.classList.toggle('active', k === i);
          b.setAttribute('aria-checked', String(k === i));
        });
        if (this.dial) {
          const n = this.options.length;
          const span = this.opts.span || 240;
          const ang = -span / 2 + (n > 1 ? (span * i) / (n - 1) : 0);
          this.dial.querySelector('.cw-rotary-pointer').style.transform = `rotate(${ang}deg)`;
        }
      }
      if (this.indicator && this.opts.indicator) {
        this.indicator.querySelector('.cw-flap-needle').style.top = `${M.clamp(this.opts.indicator(), 0, 1) * 100}%`;
      }
    }
  }

  /** Trim wheel with position indicator. Drag vertically or scroll. */
  class TrimWheel {
    constructor(label, get, adjust) {
      this.get = get;
      this.wheel = h('div.cw-trim-wheel', h('div.cw-trim-ridges'));
      this.ind = h('div.cw-trim-ind', h('span.cw-trim-mark'), h('span.cw-trim-label.up', 'NOSE UP'), h('span.cw-trim-label.dn', 'DN'));
      this.el = h('div.cw-trim', { title: `${label}: drag or scroll`, 'aria-label': label }, this.wheel, this.ind, h('span.cw-lever-label', label));
      let last = null;
      this.wheel.addEventListener('pointerdown', (e) => {
        last = e.clientY;
        this.wheel.setPointerCapture(e.pointerId);
      });
      this.wheel.addEventListener('pointermove', (e) => {
        if (last == null) return;
        adjust((last - e.clientY) * 0.006);
        last = e.clientY;
      });
      this.wheel.addEventListener('pointerup', () => (last = null));
      this.el.addEventListener('wheel', (e) => {
        e.preventDefault();
        adjust(e.deltaY < 0 ? 0.03 : -0.03);
      }, { passive: false });
    }
    update() {
      const v = this.get();
      this.ind.querySelector('.cw-trim-mark').style.top = `${(1 - (v + 1) / 2) * 100}%`;
      this.wheel.querySelector('.cw-trim-ridges').style.backgroundPositionY = `${v * 60}px`;
    }
  }

  /** Push/pull toggle knob (carb heat, parking brake). */
  class PullKnob {
    constructor(label, get, toggle, opts = {}) {
      this.get = get;
      this.el = h('button.cw-pull', { type: 'button', title: label, 'aria-label': label, onclick: () => {
        toggle();
        sound() && sound().click(1.4);
      } }, h('span.cw-pull-knob'), h('span.cw-lever-label', label));
      if (opts.color) this.el.style.setProperty('--knob', opts.color);
    }
    update() {
      const on = !!this.get();
      if (on !== this._on) {
        this._on = on;
        this.el.classList.toggle('pulled', on);
        this.el.setAttribute('aria-pressed', String(on));
      }
    }
  }

  /**
   * Yoke: drag to deflect elevator/aileron (spring-centred). Double click toggles mouse-yoke mode.
   */
  class Yoke {
    constructor(input, getControls, opts = {}) {
      this.input = input;
      this.getControls = getControls;
      const svg = opts.airliner
        ? '<svg viewBox="0 0 200 120"><path d="M40 30 Q40 15 55 15 L80 15 L88 30 L112 30 L120 15 L145 15 Q160 15 160 30 L160 70 Q160 90 140 90 L125 90 L120 70 L80 70 L75 90 L60 90 Q40 90 40 70 Z" fill="#26282c" stroke="#55585e" stroke-width="3"/><rect x="92" y="68" width="16" height="50" fill="#1d1f22"/><circle cx="100" cy="50" r="10" fill="#3a3d42"/></svg>'
        : '<svg viewBox="0 0 200 120"><path d="M30 40 Q30 18 52 18 L70 18 Q78 18 80 26 L84 40 L116 40 L120 26 Q122 18 130 18 L148 18 Q170 18 170 40 L170 52 Q170 64 158 64 L150 64 L150 36 Q150 30 144 30 L134 30 L128 56 Q126 64 118 64 L82 64 Q74 64 72 56 L66 30 L56 30 Q50 30 50 36 L50 64 L42 64 Q30 64 30 52 Z" fill="#26282c" stroke="#5a5d63" stroke-width="3"/><rect x="92" y="62" width="16" height="56" fill="#1a1b1e"/><rect x="88" y="44" width="24" height="10" rx="3" fill="#7a2a24"/></svg>';
      this.inner = h('div.cw-yoke-inner', { html: svg });
      this.el = h('div.cw-yoke', { title: 'Yoke: drag to fly, double-click toggles MOUSE YOKE mode', 'aria-label': 'Control yoke' }, this.inner, (this.mode = h('span.cw-yoke-mode', 'MOUSE YOKE')));
      let start = null;
      this.el.addEventListener('pointerdown', (e) => {
        start = { x: e.clientX, y: e.clientY };
        this.el.setPointerCapture(e.pointerId);
        input.panelYoke = { pitch: 0, roll: 0 };
      });
      this.el.addEventListener('pointermove', (e) => {
        if (!start) return;
        input.panelYoke = { pitch: M.clamp((e.clientY - start.y) / 90, -1, 1), roll: M.clamp((e.clientX - start.x) / 90, -1, 1) };
      });
      const end = () => {
        start = null;
        input.panelYoke = null;
      };
      this.el.addEventListener('pointerup', end);
      this.el.addEventListener('pointercancel', end);
      this.el.addEventListener('dblclick', () => {
        const s = SIM.app.settings;
        s.set('controls.mouseYoke', !s.data.controls.mouseYoke);
        SIM.events.emit('notify', { text: `MOUSE YOKE ${s.data.controls.mouseYoke ? 'ON' : 'OFF'}`, level: 'info' });
      });
    }
    update() {
      const c = this.getControls();
      this.inner.style.transform = `translateY(${c.elevator * 10}px) scale(${1 - c.elevator * 0.06}) rotate(${c.aileron * 40}deg)`;
      this.mode.classList.toggle('on', !!SIM.app.settings.data.controls.mouseYoke);
    }
  }

  /** Annunciator lights row. */
  class Annunciators {
    constructor(names, getStates, onTest) {
      this.getStates = getStates;
      this.lights = {};
      this.el = h('div.cw-annunciators', names.map((n) => (this.lights[n] = h('span.cw-ann', { className: n === 'STALL' || n === 'GEAR' ? 'red' : 'amber' }, n))),
        h('button.cw-ann-test', { type: 'button', title: 'Annunciator test (hold)', onpointerdown: () => onTest(true), onpointerup: () => onTest(false), onpointerleave: () => onTest(false) }, 'TEST'));
    }
    update() {
      const s = this.getStates();
      for (const k in this.lights) this.lights[k].classList.toggle('lit', !!s[k]);
    }
  }

  SIM.Widgets = { Switch, Knob, Lever, Selector, TrimWheel, PullKnob, Yoke, Annunciators };
})(window.SIM);
