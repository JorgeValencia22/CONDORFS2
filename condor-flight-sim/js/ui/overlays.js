/**
 * Flight overlays: pause menu, flight results (FLIGHT COMPLETE), crash screen, mission objective
 * tracker and mission result, plus the generic modal used for settings/controls during a flight.
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;
  const { h, icon, Fmt } = SIM.UI;

  function modal(cls, ...children) {
    return h(`div.overlay.${cls}`, { role: 'dialog', 'aria-modal': 'true' }, h('div.overlay-card', ...children));
  }

  /* ------------------------------------------------------------------ pause */

  class PauseMenu {
    constructor(ui) {
      this.ui = ui;
      this.content = h('div.pause-content');
      this.el = modal('pause-menu', h('div.pause-brand', h('span.brand-mark'), h('span', 'PAUSED')), this.content);
      this.showMain();
    }
    item(label, ic, fn, cls = '') {
      return h(`button.menu-item${cls}`, { type: 'button', onclick: fn }, icon(ic), h('span', label), icon('chevronRight', 'chev'));
    }
    showMain() {
      const ui = this.ui;
      this.el.classList.remove('wide');
      this.content.innerHTML = '';
      const s = ui.session;
      this.content.append(
        h('div.pause-info', h('div', s.aircraft.cfg.name), h('div.muted', `${s.region.name} · ${s.state.resumeState || ''}`)),
        h('nav.pause-items',
          this.item('RESUME', 'play', () => ui.resume(), '.primary'),
          this.item('CONTROLS', 'gamepad', () => this.showSub('controls')),
          this.item('SETTINGS', 'sliders', () => this.showSub('settings')),
          this.item('RESTART FLIGHT', 'restart', () => ui.app.restartFlight()),
          this.item('RETURN TO MENU', 'exit', () => ui.app.returnToMenu())),
        h('div.pause-hint.muted', 'Esc / P to resume'));
    }
    showSub(kind) {
      this.el.classList.add('wide');
      this.content.innerHTML = '';
      const body = h('div.pause-sub');
      if (kind === 'settings') SIM.SettingsView.render(body, this.ui.app, { inFlight: true });
      else SIM.ControlsView.render(body, this.ui.app);
      this.content.append(h('button.btn.btn-sm.back', { onclick: () => this.showMain() }, icon('chevronLeft'), 'BACK'), body);
    }
  }

  /* ------------------------------------------------------------------ results */

  function landingRating(vsFpm) {
    const v = Math.abs(vsFpm);
    if (v < 120) return { label: 'BUTTER', score: 100 };
    if (v < 240) return { label: 'SMOOTH', score: 88 };
    if (v < 400) return { label: 'FIRM', score: 70 };
    if (v < 650) return { label: 'HARD', score: 45 };
    return { label: 'VERY HARD', score: 15 };
  }

  function grade(score) {
    return score >= 900 ? 'S' : score >= 780 ? 'A' : score >= 640 ? 'B' : score >= 480 ? 'C' : score >= 300 ? 'D' : 'E';
  }

  class ResultsScreen {
    constructor(ui, data, { crashed = false } = {}) {
      this.ui = ui;
      const s = ui.session;
      const st = s.stats;
      const ld = s.lastLanding;
      const unit = s.aircraft.cfg.fuel.unit;
      const rows = [
        ['FLIGHT TIME', Fmt.time(st.flightTime)],
        ['DISTANCE', Fmt.dist(st.distance)],
        ['FUEL USED', Fmt.fuel(Math.max(0, st.fuelStart - s.aircraft.systems.totalFuel), unit)],
        ['MAX ALTITUDE', `${Fmt.alt(st.maxAlt)} ${Fmt.altUnit()}`],
        ['LANDING', ld ? `${ld.rating.label} · ${Math.round(ld.vsFpm)} fpm · ${ld.gLoad.toFixed(2)} g` : '—'],
        ['APPROACH SPEED', ld && ld.approachIas ? `${Math.round(ld.approachIas)} kt (Vref ${s.aircraft.cfg.performance.vref})` : '—'],
        ['RUNWAY', ld && ld.runwayEnd ? `${ld.airport} ${ld.runwayEnd}` : ld ? 'OFF-AIRPORT' : '—'],
        ['CENTRELINE DEVIATION', ld && ld.centerline != null ? `${Math.abs(ld.centerline).toFixed(1)} m ${ld.centerline > 0 ? 'R' : 'L'}` : '—'],
        ['TOUCHDOWN FROM THRESHOLD', ld && ld.fromThreshold != null ? `${Math.round(ld.fromThreshold)} m` : '—'],
        ['DAMAGE', `${Math.round(s.aircraft.damage * 100)}%`],
        ['ATC', s.atc.flags.violations.length ? s.atc.flags.violations.join(', ') : 'No violations'],
      ];
      const score = crashed ? 0 : s.computeScore();
      s.saveLogbook(score, crashed);
      this.el = modal('results',
        h('div.results-head', h('div.results-kicker', crashed ? 'FLIGHT TERMINATED' : 'FLIGHT COMPLETE'), h('h2', crashed ? s.aircraft.crashReason || 'Crash' : `${s.aircraft.cfg.name}`),
          h('div.results-score', h('div.score-grade', crashed ? '—' : grade(score)), h('div', h('div.score-num.mono', String(score)), h('div.muted', 'SCORE')))),
        h('dl.kv.results-kv', rows.map(([k, v]) => [h('dt', k), h('dd.mono', v)])),
        h('div.btn-row.center',
          h('button.btn', { onclick: () => ui.app.returnToMenu() }, icon('exit'), 'RETURN TO MENU'),
          h('button.btn.btn-primary', { onclick: () => ui.app.restartFlight() }, icon('restart'), 'FLY AGAIN'),
          crashed ? null : h('button.btn', { onclick: () => ui.closeResults() }, icon('play'), 'CONTINUE')));
    }
  }

  /* ------------------------------------------------------------------ crash */

  class CrashOverlay {
    constructor(ui, reason) {
      this.el = modal('crash',
        h('div.crash-kicker', icon('warning'), 'CRASH'),
        h('h2', reason || 'The aircraft was destroyed'),
        h('p.muted', 'Physics stopped. Review the results or try again.'),
        h('div.btn-row.center',
          h('button.btn.btn-primary', { onclick: () => ui.app.restartFlight() }, icon('restart'), 'RESTART FLIGHT'),
          h('button.btn', { onclick: () => ui.showResults(true) }, 'RESULTS'),
          h('button.btn', { onclick: () => ui.app.returnToMenu() }, icon('exit'), 'RETURN TO MENU')));
    }
  }

  /* ------------------------------------------------------------------ missions */

  class MissionHud {
    constructor(runner) {
      this.r = runner;
      this.el = h('div.mission-hud', h('div.mh-title', icon('target'), runner.def.title), (this.list = h('ol.mh-list')), (this.timer = h('div.mh-timer.mono')));
      this.lastIdx = -1;
    }
    update() {
      const r = this.r;
      if (r.index !== this.lastIdx) {
        this.lastIdx = r.index;
        this.list.innerHTML = '';
        r.objectives.forEach((o, i) => this.list.append(h('li', { className: i < r.index ? 'done' : i === r.index ? 'current' : '' }, icon(i < r.index ? 'check' : 'chevronRight'), o.label)));
      }
      const lim = r.def.timeLimit;
      this.timer.textContent = `${Fmt.time(r.time)}${lim ? ' / ' + Fmt.time(lim) : ''}`;
    }
  }

  class MissionResult {
    constructor(ui, e) {
      this.el = modal('results',
        h('div.results-head', h('div.results-kicker', e.success ? 'MISSION COMPLETE' : 'MISSION FAILED'), h('h2', e.mission.title),
          h('div.results-score', h('div.score-grade', e.success ? grade(e.score) : '—'), h('div', h('div.score-num.mono', String(e.score)), h('div.muted', `BEST ${e.record.bestScore}`)))),
        e.reason ? h('p.muted.center', e.reason) : null,
        h('dl.kv.results-kv', [['TIME', Fmt.time(e.time)], ['ATTEMPTS', String(e.record.attempts)], ['STATUS', e.record.completed ? 'COMPLETED' : 'NOT COMPLETED']].map(([k, v]) => [h('dt', k), h('dd.mono', v)])),
        h('div.btn-row.center',
          h('button.btn', { onclick: () => ui.app.returnToMenu() }, icon('exit'), 'RETURN TO MENU'),
          h('button.btn.btn-primary', { onclick: () => ui.app.restartFlight() }, icon('restart'), 'RETRY'),
          e.success ? h('button.btn', { onclick: () => ui.closeResults() }, icon('play'), 'KEEP FLYING') : null));
    }
  }

  SIM.Overlays = { PauseMenu, ResultsScreen, CrashOverlay, MissionHud, MissionResult, landingRating, grade, modal };
})(window.SIM);
