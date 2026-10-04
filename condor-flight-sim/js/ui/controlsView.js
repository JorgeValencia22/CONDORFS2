/**
 * ControlsView — remappable keyboard bindings (two slots per action), gamepad/joystick axis
 * assignment with live detection, inversion and dead zone, plus a mouse/touch reference.
 */
(function (SIM) {
  'use strict';

  const { h, icon } = SIM.UI;

  const ControlsView = {
    render(container, app) {
      container.innerHTML = '';
      const st = app.settings;
      const input = app.input;
      const tabs = h('div.tabs', { role: 'tablist' });
      const body = h('div.settings-body');
      const show = (id) => {
        tabs.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === id));
        body.innerHTML = '';
        if (id === 'keys') this.keys(body, st, input);
        else if (id === 'pad') this.pad(body, st, input);
        else this.mouse(body);
        ControlsView.last = id;
      };
      [['keys', 'KEYBOARD', 'keyboard'], ['pad', 'GAMEPAD / JOYSTICK', 'gamepad'], ['mouse', 'MOUSE & TOUCH', 'crosshair']].forEach(([id, label, ic]) => tabs.append(h('button.tab', { type: 'button', dataset: { tab: id }, onclick: () => show(id) }, icon(ic), h('span', label))));
      container.append(tabs, body);
      show(ControlsView.last || 'keys');
    },

    keys(body, st, input) {
      const groups = {};
      SIM.InputActions.forEach((a) => (groups[a.group] = groups[a.group] || []).push(a));
      const bindings = st.data.controls.bindings;
      const save = () => {
        st.set('controls.bindings', Object.assign({}, bindings));
        st.save();
        input.rebuildShiftCodes();
      };
      const slot = (action, i) => {
        const combo = (bindings[action.id] || [])[i];
        const b = h('button.key-slot.mono', { type: 'button', title: 'Click and press a key (Esc cancels)' }, combo ? SIM.comboLabel(combo) : '—');
        b.addEventListener('click', () => {
          b.textContent = 'PRESS A KEY…';
          b.classList.add('listening');
          input.captureKey((c) => {
            b.classList.remove('listening');
            if (c) {
              // remove the combo from any other action to avoid conflicts
              Object.keys(bindings).forEach((k) => (bindings[k] = (bindings[k] || []).filter((x) => !(x.code === c.code && !!x.shift === !!c.shift && !!x.ctrl === !!c.ctrl && !!x.alt === !!c.alt))));
              const list = (bindings[action.id] || []).slice();
              list[i] = c;
              bindings[action.id] = list.filter(Boolean);
              save();
            }
            body.innerHTML = '';
            ControlsView.keys(body, st, input);
          });
        });
        return b;
      };
      body.innerHTML = '';
      Object.entries(groups).forEach(([g, actions]) => {
        body.append(h('div.key-group', h('div.key-group-title', g.toUpperCase()), actions.map((a) => h('div.key-row', h('span.key-label', a.label, a.hold ? h('small.muted', ' hold') : null), slot(a, 0), slot(a, 1)))));
      });
      body.append(h('div.set-foot', h('button.btn.btn-sm', { onclick: () => {
        st.data.controls.bindings = SIM.deepClone(SIM.DefaultBindings);
        save();
        body.innerHTML = '';
        ControlsView.keys(body, st, input);
      } }, icon('restart'), 'RESTORE DEFAULT KEYS')));
    },

    pad(body, st, input) {
      const gp = st.data.controls.gamepad;
      const status = h('div.note');
      const bars = h('div.axis-bars');
      const axisRow = (name, label) => {
        const def = gp.axes[name];
        const sel = h('select.input', { 'aria-label': `${label} axis` }, h('option', { value: -1 }, name === 'throttle' ? 'Triggers (RT/LT)' : 'None'), [0, 1, 2, 3, 4, 5, 6, 7].map((i) => h('option', { value: i }, `Axis ${i}`)));
        sel.value = String(def.index);
        sel.addEventListener('change', () => {
          gp.axes[name].index = Number(sel.value);
          st.save();
        });
        const inv = h('input', { type: 'checkbox', checked: def.invert, 'aria-label': `Invert ${label}` });
        inv.addEventListener('change', () => {
          gp.axes[name].invert = inv.checked;
          st.save();
        });
        const detect = h('button.btn.btn-xs', { type: 'button', onclick: async () => {
          detect.textContent = 'MOVE AXIS…';
          const idx = await input.listenAxis();
          detect.textContent = 'DETECT';
          if (idx >= 0) {
            gp.axes[name].index = idx;
            sel.value = String(idx);
            st.save();
          } else SIM.events.emit('notify', { text: 'NO AXIS MOVEMENT DETECTED', level: 'warn' });
        } }, 'DETECT');
        return h('div.set-row', h('div.set-label', label), h('div.set-control.axis-ctl', sel, detect, h('label.check', inv, 'INVERT')));
      };
      const enabled = h('input', { type: 'checkbox', checked: gp.enabled });
      enabled.addEventListener('change', () => {
        gp.enabled = enabled.checked;
        st.save();
      });
      const dz = h('input.range', { type: 'range', min: 0, max: 0.3, step: 0.01, value: gp.deadzone });
      dz.addEventListener('input', () => {
        gp.deadzone = Number(dz.value);
        st.save();
      });
      body.append(status,
        h('div.set-row', h('div.set-label', 'Gamepad / joystick enabled'), h('div.set-control', h('label.check', enabled, 'ENABLED'))),
        axisRow('roll', 'Roll (ailerons)'), axisRow('pitch', 'Pitch (elevator)'), axisRow('yaw', 'Yaw (rudder)'), axisRow('throttle', 'Throttle'),
        h('div.set-row', h('div.set-label', 'Dead zone'), h('div.set-control', dz)),
        h('div.set-row', h('div.set-label', 'Live axes'), h('div.set-control', bars)),
        h('div.note', icon('info'), 'Standard gamepads: A = brakes, B/X = flaps, Y = camera, LB/RB = rudder, LT/RT = throttle, D-pad ↑↓ = trim, ← gear, → autopilot, Start = pause, Back = map. HID joysticks appear as generic devices: use DETECT to assign axes.'));
      const tick = () => {
        if (!body.isConnected) return;
        const pad = input.pads()[0];
        status.textContent = pad ? `Connected: ${pad.id}` : 'No controller detected. Connect one and press any button (browsers only expose controllers after an input).';
        bars.innerHTML = '';
        if (pad) pad.axes.forEach((v, i) => bars.append(h('div.axis-bar', h('span.mono', String(i)), h('div.axis-track', h('span', { style: { left: `${(v + 1) * 50}%` } })))));
        requestAnimationFrame(tick);
      };
      tick();
    },

    mouse(body) {
      const rows = [
        ['Right-drag on 3D view', 'Look around (cockpit) / orbit (external)'],
        ['Mouse wheel on 3D view', 'Zoom / field of view'],
        ['Left-drag on 3D view (external)', 'Orbit camera'],
        ['Drag the cockpit yoke', 'Fly with the mouse (springs back to centre)'],
        ['Double-click the yoke', 'Toggle MOUSE YOKE mode (pointer position = controls)'],
        ['Click knob left/right half', 'Turn knob down/up · Shift = coarse · wheel also works'],
        ['Drag levers or scroll on them', 'Throttle, mixture, propeller, speed brake'],
        ['Click switches / selectors', 'Operate them · right-click rotary selectors to turn back'],
        ['Hold IGNITION on START', 'Engages the starter while held'],
        ['Click a radio standby frequency', 'Type a frequency directly'],
        ['Touch devices', 'Virtual stick, throttle slider, rudder and quick-action buttons'],
      ];
      body.append(h('dl.kv.ref', rows.map(([k, v]) => [h('dt', k), h('dd', v)])));
    },
  };

  SIM.ControlsView = ControlsView;
})(window.SIM);
