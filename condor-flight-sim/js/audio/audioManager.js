/**
 * AudioManager — all sound is synthesised with the Web Audio API (no audio files needed):
 * piston engines (firing frequency follows RPM), propeller wash, turbofans (fan whine + roar),
 * starter, wind, rain, ground roll, switches, flaps/gear motors, tyre screech, brakes, warnings
 * (stall horn / stick shaker, gear horn, overspeed clacker, AP disconnect), radio squelch, thunder,
 * crash and ATC voice through speechSynthesis. Cockpit view applies an insulation filter.
 * Falls back to silent operation if Web Audio is unavailable.
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;

  class AudioManager {
    constructor(settings) {
      this.settings = settings;
      this.ctx = null;
      this.available = !!(window.AudioContext || window.webkitAudioContext);
      this.started = false;
      this.flight = null;
      this.speechAvailable = 'speechSynthesis' in window;
      SIM.events.on('settings:changed', ({ path }) => {
        if (path.startsWith('audio') || path === '*') this.applyVolumes();
      });
    }

    /** Must be called from a user gesture (browser autoplay policy). */
    unlock() {
      if (!this.available) return;
      try {
        if (!this.ctx) this.create();
        if (this.ctx.state === 'suspended') this.ctx.resume();
      } catch (e) {
        console.warn('[Audio] unavailable', e);
        this.available = false;
      }
    }

    create() {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      this.ctx = ctx;
      this.master = ctx.createGain();
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      this.master.connect(comp);
      comp.connect(ctx.destination);
      // Buses
      this.insulation = ctx.createBiquadFilter();
      this.insulation.type = 'lowpass';
      this.insulation.frequency.value = 12000;
      this.insulationGain = ctx.createGain();
      this.insulation.connect(this.insulationGain);
      this.insulationGain.connect(this.master);
      this.bus = {
        engine: this.gainTo(this.insulation),
        env: this.gainTo(this.insulation),
        cockpit: this.gainTo(this.master),
        radio: this.gainTo(this.master),
        ui: this.gainTo(this.master),
      };
      // Noise buffers
      const len = ctx.sampleRate * 2;
      this.white = ctx.createBuffer(1, len, ctx.sampleRate);
      this.brown = ctx.createBuffer(1, len, ctx.sampleRate);
      const w = this.white.getChannelData(0), b = this.brown.getChannelData(0);
      let last = 0;
      for (let i = 0; i < len; i++) {
        w[i] = Math.random() * 2 - 1;
        last = (last + 0.02 * w[i]) / 1.02;
        b[i] = last * 3.5;
      }
      // Soft clipping curve
      this.shaper = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) {
        const x = (i / 1023) * 2 - 1;
        this.shaper[i] = Math.tanh(x * 2.2);
      }
      this.started = true;
      this.applyVolumes();
    }

    gainTo(dest, v = 1) {
      const g = this.ctx.createGain();
      g.gain.value = v;
      g.connect(dest);
      return g;
    }

    noise(buffer = this.white) {
      const s = this.ctx.createBufferSource();
      s.buffer = buffer;
      s.loop = true;
      s.start(0, Math.random() * 1.5);
      return s;
    }

    osc(type, freq) {
      const o = this.ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      o.start();
      return o;
    }

    filter(type, freq, q = 1) {
      const f = this.ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      return f;
    }

    applyVolumes() {
      if (!this.started) return;
      const a = this.settings.data.audio;
      const t = this.ctx.currentTime;
      this.master.gain.setTargetAtTime(a.muted ? 0 : a.master, t, 0.05);
      this.bus.engine.gain.setTargetAtTime(a.engine, t, 0.05);
      this.bus.env.gain.setTargetAtTime(a.environment, t, 0.05);
      this.bus.cockpit.gain.setTargetAtTime(a.cockpit, t, 0.05);
      this.bus.radio.gain.setTargetAtTime(a.radio, t, 0.05);
      this.bus.ui.gain.setTargetAtTime(a.cockpit * 0.6, t, 0.05);
    }

    /* ------------------------------------------------------------------ flight sound graph */

    startFlight(aircraft) {
      if (!this.started) return;
      this.stopFlight();
      const ctx = this.ctx;
      const F = { engines: [], nodes: [] };
      const keep = (...n) => F.nodes.push(...n);
      aircraft.engines.forEach((en, i) => {
        if (en.kind === 'piston') {
          const cyl = en.cfg.cylinders || 4;
          const out = ctx.createGain();
          out.gain.value = 0;
          out.connect(this.bus.engine);
          const shaper = ctx.createWaveShaper();
          shaper.curve = this.shaper;
          const lp = this.filter('lowpass', 600, 0.7);
          shaper.connect(lp);
          lp.connect(out);
          const o1 = this.osc('sawtooth', 40);
          const g1 = this.gainTo(shaper, 0.5);
          o1.connect(g1);
          const o2 = this.osc('square', 20);
          const g2 = this.gainTo(shaper, 0.22);
          o2.connect(g2);
          // lumpy AM
          const am = ctx.createGain();
          am.gain.value = 0.7;
          const lfo = this.osc('sine', 10);
          const lfoG = ctx.createGain();
          lfoG.gain.value = 0.3;
          lfo.connect(lfoG);
          lfoG.connect(am.gain);
          const n = this.noise();
          const bp = this.filter('bandpass', 300, 1.4);
          n.connect(bp);
          bp.connect(am);
          am.connect(this.gainTo(shaper, 0.9));
          // propeller wash
          const pn = this.noise();
          const pbp = this.filter('bandpass', 500, 0.6);
          const pg = ctx.createGain();
          pg.gain.value = 0;
          pn.connect(pbp);
          pbp.connect(pg);
          pg.connect(this.bus.engine);
          // starter whine
          const so = this.osc('sawtooth', 60);
          const sg = ctx.createGain();
          sg.gain.value = 0;
          const slp = this.filter('lowpass', 900, 1);
          so.connect(slp);
          slp.connect(sg);
          sg.connect(this.bus.engine);
          keep(o1, o2, lfo, n, pn, so);
          F.engines.push({ kind: 'piston', cyl, out, lp, o1, o2, lfo, bp, pg, pbp, sg, so, i });
        } else {
          const out = ctx.createGain();
          out.gain.value = 0;
          out.connect(this.bus.engine);
          const whine = this.osc('sine', 800);
          const wg = this.gainTo(out, 0);
          whine.connect(wg);
          const whine2 = this.osc('triangle', 1600);
          const wg2 = this.gainTo(out, 0);
          whine2.connect(wg2);
          const n = this.noise();
          const lp = this.filter('lowpass', 500, 0.5);
          const rg = this.gainTo(out, 0);
          n.connect(lp);
          lp.connect(rg);
          keep(whine, whine2, n);
          F.engines.push({ kind: 'jet', out, whine, whine2, wg, wg2, lp, rg, i });
        }
      });
      // wind
      const wn = this.noise();
      F.windF = this.filter('bandpass', 400, 0.5);
      F.windG = this.gainTo(this.bus.env, 0);
      wn.connect(F.windF);
      F.windF.connect(F.windG);
      // ground roll
      const gn = this.noise(this.brown);
      F.rollF = this.filter('lowpass', 140, 0.8);
      F.rollG = this.gainTo(this.bus.env, 0);
      gn.connect(F.rollF);
      F.rollF.connect(F.rollG);
      // rain
      const rn = this.noise();
      F.rainF = this.filter('highpass', 1800, 0.5);
      F.rainG = this.gainTo(this.bus.env, 0);
      rn.connect(F.rainF);
      F.rainF.connect(F.rainG);
      // gyro / avionics hum (cockpit)
      const gyro = this.osc('sine', 1650);
      F.gyroG = this.gainTo(this.bus.cockpit, 0);
      gyro.connect(F.gyroG);
      const fan = this.noise();
      const fanF = this.filter('bandpass', 2400, 2);
      F.fanG = this.gainTo(this.bus.cockpit, 0);
      fan.connect(fanF);
      fanF.connect(F.fanG);
      // stall horn (GA reed) / stick shaker (jet)
      const jet = aircraft.isJet;
      const sh = this.osc(jet ? 'square' : 'sawtooth', jet ? 24 : 1080);
      const shF = this.filter(jet ? 'lowpass' : 'bandpass', jet ? 180 : 1250, jet ? 0.7 : 4);
      F.stallG = this.gainTo(this.bus.cockpit, 0);
      sh.connect(shF);
      shF.connect(F.stallG);
      // gear horn / overspeed clacker
      const gh = this.osc('square', 460);
      F.gearHornG = this.gainTo(this.bus.cockpit, 0);
      gh.connect(this.filter('lowpass', 1500)).connect(F.gearHornG);
      const ck = this.osc('square', 9);
      F.clackG = this.gainTo(this.bus.cockpit, 0);
      ck.connect(this.filter('bandpass', 1800, 3)).connect(F.clackG);
      // flaps / gear motors
      const fm = this.osc('sawtooth', 115);
      F.flapG = this.gainTo(this.bus.cockpit, 0);
      fm.connect(this.filter('lowpass', 420, 2)).connect(F.flapG);
      const hm = this.noise();
      F.hydG = this.gainTo(this.bus.cockpit, 0);
      hm.connect(this.filter('bandpass', 700, 1)).connect(F.hydG);
      // brake squeal
      const bs = this.osc('sine', 1300);
      F.brakeG = this.gainTo(this.bus.env, 0);
      bs.connect(F.brakeG);
      F.brakeOsc = bs;
      keep(wn, gn, rn, gyro, fan, sh, gh, ck, fm, hm, bs);
      this.flight = F;
      this.aircraft = aircraft;
    }

    stopFlight() {
      if (!this.flight) return;
      this.flight.nodes.forEach((n) => {
        try {
          n.stop();
        } catch (e) {
          /* already stopped */
        }
      });
      const F = this.flight;
      [F.windG, F.rollG, F.rainG, F.gyroG, F.fanG, F.stallG, F.gearHornG, F.clackG, F.flapG, F.hydG, F.brakeG].forEach((g) => g && g.disconnect());
      F.engines.forEach((e) => e.out.disconnect());
      this.flight = null;
      if (this.speechAvailable) window.speechSynthesis.cancel();
    }

    /**
     * @param {number} dt
     * @param {object} c { aircraft, cockpit (bool), distance (m), weather, paused, stallWarning }
     */
    update(dt, c) {
      const F = this.flight;
      if (!F || !this.started) return;
      const t = this.ctx.currentTime;
      const set = (param, v, tc = 0.08) => param.setTargetAtTime(v, t, tc);
      const ac = c.aircraft;
      if (c.paused) {
        set(this.insulationGain.gain, 0, 0.05);
        set(this.bus.cockpit.gain, 0, 0.05);
        return;
      }
      const a = this.settings.data.audio;
      set(this.bus.cockpit.gain, a.cockpit);
      // Cockpit insulation vs external openness and distance attenuation
      const atten = c.cockpit ? 1 : 1 / (1 + Math.max(0, c.distance - 20) / 120);
      set(this.insulation.frequency, c.cockpit ? (ac.isJet ? 900 : 1500) : 11000, 0.15);
      set(this.insulationGain.gain, (c.cockpit ? (ac.isJet ? 0.55 : 0.85) : 1.0) * atten, 0.15);

      ac.engines.forEach((en, i) => {
        const s = F.engines[i];
        if (!s) return;
        if (s.kind === 'piston') {
          const rpm = Math.max(en.rpm, 1);
          const fire = (rpm / 60) * (s.cyl / 2);
          set(s.o1.frequency, Math.max(fire, 8), 0.04);
          set(s.o2.frequency, Math.max(fire / 2, 4), 0.04);
          set(s.lfo.frequency, Math.max(fire / s.cyl, 2) * (1 + en.roughness * 0.6), 0.04);
          set(s.bp.frequency, 180 + fire * 3.5, 0.05);
          set(s.lp.frequency, 260 + rpm * 0.55 + (en.power / en.cfg.maxPower) * 900, 0.08);
          const running = en.running ? 1 : 0;
          const level = running * (0.18 + 0.5 * (en.power / en.cfg.maxPower) + 0.12 * (rpm / en.cfg.maxRPM)) + (en.state === 'STARTING' ? 0.12 : 0) + (!running && rpm > 50 ? rpm / 3000 * 0.15 : 0);
          set(s.out.gain, level * 0.6, 0.06);
          const pw = (rpm / en.cfg.maxRPM);
          set(s.pg.gain, pw * pw * (0.12 + 0.25 * en.power / en.cfg.maxPower), 0.08);
          set(s.pbp.frequency, 300 + rpm * 0.35, 0.08);
          set(s.sg.gain, en.state === 'STARTING' ? 0.22 : 0, 0.03);
          set(s.so.frequency, 40 + rpm * 0.35, 0.05);
        } else {
          const n1 = en.n1 / 100, n2 = en.n2 / 100;
          set(s.whine.frequency, 300 + n2 * 2600, 0.1);
          set(s.whine2.frequency, 700 + n1 * 3900, 0.1);
          set(s.wg.gain, n2 * 0.06 * (c.cockpit ? 0.5 : 1), 0.1);
          set(s.wg2.gain, n1 * 0.035, 0.1);
          set(s.lp.frequency, 250 + n1 * 2200, 0.1);
          set(s.rg.gain, Math.pow(n1, 2) * 0.9 * (c.cockpit ? 0.7 : 1.2), 0.1);
          set(s.out.gain, n2 > 0.02 ? 0.55 : 0, 0.1);
        }
      });

      const ias = ac.fm.ias;
      set(F.windF.frequency, 250 + ias * 9, 0.1);
      set(F.windG.gain, Math.min(0.9, Math.pow(ias / 70, 2) * 0.35) * (c.cockpit ? 0.6 : 1), 0.1);
      const gs = ac.groundSpeed;
      const rough = ac.fm.surface === 'grass' || ac.fm.surface === 'dirt' ? 2.2 : 1;
      set(F.rollG.gain, ac.onGround ? Math.min(0.8, gs / 30) * 0.45 * rough : 0, 0.05);
      set(F.rollF.frequency, 90 + gs * 3, 0.1);
      set(F.rainG.gain, c.weather.p.precipitation * (c.cockpit ? 0.22 : 0.12), 0.3);
      const sys = ac.systems;
      set(F.gyroG.gain, sys.elec.busPowered ? sys.gyro.spin * 0.006 : 0, 0.5);
      set(F.fanG.gain, sys.elec.avionicsPowered ? 0.012 : 0, 0.3);
      // Warnings
      const stallSound = c.stallWarning && this.settings.data.gameplay.stallWarnings;
      set(F.stallG.gain, stallSound ? (ac.isJet ? 0.35 : 0.12) : 0, 0.03);
      const gearOn = sys.warnings.gear && (t % 1) < 0.5;
      set(F.gearHornG.gain, gearOn ? 0.06 : 0, 0.01);
      set(F.clackG.gain, sys.warnings.overspeed ? 0.1 : 0, 0.02);
      set(F.flapG.gain, sys.flaps.moving && ac.cfg.systems.electricalFlaps ? 0.05 : 0, 0.05);
      set(F.hydG.gain, (sys.flaps.moving && !ac.cfg.systems.electricalFlaps) || sys.gear.moving ? 0.05 : 0, 0.05);
      const braking = ac.onGround && (sys.brakes.left > 0.5 || sys.brakes.right > 0.5) && gs > 3 && gs < 25;
      set(F.brakeG.gain, braking ? 0.012 : 0, 0.05);
      F.brakeOsc.frequency.setTargetAtTime(1200 + Math.sin(t * 13) * 40, t, 0.02);
    }

    /* ------------------------------------------------------------------ one shots */

    envelope(node, gain, attack, decay, dest) {
      const g = this.ctx.createGain();
      const t = this.ctx.currentTime;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(gain, t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
      node.connect(g);
      g.connect(dest);
      setTimeout(() => {
        try {
          node.stop && node.stop();
        } catch (e) {
          /* noop */
        }
        g.disconnect();
      }, (attack + decay + 0.2) * 1000);
      return g;
    }

    click(strength = 1) {
      if (!this.started) return;
      const n = this.noise();
      const f = this.filter('highpass', 2500, 0.7);
      n.connect(f);
      this.envelope(f, 0.25 * strength, 0.001, 0.035, this.bus.cockpit);
      setTimeout(() => n.stop(), 120);
      const o = this.osc('square', 1800);
      this.envelope(o, 0.03 * strength, 0.001, 0.02, this.bus.cockpit);
    }

    uiTick() {
      if (!this.started) return;
      const o = this.osc('sine', 2200);
      this.envelope(o, 0.03, 0.001, 0.04, this.bus.ui);
    }

    thump(gain = 0.4, freq = 70) {
      if (!this.started) return;
      const o = this.osc('sine', freq);
      o.frequency.exponentialRampToValueAtTime(freq * 0.5, this.ctx.currentTime + 0.25);
      this.envelope(o, gain, 0.005, 0.3, this.bus.env);
    }

    tyreScreech(intensity) {
      if (!this.started) return;
      const n = this.noise();
      const f = this.filter('bandpass', 2300, 3);
      n.connect(f);
      this.envelope(f, Math.min(0.5, 0.12 + intensity * 0.4), 0.01, 0.35 + intensity * 0.3, this.bus.env);
      setTimeout(() => n.stop(), 1200);
      this.thump(0.25 + intensity * 0.4, 55);
    }

    beep(freq = 1000, dur = 0.15, gain = 0.06, count = 1, gap = 0.12) {
      if (!this.started) return;
      for (let i = 0; i < count; i++) {
        setTimeout(() => {
          const o = this.osc('sine', freq);
          this.envelope(o, gain, 0.005, dur, this.bus.cockpit);
        }, i * (dur + gap) * 1000);
      }
    }

    apDisconnect(jet) {
      if (!this.started) return;
      if (jet) {
        // wailer
        for (let i = 0; i < 3; i++) {
          setTimeout(() => {
            const o = this.osc('sawtooth', 900);
            o.frequency.linearRampToValueAtTime(600, this.ctx.currentTime + 0.5);
            const f = this.filter('lowpass', 2500);
            o.connect(f);
            this.envelope(f, 0.05, 0.01, 0.5, this.bus.cockpit);
            setTimeout(() => o.stop(), 800);
          }, i * 600);
        }
      } else {
        this.beep(1400, 0.1, 0.07, 3, 0.06);
      }
    }

    radioSquelch() {
      if (!this.started) return;
      const n = this.noise();
      const f = this.filter('bandpass', 1500, 0.6);
      n.connect(f);
      this.envelope(f, 0.08, 0.005, 0.14, this.bus.radio);
      setTimeout(() => n.stop(), 300);
    }

    thunder(distance) {
      if (!this.started) return;
      const delay = Math.min(distance / 343, 20);
      setTimeout(() => {
        if (!this.flight) return;
        const n = this.noise(this.brown);
        const f = this.filter('lowpass', 220, 0.8);
        n.connect(f);
        const vol = M.clamp(1.2 - distance / 9000, 0.15, 0.9);
        this.envelope(f, vol, 0.25, 3.5 + Math.random() * 2, this.bus.env);
        setTimeout(() => n.stop(), 7000);
      }, delay * 1000);
    }

    crash() {
      if (!this.started) return;
      const n = this.noise(this.brown);
      const f = this.filter('lowpass', 900, 0.5);
      n.connect(f);
      this.envelope(f, 1.0, 0.01, 2.5, this.master);
      setTimeout(() => n.stop(), 3000);
      this.thump(1, 45);
    }

    /** ATC / ATIS voice via speechSynthesis (radio volume, English voice). */
    speak(text, kind = 'ATC') {
      if (!this.speechAvailable || !this.settings.data.audio.atcVoice || this.settings.data.audio.muted) return;
      try {
        const u = new SpeechSynthesisUtterance(text);
        const voices = window.speechSynthesis.getVoices();
        const en = voices.filter((v) => /^en(-|_)/i.test(v.lang));
        if (en.length) u.voice = kind === 'ATIS' ? en[en.length - 1] : en[0];
        u.lang = 'en-US';
        u.rate = kind === 'ATIS' ? 1.0 : 1.1;
        u.pitch = kind === 'ATIS' ? 0.85 : 1.0;
        u.volume = M.clamp(this.settings.data.audio.radio * this.settings.data.audio.master, 0, 1);
        if (kind === 'ATIS') window.speechSynthesis.cancel();
        window.speechSynthesis.speak(u);
      } catch (e) {
        console.warn('[Audio] speech failed', e);
      }
    }
  }

  SIM.AudioManager = AudioManager;
})(window.SIM);
