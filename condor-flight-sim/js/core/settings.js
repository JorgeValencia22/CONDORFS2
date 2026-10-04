/**
 * SettingsManager — persistent user configuration (graphics, audio, controls, camera, gameplay,
 * accessibility) plus the last flight setup. Every change is saved to localStorage immediately and
 * broadcast through `settings:changed` so live systems can react.
 */
(function (SIM) {
  'use strict';

  const STORAGE_KEY = 'settings.v1';

  const GRAPHICS_PRESETS = {
    low: {
      resolutionScale: 0.75, shadows: 'off', renderDistance: 40, terrainDetail: 'low', antialias: false,
      effects: false, particles: 'low', clouds: 'low', trees: 'low', buildings: 'low',
    },
    medium: {
      resolutionScale: 1, shadows: 'low', renderDistance: 70, terrainDetail: 'medium', antialias: true,
      effects: true, particles: 'medium', clouds: 'medium', trees: 'medium', buildings: 'medium',
    },
    high: {
      resolutionScale: 1.25, shadows: 'medium', renderDistance: 110, terrainDetail: 'high', antialias: true,
      effects: true, particles: 'high', clouds: 'high', trees: 'high', buildings: 'high',
    },
    ultra: {
      resolutionScale: 1.5, shadows: 'high', renderDistance: 160, terrainDetail: 'ultra', antialias: true,
      effects: true, particles: 'high', clouds: 'high', trees: 'ultra', buildings: 'ultra',
    },
  };

  /** Numeric multipliers derived from the qualitative levels. */
  const LEVELS = {
    terrainDetail: { low: { segments: 32, splitFactor: 1.6 }, medium: { segments: 40, splitFactor: 2.0 }, high: { segments: 48, splitFactor: 2.4 }, ultra: { segments: 56, splitFactor: 2.9 } },
    shadows: { off: 0, low: 1024, medium: 2048, high: 4096 },
    trees: { low: 0.25, medium: 0.55, high: 0.85, ultra: 1.2 },
    buildings: { low: 0.3, medium: 0.6, high: 0.85, ultra: 1.0 },
    clouds: { low: 0.4, medium: 0.7, high: 1.0 },
    particles: { low: 0.35, medium: 0.7, high: 1.0 },
  };

  function defaults() {
    return {
      graphics: Object.assign({ preset: 'auto', showFps: false, instrumentRate: 30 }, GRAPHICS_PRESETS.medium),
      audio: { master: 0.8, engine: 0.9, environment: 0.7, cockpit: 0.8, radio: 0.9, atcVoice: true, muted: false },
      controls: {
        bindings: SIM.DefaultBindings ? SIM.deepClone(SIM.DefaultBindings) : {},
        invertPitch: false,
        keyboardRate: 1.0,
        mouseYoke: false,
        gamepad: {
          enabled: true,
          deadzone: 0.08,
          axes: {
            roll: { index: 0, invert: false },
            pitch: { index: 1, invert: false },
            yaw: { index: 2, invert: false },
            throttle: { index: -1, invert: true },
          },
        },
      },
      sensitivity: { pitch: 1.0, roll: 1.0, yaw: 1.0, mouse: 1.0, curve: 0.35 },
      camera: { fov: 68, headLook: 1.0, chaseSmoothing: 0.6, defaultView: 'cockpit', shake: true, gForceHead: true },
      gameplay: {
        units: 'aviation',
        autoRudder: false,
        crashDetection: true,
        stallWarnings: true,
        realism: 'normal',
        timeRate: 1,
        showHud: true,
        pauseOnBlur: true,
        groundTraffic: true,
      },
      accessibility: { uiScale: 1, highContrast: false, reduceMotion: false, largeText: false, subtitles: true },
      last: {
        aircraft: 'c172',
        region: 'chile',
        airport: 'SCEL',
        runway: '17L',
        start: 'runway',
        location: null,
        weather: 'clear',
        weatherCustom: null,
        time: 11,
        season: 'summer',
        fuel: 0.8,
        payload: 90,
        failures: 'off',
        customFailures: [],
        traffic: 'medium',
      },
      meta: { firstRun: true },
    };
  }

  class SettingsManager {
    constructor() {
      this.data = defaults();
      const stored = SIM.Storage.load(STORAGE_KEY, null);
      if (stored) SIM.deepMerge(this.data, stored);
      // Make sure newly added bindings exist even if the stored profile predates them.
      if (SIM.DefaultBindings) {
        for (const action of Object.keys(SIM.DefaultBindings)) {
          if (!this.data.controls.bindings[action]) this.data.controls.bindings[action] = SIM.deepClone(SIM.DefaultBindings[action]);
        }
      }
    }

    get(path) {
      return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), this.data);
    }

    set(path, value, { silent = false } = {}) {
      const keys = path.split('.');
      let o = this.data;
      for (let i = 0; i < keys.length - 1; i++) {
        if (o[keys[i]] == null || typeof o[keys[i]] !== 'object') o[keys[i]] = {};
        o = o[keys[i]];
      }
      const last = keys[keys.length - 1];
      if (o[last] === value) return;
      o[last] = value;
      // Editing an individual graphics option turns the preset into "custom".
      if (keys[0] === 'graphics' && GRAPHICS_PRESETS.medium[last] !== undefined && !this._applyingPreset) {
        this.data.graphics.preset = 'custom';
      }
      this.save();
      if (!silent) SIM.events.emit('settings:changed', { path, value });
    }

    applyGraphicsPreset(name) {
      const preset = GRAPHICS_PRESETS[name];
      this._applyingPreset = true;
      if (preset) Object.keys(preset).forEach((k) => this.set('graphics.' + k, preset[k], { silent: true }));
      this.data.graphics.preset = name;
      this._applyingPreset = false;
      this.save();
      SIM.events.emit('settings:changed', { path: 'graphics.preset', value: name });
    }

    /** Picks a preset for "auto" from hardware hints. Runtime FPS adaptation refines it later. */
    detectGraphicsPreset(gpuName) {
      const cores = navigator.hardwareConcurrency || 4;
      const mem = navigator.deviceMemory || 4;
      const gpu = (gpuName || '').toLowerCase();
      const touch = 'ontouchstart' in window;
      let preset = 'medium';
      if (/rtx|radeon rx|geforce gtx 1[0-9]{3}|apple m[1-9]/.test(gpu) && cores >= 6) preset = 'high';
      if (/rtx (3|4|5)0[7-9]0|radeon rx (6|7)[89]00/.test(gpu)) preset = 'ultra';
      if (/intel|uhd|hd graphics|mali|adreno|powervr|swiftshader|llvmpipe/.test(gpu) || cores <= 2 || mem <= 2 || touch) preset = 'low';
      if (/iris xe|iris\(r\) xe/.test(gpu) && cores >= 8) preset = 'medium';
      return preset;
    }

    resetSection(section) {
      const d = defaults();
      if (d[section]) {
        this.data[section] = d[section];
        this.save();
        SIM.events.emit('settings:changed', { path: section, value: this.data[section] });
      }
    }

    resetAll() {
      this.data = defaults();
      this.data.meta.firstRun = false;
      this.save();
      SIM.events.emit('settings:changed', { path: '*', value: null });
    }

    save() {
      SIM.Storage.save(STORAGE_KEY, this.data);
    }

    level(category) {
      const table = LEVELS[category];
      return table ? table[this.data.graphics[category]] ?? Object.values(table)[1] : undefined;
    }

    /** Unit formatting helpers driven by the units setting. */
    get metric() {
      return this.data.gameplay.units === 'metric';
    }
  }

  SIM.SettingsManager = SettingsManager;
  SIM.GraphicsPresets = GRAPHICS_PRESETS;
  SIM.GraphicsLevels = LEVELS;
})(window.SIM);
