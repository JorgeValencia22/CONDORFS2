/**
 * AirportRenderer — 3D airports from the runtime layouts: runways with ICAO-style markings,
 * designators, taxiways with centrelines, aprons with stands, terminal/hangars/tower buildings,
 * windsocks, runway/taxi/approach lighting and working PAPI lights.
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;
  const RU = () => SIM.RenderUtils;

  class AirportRenderer {
    constructor(scene, airports, terrain) {
      this.scene = scene;
      this.airports = airports;
      this.terrain = terrain;
      this.group = new THREE.Group();
      this.group.name = 'airports';
      scene.add(this.group);
      this.papis = [];
      this.windsocks = [];
      this.lightMats = [];
      this.beacons = [];
      const asphalt = SIM.Textures.get('asphalt');
      this.mat = {
        runway: new THREE.MeshLambertMaterial({ map: asphalt, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
        taxi: new THREE.MeshLambertMaterial({ map: asphalt, color: 0xd9d6cf, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
        apron: new THREE.MeshLambertMaterial({ map: SIM.Textures.get('concrete'), polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
        white: new THREE.MeshLambertMaterial({ color: 0xeeeeea, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
        yellow: new THREE.MeshLambertMaterial({ color: 0xd9b23a, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
        building: new THREE.MeshLambertMaterial({ color: 0xc9c6bd }),
        hangar: new THREE.MeshLambertMaterial({ color: 0x9aa3a8 }),
        roof: new THREE.MeshLambertMaterial({ color: 0x7c8388 }),
        glass: new THREE.MeshPhongMaterial({ color: 0x2b4a5c, specular: 0x99aabb, shininess: 60, emissive: 0x000000 }),
        tower: new THREE.MeshLambertMaterial({ color: 0xd8d4c8 }),
        sock: new THREE.MeshLambertMaterial({ color: 0xff6a1a }),
        pole: new THREE.MeshLambertMaterial({ color: 0x777777 }),
      };
    }

    build() {
      this.airports.forEach((ap) => this.buildAirport(ap));
    }

    buildAirport(ap) {
      const g = new THREE.Group();
      g.name = ap.icao;
      const y = ap.elev;
      const flat = RU().flatQuadGeometry();
      const mtx = new THREE.Matrix4();
      const white = [], yellow = [];
      const lights = [];
      const addLight = (x, z, r, gg, b, s = 1, h = 0.5) => lights.push({ x, y: y + h, z, r, g: gg, b, s });

      ap.runways.forEach((rw) => {
        // Pavement
        const rm = new THREE.Mesh(flat, this.mat.runway.clone());
        rm.material.map = this.mat.runway.map.clone();
        rm.material.map.needsUpdate = true;
        rm.material.map.repeat.set(rw.width / 30, rw.length / 30);
        RU().flatMatrix(mtx, rw.cx, y + 0.12, rw.cz, rw.hdg, rw.width, rw.length + 20);
        rm.applyMatrix4(mtx);
        rm.receiveShadow = true;
        g.add(rm);
        const d = { x: rw.dx, z: rw.dz };
        const n = { x: -rw.dz, z: rw.dx };
        const at = (along, across) => ({ x: rw.cx + d.x * along + n.x * across, z: rw.cz + d.z * along + n.z * across });
        const half = rw.length / 2;
        const w = rw.width;
        const mark = (list, along, across, mw, ml) => {
          const p = at(along, across);
          list.push({ x: p.x, z: p.z, w: mw, l: ml, h: rw.hdg });
        };
        // edge lines and centreline
        mark(white, 0, w / 2 - 1.2, 0.9, rw.length - 2);
        mark(white, 0, -w / 2 + 1.2, 0.9, rw.length - 2);
        for (let s = -half + 80; s < half - 80; s += 50) mark(white, s + 15, 0, 0.9, 30);

        rw.ends.forEach((e, k) => {
          const sign = k === 0 ? 1 : -1; // along-direction into the runway from this end
          const startAlong = sign > 0 ? -half : half;
          const into = (dist) => startAlong + sign * dist;
          // threshold bars
          const bars = w >= 45 ? 12 : w >= 30 ? 8 : w >= 23 ? 6 : 4;
          const barW = 1.8, gap = (w - 6) / bars;
          for (let b = 0; b < bars; b++) {
            const across = -w / 2 + 3 + gap * (b + 0.5) + (b >= bars / 2 ? 1.5 : -1.5);
            mark(white, into(21), across * 0.92, barW, 30);
          }
          // designator label
          const label = new THREE.Mesh(flat, new THREE.MeshLambertMaterial({ map: SIM.Textures.runwayLabel(e.id), transparent: true, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, depthWrite: false }));
          const lp = at(into(58), 0);
          RU().flatMatrix(mtx, lp.x, y + 0.14, lp.z, e.hdg, Math.min(w * 0.36, 12), Math.min(w * 0.72, 24));
          label.applyMatrix4(mtx);
          g.add(label);
          // touchdown zone and aiming point
          if (rw.length >= 1200) {
            const pattern = [3, 3, 2, 2, 1, 1];
            pattern.forEach((cnt, i) => {
              const dist = 150 * (i + 1);
              if (dist === 300 || dist > half - 100) return;
              for (let s = 0; s < cnt; s++) {
                const off = w / 2 - 6 - s * 2.6;
                mark(white, into(dist + 11), off * 0.85, 1.8, 22.5);
                mark(white, into(dist + 11), -off * 0.85, 1.8, 22.5);
              }
            });
          }
          const aim = rw.length >= 2400 ? 400 : rw.length >= 1200 ? 300 : 150;
          mark(white, into(aim + 22), w * 0.26, w >= 45 ? 9 : 5, w >= 45 ? 45 : 30);
          mark(white, into(aim + 22), -w * 0.26, w >= 45 ? 9 : 5, w >= 45 ? 45 : 30);

          // Lights: threshold (green) and runway end (red)
          for (let s = -w / 2; s <= w / 2 + 0.01; s += Math.max(3, w / 10)) {
            const pg = at(into(-1.5), s);
            addLight(pg.x, pg.z, 0.2, 1, 0.45, 1.1);
            const pr = at(into(1.5), s);
            addLight(pr.x, pr.z, 1, 0.15, 0.1, 0.9);
          }
          // Approach lighting for instrument runways
          if (e.ils) {
            for (let dist = 30; dist <= 720; dist += 30) {
              for (let s = -2; s <= 2; s++) {
                const p = at(into(-dist), s * 1.2);
                addLight(p.x, p.z, 1, 0.95, 0.85, 1.0, 1 + dist * 0.005);
              }
              if (dist === 300) for (let s = -15; s <= 15; s += 2.5) {
                const p = at(into(-dist), s);
                addLight(p.x, p.z, 1, 0.95, 0.85, 1.0, 2);
              }
            }
          }
          // PAPI (left side, 300 m in)
          const papiAlong = into(Math.min(300, rw.length * 0.25));
          const papi = [];
          for (let i = 0; i < 4; i++) {
            const p = at(papiAlong, sign * -(w / 2 + 15 + i * 9));
            papi.push({ x: p.x, y: y + 1, z: p.z });
          }
          this.papis.push({ lights: papi, elev: y, thresholds: [3.5, 3.17, 2.83, 2.5], points: null });
          // windsock near each threshold (one per runway)
          if (k === 0) {
            const sp = at(into(150), (w / 2 + 70) * -sign);
            this.addWindsock(g, sp.x, y, sp.z);
          }
        });
        // runway edge lights
        for (let s = -half; s <= half + 0.1; s += 60) {
          const a = at(s, w / 2 + 2), b = at(s, -w / 2 - 2);
          addLight(a.x, a.z, 1, 0.97, 0.88, 1);
          addLight(b.x, b.z, 1, 0.97, 0.88, 1);
        }
      });

      // Taxiways
      ap.taxiways.forEach((t) => {
        const len = Math.hypot(t.x2 - t.x1, t.z2 - t.z1);
        const hdg = SIM.Geo.bearing(t.x1, t.z1, t.x2, t.z2);
        const mx = (t.x1 + t.x2) / 2, mz = (t.z1 + t.z2) / 2;
        const tm = new THREE.Mesh(flat, this.mat.taxi);
        RU().flatMatrix(mtx, mx, y + 0.08, mz, hdg, t.width, len + t.width);
        tm.applyMatrix4(mtx);
        tm.receiveShadow = true;
        g.add(tm);
        yellow.push({ x: mx, z: mz, w: 0.35, l: len, h: hdg });
        const dx = (t.x2 - t.x1) / len, dz = (t.z2 - t.z1) / len;
        for (let s = 0; s <= len; s += 45) {
          const px = t.x1 + dx * s, pz = t.z1 + dz * s;
          addLight(px - dz * (t.width / 2 + 1), pz + dx * (t.width / 2 + 1), 0.2, 0.35, 1, 0.7, 0.35);
          addLight(px + dz * (t.width / 2 + 1), pz - dx * (t.width / 2 + 1), 0.2, 0.35, 1, 0.7, 0.35);
        }
      });

      // Apron and stands
      const a = ap.apron;
      const am = new THREE.Mesh(flat, this.mat.apron.clone());
      am.material.map = this.mat.apron.map.clone();
      am.material.map.needsUpdate = true;
      am.material.map.repeat.set(a.halfWid / 32, a.halfLen / 32);
      const apHdg = Math.atan2(a.dx, -a.dz) * M.RAD;
      RU().flatMatrix(mtx, a.cx, y + 0.09, a.cz, apHdg, a.halfWid * 2, a.halfLen * 2);
      am.applyMatrix4(mtx);
      am.receiveShadow = true;
      g.add(am);
      ap.parking.forEach((p) => {
        const dir = SIM.Geo.dir(p.hdg);
        yellow.push({ x: p.x - dir.x * 6, z: p.z - dir.z * 6, w: 0.3, l: p.heavy ? 40 : 14, h: p.hdg });
        yellow.push({ x: p.x + dir.x * (p.heavy ? 14 : 4), z: p.z + dir.z * (p.heavy ? 14 : 4), w: p.heavy ? 8 : 4, l: 0.35, h: p.hdg });
      });
      // floodlights
      for (let i = -1; i <= 1; i++) {
        const px = a.cx + a.dx * a.halfLen * 0.8 * i - a.dz * a.halfWid * 0.95, pz = a.cz + a.dz * a.halfLen * 0.8 * i + a.dx * a.halfWid * 0.95;
        addLight(px, pz, 1, 0.85, 0.6, 3, 18);
      }

      // Marking instances
      [[white, this.mat.white, 0.16], [yellow, this.mat.yellow, 0.13]].forEach(([list, mat, h]) => {
        if (!list.length) return;
        const im = new THREE.InstancedMesh(flat, mat, list.length);
        list.forEach((m, i) => im.setMatrixAt(i, RU().flatMatrix(mtx, m.x, y + h, m.z, m.h, m.w, m.l)));
        im.frustumCulled = false;
        im.receiveShadow = true;
        g.add(im);
      });

      // Buildings
      ap.buildings.forEach((b) => this.addBuilding(g, b, y));

      // Lights
      const lm = RU().lightMaterial({ size: 1.1, min: 1.4, max: 9 });
      this.lightMats.push(lm);
      g.add(RU().lightPoints(lights, lm));
      // PAPI points for this airport (dynamic colours)
      const papiMat = RU().lightMaterial({ size: 1.6, min: 2.2, max: 12 });
      this.lightMats.push(papiMat);
      this.papis.filter((p) => !p.points).forEach((p) => {
        p.points = RU().lightPoints(p.lights.map((l) => ({ x: l.x, y: l.y, z: l.z, r: 1, g: 1, b: 1, s: 1 })), papiMat);
        p.material = papiMat;
        g.add(p.points);
      });
      this.group.add(g);
    }

    addBuilding(g, b, y) {
      const rot = -b.hdg * M.DEG;
      let mesh;
      if (b.kind === 'hangar') {
        mesh = new THREE.Group();
        const box = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h * 0.6, b.d), this.mat.hangar);
        box.position.y = b.h * 0.3;
        const roof = new THREE.Mesh(new THREE.CylinderGeometry(b.w / 2, b.w / 2, b.d, 16, 1, false, -Math.PI / 2, Math.PI), this.mat.roof);
        roof.rotation.x = -Math.PI / 2;
        roof.scale.set(1, 1, (b.h * 0.4) / (b.w / 2));
        roof.position.y = b.h * 0.6;
        const door = new THREE.Mesh(new THREE.PlaneGeometry(b.w * 0.8, b.h * 0.52), new THREE.MeshLambertMaterial({ color: 0x5f676d }));
        door.position.set(0, b.h * 0.26, -b.d / 2 - 0.05);
        door.rotation.y = Math.PI;
        mesh.add(box, roof, door);
        box.castShadow = roof.castShadow = true;
      } else if (b.kind === 'tower') {
        mesh = new THREE.Group();
        const shaft = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 3.2, b.h, 10), this.mat.tower);
        shaft.position.y = b.h / 2;
        const cab = new THREE.Mesh(new THREE.CylinderGeometry(5.2, 4.2, 4.5, 8), this.mat.glass);
        cab.position.y = b.h + 2.2;
        const roof = new THREE.Mesh(new THREE.CylinderGeometry(5.8, 5.6, 0.8, 8), this.mat.roof);
        roof.position.y = b.h + 4.8;
        mesh.add(shaft, cab, roof);
        shaft.castShadow = true;
        this.beacons.push({ x: b.x, y: y + b.h + 6, z: b.z });
      } else {
        mesh = new THREE.Group();
        const isTerminal = b.kind === 'terminal';
        const body = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h, b.d), isTerminal ? this.mat.building : this.mat.hangar);
        body.position.y = b.h / 2;
        body.castShadow = true;
        mesh.add(body);
        if (isTerminal) {
          const glass = new THREE.Mesh(new THREE.BoxGeometry(b.w * 0.96, b.h * 0.55, 0.6), this.mat.glass);
          glass.position.set(0, b.h * 0.5, -b.d / 2 - 0.2);
          mesh.add(glass);
          this.terminalGlass = this.terminalGlass || [];
          this.terminalGlass.push(glass);
        }
      }
      mesh.position.set(b.x, y, b.z);
      mesh.rotation.y = rot;
      g.add(mesh);
    }

    addWindsock(g, x, y, z) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 6, 6), this.mat.pole);
      pole.position.set(x, y + 3, z);
      const pivot = new THREE.Group();
      pivot.position.set(x, y + 5.8, z);
      const sock = new THREE.Mesh(new THREE.ConeGeometry(0.45, 3.6, 10, 1, true), this.mat.sock);
      sock.material.side = THREE.DoubleSide;
      sock.rotation.x = -Math.PI / 2;
      sock.position.z = 1.8;
      const inner = new THREE.Group();
      inner.add(sock);
      pivot.add(inner);
      g.add(pole, pivot);
      this.windsocks.push({ pivot, inner });
    }

    /**
     * @param {THREE.Vector3} camPos
     * @param {object} env { lightsOn (0..1), windDir (deg FROM), windKt, time }
     */
    update(camPos, env) {
      // Runway lights brightness
      this.lightMats.forEach((m) => (m.uniforms.uIntensity.value = env.lightsOn));
      // PAPI: each light white above its angle, red below
      for (const p of this.papis) {
        if (!p.points) continue;
        const col = p.points.geometry.attributes.color;
        const l0 = p.lights[0];
        const dist = Math.hypot(camPos.x - l0.x, camPos.z - l0.z);
        if (dist > 20000) continue;
        const angle = Math.atan2(camPos.y - p.elev, dist) * M.RAD;
        p.lights.forEach((l, i) => {
          const white = angle > p.thresholds[i];
          col.setXYZ(i, 1, white ? 1 : 0.12, white ? 0.95 : 0.08);
        });
        col.needsUpdate = true;
      }
      // Windsocks point downwind and droop with low wind
      const rot = -(env.windDir + 180) * M.DEG;
      const droop = M.clamp(1 - env.windKt / 15, 0, 1) * 1.2;
      this.windsocks.forEach((w, i) => {
        w.pivot.rotation.y = rot + Math.sin(env.time * 1.7 + i) * 0.05 * Math.min(env.windKt, 20) / 10;
        w.inner.rotation.x = -droop;
      });
      if (this.terminalGlass) {
        const night = 1 - env.daylight;
        this.terminalGlass.forEach((gm) => gm.material.emissive.setRGB(0.55 * night, 0.48 * night, 0.32 * night));
      }
    }

    dispose() {
      this.scene.remove(this.group);
      RU().disposeObject(this.group);
    }
  }

  SIM.AirportRenderer = AirportRenderer;
})(window.SIM);
