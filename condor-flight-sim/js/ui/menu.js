/**
 * MainMenu — PLAY, AIRCRAFT, WORLD, FREE FLIGHT, MISSIONS, SETTINGS, CONTROLS, ABOUT.
 * The flight setup is stored in settings.last (persisted), so choices survive reloads.
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;
  const { h, icon, Fmt } = SIM.UI;

  const SECTIONS = [
    ['play', 'PLAY', 'play'],
    ['aircraft', 'AIRCRAFT', 'plane'],
    ['world', 'WORLD', 'globe'],
    ['free', 'FREE FLIGHT', 'route'],
    ['missions', 'MISSIONS', 'target'],
    ['settings', 'SETTINGS', 'sliders'],
    ['controls', 'CONTROLS', 'gamepad'],
    ['about', 'ABOUT', 'info'],
  ];
  const START_TYPES = [['runway', 'RUNWAY'], ['parking', 'PARKING (COLD & DARK)'], ['air', 'IN FLIGHT 3000 FT'], ['approach', 'FINAL APPROACH'], ['location', 'LOCATION']];
  const TIMES = [[7, 'MORNING'], [12.5, 'MIDDAY'], [16, 'AFTERNOON'], [19.6, 'SUNSET'], [22.5, 'NIGHT']];
  const SEASONS = [['summer', 'SUMMER'], ['autumn', 'AUTUMN'], ['winter', 'WINTER'], ['spring', 'SPRING']];
  const TRAFFIC = [['off', 'OFF'], ['low', 'LOW'], ['medium', 'MEDIUM'], ['high', 'HIGH']];

  class MainMenu {
    constructor(app) {
      this.app = app;
      this.cfg = app.settings.data.last;
      this.section = 'play';
      this.el = h('div.menu', { role: 'application', 'aria-label': 'CÓNDOR Flight Simulator main menu' });
      this.bg = h('canvas.menu-bg', { 'aria-hidden': 'true' });
      this.nav = h('nav.menu-nav', { 'aria-label': 'Main menu' });
      this.main = h('main.menu-main');
      this.status = h('div.menu-status');
      this.summary = h('div.menu-summary');
      SECTIONS.forEach(([id, label, ic], i) => this.nav.append(h('button.nav-item', { type: 'button', dataset: { id }, onclick: () => this.show(id), style: { '--i': i } }, icon(ic), h('span', label))));
      this.el.append(this.bg, h('div.menu-shell',
        h('header.menu-top',
          h('div.brand', h('span.brand-mark'), h('div', h('div.brand-name', 'CÓNDOR'), h('div.brand-sub', 'FLIGHT SIMULATOR'))),
          this.status),
        this.nav,
        this.main,
        h('footer.menu-foot', this.summary,
          h('button.btn.btn-ghost', { onclick: () => this.show('free') }, icon('sliders'), 'CONFIGURE'),
          h('button.btn.btn-primary.btn-lg', { onclick: () => this.start() }, icon('play'), 'START FLIGHT'))));
      this.bgAnim = new MenuBackground(this.bg, app.settings);
      SIM.events.on('settings:changed', ({ path }) => {
        if (path.startsWith('last') && this.visible) this.renderSummary();
      });
      SIM.events.on('input:gamepad', () => this.visible && this.renderStatus());
    }

    get visible() {
      return !this.el.classList.contains('hidden');
    }

    open() {
      this.el.classList.remove('hidden');
      this.bgAnim.start();
      this.renderStatus();
      this.show(this.section);
    }

    close() {
      this.el.classList.add('hidden');
      this.bgAnim.stop();
    }

    set(key, value) {
      this.app.settings.set('last.' + key, value);
      this.renderSummary();
    }

    renderStatus() {
      const a = this.app;
      const pad = a.input.pads()[0];
      const pill = (label, ok, title) => h('span.pill', { className: ok ? 'ok' : 'off', title }, h('span.dot'), label);
      this.status.innerHTML = '';
      this.status.append(
        pill('3D', a.render && a.render.available, a.render && a.render.available ? a.render.gpuName : 'WebGL unavailable — instrument-only mode'),
        pill('AUDIO', a.audio.available, a.audio.available ? 'Web Audio' : 'No Web Audio'),
        pill('CONTROLLER', !!pad, pad ? pad.id : 'No controller'),
        pill('SAVE', SIM.Storage.available, SIM.Storage.available ? 'Settings saved in this browser' : 'Storage blocked: settings last only this session'),
        h('span.version.mono', `v${SIM.VERSION}`));
    }

    renderSummary() {
      const c = this.cfg;
      const ac = SIM.AircraftData[c.aircraft];
      const ap = SIM.AirportDB[c.airport];
      const w = SIM.WeatherPresets[c.weather];
      const start = c.start === 'location' ? (SIM.Regions[c.region].locations.find((l) => l.id === c.location) || {}).name || 'LOCATION' : START_TYPES.find((s) => s[0] === c.start)[1];
      this.summary.innerHTML = '';
      this.summary.append(
        h('div.sum-item', icon('plane'), h('span', ac.shortName)),
        h('div.sum-item', icon('globe'), h('span', `${ap.icao} ${c.start === 'runway' || c.start === 'approach' ? c.runway || '' : ''}`)),
        h('div.sum-item', icon('route'), h('span', start)),
        h('div.sum-item', icon('cloud'), h('span', w.label)),
        h('div.sum-item', icon('clock'), h('span', `${Fmt.clock(c.time)} · ${c.season.toUpperCase()}`)));
    }

    show(id) {
      this.section = id;
      this.nav.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.id === id));
      this.main.innerHTML = '';
      const page = h(`section.page.page-${id}`);
      this.main.append(page);
      this['page_' + id](page);
      this.renderSummary();
      this.main.scrollTop = 0;
    }

    pageHead(title, sub) {
      return h('div.page-head', h('h1', title), sub ? h('p.muted', sub) : null);
    }

    start(opts = {}) {
      this.app.audio.unlock();
      this.app.startFlight(Object.assign({}, this.cfg), opts);
    }

    /* ------------------------------------------------------------------ PLAY */

    page_play(p) {
      const log = SIM.Storage.load('logbook.v1', { flights: 0, seconds: 0, landings: 0, bestLanding: null, crashes: 0 });
      const prog = SIM.Storage.load('progress.v1', { missions: {} });
      const done = Object.values(prog.missions).filter((m) => m.completed).length;
      const card = (cls, ic, title, text, action, label) => h(`article.play-card.${cls}`, h('div.play-icon', icon(ic)), h('h3', title), h('p', text), h('button.btn.btn-primary', { onclick: action }, label, icon('chevronRight')));
      p.append(this.pageHead('Ready for departure', 'Choose how you want to fly today.'),
        h('div.play-grid',
          card('quick', 'bolt', 'Quick Flight', 'Cessna 172 lined up on runway 17L at Santiago (SCEL). Clear skies, daytime, engine running.', () => this.quickFlight(), 'QUICK FLIGHT'),
          card('free', 'route', 'Free Flight', 'Pick aircraft, airport, runway, weather, time, fuel, failures and traffic.', () => this.show('free'), 'CONFIGURE'),
          card('missions', 'target', 'Missions', `${SIM.Missions.length} training missions · ${done} completed. Scored landings and navigation.`, () => this.show('missions'), 'MISSIONS')),
        h('div.stat-row',
          this.stat('FLIGHTS', log.flights),
          this.stat('HOURS', (log.seconds / 3600).toFixed(1)),
          this.stat('LANDINGS', log.landings),
          this.stat('BEST LANDING', log.bestLanding != null ? `${Math.round(log.bestLanding)} fpm` : '—'),
          this.stat('MISSIONS', `${done}/${SIM.Missions.length}`)),
        h('div.keys-strip', [['W S', 'Pitch'], ['A D', 'Roll'], ['Q E', 'Rudder'], ['T ⇧T', 'Throttle'], ['F ⇧F', 'Flaps'], ['G', 'Gear'], ['B', 'Brakes'], ['V', 'Camera'], ['M', 'Map'], ['Ctrl+E', 'Auto start'], ['Tab', 'ATC'], ['P', 'Pause']].map(([k, l]) => h('span.kbd-item', h('kbd', k), l))));
    }

    stat(label, value) {
      return h('div.stat', h('div.stat-value.mono', String(value)), h('div.stat-label', label));
    }

    quickFlight() {
      this.app.audio.unlock();
      this.app.startFlight({ aircraft: 'c172', region: 'chile', airport: 'SCEL', runway: '17L', start: 'runway', weather: 'clear', weatherCustom: null, time: 11, season: 'summer', fuel: 0.8, payload: 90, failures: 'off', customFailures: [], traffic: 'medium' });
    }

    /* ------------------------------------------------------------------ AIRCRAFT */

    page_aircraft(p) {
      p.append(this.pageHead('Aircraft', 'Five aircraft with their own flight model, engines, systems and cockpit.'));
      const grid = h('div.ac-grid');
      const detail = h('div.ac-detail.panel');
      const renderDetail = () => {
        const a = SIM.AircraftData[this.cfg.aircraft];
        const e = a.engines[0];
        const pow = e.type === 'piston' ? `${a.engines.length > 1 ? '2 × ' : ''}${Math.round(e.maxPower / SIM.Units.HP)} hp ${e.name.replace(/ \(.\)$/, '')}` : `2 × ${Math.round(e.maxThrust / 1000)} kN ${e.name.replace(/ \(\d\)$/, '')}`;
        detail.innerHTML = '';
        detail.append(h('div.ac-detail-head', h('h2', a.name), h('span.chip', a.role)), h('p', a.description),
          h('dl.kv.cols', [
            ['ENGINES', pow], ['MAX TAKEOFF WEIGHT', `${a.mass.maxTakeoff.toLocaleString('en-US')} kg`], ['WINGSPAN', `${a.geometry.span} m`],
            ['CRUISE', `${a.performance.cruise} kt`], ['STALL (Vs0 / Vs1)', `${a.performance.vs0} / ${a.performance.vs1} kt`], ['ROTATE (Vr)', `${a.performance.vr} kt`],
            ['CLIMB', `${a.performance.climbFpm} fpm`], ['CEILING', `${a.performance.ceiling.toLocaleString('en-US')} ft`], ['RANGE', `${a.performance.rangeNm} nm`],
            ['FUEL', a.fuel.unit === 'kg' ? `${a.fuel.tanks.reduce((s, t) => s + t.capacity, 0).toLocaleString('en-US')} kg ${a.fuel.type}` : `${a.fuel.tanks.reduce((s, t) => s + t.capacity, 0)} gal ${a.fuel.type}`],
            ['GEAR', a.gear.retractable ? 'Retractable tricycle' : 'Fixed tricycle'], ['COCKPIT', a.cockpit.layout === 'airliner' ? 'Glass (PFD/ND/EICAS, MCP)' : a.cockpit.layout === 'ga-twin' ? 'Analog twin + GPS + autopilot' : `Analog six-pack${a.avionics.gps ? ' + GPS' : ''}${a.avionics.autopilot ? ' + autopilot' : ''}`],
          ].map(([k, v]) => [h('dt', k), h('dd', v)])));
      };
      SIM.AircraftOrder.forEach((id) => {
        const a = SIM.AircraftData[id];
        const sel = this.cfg.aircraft === id;
        const card = h('article.ac-card', { className: sel ? 'selected' : '', tabIndex: 0 },
          h('div.ac-thumb', h('img', { src: SIM.ThumbnailRenderer.get(id), alt: `${a.name} render`, loading: 'lazy' })),
          h('div.ac-info',
            h('div.ac-role', a.role),
            h('h3', a.name),
            h('div.ac-specs',
              h('span', icon('wind'), `${a.performance.cruise} kt`),
              h('span', icon('weight'), a.capacity),
              h('span.diff', { title: `Difficulty ${a.difficulty}/5` }, [1, 2, 3, 4, 5].map((n) => h('i', { className: n <= a.difficulty ? 'on' : '' })))),
            h('button.btn.btn-sm', { className: sel ? 'btn-primary' : '', onclick: (e) => {
              e.stopPropagation();
              this.selectAircraft(id);
              this.show('aircraft');
            } }, sel ? 'SELECTED' : 'SELECT')));
        card.addEventListener('click', () => {
          this.selectAircraft(id);
          this.show('aircraft');
        });
        grid.append(card);
      });
      p.append(h('div.ac-layout', grid, detail));
      renderDetail();
    }

    selectAircraft(id) {
      this.set('aircraft', id);
      const a = SIM.AircraftData[id];
      this.set('payload', a.mass.defaultPayload);
    }

    /* ------------------------------------------------------------------ WORLD */

    page_world(p) {
      const c = this.cfg;
      const region = SIM.Regions[c.region];
      p.append(this.pageHead('World', 'Region, airport or location, weather, time of day and season.'));
      const regionTabs = h('div.seg.big', SIM.RegionOrder.map((id) => h('button.seg-btn', { type: 'button', className: c.region === id ? 'active' : '', onclick: () => {
        this.set('region', id);
        this.set('airport', SIM.Regions[id].defaultAirport);
        this.set('runway', SIM.AirportDB[SIM.Regions[id].defaultAirport].preferred);
        if (c.start === 'location') this.set('location', SIM.Regions[id].locations[0].id);
        this.show('world');
      } }, SIM.Regions[id].country)));
      const preview = new RegionPreview(region, c);
      const airports = h('div.list', region.airports.map((icao) => {
        const ap = SIM.AirportDB[icao];
        return h('button.list-item', { type: 'button', className: c.airport === icao && c.start !== 'location' ? 'active' : '', onclick: () => {
          this.set('airport', icao);
          this.set('runway', ap.preferred);
          if (c.start === 'location') this.set('start', 'runway');
          this.show('world');
        } }, h('span.mono.li-ident', icao), h('span.li-main', ap.name, h('small.muted', `${ap.city} · ${ap.elevFt} ft · RWY ${ap.runways.map((r) => r.ids.join('/')).join(', ')}`)));
      }));
      const locations = h('div.list', region.locations.map((l) => h('button.list-item', { type: 'button', className: c.start === 'location' && c.location === l.id ? 'active' : '', onclick: () => {
        this.set('start', 'location');
        this.set('location', l.id);
        this.show('world');
      } }, h('span.li-main', l.name, h('small.muted', `${l.desc} ${l.altFt} ft`)))));
      p.append(h('div.world-layout',
        h('div.world-col', regionTabs, h('p.muted', region.description), preview.canvas),
        h('div.world-col', h('h3.col-title', icon('plane'), 'AIRPORTS'), airports, h('h3.col-title', icon('crosshair'), 'LOCATIONS (AIR START)'), locations),
        h('div.world-col', this.weatherBlock(), this.timeBlock())));
      preview.draw();
    }

    weatherBlock() {
      const c = this.cfg;
      const cards = h('div.wx-grid', Object.entries(SIM.WeatherPresets).map(([id, w]) => h('button.wx-card', { type: 'button', className: c.weather === id ? 'active' : '', onclick: () => {
        this.set('weather', id);
        this.set('weatherCustom', null);
        this.show(this.section);
      } }, icon(id === 'clear' ? 'sun' : id === 'storm' ? 'bolt' : id === 'rain' ? 'cloud' : id === 'fog' ? 'layers' : 'cloud'), h('span', w.label), h('small.muted', `${w.windKt} kt · ${w.visibilityKm >= 10 ? '10+ km' : w.visibilityKm + ' km'}`))));
      const w = Object.assign({}, SIM.WeatherPresets[c.weather], c.weatherCustom || {});
      const slider = (label, key, min, max, step, fmt) => {
        const out = h('span.mono', fmt(w[key]));
        const input = h('input.range', { type: 'range', min, max, step, value: w[key], 'aria-label': label });
        input.addEventListener('input', () => {
          const custom = Object.assign({}, this.cfg.weatherCustom || {}, { [key]: Number(input.value) });
          this.set('weatherCustom', custom);
          out.textContent = fmt(Number(input.value));
        });
        return h('label.field', h('span', label, out), input);
      };
      return h('div.block', h('h3.col-title', icon('cloud'), 'WEATHER'), cards,
        h('details.adv', h('summary', 'Custom weather parameters'),
          slider('Wind direction', 'windDir', 0, 359, 1, (v) => `${Fmt.hdg(v)}°`),
          slider('Wind speed', 'windKt', 0, 45, 1, (v) => `${v} kt`),
          slider('Visibility', 'visibilityKm', 0.5, 80, 0.5, (v) => `${v} km`),
          slider('Cloud coverage', 'cloudCover', 0, 1, 0.01, (v) => `${Math.round(v * 8)}/8`),
          slider('Cloud base', 'cloudBaseFt', 300, 12000, 100, (v) => `${v} ft`),
          slider('Temperature', 'tempC', -20, 40, 1, (v) => `${v} °C`),
          slider('Pressure', 'qnh', 970, 1045, 1, (v) => `${v} hPa`)));
    }

    timeBlock() {
      const c = this.cfg;
      const out = h('span.mono', Fmt.clock(c.time));
      const slider = h('input.range', { type: 'range', min: 0, max: 23.99, step: 0.05, value: c.time, 'aria-label': 'Time of day' });
      const presets = h('div.seg.wrap', TIMES.map(([t, l]) => h('button.seg-btn', { type: 'button', className: Math.abs(c.time - t) < 0.3 ? 'active' : '', onclick: () => {
        this.set('time', t);
        this.show(this.section);
      } }, l)));
      slider.addEventListener('input', () => {
        this.set('time', Number(slider.value));
        out.textContent = Fmt.clock(Number(slider.value));
      });
      const seasons = h('div.seg.wrap', SEASONS.map(([s, l]) => h('button.seg-btn', { type: 'button', className: c.season === s ? 'active' : '', onclick: () => {
        this.set('season', s);
        this.show(this.section);
      } }, l)));
      return h('div.block', h('h3.col-title', icon('clock'), 'TIME & SEASON'), presets, h('label.field', h('span', 'Local time', out), slider), seasons,
        h('p.muted.small', SIM.Regions[c.region].hemisphere === 'S' ? 'Southern hemisphere: summer is December–February, snow line lower in winter.' : 'Northern hemisphere seasons.'));
    }

    /* ------------------------------------------------------------------ FREE FLIGHT */

    page_free(p) {
      const c = this.cfg;
      const a = SIM.AircraftData[c.aircraft];
      const region = SIM.Regions[c.region];
      const ap = SIM.AirportDB[c.airport];
      const seg = (key, options, rerender = true) => h('div.seg.wrap', options.map(([v, l]) => h('button.seg-btn', { type: 'button', className: String(c[key]) === String(v) ? 'active' : '', onclick: () => {
        this.set(key, v);
        if (rerender) this.show('free');
      } }, l)));
      p.append(this.pageHead('Free Flight', 'Every option below is applied to the simulation.'));
      const acSel = h('select.input', { 'aria-label': 'Aircraft' }, SIM.AircraftOrder.map((id) => h('option', { value: id, selected: id === c.aircraft }, SIM.AircraftData[id].name)));
      acSel.addEventListener('change', () => {
        this.selectAircraft(acSel.value);
        this.show('free');
      });
      const regSel = h('select.input', { 'aria-label': 'Region' }, SIM.RegionOrder.map((id) => h('option', { value: id, selected: id === c.region }, SIM.Regions[id].name)));
      regSel.addEventListener('change', () => {
        this.set('region', regSel.value);
        this.set('airport', SIM.Regions[regSel.value].defaultAirport);
        this.set('runway', SIM.AirportDB[SIM.Regions[regSel.value].defaultAirport].preferred);
        this.set('location', SIM.Regions[regSel.value].locations[0].id);
        this.show('free');
      });
      const apSel = h('select.input', { 'aria-label': 'Airport' }, region.airports.map((id) => h('option', { value: id, selected: id === c.airport }, `${id} — ${SIM.AirportDB[id].name}`)));
      apSel.addEventListener('change', () => {
        this.set('airport', apSel.value);
        this.set('runway', SIM.AirportDB[apSel.value].preferred);
        this.show('free');
      });
      const rwIds = ap.runways.flatMap((r) => r.ids);
      const rwSel = h('select.input', { 'aria-label': 'Runway' }, h('option', { value: 'auto', selected: c.runway === 'auto' }, 'AUTO (into wind)'), rwIds.map((id) => h('option', { value: id, selected: id === c.runway }, `RWY ${id}`)));
      rwSel.addEventListener('change', () => this.set('runway', rwSel.value));
      const locSel = h('select.input', { 'aria-label': 'Location' }, region.locations.map((l) => h('option', { value: l.id, selected: l.id === c.location }, `${l.name} (${l.altFt} ft)`)));
      locSel.addEventListener('change', () => this.set('location', locSel.value));

      const fuelOut = h('span.mono');
      const payloadOut = h('span.mono');
      const weightOut = h('div.weight-readout');
      const fuelIn = h('input.range', { type: 'range', min: 0.05, max: 1, step: 0.01, value: c.fuel, 'aria-label': 'Fuel' });
      const payIn = h('input.range', { type: 'range', min: 60, max: Math.max(100, a.mass.maxTakeoff - a.mass.empty), step: a.mass.maxTakeoff > 10000 ? 100 : 5, value: c.payload, 'aria-label': 'Payload' });
      const updWeight = () => {
        const cap = a.fuel.tanks.reduce((s, t) => s + t.capacity, 0);
        const fuelKg = cap * c.fuel * (a.fuel.unit === 'kg' ? 1 : SIM.Units.AVGAS_KG_PER_GAL);
        const gross = a.mass.empty + c.payload + fuelKg;
        fuelOut.textContent = `${Math.round(c.fuel * 100)}% · ${a.fuel.unit === 'kg' ? Math.round(cap * c.fuel) + ' kg' : (cap * c.fuel).toFixed(1) + ' gal'}`;
        payloadOut.textContent = `${Math.round(c.payload)} kg`;
        weightOut.innerHTML = '';
        weightOut.append(h('div.bar' + (gross > a.mass.maxTakeoff ? '.low' : ''), h('span', { style: { width: `${M.clamp(gross / a.mass.maxTakeoff, 0, 1) * 100}%` } })), h('span.mono', `GROSS ${Math.round(gross).toLocaleString('en-US')} / ${a.mass.maxTakeoff.toLocaleString('en-US')} kg${gross > a.mass.maxTakeoff ? ' — OVERWEIGHT' : ''}`));
      };
      fuelIn.addEventListener('input', () => {
        this.set('fuel', Number(fuelIn.value));
        updWeight();
      });
      payIn.addEventListener('input', () => {
        this.set('payload', Number(payIn.value));
        updWeight();
      });
      updWeight();

      const failBox = h('div.fail-custom');
      if (c.failures === 'custom') {
        const tmp = new SIM.FailureManager({ cfg: a }, 'off');
        tmp.available().forEach((f) => {
          const cur = (c.customFailures || []).find((x) => x.id === f.id);
          const chk = h('input', { type: 'checkbox', checked: !!cur });
          const mins = h('input.input.mini', { type: 'number', min: 0, max: 120, value: cur ? cur.minutes : 5, 'aria-label': `${f.label} minutes` });
          const save = () => {
            const list = (this.cfg.customFailures || []).filter((x) => x.id !== f.id);
            if (chk.checked) list.push({ id: f.id, minutes: Number(mins.value) || 0 });
            this.set('customFailures', list);
          };
          chk.addEventListener('change', save);
          mins.addEventListener('change', save);
          failBox.append(h('label.fail-item', chk, h('span', f.label), mins, h('small.muted', 'min after takeoff')));
        });
      }

      const row = (label, control, hint) => h('div.form-row', h('div.form-label', label, hint ? h('small.muted', hint) : null), h('div.form-control', control));
      p.append(h('div.free-layout',
        h('div.panel.form',
          h('h3.col-title', icon('plane'), 'AIRCRAFT & POSITION'),
          row('Aircraft', acSel),
          row('Region', regSel),
          row('Airport', apSel),
          row('Runway', rwSel),
          row('Start position', seg('start', START_TYPES)),
          c.start === 'location' ? row('Location', locSel) : null,
          h('h3.col-title', icon('weight'), 'LOAD'),
          row('Fuel', h('div', fuelIn, fuelOut)),
          row('Payload (people, bags)', h('div', payIn, payloadOut)),
          weightOut),
        h('div.panel.form',
          this.weatherBlock(),
          this.timeBlock()),
        h('div.panel.form',
          h('h3.col-title', icon('warning'), 'FAILURES'),
          row('Failures', seg('failures', [['off', 'OFF'], ['random', 'RANDOM'], ['custom', 'CUSTOM']])),
          c.failures === 'custom' ? failBox : h('p.muted.small', c.failures === 'random' ? 'Random failures may happen after 90 s of flight (engine, electrical, vacuum, pitot, fuel leak, gear...).' : 'No failures will occur.'),
          h('h3.col-title', icon('route'), 'TRAFFIC'),
          row('Air traffic', seg('traffic', TRAFFIC)),
          h('div.btn-row', h('button.btn.btn-primary.btn-lg.wide', { onclick: () => this.start() }, icon('play'), 'START FLIGHT')))));
    }

    /* ------------------------------------------------------------------ MISSIONS */

    page_missions(p) {
      const prog = SIM.Storage.load('progress.v1', { missions: {} });
      p.append(this.pageHead('Missions', 'Scored scenarios. Results are saved locally.'));
      const list = h('div.mission-list');
      const detail = h('div.mission-detail.panel');
      const showDetail = (m) => {
        const rec = prog.missions[m.id];
        const a = SIM.AircraftData[m.aircraft];
        detail.innerHTML = '';
        detail.append(h('div.ac-role', `${a.name} · ${m.airport}`), h('h2', m.title), h('p', m.briefing),
          h('ol.obj-list', m.objectives().map((o) => h('li', o.label))),
          h('dl.kv', [['WEATHER', SIM.WeatherPresets[m.weather].label], ['TIME', Fmt.clock(m.time)], ['TIME LIMIT', m.timeLimit ? Fmt.time(m.timeLimit) : '—'], ['BEST SCORE', rec ? String(rec.bestScore) : '—'], ['STATUS', rec && rec.completed ? 'COMPLETED' : 'NOT COMPLETED']].map(([k, v]) => [h('dt', k), h('dd', v)])),
          h('button.btn.btn-primary.btn-lg', { onclick: () => this.startMission(m) }, icon('play'), 'START MISSION'));
      };
      SIM.Missions.forEach((m, i) => {
        const rec = prog.missions[m.id];
        const item = h('button.mission-item', { type: 'button', onclick: () => {
          list.querySelectorAll('.mission-item').forEach((x) => x.classList.remove('active'));
          item.classList.add('active');
          showDetail(m);
        } },
        h('span.mi-num.mono', String(i + 1).padStart(2, '0')),
        h('span.mi-main', h('b', m.title), h('small.muted', m.subtitle)),
        h('span.diff', [1, 2, 3, 4, 5].map((n) => h('i', { className: n <= m.difficulty ? 'on' : '' }))),
        h('span.mi-score.mono', rec && rec.completed ? icon('check') : '', rec ? String(rec.bestScore) : ''));
        list.append(item);
        if (i === 0) {
          item.classList.add('active');
          showDetail(m);
        }
      });
      p.append(h('div.mission-layout', list, detail));
    }

    startMission(m) {
      this.app.audio.unlock();
      this.app.startFlight({
        aircraft: m.aircraft, region: m.region, airport: m.airport, runway: m.runway, start: m.start, location: null, missionLocation: m.location || null, startDistNm: m.startDistNm,
        weather: m.weather, weatherCustom: null, time: m.time, season: m.season, fuel: 0.75, payload: SIM.AircraftData[m.aircraft].mass.defaultPayload,
        failures: m.failures ? 'custom' : 'off', customFailures: m.failures || [], traffic: 'low',
      }, { mission: m });
    }

    /* ------------------------------------------------------------------ SETTINGS / CONTROLS / ABOUT */

    page_settings(p) {
      p.append(this.pageHead('Settings', 'Saved automatically in this browser.'));
      const box = h('div.panel.settings-box');
      p.append(box);
      SIM.SettingsView.render(box, this.app);
    }

    page_controls(p) {
      p.append(this.pageHead('Controls', 'Keyboard, gamepad / joystick (Gamepad API) and mouse.'));
      const box = h('div.panel.settings-box');
      p.append(box);
      SIM.ControlsView.render(box, this.app);
    }

    page_about(p) {
      const feats = [
        '6-DOF flight model: lift with post-stall, drag, thrust, gravity, ground effect, P-factor, torque, propwash, spins',
        'Five aircraft with their own aerodynamics, engines, systems and cockpits (C172, C152, PA-28, Baron 58, 737-800)',
        'Piston engines (mixture, carb ice, magnetos, starter, oil, EGT) and turbofans (N1/N2 spool, reversers)',
        'Electrical bus, alternator/battery, vacuum gyros, pitot icing, fuel tanks and selectors, flaps, retractable gear',
        'Interactive 2D cockpits with working switches, levers, knobs, radios, GPS, autopilot and glass displays',
        'Autopilot HDG / NAV / APR / ALT / VS with GPS, VOR and ILS guidance, autothrottle on the 737',
        'Procedural Central Chile (Andes, coastal range, Santiago, Valparaíso, Viña del Mar, Curacaví) and San Francisco Bay',
        '12 airports with runways, markings, taxiways, aprons, lighting and PAPI',
        'Weather (clear to storm), wind, gusts, turbulence, rain, fog, lightning; dynamic time of day and seasons',
        'ATC with ATIS, ground, tower, approach and CTAF; AI air traffic and road vehicles',
        'Missions with scoring, landing analysis, map with route editing, 8 cameras, Web Audio sound, gamepad support',
      ];
      p.append(this.pageHead('About', `${SIM.PRODUCT} ${SIM.VERSION}`),
        h('div.about-layout',
          h('div.panel', h('h3', 'What is implemented'), h('ul.feat-list', feats.map((f) => h('li', icon('check'), f)))),
          h('div.panel',
            h('h3', 'Data and limitations'),
            h('p', 'Terrain, coastlines, airports, frequencies and navaids are simplified approximations built from public coordinates. They are designed for an enjoyable, coherent simulation — never use them for real-world navigation.'),
            h('p', 'All textures and sounds are generated procedurally at runtime (canvas and Web Audio), so the simulator needs no binary assets. The 3D view uses Three.js r149 loaded from js/vendor or a CDN; without WebGL the simulator runs in instrument-only mode.'),
            h('h3', 'Technology'),
            h('p.muted', 'HTML5 · CSS3 · JavaScript ES2020 · Three.js · Canvas 2D · Web Audio API · Gamepad API · Speech Synthesis · localStorage')))
      );
    }
  }

  /* ================================================================== region preview */

  class RegionPreview {
    constructor(region, cfg) {
      this.region = region;
      this.cfg = cfg;
      this.canvas = h('canvas.region-preview', { 'aria-label': `${region.name} overview map` });
    }
    draw() {
      const W = 420, H = 300;
      const ctx = SIM.UI.fitCanvas(this.canvas, W, H);
      const r = this.region;
      const geo = new SIM.GeoProjection(r.origin[0], r.origin[1]);
      const b = r.bounds;
      const a = geo.toLocal(b.latMax, b.lonMin), c = geo.toLocal(b.latMin, b.lonMax);
      const sc = Math.min(W / (c.x - a.x), H / (c.z - a.z));
      const P = (lat, lon) => {
        const p = geo.toLocal(lat, lon);
        return [(p.x - a.x) * sc, (p.z - a.z) * sc];
      };
      ctx.fillStyle = '#7d8a6c';
      ctx.fillRect(0, 0, W, H);
      // ridges
      r.ridges.forEach((rg) => {
        ctx.strokeStyle = `rgba(${rg.height > 3000 ? '235,235,240' : '150,128,100'},${Math.min(0.9, rg.height / 3000)})`;
        ctx.lineWidth = rg.width * sc * 1.1;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        rg.pts.forEach((pt, i) => ctx[i ? 'lineTo' : 'moveTo'](...P(pt[0], pt[1])));
        ctx.stroke();
      });
      // ocean (west of the coast)
      ctx.fillStyle = '#2b4f6e';
      ctx.beginPath();
      ctx.moveTo(0, 0);
      r.coast.forEach((pt) => ctx.lineTo(...P(pt[0], pt[1])));
      ctx.lineTo(0, H);
      ctx.closePath();
      ctx.fill();
      (r.water || []).forEach((poly) => {
        ctx.beginPath();
        poly.forEach((pt, i) => ctx[i ? 'lineTo' : 'moveTo'](...P(pt[0], pt[1])));
        ctx.fill();
      });
      // roads
      ctx.strokeStyle = 'rgba(255,240,210,0.55)';
      ctx.lineWidth = 1;
      r.roads.forEach((rd) => {
        ctx.beginPath();
        rd.pts.forEach((pt, i) => ctx[i ? 'lineTo' : 'moveTo'](...P(pt[0], pt[1])));
        ctx.stroke();
      });
      // cities
      r.cities.forEach((ct) => {
        const [x, y] = P(ct.lat, ct.lon);
        ctx.fillStyle = 'rgba(200,196,188,0.8)';
        ctx.beginPath();
        ctx.arc(x, y, Math.max(2, ct.r * sc), 0, Math.PI * 2);
        ctx.fill();
        if (ct.r > 3000) {
          ctx.fillStyle = '#fff';
          ctx.font = '600 10px "Barlow Condensed", sans-serif';
          ctx.fillText(ct.name.toUpperCase(), x + 6, y - 4);
        }
      });
      // airports
      r.airports.forEach((id) => {
        const ap = SIM.AirportDB[id];
        const [x, y] = P(ap.lat, ap.lon);
        const sel = id === this.cfg.airport && this.cfg.start !== 'location';
        ctx.fillStyle = sel ? '#ffb43c' : '#bfe4ff';
        ctx.beginPath();
        ctx.arc(x, y, sel ? 5 : 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.font = `${sel ? 700 : 600} 10px "JetBrains Mono", monospace`;
        ctx.fillText(id, x + 6, y + 10);
      });
      if (this.cfg.start === 'location') {
        const l = r.locations.find((x) => x.id === this.cfg.location);
        if (l) {
          const [x, y] = P(l.lat, l.lon);
          ctx.strokeStyle = '#ffb43c';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(x, y, 7, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }
  }

  /* ================================================================== animated background */

  class MenuBackground {
    constructor(canvas, settings) {
      this.canvas = canvas;
      this.settings = settings;
      this.t = Math.random() * 100;
      this.running = false;
      this.layers = [0.35, 0.55, 0.75, 0.92].map((depth, i) => {
        const rnd = SIM.mulberry32(17 + i * 31);
        const pts = [];
        for (let x = 0; x <= 64; x++) {
          const n = SIM.Noise.ridged(x / (6 + i * 3), i * 3.1, 4, i + 2);
          pts.push(n * (0.25 + (1 - depth) * 0.55) + rnd() * 0.012);
        }
        return { depth, pts };
      });
      window.addEventListener('resize', () => this.resize());
      this.resize();
    }
    resize() {
      this.w = window.innerWidth;
      this.h = window.innerHeight;
      this.ctx = SIM.UI.fitCanvas(this.canvas, this.w, this.h, 0.75);
    }
    start() {
      if (this.running) return;
      this.running = true;
      let last = performance.now();
      const loop = (now) => {
        if (!this.running) return;
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        if (!this.settings.data.accessibility.reduceMotion) this.t += dt;
        this.draw();
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }
    stop() {
      this.running = false;
    }
    draw() {
      const { ctx, w, h: hh } = this;
      const t = this.t;
      const g = ctx.createLinearGradient(0, 0, 0, hh);
      g.addColorStop(0, '#0e1a2b');
      g.addColorStop(0.45, '#33435a');
      g.addColorStop(0.72, '#b8846a');
      g.addColorStop(1, '#f0c493');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, hh);
      // sun
      const sx = w * 0.72, sy = hh * 0.62;
      const sg = ctx.createRadialGradient(sx, sy, 0, sx, sy, hh * 0.35);
      sg.addColorStop(0, 'rgba(255,226,170,0.95)');
      sg.addColorStop(0.08, 'rgba(255,206,140,0.6)');
      sg.addColorStop(1, 'rgba(255,190,120,0)');
      ctx.fillStyle = sg;
      ctx.fillRect(0, 0, w, hh);
      // contrail plane
      const px = ((t * 18) % (w + 400)) - 200, py = hh * 0.22 + Math.sin(t * 0.1) * 10;
      const cg = ctx.createLinearGradient(px - 260, 0, px, 0);
      cg.addColorStop(0, 'rgba(255,255,255,0)');
      cg.addColorStop(1, 'rgba(255,255,255,0.45)');
      ctx.strokeStyle = cg;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px - 260, py + 4);
      ctx.lineTo(px, py);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillRect(px, py - 1, 4, 2);
      // mountain layers (Andes silhouettes) with parallax drift
      this.layers.forEach((L, i) => {
        const shift = (t * (2 + i * 3)) % (w / 16);
        const baseY = hh * (0.55 + L.depth * 0.32);
        const tone = 0.1 + L.depth * 0.12;
        ctx.fillStyle = `rgba(${Math.round(30 + 60 * (1 - L.depth))},${Math.round(36 + 50 * (1 - L.depth))},${Math.round(52 + 60 * (1 - L.depth))},${0.75 + tone})`;
        ctx.beginPath();
        ctx.moveTo(0, hh);
        const step = w / 60;
        for (let k = 0; k <= 64; k++) {
          const x = k * step - shift;
          ctx.lineTo(x, baseY - L.pts[k] * hh * 0.6);
        }
        ctx.lineTo(w, hh);
        ctx.closePath();
        ctx.fill();
        if (i === 0) {
          // snow caps on the far range
          ctx.strokeStyle = 'rgba(255,240,230,0.25)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      });
      const vg = ctx.createLinearGradient(0, 0, w, 0);
      vg.addColorStop(0, 'rgba(8,12,18,0.85)');
      vg.addColorStop(0.45, 'rgba(8,12,18,0.35)');
      vg.addColorStop(1, 'rgba(8,12,18,0.15)');
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, w, hh);
    }
  }

  SIM.MainMenu = MainMenu;
})(window.SIM);
