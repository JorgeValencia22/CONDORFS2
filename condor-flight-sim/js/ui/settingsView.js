/**
 * SettingsView — Graphics, Audio, Controls (sensitivity), Camera, Gameplay and Accessibility.
 * Used from the main menu and from the pause menu. Every control writes to SettingsManager
 * (persisted in localStorage) and live systems react through `settings:changed`.
 */
(function (SIM) {
  'use strict';

  const { h, icon } = SIM.UI;

  const TABS = [
    ['graphics', 'GRAPHICS', 'layers'],
    ['audio', 'AUDIO', 'volume'],
    ['controls', 'CONTROLS', 'gamepad'],
    ['camera', 'CAMERA', 'camera'],
    ['gameplay', 'GAMEPLAY', 'plane'],
    ['accessibility', 'ACCESSIBILITY', 'access'],
  ];

  function fields(app) {
    const st = app.settings;
    const row = (label, control, hint) => h('div.set-row', h('div.set-label', h('span', label), hint ? h('small.muted', hint) : null), h('div.set-control', control));

    const select = (path, options, onChange) => {
      const el = h('div.seg', options.map(([v, l]) => h('button.seg-btn', { type: 'button', dataset: { v: String(v) }, onclick: () => {
        st.set(path, v);
        el.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.v === String(v)));
        onChange && onChange(v);
      } }, l)));
      const cur = String(st.get(path));
      el.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.v === cur));
      return el;
    };
    const slider = (path, min, max, step, fmt) => {
      const out = h('span.mono.set-value', fmt(st.get(path)));
      const input = h('input.range', { type: 'range', min, max, step, value: st.get(path), 'aria-label': path });
      input.addEventListener('input', () => {
        st.set(path, Number(input.value));
        out.textContent = fmt(Number(input.value));
      });
      return h('div.slider-wrap', input, out);
    };
    const toggle = (path, onChange) => {
      const input = h('input', { type: 'checkbox', checked: !!st.get(path), 'aria-label': path });
      input.addEventListener('change', () => {
        st.set(path, input.checked);
        onChange && onChange(input.checked);
      });
      return h('label.toggle', input, h('span.toggle-track', h('span.toggle-thumb')));
    };
    return { row, select, slider, toggle };
  }

  const pct = (v) => `${Math.round(v * 100)}%`;

  const SettingsView = {
    render(container, app, opts = {}) {
      container.innerHTML = '';
      const tabsEl = h('div.tabs', { role: 'tablist' });
      const body = h('div.settings-body');
      const show = (id) => {
        tabsEl.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === id));
        body.innerHTML = '';
        this[id](body, app, opts);
        SettingsView.last = id;
      };
      TABS.forEach(([id, label, ic]) => tabsEl.append(h('button.tab', { type: 'button', role: 'tab', dataset: { tab: id }, onclick: () => show(id) }, icon(ic), h('span', label))));
      container.append(tabsEl, body);
      show(SettingsView.last || 'graphics');
    },

    footer(body, app, section) {
      body.append(h('div.set-foot', h('button.btn.btn-sm', { onclick: () => {
        app.settings.resetSection(section);
        SettingsView.render(body.parentElement, app);
      } }, icon('restart'), 'RESET SECTION')));
    },

    graphics(body, app) {
      const { row, select, slider, toggle } = fields(app);
      const st = app.settings;
      const presetSel = h('div.seg', ['auto', 'low', 'medium', 'high', 'ultra'].map((p) => h('button.seg-btn', { type: 'button', dataset: { v: p }, onclick: () => {
        if (p === 'auto') {
          st.applyGraphicsPreset(st.detectGraphicsPreset(app.render && app.render.gpuName));
          st.set('graphics.preset', 'auto');
        } else st.applyGraphicsPreset(p);
        SettingsView.render(body.parentElement, app);
      } }, p.toUpperCase())));
      presetSel.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.v === st.data.graphics.preset));
      const gpu = app.render && app.render.gpuName ? app.render.gpuName : app.render && app.render.available ? 'WebGL' : 'WebGL unavailable — instrument-only mode';
      const restartNote = app.render && app.render.needsRestartForAA ? h('div.note.warn', 'Anti-aliasing changes apply after reloading the simulator.') : null;
      body.append(
        h('div.note', icon('info'), `GPU: ${gpu}. AUTO adapts resolution and draw distance to keep the frame rate playable.`),
        row('Quality preset', presetSel, st.data.graphics.preset === 'custom' ? 'Custom (individual options changed)' : null),
        row('Resolution scale', slider('graphics.resolutionScale', 0.5, 2, 0.05, pct)),
        row('Shadow quality', select('graphics.shadows', [['off', 'OFF'], ['low', 'LOW'], ['medium', 'MED'], ['high', 'HIGH']])),
        row('Render distance', slider('graphics.renderDistance', 20, 200, 5, (v) => `${v} km`)),
        row('Terrain detail', select('graphics.terrainDetail', [['low', 'LOW'], ['medium', 'MED'], ['high', 'HIGH'], ['ultra', 'ULTRA']]), 'Rebuilds terrain tiles progressively'),
        row('Trees', select('graphics.trees', [['low', 'LOW'], ['medium', 'MED'], ['high', 'HIGH'], ['ultra', 'ULTRA']]), 'Applies to newly built terrain'),
        row('Buildings', select('graphics.buildings', [['low', 'LOW'], ['medium', 'MED'], ['high', 'HIGH'], ['ultra', 'ULTRA']]), 'Applies on the next flight'),
        row('Clouds', select('graphics.clouds', [['low', 'LOW'], ['medium', 'MED'], ['high', 'HIGH']])),
        row('Particles', select('graphics.particles', [['low', 'LOW'], ['medium', 'MED'], ['high', 'HIGH']])),
        row('Effects (dust, vapour, spray)', toggle('graphics.effects')),
        row('Anti-aliasing', toggle('graphics.antialias', () => SettingsView.render(body.parentElement, app))),
        restartNote || '',
        row('Instrument refresh', select('graphics.instrumentRate', [[15, '15 Hz'], [30, '30 Hz'], [60, '60 Hz']])),
        row('Show FPS counter', toggle('graphics.showFps')));
      this.footer(body, app, 'graphics');
    },

    audio(body, app) {
      const { row, slider, toggle } = fields(app);
      const a = app.audio;
      body.append(
        h('div.note', icon('info'), a.available ? 'All sounds are synthesised in real time with the Web Audio API.' : 'Web Audio is not available in this browser: the simulator runs silently.'),
        row('Master volume', slider('audio.master', 0, 1, 0.01, pct)),
        row('Engine', slider('audio.engine', 0, 1, 0.01, pct)),
        row('Environment (wind, rain, ground)', slider('audio.environment', 0, 1, 0.01, pct)),
        row('Cockpit (switches, warnings)', slider('audio.cockpit', 0, 1, 0.01, pct)),
        row('Radio / ATC', slider('audio.radio', 0, 1, 0.01, pct)),
        row('ATC voice (speech synthesis)', toggle('audio.atcVoice'), a.speechAvailable ? null : 'Not supported by this browser'),
        row('Mute all', toggle('audio.muted')));
      this.footer(body, app, 'audio');
    },

    controls(body, app) {
      const { row, slider, toggle } = fields(app);
      body.append(
        row('Pitch sensitivity', slider('sensitivity.pitch', 0.3, 1.5, 0.05, pct)),
        row('Roll sensitivity', slider('sensitivity.roll', 0.3, 1.5, 0.05, pct)),
        row('Yaw sensitivity', slider('sensitivity.yaw', 0.3, 1.5, 0.05, pct)),
        row('Stick response curve', slider('sensitivity.curve', 0, 1, 0.05, pct), '0 = linear, higher = finer centre'),
        row('Keyboard control speed', slider('controls.keyboardRate', 0.4, 2, 0.05, pct)),
        row('Invert pitch', toggle('controls.invertPitch')),
        row('Mouse yoke', toggle('controls.mouseYoke'), 'Fly with the mouse pointer over the 3D view (double-click the cockpit yoke to toggle)'),
        h('div.note', icon('keyboard'), 'Key bindings and joystick axes are in the CONTROLS section.'));
      this.footer(body, app, 'sensitivity');
    },

    camera(body, app) {
      const { row, select, slider, toggle } = fields(app);
      body.append(
        row('Field of view', slider('camera.fov', 40, 100, 1, (v) => `${v}°`)),
        row('Head-look / orbit speed', slider('camera.headLook', 0.3, 2.5, 0.05, pct)),
        row('Chase camera smoothing', slider('camera.chaseSmoothing', 0, 1, 0.05, pct)),
        row('Default view', select('camera.defaultView', [['cockpit', 'COCKPIT'], ['external', 'EXTERNAL']])),
        row('Camera shake (buffet, turbulence)', toggle('camera.shake')),
        row('G-force head movement', toggle('camera.gForceHead')));
      this.footer(body, app, 'camera');
    },

    gameplay(body, app) {
      const { row, select, toggle } = fields(app);
      body.append(
        row('Units', select('gameplay.units', [['aviation', 'AVIATION (kt, ft)'], ['metric', 'METRIC (km/h, m)']])),
        row('Realism', select('gameplay.realism', [['easy', 'EASY'], ['normal', 'NORMAL'], ['realistic', 'REALISTIC']]), 'Torque, P-factor and gyro precession strength (next flight)'),
        row('Auto-rudder (coordination assist)', toggle('gameplay.autoRudder')),
        row('Crash detection', toggle('gameplay.crashDetection')),
        row('Stall warning sound', toggle('gameplay.stallWarnings')),
        row('HUD in external views', toggle('gameplay.showHud')),
        row('Ground vehicle traffic', toggle('gameplay.groundTraffic'), 'Applies on the next flight'),
        row('Pause when window loses focus', toggle('gameplay.pauseOnBlur')));
      this.footer(body, app, 'gameplay');
    },

    accessibility(body, app) {
      const { row, slider, toggle } = fields(app);
      body.append(
        row('Interface scale', slider('accessibility.uiScale', 0.8, 1.4, 0.05, pct)),
        row('Large text', toggle('accessibility.largeText')),
        row('High contrast HUD and menus', toggle('accessibility.highContrast')),
        row('Reduce motion (menu animations)', toggle('accessibility.reduceMotion')),
        row('ATC subtitles as notifications', toggle('accessibility.subtitles')));
      this.footer(body, app, 'accessibility');
    },
  };

  SIM.SettingsView = SettingsView;
})(window.SIM);
