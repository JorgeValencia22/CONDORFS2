/**
 * Default keyboard bindings. Each action maps to a list of key combos ({code, shift, ctrl, alt})
 * using KeyboardEvent.code so layouts (QWERTY/AZERTY...) keep physical positions.
 *
 * `hold` actions are continuous (evaluated every frame); the rest trigger once per key press.
 */
(function (SIM) {
  'use strict';

  const k = (code, mods = {}) => Object.assign({ code }, mods);
  const S = { shift: true };
  const C = { ctrl: true };

  const ACTIONS = [
    // group, id, label, hold
    ['Flight controls', 'pitchDown', 'Pitch down (nose down)', true],
    ['Flight controls', 'pitchUp', 'Pitch up (nose up)', true],
    ['Flight controls', 'rollLeft', 'Roll left', true],
    ['Flight controls', 'rollRight', 'Roll right', true],
    ['Flight controls', 'yawLeft', 'Rudder left', true],
    ['Flight controls', 'yawRight', 'Rudder right', true],
    ['Flight controls', 'trimModifier', 'Trim modifier (hold + W/S or Q/E)', true],
    ['Flight controls', 'trimUp', 'Elevator trim nose up', true],
    ['Flight controls', 'trimDown', 'Elevator trim nose down', true],
    ['Engine', 'throttleUp', 'Throttle increase', true],
    ['Engine', 'throttleDown', 'Throttle decrease', true],
    ['Engine', 'throttleFull', 'Throttle full', false],
    ['Engine', 'throttleIdle', 'Throttle idle', false],
    ['Engine', 'mixtureRich', 'Mixture richer', true],
    ['Engine', 'mixtureLean', 'Mixture leaner', true],
    ['Engine', 'propUp', 'Propeller RPM increase', true],
    ['Engine', 'propDown', 'Propeller RPM decrease', true],
    ['Engine', 'autoStart', 'Auto start / shutdown', false],
    ['Engine', 'reverse', 'Thrust reverse (hold, jets)', true],
    ['Aircraft', 'flapsDown', 'Flaps extend one notch', false],
    ['Aircraft', 'flapsUp', 'Flaps retract one notch', false],
    ['Aircraft', 'gear', 'Landing gear up/down', false],
    ['Aircraft', 'brakes', 'Wheel brakes (hold)', true],
    ['Aircraft', 'brakeLeft', 'Left brake (hold)', true],
    ['Aircraft', 'brakeRight', 'Right brake (hold)', true],
    ['Aircraft', 'parkingBrake', 'Parking brake', false],
    ['Aircraft', 'speedbrake', 'Speed brake', false],
    ['Aircraft', 'landingLight', 'Landing light', false],
    ['Aircraft', 'autopilot', 'Autopilot on/off', false],
    ['View', 'cameraToggle', 'Cockpit / external view', false],
    ['View', 'cameraCycle', 'Cycle cameras', false],
    ['View', 'lookLeft', 'Look / orbit left', true],
    ['View', 'lookRight', 'Look / orbit right', true],
    ['View', 'lookUp', 'Look / orbit up', true],
    ['View', 'lookDown', 'Look / orbit down', true],
    ['View', 'zoomIn', 'Zoom in', true],
    ['View', 'zoomOut', 'Zoom out', true],
    ['View', 'resetView', 'Reset view', false],
    ['Interface', 'map', 'Map', false],
    ['Interface', 'pause', 'Pause menu', false],
    ['Interface', 'hud', 'HUD on/off', false],
    ['Interface', 'panel', 'Instrument panel on/off', false],
    ['Interface', 'sidePanel', 'Side info panel', false],
    ['Interface', 'atc', 'ATC / radio window', false],
    ['Interface', 'debug', 'Debug overlay', false],
  ];

  const DEFAULTS = {
    pitchDown: [k('KeyW')],
    pitchUp: [k('KeyS')],
    rollLeft: [k('KeyA')],
    rollRight: [k('KeyD')],
    yawLeft: [k('KeyQ')],
    yawRight: [k('KeyE')],
    trimModifier: [k('KeyR')],
    trimUp: [k('End')],
    trimDown: [k('Home')],
    throttleUp: [k('KeyT'), k('PageUp')],
    throttleDown: [k('KeyT', S), k('PageDown')],
    throttleFull: [k('F4')],
    throttleIdle: [k('F1')],
    mixtureRich: [k('KeyK')],
    mixtureLean: [k('KeyJ')],
    propUp: [k('KeyN')],
    propDown: [k('KeyN', S)],
    autoStart: [k('KeyE', C)],
    reverse: [k('Backspace')],
    flapsDown: [k('KeyF')],
    flapsUp: [k('KeyF', S)],
    gear: [k('KeyG')],
    brakes: [k('KeyB')],
    brakeLeft: [k('Comma')],
    brakeRight: [k('Period')],
    parkingBrake: [k('KeyB', S)],
    speedbrake: [k('Slash')],
    landingLight: [k('KeyL')],
    autopilot: [k('KeyZ')],
    cameraToggle: [k('KeyC')],
    cameraCycle: [k('KeyV')],
    lookLeft: [k('ArrowLeft')],
    lookRight: [k('ArrowRight')],
    lookUp: [k('ArrowUp')],
    lookDown: [k('ArrowDown')],
    zoomIn: [k('Equal'), k('NumpadAdd')],
    zoomOut: [k('Minus'), k('NumpadSubtract')],
    resetView: [k('Space')],
    map: [k('KeyM')],
    pause: [k('KeyP'), k('Escape')],
    hud: [k('KeyH')],
    panel: [k('KeyI')],
    sidePanel: [k('KeyO')],
    atc: [k('Tab')],
    debug: [k('Backquote'), k('F3')],
  };

  /** Human readable label for a combo. */
  function comboLabel(c) {
    if (!c) return '—';
    const names = { Backquote: '`', Comma: ',', Period: '.', Slash: '/', Equal: '=', Minus: '-', Space: 'Space', Escape: 'Esc', Backspace: '⌫', PageUp: 'PgUp', PageDown: 'PgDn', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', NumpadAdd: 'Num +', NumpadSubtract: 'Num −', Tab: 'Tab' };
    let key = names[c.code] || c.code.replace(/^Key/, '').replace(/^Digit/, '');
    const mods = [c.ctrl && 'Ctrl', c.alt && 'Alt', c.shift && 'Shift'].filter(Boolean);
    return [...mods, key].join('+');
  }

  SIM.InputActions = ACTIONS.map(([group, id, label, hold]) => ({ group, id, label, hold }));
  SIM.DefaultBindings = DEFAULTS;
  SIM.comboLabel = comboLabel;
})(window.SIM);
