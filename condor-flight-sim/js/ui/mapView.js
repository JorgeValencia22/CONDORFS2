/**
 * Map system: MapRenderer draws a shaded-relief base map generated from the terrain plus roads,
 * cities, airports (real runway geometry), navaids, fixes, route, traffic and the aircraft.
 * MapOverlay is the full-screen interactive map (pan, zoom, select, direct-to, route editing).
 * The same renderer draws the cockpit mini-map (track-up).
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;
  const { h, icon, Fmt } = SIM.UI;
  const NM = SIM.Units.NM;
  const basemapCache = new Map();

  class MapRenderer {
    constructor(session) {
      this.s = session;
      this.terrain = session.world.terrain;
      this.region = session.world.region;
      this.geo = session.world.geo;
      this.roads = this.region.roads.map((r) => ({ type: r.type, pts: r.pts.map((ll) => this.geo.xz(ll)), loop: r.loop }));
      this.cities = this.terrain.cities;
    }

    /** Generates (or reuses) the shaded relief image for the region. */
    async buildBasemap(progress) {
      const key = this.region.id + ':' + this.terrain.season;
      if (basemapCache.has(key)) {
        this.basemap = basemapCache.get(key);
        return;
      }
      const t = this.terrain;
      const W = 640;
      const aspect = (t.maxZ - t.minZ) / (t.maxX - t.minX);
      const H = Math.round(W * aspect);
      const cx = (t.maxX - t.minX) / W;
      const heights = new Float32Array(W * H);
      const land = new Float32Array(W * H);
      for (let j = 0; j < H; j++) {
        const z = t.minZ + (j + 0.5) * cx;
        for (let i = 0; i < W; i++) {
          const x = t.minX + (i + 0.5) * cx;
          const L = t.landDistance(x, z);
          land[j * W + i] = L;
          heights[j * W + i] = L < 0 ? -1 : t.macroAt(x, z) * M.smoothstep(0, 1500, L);
        }
        if (j % 40 === 0) {
          progress && progress(j / H);
          await SIM.nextFrame();
        }
      }
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const ctx = c.getContext('2d');
      const img = ctx.createImageData(W, H);
      const ramp = [
        [0, [118, 140, 98]], [300, [140, 150, 104]], [800, [170, 158, 118]], [1500, [158, 130, 98]], [2500, [140, 118, 98]], [3500, [176, 170, 164]], [4500, [232, 234, 238]],
      ];
      const colorFor = (hh) => {
        for (let k = 0; k < ramp.length - 1; k++) {
          if (hh <= ramp[k + 1][0]) {
            const f = (hh - ramp[k][0]) / (ramp[k + 1][0] - ramp[k][0]);
            return ramp[k][1].map((v, n) => v + (ramp[k + 1][1][n] - v) * M.clamp(f, 0, 1));
          }
        }
        return ramp[ramp.length - 1][1];
      };
      for (let j = 0; j < H; j++) {
        for (let i = 0; i < W; i++) {
          const k = j * W + i;
          const o = k * 4;
          if (land[k] < 0) {
            const depth = M.clamp(-land[k] / 20000, 0, 1);
            img.data[o] = 38 - depth * 14;
            img.data[o + 1] = 74 - depth * 20;
            img.data[o + 2] = 104 - depth * 22;
            img.data[o + 3] = 255;
            continue;
          }
          const hh = heights[k];
          const hx = heights[k + (i < W - 1 ? 1 : 0)] - heights[k - (i > 0 ? 1 : 0)];
          const hz = heights[k + (j < H - 1 ? W : 0)] - heights[k - (j > 0 ? W : 0)];
          const shade = M.clamp(0.82 + (-hx * 0.7 - hz * 0.7) / (cx * 0.9), 0.45, 1.25);
          let col = colorFor(hh);
          const x = t.minX + (i + 0.5) * cx, z = t.minZ + (j + 0.5) * cx;
          const u = t.urbanAt(x, z);
          if (u > 0.25) col = col.map((v, n) => v + ([168, 160, 152][n] - v) * Math.min(1, u));
          img.data[o] = M.clamp(col[0] * shade, 0, 255);
          img.data[o + 1] = M.clamp(col[1] * shade, 0, 255);
          img.data[o + 2] = M.clamp(col[2] * shade, 0, 255);
          img.data[o + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      this.basemap = { canvas: c, minX: t.minX, minZ: t.minZ, mpp: cx };
      basemapCache.set(key, this.basemap);
      progress && progress(1);
    }

    /**
     * @param {CanvasRenderingContext2D} ctx
     * @param {object} v view {cx, cz, scale (px/m), rot (rad, track-up), w, h, mini}
     */
    draw(ctx, v, opts = {}) {
      const s = this.s;
      const nav = s.nav;
      ctx.save();
      ctx.fillStyle = '#1b2733';
      ctx.fillRect(0, 0, v.w, v.h);
      ctx.translate(v.w / 2, v.h / 2);
      ctx.rotate(-(v.rot || 0));
      const P = (x, z) => [(x - v.cx) * v.scale, (z - v.cz) * v.scale];
      // basemap
      if (this.basemap) {
        const b = this.basemap;
        const [x0, y0] = P(b.minX, b.minZ);
        ctx.imageSmoothingEnabled = true;
        ctx.globalAlpha = v.mini ? 0.85 : 1;
        ctx.drawImage(b.canvas, x0, y0, b.canvas.width * b.mpp * v.scale, b.canvas.height * b.mpp * v.scale);
        ctx.globalAlpha = 1;
      }
      const lw = (px) => px;
      // roads
      if (v.scale > 0.0012) {
        this.roads.forEach((r) => {
          ctx.strokeStyle = r.type === 'highway' ? 'rgba(250,236,200,0.75)' : 'rgba(240,240,236,0.45)';
          ctx.lineWidth = lw(r.type === 'highway' ? 1.6 : 1);
          ctx.beginPath();
          r.pts.forEach((p, i) => {
            const q = P(p[0], p[1]);
            if (i) ctx.lineTo(q[0], q[1]);
            else ctx.moveTo(q[0], q[1]);
          });
          if (r.loop) ctx.closePath();
          ctx.stroke();
        });
      }
      const upright = (fn, x, y) => {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(v.rot || 0);
        fn();
        ctx.restore();
      };
      const text = (str, x, y, color, size = 11, weight = 600, align = 'left') => {
        upright(() => {
          ctx.font = `${weight} ${size}px "Barlow Condensed", sans-serif`;
          ctx.textAlign = align;
          ctx.textBaseline = 'middle';
          ctx.lineWidth = 3;
          ctx.strokeStyle = 'rgba(10,14,18,0.75)';
          ctx.strokeText(str, 0, 0);
          ctx.fillStyle = color;
          ctx.fillText(str, 0, 0);
        }, x, y);
      };
      // cities
      if (!v.mini || v.scale > 0.004) {
        this.cities.forEach((c) => {
          const [x, y] = P(c.xz[0], c.xz[1]);
          if (c.r * v.scale > 4 || c.density > 0.8) text(c.name.toUpperCase(), x, y, 'rgba(255,255,255,0.75)', c.r > 6000 ? 13 : 10, 500, 'center');
        });
      }
      // airports
      s.airports.forEach((ap) => {
        const [x, y] = P(ap.x, ap.z);
        const sel = opts.selected && opts.selected.airport === ap;
        ap.runways.forEach((rw) => {
          const a = P(rw.ends[0].x, rw.ends[0].z), b = P(rw.ends[1].x, rw.ends[1].z);
          ctx.strokeStyle = sel ? '#ffd27a' : '#e9eef3';
          ctx.lineWidth = Math.max(2.5, rw.width * v.scale);
          ctx.beginPath();
          ctx.moveTo(a[0], a[1]);
          ctx.lineTo(b[0], b[1]);
          ctx.stroke();
        });
        ctx.strokeStyle = sel ? '#ffd27a' : '#7fc8ff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(9, Math.min(26, ap.runways[0].length * v.scale * 0.6)), 0, Math.PI * 2);
        ctx.stroke();
        text(ap.icao, x + 12, y - 12, sel ? '#ffd27a' : '#bfe4ff', v.mini ? 10 : 12, 700);
      });
      // navaids and fixes
      nav.db.forEach((w) => {
        if (w.type === 'APT') return;
        const [x, y] = P(w.x, w.z);
        if (Math.abs(x) > v.w * 1.5 || Math.abs(y) > v.h * 1.5) return;
        const sel = opts.selected === w;
        if (w.type === 'VOR') {
          ctx.strokeStyle = sel ? '#ffd27a' : '#6fd0ff';
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          for (let k = 0; k < 6; k++) {
            const a = (k / 6) * Math.PI * 2;
            ctx[k ? 'lineTo' : 'moveTo'](x + Math.cos(a) * 6, y + Math.sin(a) * 6);
          }
          ctx.closePath();
          ctx.stroke();
          if (!v.mini || v.scale > 0.003) text(w.ident, x + 8, y + 8, '#6fd0ff', 10, 600);
        } else if (!v.mini) {
          ctx.fillStyle = sel ? '#ffd27a' : '#d7d9dc';
          ctx.beginPath();
          ctx.moveTo(x, y - 5);
          ctx.lineTo(x + 4.5, y + 3.5);
          ctx.lineTo(x - 4.5, y + 3.5);
          ctx.fill();
          if (v.scale > 0.002) text(w.ident, x + 7, y + 4, '#d7d9dc', 9, 500);
        }
      });
      // route
      const route = nav.route;
      if (route.length) {
        const pos = s.aircraft.fm.pos;
        ctx.strokeStyle = '#e04de0';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        const start = nav.legFrom || pos;
        let p = P(start.x, start.z);
        ctx.moveTo(p[0], p[1]);
        route.slice(nav.activeLeg).forEach((w) => {
          p = P(w.x, w.z);
          ctx.lineTo(p[0], p[1]);
        });
        ctx.stroke();
        ctx.setLineDash([5, 5]);
        ctx.strokeStyle = 'rgba(224,77,224,0.5)';
        ctx.beginPath();
        route.slice(0, nav.activeLeg + 1).forEach((w, i) => {
          p = P(w.x, w.z);
          ctx[i ? 'lineTo' : 'moveTo'](p[0], p[1]);
        });
        ctx.stroke();
        ctx.setLineDash([]);
        route.forEach((w, i) => {
          const q = P(w.x, w.z);
          ctx.fillStyle = i === nav.activeLeg ? '#e04de0' : '#fff';
          ctx.beginPath();
          ctx.arc(q[0], q[1], 4, 0, Math.PI * 2);
          ctx.fill();
          if (!v.mini) text(`${i + 1}. ${w.ident}`, q[0] + 8, q[1] - 10, i === nav.activeLeg ? '#ff9cff' : '#fff', 11, 700);
        });
      }
      // traffic
      if (s.traffic) {
        s.traffic.contacts().forEach((t) => {
          const [x, y] = P(t.x, t.z);
          upright(() => {
            ctx.rotate((t.hdg * Math.PI) / 180 - (v.rot || 0));
            ctx.fillStyle = '#4fd6f0';
            ctx.beginPath();
            ctx.moveTo(0, -6);
            ctx.lineTo(4, 5);
            ctx.lineTo(0, 3);
            ctx.lineTo(-4, 5);
            ctx.fill();
          }, x, y);
          if (!v.mini) text(`${t.callsign} ${Math.round(t.altFt / 100)}`, x + 8, y + 9, '#4fd6f0', 9, 500);
        });
      }
      // aircraft
      const ac = s.aircraft;
      const [ax, ay] = P(ac.fm.pos.x, ac.fm.pos.z);
      upright(() => {
        ctx.rotate(ac.state.trueHeadingDeg * M.DEG - (v.rot || 0));
        ctx.fillStyle = '#ffcf3a';
        ctx.strokeStyle = '#1a1a1a';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(0, -11);
        ctx.lineTo(2, -3);
        ctx.lineTo(10, 2);
        ctx.lineTo(10, 4);
        ctx.lineTo(2, 2);
        ctx.lineTo(1.5, 8);
        ctx.lineTo(4, 10);
        ctx.lineTo(-4, 10);
        ctx.lineTo(-1.5, 8);
        ctx.lineTo(-2, 2);
        ctx.lineTo(-10, 4);
        ctx.lineTo(-10, 2);
        ctx.lineTo(-2, -3);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        // track line 2 minutes ahead
        const gs = ac.groundSpeed * 120 * v.scale;
        ctx.rotate((ac.state.trueTrackDeg - ac.state.trueHeadingDeg) * M.DEG);
        ctx.strokeStyle = 'rgba(255,207,58,0.6)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(0, -12);
        ctx.lineTo(0, -12 - gs);
        ctx.stroke();
        ctx.setLineDash([]);
      }, ax, ay);
      ctx.restore();
    }
  }

  /* ================================================================== full map overlay */

  class MapOverlay {
    constructor(ui) {
      this.ui = ui;
      this.root = h('div.map-overlay', { role: 'dialog', 'aria-label': 'Navigation map' });
      this.canvas = h('canvas.map-canvas');
      this.view = { cx: 0, cz: 0, scale: 0.004, rot: 0, w: 800, h: 600 };
      this.follow = true;
      this.selected = null;
      this.build();
    }

    build() {
      const top = h('div.map-topbar',
        h('div.map-title', icon('map'), h('span', 'NAVIGATION MAP')),
        (this.readout = h('div.map-readout.mono')),
        h('div.map-actions',
          (this.followBtn = h('button.btn.btn-sm.active', { onclick: () => this.toggleFollow(), title: 'Center on aircraft' }, icon('crosshair'), 'FOLLOW')),
          h('button.btn.btn-sm', { onclick: () => this.zoom(1.5), 'aria-label': 'Zoom in' }, icon('plus')),
          h('button.btn.btn-sm', { onclick: () => this.zoom(1 / 1.5), 'aria-label': 'Zoom out' }, icon('minus')),
          h('button.btn.btn-sm', { onclick: () => this.ui.toggleMap(false), 'aria-label': 'Close map' }, icon('close'), 'CLOSE  M')
        )
      );
      this.info = h('div.map-info.panel');
      this.search = h('input.input.map-search', { type: 'text', placeholder: 'Search airport, VOR or fix…', 'aria-label': 'Search waypoint' });
      this.searchResults = h('div.map-search-results');
      this.search.addEventListener('input', () => this.renderSearch());
      this.routePanel = h('div.map-route.panel');
      const side = h('div.map-side', h('div.panel.map-search-box', this.search, this.searchResults), this.info, this.routePanel);
      this.root.append(top, h('div.map-body', this.canvas, side));
      // interaction
      let drag = null;
      this.canvas.addEventListener('pointerdown', (e) => {
        drag = { x: e.clientX, y: e.clientY, cx: this.view.cx, cz: this.view.cz, moved: false };
        this.canvas.setPointerCapture(e.pointerId);
      });
      this.canvas.addEventListener('pointermove', (e) => {
        const r = this.canvas.getBoundingClientRect();
        this.cursor = this.toWorld(e.clientX - r.left, e.clientY - r.top);
        if (!drag) return;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) {
          drag.moved = true;
          this.setFollow(false);
        }
        this.view.cx = drag.cx - dx / this.view.scale;
        this.view.cz = drag.cz - dy / this.view.scale;
      });
      this.canvas.addEventListener('pointerup', (e) => {
        if (drag && !drag.moved) {
          const r = this.canvas.getBoundingClientRect();
          this.pick(e.clientX - r.left, e.clientY - r.top);
        }
        drag = null;
      });
      this.canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        this.zoom(e.deltaY < 0 ? 1.2 : 1 / 1.2);
      }, { passive: false });
    }

    toWorld(px, py) {
      return { x: this.view.cx + (px - this.view.w / 2) / this.view.scale, z: this.view.cz + (py - this.view.h / 2) / this.view.scale };
    }

    zoom(f) {
      this.view.scale = M.clamp(this.view.scale * f, 0.0003, 0.12);
    }

    toggleFollow() {
      this.setFollow(!this.follow);
    }

    setFollow(v) {
      this.follow = v;
      this.followBtn.classList.toggle('active', v);
    }

    pick(px, py) {
      const s = this.ui.session;
      let best = null, bd = 14;
      const P = (x, z) => [(x - this.view.cx) * this.view.scale + this.view.w / 2, (z - this.view.cz) * this.view.scale + this.view.h / 2];
      s.nav.db.forEach((w) => {
        const [x, y] = P(w.x, w.z);
        const d = Math.hypot(x - px, y - py);
        if (d < bd) {
          bd = d;
          best = w;
        }
      });
      this.select(best);
    }

    select(w) {
      this.selected = w;
      this.renderInfo();
    }

    renderInfo() {
      const w = this.selected;
      const s = this.ui.session;
      const nav = s.nav;
      this.info.innerHTML = '';
      if (!w) {
        this.info.append(h('div.muted', 'Click an airport, VOR or fix to select it. Drag to pan, wheel to zoom.'));
        return;
      }
      const p = s.aircraft.fm.pos;
      const dist = Math.hypot(w.x - p.x, w.z - p.z);
      const brg = nav.toMag(SIM.Geo.bearing(p.x, p.z, w.x, w.z));
      const rows = [
        ['TYPE', w.type === 'APT' ? 'AIRPORT' : w.type === 'VOR' ? 'VOR/DME' : 'FIX'],
        ['POSITION', `${SIM.Geo.formatLat(w.lat)} ${SIM.Geo.formatLon(w.lon)}`],
        ['BEARING', `${Fmt.hdg(brg)}° MAG`],
        ['DISTANCE', Fmt.dist(dist)],
      ];
      if (w.type === 'VOR') rows.push(['FREQUENCY', w.freq.toFixed(2)]);
      if (w.type === 'APT') {
        rows.push(['ELEVATION', `${w.elevFt} ft`]);
        rows.push(['RUNWAYS', w.airport.runways.map((r) => `${r.ids.join('/')} ${Math.round(r.length)}m`).join(' · ')]);
        const f = w.airport.def.freqs;
        rows.push(['RADIO', Object.entries(f).map(([k, v]) => `${k.toUpperCase()} ${v}`).join('  ')]);
      }
      this.info.append(
        h('div.map-info-head', h('div.map-info-ident', w.ident), h('div.map-info-name', w.name)),
        h('dl.kv', rows.map(([k, v]) => [h('dt', k), h('dd.mono', v)])),
        h('div.btn-row',
          h('button.btn.btn-primary.btn-sm', { onclick: () => nav.directTo(w) }, 'DIRECT TO'),
          h('button.btn.btn-sm', { onclick: () => nav.addToRoute(w) }, 'ADD TO ROUTE'),
          w.type === 'APT' ? h('button.btn.btn-sm', { onclick: () => { nav.setRoute([...nav.route.filter((r) => r !== w), w]); } }, 'SET DESTINATION') : null,
          w.type === 'VOR' ? h('button.btn.btn-sm', { onclick: () => { nav.radios.set('nav1', w.freq, 'active'); SIM.events.emit('notify', { text: `NAV1 ${w.freq.toFixed(2)} ${w.ident}`, level: 'info' }); } }, 'TUNE NAV1') : null
        )
      );
    }

    renderSearch() {
      const nav = this.ui.session.nav;
      this.searchResults.innerHTML = '';
      const q = this.search.value;
      if (!q) return;
      nav.search(q, 8).forEach((w) => {
        this.searchResults.append(h('button.search-item', { onclick: () => { this.select(w); this.setFollow(false); this.view.cx = w.x; this.view.cz = w.z; this.search.value = ''; this.searchResults.innerHTML = ''; } },
          h('span.mono', w.ident), h('span.muted', `${w.type} · ${w.name}`)));
      });
    }

    renderRoute() {
      const nav = this.ui.session.nav;
      const key = nav.route.map((w) => w.ident).join(',') + '|' + nav.activeLeg;
      if (key === this._routeKey) return;
      this._routeKey = key;
      this.routePanel.innerHTML = '';
      this.routePanel.append(h('div.panel-title', icon('route'), 'FLIGHT PLAN', h('button.btn.btn-xs', { onclick: () => nav.clearRoute(), disabled: !nav.route.length }, 'CLEAR')));
      if (!nav.route.length) {
        this.routePanel.append(h('div.muted', 'No route. Select waypoints on the map and use DIRECT TO or ADD TO ROUTE.'));
        return;
      }
      const list = h('ol.route-list');
      nav.route.forEach((w, i) => {
        list.append(h('li', { className: i === nav.activeLeg ? 'active' : '' },
          h('span.mono.route-ident', w.ident),
          h('span.muted.route-name', w.name),
          h('span.route-btns',
            h('button.icon-btn', { onclick: () => nav.moveInRoute(i, -1), 'aria-label': 'Move up' }, icon('up')),
            h('button.icon-btn', { onclick: () => nav.moveInRoute(i, 1), 'aria-label': 'Move down' }, icon('down')),
            h('button.icon-btn', { onclick: () => nav.directTo(w), 'aria-label': 'Direct to' }, icon('nav')),
            h('button.icon-btn', { onclick: () => nav.removeFromRoute(i), 'aria-label': 'Remove' }, icon('trash')))));
      });
      this.routePanel.append(list);
    }

    open() {
      const s = this.ui.session;
      if (!this.renderer || this.renderer.s !== s) {
        this.renderer = s.mapRenderer;
        this.view.scale = 0.004;
        this.selected = null;
      }
      this.setFollow(true);
      this.renderInfo();
      this._routeKey = null;
    }

    update() {
      if (!this.renderer) return;
      const s = this.ui.session;
      const r = this.canvas.parentElement.getBoundingClientRect();
      const w = Math.max(200, Math.floor(r.width - (this.root.querySelector('.map-side').offsetWidth || 0)));
      const hh = Math.max(200, Math.floor(r.height));
      if (w !== this.view.w || hh !== this.view.h) {
        this.view.w = w;
        this.view.h = hh;
        this.ctx = SIM.UI.fitCanvas(this.canvas, w, hh);
      }
      if (this.follow) {
        this.view.cx = s.aircraft.fm.pos.x;
        this.view.cz = s.aircraft.fm.pos.z;
      }
      this.renderer.draw(this.ctx, this.view, { selected: this.selected });
      this.drawScale();
      this.renderRoute();
      const g = s.nav.gps;
      const cur = this.cursor;
      let curTxt = '';
      if (cur) {
        const p = s.aircraft.fm.pos;
        const ll = s.world.geo.toGeo(cur.x, cur.z);
        curTxt = `CURSOR ${SIM.Geo.formatLat(ll.lat)} ${SIM.Geo.formatLon(ll.lon)} · ${Fmt.hdg(s.nav.toMag(SIM.Geo.bearing(p.x, p.z, cur.x, cur.z)))}° ${Fmt.dist(Math.hypot(cur.x - p.x, cur.z - p.z))}`;
      }
      this.readout.textContent = `${g.wp ? `→ ${g.wp.ident} ${Fmt.dist(g.dist)} ${Fmt.hdg(g.brg)}°` : 'NO ACTIVE WAYPOINT'}   ${curTxt}`;
    }

    drawScale() {
      const ctx = this.ctx;
      const targetPx = 120;
      const metersPerPx = 1 / this.view.scale;
      const nm = (targetPx * metersPerPx) / NM;
      const nice = [0.5, 1, 2, 5, 10, 20, 50, 100].find((n) => n >= nm) || 100;
      const px = (nice * NM) / metersPerPx;
      ctx.save();
      ctx.fillStyle = 'rgba(12,16,20,0.75)';
      ctx.fillRect(14, this.view.h - 38, px + 70, 26);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(22, this.view.h - 20);
      ctx.lineTo(22 + px, this.view.h - 20);
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = '600 12px "Barlow Condensed", sans-serif';
      ctx.fillText(`${nice} NM`, 30 + px, this.view.h - 20);
      // north arrow
      ctx.translate(this.view.w - 34, 40);
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.moveTo(0, -14);
      ctx.lineTo(7, 8);
      ctx.lineTo(0, 3);
      ctx.lineTo(-7, 8);
      ctx.fill();
      ctx.fillText('N', -3, 22);
      ctx.restore();
    }
  }

  SIM.MapRenderer = MapRenderer;
  SIM.MapOverlay = MapOverlay;
})(window.SIM);
