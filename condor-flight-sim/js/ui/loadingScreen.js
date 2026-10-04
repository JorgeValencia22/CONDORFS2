/**
 * LoadingScreen — task-based progress (LOADING WORLD, LOADING AIRCRAFT, LOADING WEATHER,
 * INITIALIZING FLIGHT SYSTEMS) driven by the real TaskLoader.
 */
(function (SIM) {
  'use strict';

  const { h, icon } = SIM.UI;
  const GROUPS = ['LOADING WORLD', 'LOADING AIRCRAFT', 'LOADING WEATHER', 'INITIALIZING FLIGHT SYSTEMS'];
  const TIPS = [
    'Ctrl+E runs the automatic start checklist on the real switches — or start it yourself: MASTER, FUEL, MIXTURE RICH, IGNITION START.',
    'Hold R and press W/S to trim the elevator. A trimmed aircraft flies hands-off.',
    'Rotate the C172 at 55 KIAS and climb at 74 KIAS (Vy). Use right rudder on the takeoff roll.',
    'Tune COM1 to the tower frequency and press Tab to talk to ATC.',
    'The PAPI lights show two white and two red when you are on a 3° glide path.',
    'With the engine stopped, pitch for best glide: 68 KIAS in the C172.',
    'Carburettor ice is likely in humid air between −5 and 25 °C. Pull CARB HEAT if RPM drops.',
    'Press M for the map: click any airport or VOR for DIRECT TO.',
    'The Baron has constant-speed propellers: set RPM with the blue PROP levers (N / Shift+N).',
    'In the 737 the engines spool slowly: anticipate thrust changes several seconds ahead.',
  ];

  class LoadingScreen {
    constructor() {
      this.el = h('div.loading-screen', { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100 });
      this.rows = GROUPS.map((g) => h('li', h('span.ls-dot'), h('span', g)));
      this.bar = h('div.ls-bar-fill');
      this.pct = h('span.ls-pct.mono', '0%');
      this.label = h('div.ls-task.mono');
      this.title = h('h2.ls-title');
      this.sub = h('div.ls-sub');
      this.tip = h('p.ls-tip');
      this.el.append(h('div.ls-card',
        h('div.ls-brand', h('span.brand-mark'), h('span.brand-name', 'CÓNDOR'), h('span.brand-sub', 'FLIGHT SIMULATOR')),
        this.title, this.sub,
        h('ol.ls-groups', this.rows),
        h('div.ls-bar', this.bar),
        h('div.ls-foot', this.label, this.pct),
        h('div.ls-tipbox', icon('info'), this.tip)));
    }

    show(title, subtitle) {
      this.title.textContent = title;
      this.sub.textContent = subtitle;
      this.tip.textContent = TIPS[Math.floor(Math.random() * TIPS.length)];
      this.rows.forEach((r) => r.className = '');
      this.set({ progress: 0, group: GROUPS[0], label: 'Preparing…' });
      this.el.classList.add('visible');
    }

    set(info) {
      const p = Math.round(info.progress * 100);
      this.bar.style.width = p + '%';
      this.pct.textContent = p + '%';
      this.el.setAttribute('aria-valuenow', p);
      this.label.textContent = info.label;
      const gi = GROUPS.indexOf(info.group);
      this.rows.forEach((r, i) => {
        r.classList.toggle('done', info.group === 'READY' || (gi >= 0 && i < gi));
        r.classList.toggle('active', i === gi);
      });
    }

    hide() {
      this.el.classList.remove('visible');
    }
  }

  SIM.LoadingScreen = LoadingScreen;
  SIM.LoadingGroups = GROUPS;
})(window.SIM);
