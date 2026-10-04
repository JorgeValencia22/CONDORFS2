/**
 * World — owns the region data (projection, airports, terrain, weather) and, when WebGL is
 * available, every world renderer (terrain LOD, airports, scenery, sky, clouds, rain, particles).
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;

  class World {
    constructor(config, render, settings) {
      this.config = config;
      this.render = render && render.available ? render : null;
      this.settings = settings;
      this.region = SIM.Regions[config.region] || SIM.Regions.chile;
      this.geo = new SIM.GeoProjection(this.region.origin[0], this.region.origin[1]);
      this.airports = this.region.airports.map((id) => SIM.Airports.buildLayout(SIM.AirportDB[id], this.geo));
      this.terrain = new SIM.Terrain(this.region, this.geo, this.airports, config.season);
      this.weather = new SIM.Weather(config.weather, config.weatherCustom, this.region);
      this.time = 0;
      this.env = { daylight: 1, lightsOn: 0, windDir: 0, windKt: 0, time: 0, renderDistance: 60000 };
    }

    async buildTerrainData(progress) {
      await this.terrain.buildMacro(progress);
    }

    /** Creates the 3D scene content. `camPos` is the expected start position. */
    async buildScene(camPos, progress) {
      if (!this.render) return;
      const scene = this.render.scene;
      const s = this.settings;
      this.sky = new SIM.SkySystem(scene, this.render.renderer, this.region, s);
      this.sky.setSeason(this.config.season);
      progress(0.05);
      this.terrainRenderer = new SIM.TerrainRenderer(scene, this.terrain, s);
      await this.terrainRenderer.prebuild(camPos, (f) => progress(0.05 + f * 0.55));
      this.airportRenderer = new SIM.AirportRenderer(scene, this.airports, this.terrain);
      this.airportRenderer.build();
      progress(0.65);
      this.scenery = new SIM.SceneryRenderer(scene, this.terrain, this.region, this.geo, s);
      await this.scenery.build((f) => progress(0.65 + f * 0.33));
      progress(1);
    }

    buildAtmosphere() {
      if (!this.render) return;
      const scene = this.render.scene;
      this.clouds = new SIM.CloudRenderer(scene, this.settings);
      this.particles = new SIM.ParticleSystem(scene, this.settings);
      this.rain = new SIM.RainRenderer(scene);
    }

    get buildingIndex() {
      return this.scenery ? this.scenery.index : null;
    }

    /**
     * Per-frame world update.
     * @param {number} dt
     * @param {number} hour local time of day
     * @param {THREE.Camera} camera
     * @param {object} focus {x,y,z} shadow focus (aircraft)
     * @param {number} shadowExtent
     * @param {object} camVel world velocity of the camera (for rain streaks)
     */
    update(dt, hour, camera, focus, shadowExtent, camVel) {
      this.time += dt;
      this.weather.update(dt);
      if (!this.render) {
        // Still compute daylight for the instrument-only UI
        const sun = SIM.sunPosition(this.region.origin[0], 15, hour);
        this.env.daylight = M.smoothstep(-6, 8, sun.elevation);
        return;
      }
      const g = this.settings.data.graphics;
      const renderDistance = g.renderDistance * 1000;
      camera.far = renderDistance * 1.25;
      this.sky.update(hour, this.weather, camera, focus, shadowExtent, renderDistance);
      const env = this.env;
      env.daylight = this.sky.daylight;
      env.lightsOn = this.sky.lightsFactor(this.weather);
      env.windDir = this.weather.p.windDir;
      env.windKt = this.weather.p.windKt;
      env.time = this.time;
      env.renderDistance = renderDistance;
      this.terrainRenderer.update(camera);
      this.airportRenderer.update(camera.position, env);
      this.scenery.update(camera, env);
      this.clouds.update(camera, this.weather, this.sky, renderDistance);
      this.particles.update(dt, 0.2 + 0.8 * env.daylight);
      this.rain.update(dt, camera, this.weather, camVel, env.daylight, this.particles.budget);
    }

    dispose() {
      ['terrainRenderer', 'airportRenderer', 'scenery', 'sky', 'clouds', 'particles', 'rain'].forEach((k) => {
        if (this[k]) this[k].dispose();
        this[k] = null;
      });
    }
  }

  SIM.World = World;
})(window.SIM);
