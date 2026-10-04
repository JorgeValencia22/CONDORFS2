/**
 * Weather — meteorological model (pure simulation, no rendering).
 * Provides the atmosphere (ISA with temperature/QNH offsets), wind with altitude profile, gusts and
 * turbulence, visibility, clouds, precipitation and lightning timing.
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;
  const FT = SIM.Units.FT;
  const KT = SIM.Units.KT;

  const PRESETS = {
    clear: { label: 'CLEAR', cloudCover: 0.06, cloudBaseFt: 7500, visibilityKm: 60, windDir: 210, windKt: 6, gustKt: 0, tempC: 22, qnh: 1016, precipitation: 0, turbulence: 0.04, humidity: 0.35, lightning: false },
    partly: { label: 'PARTLY CLOUDY', cloudCover: 0.42, cloudBaseFt: 4500, visibilityKm: 40, windDir: 220, windKt: 10, gustKt: 4, tempC: 19, qnh: 1013, precipitation: 0, turbulence: 0.15, humidity: 0.55, lightning: false },
    overcast: { label: 'OVERCAST', cloudCover: 0.96, cloudBaseFt: 2800, visibilityKm: 18, windDir: 230, windKt: 12, gustKt: 5, tempC: 13, qnh: 1009, precipitation: 0, turbulence: 0.2, humidity: 0.78, lightning: false },
    fog: { label: 'FOG', cloudCover: 0.7, cloudBaseFt: 600, visibilityKm: 0.9, windDir: 180, windKt: 2, gustKt: 0, tempC: 10, qnh: 1019, precipitation: 0, turbulence: 0.02, humidity: 0.98, lightning: false },
    rain: { label: 'RAIN', cloudCover: 0.97, cloudBaseFt: 1800, visibilityKm: 7, windDir: 250, windKt: 15, gustKt: 8, tempC: 11, qnh: 1003, precipitation: 0.65, turbulence: 0.32, humidity: 0.93, lightning: false },
    storm: { label: 'STORM', cloudCover: 1, cloudBaseFt: 1500, visibilityKm: 3.5, windDir: 270, windKt: 24, gustKt: 16, tempC: 9, qnh: 994, precipitation: 1, turbulence: 0.7, humidity: 0.97, lightning: true },
  };

  class Weather {
    constructor(presetId = 'clear', custom = null, region = null) {
      this.region = region;
      this.time = 0;
      this.lightningTimer = 4 + Math.random() * 6;
      this.flash = 0;
      this.set(presetId, custom);
    }

    set(presetId, custom = null) {
      const base = PRESETS[presetId] || PRESETS.clear;
      this.preset = PRESETS[presetId] ? presetId : 'clear';
      this.p = Object.assign({}, base, custom || {});
      SIM.events.emit('weather:changed', { preset: this.preset, params: this.p });
    }

    /** Partial updates from the UI (e.g. wind slider). */
    setParam(key, value) {
      this.p[key] = value;
      SIM.events.emit('weather:changed', { preset: this.preset, params: this.p });
    }

    get label() {
      return this.p.label;
    }

    get visibility() {
      return this.p.visibilityKm * 1000;
    }

    get cloudBase() {
      return this.p.cloudBaseFt * FT;
    }

    get cloudTop() {
      const thickness = this.preset === 'storm' ? 9000 : this.p.cloudCover > 0.8 ? 1100 : this.preset === 'fog' ? 250 : 900;
      return this.cloudBase + thickness;
    }

    get qnh() {
      return this.p.qnh;
    }

    get humidity() {
      return this.p.humidity;
    }

    /** ISA atmosphere with sea-level temperature and pressure from the weather. */
    atmosphereAt(y) {
      const T0 = 273.15 + this.p.tempC;
      const h = Math.max(-200, Math.min(y, 15000));
      const T = Math.max(T0 - SIM.Phys.LAPSE * h, 216.65);
      const p = this.p.qnh * 100 * Math.pow(1 - (SIM.Phys.LAPSE * h) / T0, 5.25588);
      const rho = p / (SIM.Phys.R * T);
      if (!this._atm) this._atm = {};
      const a = this._atm;
      a.tempC = T - 273.15;
      a.pressure = p;
      a.rho = rho;
      a.soundSpeed = Math.sqrt(1.4 * SIM.Phys.R * T);
      return a;
    }

    /** Wind speed (m/s) and FROM direction (deg true) at a height above sea level, without gusts. */
    windProfile(y, groundY = 0) {
      const agl = Math.max(0, y - groundY);
      const shear = M.clamp(0.55 + 0.45 * Math.pow(Math.min(agl, 600) / 600, 0.35), 0.55, 1);
      const aloft = 1 + Math.min(y, 6000) / 6000;
      const speed = this.p.windKt * KT * shear * aloft;
      const dir = this.p.windDir + Math.min(y, 3000) / 3000 * 20;
      return { speed, dir };
    }

    /** Wind velocity vector (air motion, world frame) at a position. */
    windAt(pos, out, groundY) {
      const prof = this.windProfile(pos.y, groundY !== undefined ? groundY : this._groundY || 0);
      const t = this.time;
      const gust = this.p.gustKt * KT * Math.max(0, SIM.Noise.fbm(t * 0.25, 3.7, 2, 77) * 2 - 0.6);
      const speed = prof.speed + gust;
      const r = prof.dir * M.DEG;
      // air moves TOWARD dir+180
      let vx = -Math.sin(r) * speed;
      let vz = Math.cos(r) * speed;
      let vy = 0;
      const turb = this.p.turbulence;
      if (turb > 0) {
        const s = 1.2 + turb * 4;
        const n = SIM.Noise.valueNoise;
        vx += (n(pos.x / 90 + t * 0.6, pos.z / 90, 11) - 0.5) * s;
        vz += (n(pos.x / 90, pos.z / 90 + t * 0.6, 12) - 0.5) * s;
        vy += (n(pos.x / 70 + t * 0.5, pos.z / 70 - t * 0.3, 13) - 0.5) * s * 0.9;
      }
      // Thermals/sink over terrain in clear daytime weather
      out.x = vx;
      out.y = vy;
      out.z = vz;
      return out;
    }

    /** True when the point is inside cloud or precipitation (for icing). */
    visibleMoisture(y) {
      if (this.p.precipitation > 0.1) return y < this.cloudTop;
      return this.p.cloudCover > 0.6 && y > this.cloudBase && y < this.cloudTop;
    }

    /** Turbulence intensity felt by the aircraft (stronger in/under clouds). */
    turbulenceAt(y) {
      let t = this.p.turbulence;
      if (y > this.cloudBase && y < this.cloudTop) t *= 1.5;
      return t;
    }

    update(dt) {
      this.time += dt;
      this.flash = Math.max(0, this.flash - dt * 3);
      if (this.p.lightning) {
        this.lightningTimer -= dt;
        if (this.lightningTimer <= 0) {
          this.lightningTimer = 5 + Math.random() * 14;
          this.flash = 1;
          const distance = 1500 + Math.random() * 8000;
          SIM.events.emit('weather:lightning', { distance });
        }
      }
    }

    /** METAR-like summary used by ATIS and the UI. */
    metar(icao, magVar = 0) {
      const p = this.p;
      const dir = M.wrap360(Math.round((p.windDir - magVar) / 10) * 10);
      const wind = p.windKt < 3 ? '00000KT' : `${String(dir).padStart(3, '0')}${String(Math.round(p.windKt)).padStart(2, '0')}${p.gustKt > 3 ? 'G' + Math.round(p.windKt + p.gustKt) : ''}KT`;
      const vis = p.visibilityKm >= 10 ? '9999' : String(Math.round(p.visibilityKm * 1000)).padStart(4, '0');
      const cover = p.cloudCover < 0.1 ? 'SKC' : p.cloudCover < 0.3 ? 'FEW' : p.cloudCover < 0.55 ? 'SCT' : p.cloudCover < 0.88 ? 'BKN' : 'OVC';
      const clouds = cover === 'SKC' ? 'CAVOK' : `${cover}${String(Math.round(p.cloudBaseFt / 100)).padStart(3, '0')}${this.preset === 'storm' ? 'CB' : ''}`;
      const wx = this.preset === 'storm' ? ' +TSRA' : this.preset === 'rain' ? ' RA' : this.preset === 'fog' ? ' FG' : '';
      const t = Math.round(p.tempC), dp = Math.round(p.tempC - (1 - p.humidity) * 20);
      return `${icao} ${wind} ${vis}${wx} ${clouds} ${t < 0 ? 'M' : ''}${Math.abs(t)}/${dp < 0 ? 'M' : ''}${Math.abs(dp)} Q${Math.round(p.qnh)}`;
    }
  }

  SIM.WeatherPresets = PRESETS;
  SIM.Weather = Weather;
})(window.SIM);
