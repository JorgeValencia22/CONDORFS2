/**
 * ATCSystem — simulated air traffic control. Facilities (ATIS, Ground, Tower, Approach/Center and
 * CTAF) are reached by tuning COM1. The pilot picks context-sensitive requests; controllers answer
 * with standard phraseology based on the real situation: wind, runway in use, position, traffic.
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;
  const NM = SIM.Units.NM;
  const FT = SIM.Units.FT;

  const PHONETIC = 'Alfa Bravo Charlie Delta Echo Foxtrot Golf Hotel India Juliett Kilo Lima Mike November Oscar Papa Quebec Romeo Sierra Tango Uniform Victor Whiskey X-ray Yankee Zulu'.split(' ');
  const DIGITS = ['zero', 'one', 'two', 'tree', 'four', 'fife', 'six', 'seven', 'eight', 'niner'];

  /** Converts a string with digits to radio pronunciation ("17L" -> "one seven left"). */
  function spoken(str) {
    return String(str)
      .replace(/(\d)(L|R|C)\b/g, (m, d, s) => `${d} ${{ L: 'left', R: 'right', C: 'center' }[s]}`)
      .replace(/\d/g, (d) => ` ${DIGITS[+d]} `)
      .replace(/\./g, ' decimal ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const RANGES = { ATIS: 45, GND: 12, TWR: 30, APP: 90, CTR: 220, CTAF: 22 };

  class ATCSystem {
    constructor(session) {
      this.s = session;
      this.log = [];
      this.queue = [];
      this.state = { airport: null, taxi: false, takeoff: false, landing: false, inbound: false, downwind: false, flightFollowing: false, squawk: null, departedFrom: null };
      this.atisTimer = 0;
      this.lastTuned = null;
      this.flags = { violations: [] };
      const cfg = session.aircraft.cfg;
      this.cs = cfg.flightNumber ? `Condor ${cfg.flightNumber.replace(/\D/g, '')}` : cfg.registration;
      this.csShort = cfg.flightNumber ? this.cs : cfg.registration.slice(-3);
      this.csSpoken = cfg.flightNumber ? cfg.callsign : cfg.callsignFull;
      this.csShortSpoken = cfg.callsign;
      this.buildFacilities();
    }

    buildFacilities() {
      const list = [];
      this.s.airports.forEach((ap) => {
        const f = ap.def.freqs || {};
        const city = ap.def.city;
        if (f.atis) list.push({ type: 'ATIS', freq: f.atis, name: `${city} Information`, airport: ap });
        if (f.gnd) list.push({ type: 'GND', freq: f.gnd, name: `${city} Ground`, airport: ap });
        if (f.twr) list.push({ type: 'TWR', freq: f.twr, name: `${ap.def.type === 'military' ? ap.def.name.split(' ')[0] : city} Tower`, airport: ap });
        if (f.app) list.push({ type: 'APP', freq: f.app, name: `${city} Approach`, airport: ap });
        if (f.ctaf) list.push({ type: 'CTAF', freq: f.ctaf, name: `${city} Traffic`, airport: ap });
      });
      (this.s.nav.centers || []).forEach((c) => list.push({ type: 'CTR', freq: c.freq, name: c.name, x: c.x, z: c.z, airport: null }));
      this.facilities = list;
    }

    facilityPos(f) {
      return f.airport ? { x: f.airport.x, z: f.airport.z } : { x: f.x, z: f.z };
    }

    /** Facility currently tuned on COM1 and in radio range, or null. */
    tuned() {
      const radios = this.s.nav.radios;
      if (!radios.powered) return null;
      const freq = radios.units.com1.active;
      const p = this.s.aircraft.fm.pos;
      let best = null, bestD = Infinity;
      for (const f of this.facilities) {
        if (Math.abs(f.freq - freq) > 0.004) continue;
        const fp = this.facilityPos(f);
        const d = Math.hypot(fp.x - p.x, fp.z - p.z);
        if (d < RANGES[f.type] * NM && d < bestD) {
          best = f;
          bestD = d;
        }
      }
      return best;
    }

    /** Facilities sorted by distance, for the frequency list in the ATC window. */
    nearbyFacilities(limit = 10) {
      const p = this.s.aircraft.fm.pos;
      return this.facilities
        .map((f) => {
          const fp = this.facilityPos(f);
          return { f, d: Math.hypot(fp.x - p.x, fp.z - p.z) };
        })
        .filter((o) => o.d < RANGES[o.f.type] * NM * 1.5)
        .sort((a, b) => a.d - b.d)
        .slice(0, limit);
    }

    /* ------------------------------------------------------------------ helpers */

    weather() {
      return this.s.world.weather;
    }

    windText() {
      const w = this.weather().p;
      if (w.windKt < 3) return { text: 'wind calm', speech: 'wind calm' };
      const dir = String(M.wrap360(Math.round((w.windDir - this.s.region.magVar) / 10) * 10) || 360).padStart(3, '0');
      const gust = w.gustKt > 3 ? ` gusting ${Math.round(w.windKt + w.gustKt)}` : '';
      return { text: `wind ${dir} at ${Math.round(w.windKt)}${gust}`, speech: `wind ${spoken(dir)} at ${Math.round(w.windKt)}${gust}` };
    }

    runwayFor(ap) {
      const w = this.weather().p;
      return SIM.Airports.activeRunway(ap, w.windDir, w.windKt);
    }

    qnh() {
      return Math.round(this.weather().qnh);
    }

    atisLetter() {
      return PHONETIC[Math.floor(this.s.timeOfDay / 3600) % 26];
    }

    position() {
      const p = this.s.aircraft.fm.pos;
      return { x: p.x, z: p.z };
    }

    distTo(ap) {
      const p = this.position();
      return Math.hypot(ap.x - p.x, ap.z - p.z);
    }

    nearestAirport() {
      let best = null, bd = Infinity;
      for (const ap of this.s.airports) {
        const d = this.distTo(ap);
        if (d < bd) {
          bd = d;
          best = ap;
        }
      }
      return best;
    }

    /** Relative position phrase ("8 miles northwest of the field"). */
    relativePosition(ap) {
      const p = this.position();
      const brg = SIM.Geo.bearing(ap.x, ap.z, p.x, p.z);
      const dirs = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
      const d = Math.round(this.distTo(ap) / NM);
      return `${d} miles ${dirs[Math.round(brg / 45) % 8]} of ${ap.def.city}`;
    }

    /* ------------------------------------------------------------------ messaging */

    say(from, text, speech, facility, delay = 0) {
      this.queue.push({ t: delay, msg: { from, text, speech: speech || text, facility: facility ? facility.name : '', time: this.s.timeOfDay } });
    }

    pilot(text, facility) {
      this.say('PILOT', text, null, facility, 0);
    }

    controller(text, speech, facility, delay = 1.8 + Math.random() * 1.4) {
      this.say(facility.type === 'ATIS' ? 'ATIS' : 'ATC', text, speech, facility, delay);
    }

    /* ------------------------------------------------------------------ requests */

    requests() {
      const f = this.tuned();
      if (!f) return [];
      const ac = this.s.aircraft;
      const st = this.state;
      const onGround = ac.onGround;
      const list = [];
      const atThis = f.airport && this.distTo(f.airport) < 4 * NM;
      if (f.type === 'ATIS') return [{ id: 'atis', label: 'Listen to ATIS' }];
      if (f.type === 'CTAF') {
        if (onGround && atThis) list.push({ id: 'ctafTaxi', label: 'Announce: taxiing to runway' }, { id: 'ctafDepart', label: 'Announce: departing' });
        if (!onGround) list.push({ id: 'ctafInbound', label: 'Announce: inbound' }, { id: 'ctafDownwind', label: 'Announce: downwind' }, { id: 'ctafFinal', label: 'Announce: final' });
        if (onGround && st.landedAt === f.airport) list.push({ id: 'ctafClear', label: 'Announce: clear of runway' });
        return list;
      }
      if (f.type === 'GND' || (f.type === 'TWR' && !f.airport.def.freqs.gnd)) {
        if (onGround && atThis && !st.taxi) list.push({ id: 'taxi', label: 'Request taxi' });
      }
      if (f.type === 'GND' && onGround && atThis && st.taxi) list.push({ id: 'readyGnd', label: 'Ready for departure' });
      if (f.type === 'TWR') {
        if (onGround && atThis) {
          if (!st.takeoff) list.push({ id: 'ready', label: 'Ready for departure' });
          if (st.landedAt === f.airport) list.push({ id: 'vacated', label: 'Runway vacated' });
        } else if (!onGround) {
          if (st.departedFrom === f.airport && this.distTo(f.airport) < 12 * NM) list.push({ id: 'leaving', label: 'Leaving the zone / frequency change' });
          if (!st.inbound) list.push({ id: 'inbound', label: 'Inbound for landing' });
          if (st.inbound && !st.downwind && !st.landing) list.push({ id: 'downwind', label: 'Report downwind' });
          if (st.inbound && !st.landing) list.push({ id: 'final', label: 'Report final' }, { id: 'touchgo', label: 'Request touch and go' });
          if (st.landing) list.push({ id: 'goaround', label: 'Going around' });
        }
      }
      if ((f.type === 'APP' || f.type === 'CTR') && !onGround) {
        if (!st.flightFollowing) list.push({ id: 'following', label: 'Request flight following' });
        list.push({ id: 'vectors', label: `Request vectors to ${this.vectorTarget().def.icao}` });
        const dest = this.vectorTarget();
        if (dest.runways.some((r) => r.ends.some((e) => e.ils))) list.push({ id: 'ils', label: `Request ILS approach ${dest.def.icao}` });
        if (st.flightFollowing) list.push({ id: 'cancel', label: 'Cancel radar service' });
      }
      return list;
    }

    vectorTarget() {
      const dest = this.s.nav.destination;
      if (dest && dest.type === 'APT') return dest.airport;
      return this.nearestAirport();
    }

    request(id) {
      const f = this.tuned();
      if (!f) return;
      const ac = this.s.aircraft;
      const st = this.state;
      const cs = this.cs, csS = this.csShort;
      const ap = f.airport;
      const wind = this.windText();
      const sp = (t) => t; // helper for readability
      switch (id) {
        case 'atis':
          this.broadcastAtis(f);
          break;
        case 'taxi': {
          const rw = this.runwayFor(ap);
          this.pilot(`${f.name}, ${cs}, at the apron with information ${this.atisLetter()}, request taxi.`, f);
          this.controller(`${csS}, ${f.name}, taxi to holding point runway ${rw.id} via taxiway Alpha, QNH ${this.qnh()}.`,
            `${this.csShortSpoken}, ${f.name}, taxi to holding point runway ${spoken(rw.id)} via taxiway alfa, Q N H ${spoken(this.qnh())}.`, f);
          st.taxi = true;
          st.airport = ap;
          st.runway = rw;
          this.say('PILOT', `Taxi holding point runway ${rw.id} via Alpha, QNH ${this.qnh()}, ${csS}.`, null, f, 4.2);
          break;
        }
        case 'readyGnd':
          this.pilot(`${f.name}, ${csS}, holding point, ready.`, f);
          this.controller(`${csS}, contact tower ${ap.def.freqs.twr.toFixed(1)}.`, `${this.csShortSpoken}, contact tower ${spoken(ap.def.freqs.twr.toFixed(1))}.`, f);
          break;
        case 'ready': {
          const rw = st.runway && st.airport === ap ? st.runway : this.runwayFor(ap);
          this.pilot(`${f.name}, ${csS}, holding point runway ${rw.id}, ready for departure.`, f);
          const traffic = this.s.traffic ? this.s.traffic.onFinal(ap, 3 * NM) : null;
          if (traffic) {
            this.controller(`${csS}, hold short runway ${rw.id}, traffic on short final.`, `${this.csShortSpoken}, hold short runway ${spoken(rw.id)}, traffic on short final.`, f);
            st.pendingTakeoff = { f, rw, t: 25 };
          } else {
            this.clearTakeoff(f, rw);
          }
          break;
        }
        case 'leaving':
          this.pilot(`${f.name}, ${csS}, leaving the control zone, request frequency change.`, f);
          this.controller(`${csS}, frequency change approved, good day.`, `${this.csShortSpoken}, frequency change approved, good day.`, f);
          st.departedFrom = null;
          break;
        case 'inbound': {
          const rw = this.runwayFor(ap);
          st.runway = rw;
          st.airport = ap;
          st.inbound = true;
          this.pilot(`${f.name}, ${cs}, ${this.relativePosition(ap)}, ${Math.round(ac.state.altFt / 100) * 100} feet, inbound for landing with information ${this.atisLetter()}.`, f);
          const side = 'left';
          this.controller(`${csS}, ${f.name}, join ${side} downwind runway ${rw.id}, ${wind.text}, QNH ${this.qnh()}, report downwind.`,
            `${this.csShortSpoken}, ${f.name}, join ${side} downwind runway ${spoken(rw.id)}, ${wind.speech}, Q N H ${spoken(this.qnh())}, report downwind.`, f);
          break;
        }
        case 'downwind': {
          st.downwind = true;
          const rw = st.runway || this.runwayFor(ap);
          this.pilot(`${f.name}, ${csS}, downwind runway ${rw.id}.`, f);
          const n = this.s.traffic ? this.s.traffic.inPattern(ap).length : 0;
          this.controller(`${csS}, number ${n + 1}${n ? ', follow the traffic on base' : ''}, report final.`, `${this.csShortSpoken}, number ${n + 1}${n ? ', follow the traffic on base' : ''}, report final.`, f);
          break;
        }
        case 'final':
        case 'touchgo': {
          const rw = st.runway || this.runwayFor(ap);
          this.pilot(`${f.name}, ${csS}, final runway ${rw.id}${id === 'touchgo' ? ', request touch and go' : ''}.`, f);
          const verb = id === 'touchgo' ? 'cleared touch and go' : 'cleared to land';
          this.controller(`${csS}, runway ${rw.id}, ${wind.text}, ${verb}.`, `${this.csShortSpoken}, runway ${spoken(rw.id)}, ${wind.speech}, ${verb}.`, f);
          st.landing = true;
          st.inbound = true;
          st.runway = rw;
          st.airport = ap;
          this.say('PILOT', `${verb.charAt(0).toUpperCase() + verb.slice(1)} runway ${rw.id}, ${csS}.`, null, f, 4.5);
          break;
        }
        case 'goaround':
          this.pilot(`${f.name}, ${csS}, going around.`, f);
          this.controller(`${csS}, roger, climb runway heading to ${Math.round((ap.elev / FT + 1500) / 100) * 100} feet, report downwind.`, null, f);
          st.landing = false;
          st.downwind = false;
          break;
        case 'vacated':
          this.pilot(`${f.name}, ${csS}, runway vacated.`, f);
          this.controller(`${csS}, ${ap.def.freqs.gnd ? `contact ground ${ap.def.freqs.gnd.toFixed(2)}` : 'taxi to the apron'}, good day.`, null, f);
          this.resetAfterLanding();
          break;
        case 'following': {
          const code = 4000 + Math.floor(Math.random() * 700);
          const sq = String(code).replace(/[89]/g, '7');
          st.squawk = Number(sq);
          st.flightFollowing = true;
          this.pilot(`${f.name}, ${cs}, ${Math.round(ac.state.altFt / 100) * 100} feet, request flight following.`, f);
          this.controller(`${csS}, squawk ${sq}.`, `${this.csShortSpoken}, squawk ${spoken(sq)}.`, f);
          this.say('ATC', `${csS}, radar contact, ${this.relativePosition(this.nearestAirport())}. Altimeter ${this.qnh()}.`, null, f, 9);
          st.squawkCheck = 40;
          break;
        }
        case 'vectors':
        case 'ils': {
          const dest = this.vectorTarget();
          const rw = this.runwayFor(dest);
          // Vector toward a point 8 NM out on the extended centreline
          const fx = rw.x - rw.dirX * 8 * NM, fz = rw.z - rw.dirZ * 8 * NM;
          const p = this.position();
          const hdg = M.wrap360(Math.round(this.s.nav.toMag(SIM.Geo.bearing(p.x, p.z, fx, fz)) / 5) * 5);
          const alt = Math.max(Math.round((dest.elev / FT + 2500) / 500) * 500, Math.round(ac.state.altFt / 500) * 500 - 2000);
          const hdgS = String(hdg || 360).padStart(3, '0');
          this.pilot(`${f.name}, ${csS}, request ${id === 'ils' ? 'ILS approach' : 'vectors'} to ${dest.def.icao}.`, f);
          this.controller(`${csS}, fly heading ${hdgS}, descend and maintain ${alt} feet, expect ${id === 'ils' && rw.ils ? 'ILS' : 'visual'} approach runway ${rw.id}${rw.ils ? `, ILS frequency ${rw.ils.freq.toFixed(2)}` : ''}.`,
            `${this.csShortSpoken}, fly heading ${spoken(hdgS)}, descend and maintain ${alt} feet, expect ${id === 'ils' && rw.ils ? 'I L S' : 'visual'} approach runway ${spoken(rw.id)}.`, f);
          st.vector = { hdg, alt, dest, rw };
          break;
        }
        case 'cancel':
          this.pilot(`${f.name}, ${csS}, cancel radar service.`, f);
          this.controller(`${csS}, radar service terminated, squawk VFR, frequency change approved.`, null, f);
          st.flightFollowing = false;
          st.squawk = null;
          break;
        case 'ctafTaxi':
        case 'ctafDepart':
        case 'ctafInbound':
        case 'ctafDownwind':
        case 'ctafFinal':
        case 'ctafClear': {
          const rw = this.runwayFor(ap);
          const txt = {
            ctafTaxi: `taxiing to runway ${rw.id}`,
            ctafDepart: `departing runway ${rw.id}`,
            ctafInbound: `${this.relativePosition(ap)}, inbound for landing`,
            ctafDownwind: `left downwind runway ${rw.id}`,
            ctafFinal: `final runway ${rw.id}, full stop`,
            ctafClear: `clear of runway ${rw.id}`,
          }[id];
          this.pilot(`${f.name}, ${cs}, ${txt}, ${f.name}.`, f);
          if (id === 'ctafDepart') {
            st.takeoff = true;
            st.airport = ap;
          }
          if (id === 'ctafFinal') st.landing = true;
          if (id === 'ctafClear') this.resetAfterLanding();
          break;
        }
        default:
          sp(id);
      }
    }

    clearTakeoff(f, rw) {
      const wind = this.windText();
      this.controller(`${this.csShort}, ${wind.text}, runway ${rw.id}, cleared for takeoff.`, `${this.csShortSpoken}, ${wind.speech}, runway ${spoken(rw.id)}, cleared for take off.`, f);
      this.say('PILOT', `Runway ${rw.id}, cleared for takeoff, ${this.csShort}.`, null, f, 5.2);
      this.state.takeoff = true;
      this.state.airport = f.airport;
      this.state.runway = rw;
    }

    broadcastAtis(f) {
      const ap = f.airport;
      const rw = this.runwayFor(ap);
      const w = this.weather();
      const metar = w.metar(ap.def.icao, this.s.region.magVar);
      const letter = this.atisLetter();
      const vis = w.p.visibilityKm >= 10 ? 'visibility one zero kilometers or more' : `visibility ${w.p.visibilityKm.toFixed(1)} kilometers`;
      const t = Math.round(w.p.tempC);
      const text = `${f.name}, information ${letter}. ${metar}. Runway in use ${rw.id}${rw.ils ? ', expect ILS approach' : ''}. ${this.windText().text}, ${vis}, temperature ${t}, QNH ${this.qnh()}. Advise on initial contact you have information ${letter}.`;
      const speech = `${f.name}, information ${letter}. Runway in use ${spoken(rw.id)}. ${this.windText().speech}, ${vis}, temperature ${t}, Q N H ${spoken(this.qnh())}. Advise on initial contact you have information ${letter}.`;
      this.say('ATIS', text, speech, f, 0.6);
    }

    resetAfterLanding() {
      const st = this.state;
      st.taxi = false;
      st.takeoff = false;
      st.landing = false;
      st.inbound = false;
      st.downwind = false;
      st.landedAt = null;
    }

    /* ------------------------------------------------------------------ events */

    onLiftoff() {
      const st = this.state;
      const ap = this.nearestAirport();
      if (!ap || this.distTo(ap) > 3 * NM) return;
      st.departedFrom = ap;
      const towered = !!ap.def.freqs.twr;
      if (towered && !(st.takeoff && st.airport === ap)) {
        this.flags.violations.push('Takeoff without clearance');
        const twr = this.facilities.find((f) => f.airport === ap && f.type === 'TWR');
        const tuned = this.tuned();
        if (tuned && tuned.airport === ap) this.controller(`${this.csShort}, you departed without a takeoff clearance. Report on the ground when able... continue on runway heading.`, null, twr);
        else SIM.events.emit('notify', { text: 'DEPARTED WITHOUT ATC CLEARANCE', level: 'warn' });
      }
      st.takeoff = false;
      st.taxi = false;
    }

    onTouchdown() {
      const st = this.state;
      const ap = this.nearestAirport();
      if (!ap || this.distTo(ap) > 3 * NM) return;
      if (ap.def.freqs.twr && !(st.landing && st.airport === ap)) {
        this.flags.violations.push('Landing without clearance');
        SIM.events.emit('notify', { text: 'LANDED WITHOUT ATC CLEARANCE', level: 'warn' });
      }
      st.landedAt = ap;
      st.vacateCall = ap.def.freqs.twr && st.landing ? 1 : 0;
    }

    update(dt) {
      const st = this.state;
      // Deliver queued messages
      for (let i = this.queue.length - 1; i >= 0; i--) {
        const q = this.queue[i];
        q.t -= dt;
        if (q.t <= 0) {
          this.queue.splice(i, 1);
          this.log.push(q.msg);
          if (this.log.length > 60) this.log.shift();
          SIM.events.emit('atc:message', q.msg);
        }
      }
      const tuned = this.tuned();
      if (tuned !== this.lastTuned) {
        this.lastTuned = tuned;
        this.atisTimer = 0.5;
        SIM.events.emit('atc:tuned', { facility: tuned });
      }
      // ATIS loops while tuned
      if (tuned && tuned.type === 'ATIS') {
        this.atisTimer -= dt;
        if (this.atisTimer <= 0) {
          this.atisTimer = 45;
          this.broadcastAtis(tuned);
        }
      }
      // Pending takeoff clearance after traffic lands
      if (st.pendingTakeoff) {
        st.pendingTakeoff.t -= dt;
        if (st.pendingTakeoff.t <= 0) {
          const p = st.pendingTakeoff;
          st.pendingTakeoff = null;
          if (tuned === p.f) this.clearTakeoff(p.f, p.rw);
        }
      }
      // Vacate instruction after landing roll
      if (st.vacateCall && this.s.aircraft.state.gsKt < 35 && tuned && tuned.type === 'TWR') {
        st.vacateCall = 0;
        const ap = tuned.airport;
        this.controller(`${this.csShort}, vacate runway via next taxiway${ap.def.freqs.gnd ? `, contact ground ${ap.def.freqs.gnd.toFixed(2)}` : ''}.`, null, tuned);
      }
      // Squawk compliance check
      if (st.squawkCheck) {
        st.squawkCheck -= dt;
        if (st.squawkCheck <= 0) {
          st.squawkCheck = 0;
          const radios = this.s.nav.radios;
          if (st.squawk && radios.xpdr.code !== st.squawk && tuned && (tuned.type === 'APP' || tuned.type === 'CTR')) {
            this.controller(`${this.csShort}, verify squawk ${st.squawk}.`, null, tuned);
            st.squawkCheck = 60;
          }
        }
      }
    }
  }

  SIM.ATCSystem = ATCSystem;
  SIM.spoken = spoken;
})(window.SIM);
