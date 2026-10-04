/**
 * ATCWindow — radio communications interface: tuned facility on COM1, context-sensitive pilot
 * requests, nearby frequencies (one-click tuning) and a scrolling transmissions log.
 */
(function (SIM) {
  'use strict';

  const { h, icon } = SIM.UI;
  const NM = SIM.Units.NM;

  class ATCWindow {
    constructor(session) {
      this.s = session;
      this.el = h('div.atc-window', { role: 'dialog', 'aria-label': 'Radio communications' });
      this.head = h('div.atc-head', icon('radio'), (this.facility = h('div.atc-facility')), h('button.icon-btn', { onclick: () => SIM.events.emit('action', { id: 'atc' }), 'aria-label': 'Close' }, icon('close')));
      this.requests = h('div.atc-requests');
      this.freqs = h('div.atc-freqs');
      this.log = h('div.atc-log', { 'aria-live': 'polite' });
      this.el.append(this.head, this.requests, this.freqs, this.log);
      this.lastKey = '';
      this.timer = 0;
      session.scope.on('atc:message', (m) => this.addMessage(m));
      session.atc.log.forEach((m) => this.addMessage(m));
    }

    addMessage(m) {
      const cls = m.from === 'PILOT' ? 'pilot' : m.from === 'ATIS' ? 'atis' : 'atc';
      const line = h(`div.atc-msg.${cls}`, h('span.atc-from', m.from === 'PILOT' ? 'YOU' : m.facility || m.from), h('span.atc-text', m.text));
      this.log.append(line);
      while (this.log.children.length > 40) this.log.firstChild.remove();
      this.log.scrollTop = this.log.scrollHeight;
    }

    update(dt) {
      this.timer -= dt;
      if (this.timer > 0) return;
      this.timer = 0.4;
      const atc = this.s.atc;
      const f = atc.tuned();
      const radios = this.s.nav.radios;
      const reqs = atc.requests();
      const key = (f ? f.name : '-') + '|' + reqs.map((r) => r.id).join(',') + '|' + radios.powered + '|' + radios.units.com1.active;
      if (key === this.lastKey) return;
      this.lastKey = key;
      this.facility.innerHTML = '';
      if (!radios.powered) {
        this.facility.append(h('span.atc-name', 'RADIO OFF'), h('span.muted', 'Turn on MASTER and AVIONICS'));
      } else {
        this.facility.append(h('span.atc-name', f ? f.name : 'NO STATION'), h('span.mono.muted', `COM1 ${radios.format('com1')}`));
      }
      this.requests.innerHTML = '';
      reqs.forEach((r) => this.requests.append(h('button.btn.btn-sm.atc-req', { onclick: () => {
        atc.request(r.id);
        this.lastKey = '';
      } }, r.label)));
      if (radios.powered && f && !reqs.length) this.requests.append(h('div.muted', 'No requests available in the current phase of flight.'));
      this.freqs.innerHTML = '';
      if (radios.powered) {
        const near = atc.nearbyFacilities(8);
        if (near.length) {
          this.freqs.append(h('div.atc-sub', 'NEARBY FREQUENCIES'));
          near.forEach(({ f: fac, d }) => this.freqs.append(h('button.atc-freq', { className: fac === f ? 'active' : '', onclick: () => {
            radios.set('com1', fac.freq, 'active');
            this.lastKey = '';
          }, title: 'Tune COM1' }, h('span.mono', fac.freq.toFixed(fac.freq.toFixed(3).endsWith('0') ? 2 : 3)), h('span', fac.name), h('span.muted.mono', `${(d / NM).toFixed(0)} nm`))));
        } else {
          this.freqs.append(h('div.muted', 'No ATC facilities in radio range.'));
        }
      }
    }
  }

  SIM.ATCWindow = ATCWindow;
})(window.SIM);
