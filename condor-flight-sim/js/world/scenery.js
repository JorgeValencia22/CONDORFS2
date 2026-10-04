/**
 * Scenery — cities (instanced buildings in culled cells), landmark towers, roads with bridges,
 * street/city lights for night flying and a spatial index of buildings for collision checks.
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;
  const RU = () => SIM.RenderUtils;

  /** Spatial hash of building boxes (also used by the physics for collisions). */
  class BuildingIndex {
    constructor(cell = 250) {
      this.cell = cell;
      this.map = new Map();
      this.count = 0;
    }
    key(i, j) {
      return i * 73856093 ^ j * 19349663;
    }
    insert(b) {
      const r = Math.max(b.w, b.d) * 0.75;
      const i0 = Math.floor((b.x - r) / this.cell), i1 = Math.floor((b.x + r) / this.cell);
      const j0 = Math.floor((b.z - r) / this.cell), j1 = Math.floor((b.z + r) / this.cell);
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const k = this.key(i, j);
          if (!this.map.has(k)) this.map.set(k, []);
          this.map.get(k).push(b);
        }
      }
      this.count++;
    }
    /** Returns the building containing point (x,y,z) inflated by radius, or null. */
    hit(x, y, z, radius = 0) {
      const list = this.map.get(this.key(Math.floor(x / this.cell), Math.floor(z / this.cell)));
      if (!list) return null;
      for (const b of list) {
        if (y > b.base + b.h + radius || y < b.base - 2) continue;
        const dx = x - b.x, dz = z - b.z;
        const c = Math.cos(b.rot), s = Math.sin(b.rot);
        const u = dx * c - dz * s, v = dx * s + dz * c;
        if (Math.abs(u) < b.w / 2 + radius && Math.abs(v) < b.d / 2 + radius) return b;
      }
      return null;
    }
  }

  class SceneryRenderer {
    constructor(scene, terrain, region, geo, settings) {
      this.scene = scene;
      this.terrain = terrain;
      this.region = region;
      this.geo = geo;
      this.settings = settings;
      this.group = new THREE.Group();
      this.group.name = 'scenery';
      scene.add(this.group);
      this.cells = [];
      this.index = new BuildingIndex();
      this.roadPaths = [];
      this.lightMats = [];
      this.frustum = new THREE.Frustum();
      this.projScreen = new THREE.Matrix4();
      this.sphere = new THREE.Sphere();
      const facade = SIM.Textures.get('facade');
      const lights = SIM.Textures.get('facadeLights');
      this.facadeMat = new THREE.MeshLambertMaterial({ map: facade, emissiveMap: lights, emissive: new THREE.Color(0, 0, 0) });
      this.roofMat = new THREE.MeshLambertMaterial({ color: 0x8a8781 });
      this.geoms = [this.boxGeometry(0.25, 0.19), this.boxGeometry(0.5, 0.6), this.boxGeometry(0.75, 1.7)];
    }

    /** Unit box (x,z in ±0.5, y 0..1) with facade UVs on the sides and a separate roof group. */
    boxGeometry(uRep, vRep) {
      const pos = [], nor = [], uv = [], idx = [];
      const face = (corners, n, u0, v0) => {
        const b = pos.length / 3;
        corners.forEach((c, i) => {
          pos.push(c[0], c[1], c[2]);
          nor.push(n[0], n[1], n[2]);
          uv.push([u0, u0 + uRep, u0 + uRep, u0][i] , [0, 0, v0, v0][i]);
        });
        idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
      };
      const h = 0.5;
      face([[-h, 0, h], [h, 0, h], [h, 1, h], [-h, 1, h]], [0, 0, 1], 0, vRep);
      face([[h, 0, -h], [-h, 0, -h], [-h, 1, -h], [h, 1, -h]], [0, 0, -1], 0.13, vRep);
      face([[h, 0, h], [h, 0, -h], [h, 1, -h], [h, 1, h]], [1, 0, 0], 0.31, vRep);
      face([[-h, 0, -h], [-h, 0, h], [-h, 1, h], [-h, 1, -h]], [-1, 0, 0], 0.57, vRep);
      const sideCount = idx.length;
      const b = pos.length / 3;
      [[-h, 1, h], [h, 1, h], [h, 1, -h], [-h, 1, -h]].forEach((c) => {
        pos.push(c[0], c[1], c[2]);
        nor.push(0, 1, 0);
        uv.push(0, 0);
      });
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.addGroup(0, sideCount, 0);
      g.addGroup(sideCount, 6, 1);
      return g;
    }

    /* ------------------------------------------------------------------ build */

    async build(progress) {
      const level = this.settings.level('buildings') || 0.6;
      const spacing = 68 / Math.pow(level, 0.6);
      const cities = this.terrain.cities;
      const total = cities.length + 2;
      for (let ci = 0; ci < cities.length; ci++) {
        this.buildCity(cities[ci], spacing, ci);
        progress && progress(ci / total);
        await SIM.nextFrame();
      }
      this.buildLandmarks();
      this.buildRoads();
      progress && progress(1);
    }

    buildCity(city, spacing, seed) {
      const terrain = this.terrain;
      const rnd = SIM.mulberry32(9001 + seed * 7919);
      const angle = rnd() * Math.PI * 0.5;
      const ca = Math.cos(angle), sa = Math.sin(angle);
      const R = city.r * 1.3;
      const cellSize = 2000;
      const cellMap = new Map();
      const [cx, cz] = city.xz;
      const n = Math.ceil(R / spacing);
      for (let j = -n; j <= n; j++) {
        for (let i = -n; i <= n; i++) {
          // grid aligned with the city's street orientation
          const gx = (i + (rnd() - 0.5) * 0.35) * spacing, gz = (j + (rnd() - 0.5) * 0.35) * spacing;
          const x = cx + gx * ca - gz * sa, z = cz + gx * sa + gz * ca;
          if ((x - cx) * (x - cx) + (z - cz) * (z - cz) > R * R) continue;
          // leave streets: every 4th row/col is empty
          if (i % 4 === 0 || j % 5 === 0) continue;
          const u = terrain.urbanAt(x, z);
          if (u <= 0.05 || rnd() > u * 0.95) continue;
          if (terrain.pavementAt(x, z)) continue;
          const base = terrain.rawHeight(x, z);
          if (base < 1.5) continue;
          const nrm = terrain.normalAt(x, z);
          if (nrm.y < 0.9) continue;
          const core = terrain.coreAt(x, z);
          let h, w, d;
          if (core > 0.05 && rnd() < core * 0.9) {
            h = 25 + Math.pow(rnd(), 1.6) * (city.core.maxH - 25) * (0.5 + core * 0.5);
            w = 20 + rnd() * 22;
            d = 20 + rnd() * 22;
          } else {
            const tall = rnd() < 0.08 * u ? 1 : 0;
            h = tall ? 15 + rnd() * city.maxH : 4 + Math.pow(rnd(), 2.2) * 12 * (0.4 + u);
            w = 9 + rnd() * (tall ? 20 : 16);
            d = 9 + rnd() * (tall ? 20 : 14);
          }
          const rot = angle + (rnd() - 0.5) * 0.06;
          const variant = h < 14 ? 0 : h < 42 ? 1 : 2;
          const ck = `${Math.floor(x / cellSize)}:${Math.floor(z / cellSize)}`;
          if (!cellMap.has(ck)) cellMap.set(ck, { lists: [[], [], []], lights: [], minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, maxH: 0 });
          const cell = cellMap.get(ck);
          const tint = 0.78 + rnd() * 0.3;
          cell.lists[variant].push({ x, z, base: base - 1, h: h + 1, w, d, rot, tint, warm: rnd() });
          cell.minX = Math.min(cell.minX, x);
          cell.maxX = Math.max(cell.maxX, x);
          cell.minZ = Math.min(cell.minZ, z);
          cell.maxZ = Math.max(cell.maxZ, z);
          cell.maxH = Math.max(cell.maxH, base + h);
          this.index.insert({ x, z, w, d, h: h + 1, base: base - 1, rot });
          if (rnd() < 0.55) {
            const lx = x + (w / 2 + 6) * Math.cos(rot), lz = z - (w / 2 + 6) * Math.sin(rot);
            const warm = rnd();
            cell.lights.push({ x: lx, y: base + 7, z: lz, r: 1, g: warm < 0.75 ? 0.72 : 0.92, b: warm < 0.75 ? 0.38 : 0.82, s: 0.9 });
          }
        }
      }
      const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
      const color = new THREE.Color();
      const lightMat = RU().lightMaterial({ size: 1.0, min: 1.0, max: 6 });
      this.lightMats.push(lightMat);
      cellMap.forEach((cell) => {
        const g = new THREE.Group();
        cell.lists.forEach((list, variant) => {
          if (!list.length) return;
          const im = new THREE.InstancedMesh(this.geoms[variant], [this.facadeMat, this.roofMat], list.length);
          list.forEach((b, k) => {
            q.setFromAxisAngle(up, b.rot);
            p.set(b.x, b.base, b.z);
            s.set(b.w, b.h, b.d);
            mtx.compose(p, q, s);
            im.setMatrixAt(k, mtx);
            const t = b.tint;
            color.setRGB(t, t * (0.97 + b.warm * 0.05), t * (0.92 + b.warm * 0.08));
            im.setColorAt(k, color);
          });
          im.frustumCulled = false;
          im.castShadow = variant > 0 && this.settings.data.graphics.shadows !== 'off';
          im.receiveShadow = true;
          g.add(im);
        });
        if (cell.lights.length) {
          const pts = RU().lightPoints(cell.lights, lightMat);
          pts.userData.night = true;
          g.add(pts);
        }
        const cxm = (cell.minX + cell.maxX) / 2, czm = (cell.minZ + cell.maxZ) / 2;
        const radius = Math.hypot(cell.maxX - cell.minX, cell.maxZ - cell.minZ) / 2 + 60;
        this.cells.push({ group: g, center: new THREE.Vector3(cxm, cell.maxH / 2, czm), radius: Math.max(radius, cell.maxH) });
        this.group.add(g);
      });
    }

    buildLandmarks() {
      const glass = new THREE.MeshPhongMaterial({ color: 0x5f7f96, specular: 0xbcd0e0, shininess: 80, emissive: 0x000000 });
      const steel = new THREE.MeshLambertMaterial({ color: 0x9aa0a6 });
      this.landmarkGlass = glass;
      const lights = [];
      (this.region.landmarks || []).forEach((l) => {
        const p = this.geo.toLocal(l.lat, l.lon);
        const base = this.terrain.rawHeight(p.x, p.z);
        let mesh;
        if (l.kind === 'tower') {
          const geo = new THREE.CylinderGeometry(l.width * 0.32, l.width * 0.55, l.height, 4, 1);
          geo.rotateY(Math.PI / 4);
          mesh = new THREE.Mesh(geo, glass);
          mesh.position.set(p.x, base + l.height / 2, p.z);
        } else {
          mesh = new THREE.Group();
          const mast = new THREE.Mesh(new THREE.CylinderGeometry(l.width * 0.15, l.width * 0.5, l.height, 6), steel);
          mast.position.y = l.height / 2;
          mesh.add(mast);
          mesh.position.set(p.x, base, p.z);
        }
        mesh.castShadow = true;
        this.group.add(mesh);
        this.index.insert({ x: p.x, z: p.z, w: l.width, d: l.width, h: l.height, base, rot: 0 });
        lights.push({ x: p.x, y: base + l.height + 2, z: p.z, r: 1, g: 0.1, b: 0.05, s: 2.2 });
      });
      if (lights.length) {
        this.obstructionMat = RU().lightMaterial({ size: 2, min: 2.5, max: 10 });
        this.group.add(RU().lightPoints(lights, this.obstructionMat));
      }
    }

    buildRoads() {
      const terrain = this.terrain;
      const groups = { highway: { pos: [], idx: [], width: 22, color: 0x45464a }, road: { pos: [], idx: [], width: 11, color: 0x55534f } };
      const streetLights = [];
      (this.region.roads || []).forEach((road) => {
        const pts = road.pts.map((ll) => this.geo.xz(ll));
        if (road.loop) pts.push(pts[0]);
        // resample
        const step = road.type === 'highway' ? 45 : 60;
        const samples = [];
        for (let k = 0; k < pts.length - 1; k++) {
          const [ax, az] = pts[k], [bx, bz] = pts[k + 1];
          const len = Math.hypot(bx - ax, bz - az);
          const n = Math.max(1, Math.ceil(len / step));
          for (let i = 0; i < n; i++) samples.push([ax + ((bx - ax) * i) / n, az + ((bz - az) * i) / n]);
        }
        samples.push(pts[pts.length - 1]);
        let ys = samples.map(([x, z]) => {
          const h = terrain.rawHeight(x, z);
          if (road.bridge) return Math.max(h, 0) + (h < 3 ? 32 : 1.2);
          return Math.max(h, 0.5) + 1.0;
        });
        if (road.bridge) {
          for (let pass = 0; pass < 6; pass++) ys = ys.map((y, i) => (i === 0 || i === ys.length - 1 ? y : (ys[i - 1] + y * 2 + ys[i + 1]) / 4));
        }
        const g = groups[road.type] || groups.road;
        const half = g.width / 2;
        const path = { type: road.type, pts: [], length: 0, cum: [0] };
        samples.forEach(([x, z], i) => {
          const [nx, nz] = samples[Math.min(i + 1, samples.length - 1)];
          const [px, pz] = samples[Math.max(i - 1, 0)];
          let dx = nx - px, dz = nz - pz;
          const l = Math.hypot(dx, dz) || 1;
          dx /= l;
          dz /= l;
          const ox = -dz * half, oz = dx * half;
          const b = g.pos.length / 3;
          g.pos.push(x + ox, ys[i], z + oz, x - ox, ys[i], z - oz);
          if (i > 0) g.idx.push(b - 2, b, b - 1, b - 1, b, b + 1);
          path.pts.push({ x, y: ys[i], z, dx, dz });
          if (i > 0) {
            path.length += Math.hypot(x - samples[i - 1][0], z - samples[i - 1][1]);
            path.cum.push(path.length);
          }
          if (road.type === 'highway' && i % 2 === 0 && terrain.urbanAt(x, z) > 0.2) {
            streetLights.push({ x: x + ox * 1.2, y: ys[i] + 9, z: z + oz * 1.2, r: 1, g: 0.68, b: 0.32, s: 1.1 });
          }
        });
        this.roadPaths.push(path);
      });
      Object.values(groups).forEach((g) => {
        if (!g.pos.length) return;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(g.pos, 3));
        geo.setIndex(g.idx);
        geo.computeVertexNormals();
        // normals of a road should face up regardless of winding
        const nrm = geo.attributes.normal;
        for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, 0, 1, 0);
        const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: g.color, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        this.group.add(mesh);
      });
      if (streetLights.length) {
        const mat = RU().lightMaterial({ size: 1.0, min: 1.0, max: 6 });
        this.lightMats.push(mat);
        this.group.add(RU().lightPoints(streetLights, mat));
      }
    }

    /* ------------------------------------------------------------------ per frame */

    update(camera, env) {
      const night = 1 - env.daylight;
      this.facadeMat.emissive.setRGB(night * 0.9, night * 0.85, night * 0.75);
      if (this.landmarkGlass) this.landmarkGlass.emissive.setRGB(night * 0.15, night * 0.18, night * 0.25);
      this.lightMats.forEach((m) => (m.uniforms.uIntensity.value = M.clamp(night * 1.3 - 0.15, 0, 1)));
      if (this.obstructionMat) this.obstructionMat.uniforms.uIntensity.value = M.clamp(night * 1.5, 0.15, 1) * (Math.sin(env.time * 3) > 0 ? 1 : 0.35);
      // Cell culling: frustum + distance
      this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      this.frustum.setFromProjectionMatrix(this.projScreen);
      const maxD = Math.min(env.renderDistance, 45000);
      const cp = camera.position;
      for (const c of this.cells) {
        const d = c.center.distanceTo(cp);
        this.sphere.set(c.center, c.radius);
        c.group.visible = d - c.radius < maxD && this.frustum.intersectsSphere(this.sphere);
      }
    }

    dispose() {
      this.scene.remove(this.group);
      RU().disposeObject(this.group);
    }
  }

  SIM.SceneryRenderer = SceneryRenderer;
  SIM.BuildingIndex = BuildingIndex;
})(window.SIM);
