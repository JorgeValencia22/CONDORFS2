/**
 * TerrainRenderer — quadtree level-of-detail terrain built from the procedural Terrain functions.
 *
 * - Root tiles (32 km) cover the whole region and are always resident.
 * - Tiles split while the camera is closer than size × splitFactor (quality dependent).
 * - Children replace a parent only when all four are built (no holes); skirts hide LOD cracks.
 * - Tiles are generated under a per-frame time budget and recycled with an LRU cache.
 * - Fine tiles carry instanced trees.
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;
  const C = SIM.Config;

  class TerrainRenderer {
    constructor(scene, terrain, settings) {
      this.scene = scene;
      this.terrain = terrain;
      this.settings = settings;
      this.group = new THREE.Group();
      this.group.name = 'terrain';
      scene.add(this.group);
      this.tiles = new Map();
      this.queue = new Map();
      this.frame = 0;
      this.stats = { visible: 0, built: 0, queued: 0 };
      this.material = new THREE.MeshLambertMaterial({ vertexColors: true, map: SIM.Textures.get('terrainDetail') });
      this.treeMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
      this.treeGeoms = this.makeTreeGeometries();
      this.applyQuality();
      SIM.events.on('settings:changed', ({ path }) => {
        if (path.startsWith('graphics')) this.applyQuality();
      });
      // Root grid
      const R = C.TERRAIN_ROOT_SIZE;
      this.rootSize = R;
      this.rootX0 = Math.floor(terrain.minX / R) * R;
      this.rootZ0 = Math.floor(terrain.minZ / R) * R;
      this.rootNx = Math.ceil((terrain.maxX - this.rootX0) / R);
      this.rootNz = Math.ceil((terrain.maxZ - this.rootZ0) / R);
    }

    applyQuality() {
      const g = this.settings.data.graphics;
      const lvl = SIM.GraphicsLevels.terrainDetail[g.terrainDetail] || SIM.GraphicsLevels.terrainDetail.medium;
      this.segments = lvl.segments;
      this.splitFactor = lvl.splitFactor;
      this.renderDistance = g.renderDistance * 1000;
      this.treeLevel = SIM.GraphicsLevels.trees[g.trees] ?? 0.55;
    }

    key(level, ix, iz) {
      return `${level}:${ix}:${iz}`;
    }

    nodeSize(level) {
      return this.rootSize / (1 << level);
    }

    /* ------------------------------------------------------------------ geometry */

    makeTreeGeometries() {
      const merge = (parts) => {
        let total = 0;
        parts.forEach((p) => (total += p.g.attributes.position.count));
        const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), col = new Float32Array(total * 3);
        let o = 0;
        parts.forEach(({ g, color }) => {
          const ng = g.index ? g.toNonIndexed() : g;
          ng.computeVertexNormals();
          const p = ng.attributes.position.array, n = ng.attributes.normal.array;
          for (let i = 0; i < p.length; i += 3) {
            pos[o] = p[i]; pos[o + 1] = p[i + 1]; pos[o + 2] = p[i + 2];
            nor[o] = n[i]; nor[o + 1] = n[i + 1]; nor[o + 2] = n[i + 2];
            col[o] = color[0]; col[o + 1] = color[1]; col[o + 2] = color[2];
            o += 3;
          }
        });
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
        return geo;
      };
      const trunk = new THREE.CylinderGeometry(0.18, 0.28, 2.4, 5).translate(0, 1.2, 0);
      const cone = new THREE.ConeGeometry(2.2, 7.5, 7).translate(0, 5.6, 0);
      const crown = new THREE.IcosahedronGeometry(2.8, 0).scale(1, 0.85, 1).translate(0, 4.6, 0);
      const trunk2 = new THREE.CylinderGeometry(0.2, 0.32, 2.8, 5).translate(0, 1.4, 0);
      return [
        merge([{ g: trunk, color: [0.36, 0.27, 0.18] }, { g: cone, color: [0.2, 0.3, 0.17] }]),
        merge([{ g: trunk2, color: [0.38, 0.29, 0.2] }, { g: crown, color: [0.27, 0.36, 0.18] }]),
      ];
    }

    buildTile(level, ix, iz) {
      const t0 = performance.now();
      const size = this.nodeSize(level);
      const x0 = this.rootX0 + ix * size, z0 = this.rootZ0 + iz * size;
      const seg = this.segments;
      const step = size / seg;
      const terrain = this.terrain;
      const n1 = seg + 3; // grid with one-cell border for normals
      const H = new Float32Array(n1 * n1);
      const RUG = new Float32Array(n1 * n1);
      const LND = new Float32Array(n1 * n1);
      for (let j = 0; j < n1; j++) {
        for (let i = 0; i < n1; i++) {
          const gi = j * n1 + i;
          H[gi] = terrain.rawHeight(x0 + (i - 1) * step, z0 + (j - 1) * step);
          RUG[gi] = terrain._rug;
          LND[gi] = terrain._lastL;
        }
      }
      const vCount = (seg + 1) * (seg + 1);
      const skirtCount = seg * 4;
      const total = vCount + skirtCount;
      const pos = new Float32Array(total * 3);
      const nor = new Float32Array(total * 3);
      const col = new Float32Array(total * 3);
      const uv = new Float32Array(total * 2);
      const color = [0, 0, 0];
      let hMin = Infinity, hMax = -Infinity;
      const uvScale = 1 / 55;
      for (let j = 0; j <= seg; j++) {
        for (let i = 0; i <= seg; i++) {
          const k = j * (seg + 1) + i;
          const gi = (j + 1) * n1 + (i + 1);
          const h = H[gi];
          const lx = i * step, lz = j * step;
          pos[k * 3] = lx;
          pos[k * 3 + 1] = h;
          pos[k * 3 + 2] = lz;
          const dx = (H[gi + 1] - H[gi - 1]) / (2 * step);
          const dz = (H[gi + n1] - H[gi - n1]) / (2 * step);
          const l = Math.sqrt(dx * dx + 1 + dz * dz);
          nor[k * 3] = -dx / l;
          nor[k * 3 + 1] = 1 / l;
          nor[k * 3 + 2] = -dz / l;
          const wx = x0 + lx, wz = z0 + lz;
          terrain._rug = RUG[gi]; // cached land-cover inputs for colorAt
          terrain._lastL = LND[gi];
          terrain.colorAt(wx, wz, h, Math.sqrt(dx * dx + dz * dz), color);
          col[k * 3] = color[0];
          col[k * 3 + 1] = color[1];
          col[k * 3 + 2] = color[2];
          uv[k * 2] = wx * uvScale;
          uv[k * 2 + 1] = wz * uvScale;
          if (h < hMin) hMin = h;
          if (h > hMax) hMax = h;
        }
      }
      // Skirts: duplicate border vertices pushed down
      const skirt = Math.max(15, size * 0.02);
      const border = [];
      for (let i = 0; i < seg; i++) border.push(i);                                // top edge  (j=0)
      for (let j = 0; j < seg; j++) border.push(j * (seg + 1) + seg);              // right edge
      for (let i = seg; i > 0; i--) border.push(seg * (seg + 1) + i);              // bottom edge
      for (let j = seg; j > 0; j--) border.push(j * (seg + 1));                    // left edge
      border.forEach((src, n) => {
        const k = vCount + n;
        pos[k * 3] = pos[src * 3];
        pos[k * 3 + 1] = pos[src * 3 + 1] - skirt;
        pos[k * 3 + 2] = pos[src * 3 + 2];
        for (let c = 0; c < 3; c++) {
          nor[k * 3 + c] = nor[src * 3 + c];
          col[k * 3 + c] = col[src * 3 + c] * 0.85;
        }
        uv[k * 2] = uv[src * 2];
        uv[k * 2 + 1] = uv[src * 2 + 1];
      });
      const indices = [];
      for (let j = 0; j < seg; j++) {
        for (let i = 0; i < seg; i++) {
          const a = j * (seg + 1) + i, b = a + 1, c = a + seg + 1, d = c + 1;
          indices.push(a, c, b, b, c, d);
        }
      }
      const nb = border.length;
      for (let n = 0; n < nb; n++) {
        const a = border[n], b = border[(n + 1) % nb];
        const sa = vCount + n, sb = vCount + ((n + 1) % nb);
        indices.push(a, b, sa, b, sb, sa);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geo.setIndex(total > 65535 ? new THREE.Uint32BufferAttribute(indices, 1) : new THREE.Uint16BufferAttribute(indices, 1));
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, this.material);
      mesh.position.set(x0, 0, z0);
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.visible = false;
      this.group.add(mesh);
      const tile = { key: this.key(level, ix, iz), level, ix, iz, size, x0, z0, mesh, hMin, hMax, lastUsed: this.frame, buildMs: 0 };
      if (level >= C.TERRAIN_MAX_LEVEL - 2 && this.treeLevel > 0) this.addTrees(tile);
      tile.buildMs = performance.now() - t0;
      this.tiles.set(tile.key, tile);
      this.stats.built++;
      return tile;
    }

    addTrees(tile) {
      const terrain = this.terrain;
      const levelFromMax = C.TERRAIN_MAX_LEVEL - tile.level; // 0 finest
      const per = Math.round(26 * Math.sqrt(this.treeLevel));
      const spacing = tile.size / per;
      const rnd = SIM.mulberry32((tile.ix * 73856093) ^ (tile.iz * 19349663) ^ (tile.level * 83492791));
      const lists = [[], []];
      const accept = levelFromMax === 0 ? 1 : levelFromMax === 1 ? 0.8 : 0.6;
      for (let j = 0; j < per; j++) {
        for (let i = 0; i < per; i++) {
          const lx = (i + rnd()) * spacing, lz = (j + rnd()) * spacing;
          const wx = tile.x0 + lx, wz = tile.z0 + lz;
          const h = terrain.rawHeight(wx, wz);
          if (h < 2) continue;
          const nrm = terrain.normalAt(wx, wz);
          const slope = Math.sqrt(1 - nrm.y * nrm.y) / nrm.y;
          const d = terrain.treeDensity(wx, wz, h, slope);
          if (rnd() > d * accept) continue;
          const kind = h > 900 || rnd() < 0.35 ? 0 : 1;
          lists[kind].push({ x: lx, y: h - 0.3, z: lz, s: (0.8 + rnd() * 0.7) * (1 + levelFromMax * 0.5), r: rnd() * Math.PI * 2, c: 0.75 + rnd() * 0.4 });
        }
      }
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
      const color = new THREE.Color();
      lists.forEach((list, kind) => {
        if (!list.length) return;
        const im = new THREE.InstancedMesh(this.treeGeoms[kind], this.treeMaterial, list.length);
        list.forEach((t, n) => {
          q.setFromAxisAngle(up, t.r);
          s.set(t.s, t.s * (0.85 + (t.c - 0.75) * 0.6), t.s);
          p.set(t.x, t.y, t.z);
          m.compose(p, q, s);
          im.setMatrixAt(n, m);
          color.setRGB(t.c, t.c * (0.95 + (t.c - 0.95) * 0.3), t.c * 0.9);
          im.setColorAt(n, color);
        });
        im.frustumCulled = false;
        im.castShadow = this.settings.data.graphics.shadows === 'high';
        im.matrixAutoUpdate = false;
        tile.mesh.add(im);
      });
    }

    disposeTile(tile) {
      tile.mesh.traverse((o) => {
        if (o.isInstancedMesh) o.dispose();
      });
      tile.mesh.geometry.dispose();
      this.group.remove(tile.mesh);
      this.tiles.delete(tile.key);
    }

    /* ------------------------------------------------------------------ selection */

    distanceTo(cx, cy, cz, level, ix, iz, hMin, hMax) {
      const size = this.nodeSize(level);
      const x0 = this.rootX0 + ix * size, z0 = this.rootZ0 + iz * size;
      const dx = Math.max(x0 - cx, 0, cx - (x0 + size));
      const dz = Math.max(z0 - cz, 0, cz - (z0 + size));
      const dy = cy - M.clamp(cy, hMin, hMax);
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    request(level, ix, iz, priority) {
      const k = this.key(level, ix, iz);
      if (this.tiles.has(k)) return;
      const q = this.queue.get(k);
      if (!q || q.priority > priority) this.queue.set(k, { level, ix, iz, priority });
    }

    select(level, ix, iz, cam, out) {
      const tile = this.tiles.get(this.key(level, ix, iz));
      const hMin = tile ? tile.hMin : 0, hMax = tile ? tile.hMax : 5000;
      const d = this.distanceTo(cam.x, cam.y, cam.z, level, ix, iz, hMin, hMax);
      if (d > this.renderDistance) return;
      const size = this.nodeSize(level);
      if (level < C.TERRAIN_MAX_LEVEL && d < size * this.splitFactor) {
        const cl = level + 1;
        const kids = [[ix * 2, iz * 2], [ix * 2 + 1, iz * 2], [ix * 2, iz * 2 + 1], [ix * 2 + 1, iz * 2 + 1]];
        let ready = true;
        for (const [cx, cz] of kids) {
          if (!this.tiles.has(this.key(cl, cx, cz))) {
            ready = false;
            this.request(cl, cx, cz, d);
          }
        }
        if (ready) {
          for (const [cx, cz] of kids) this.select(cl, cx, cz, cam, out);
          return;
        }
      }
      if (tile) out.push(tile);
      else this.request(level, ix, iz, d);
    }

    /** Builds everything needed around a point (loading screen). */
    async prebuild(cam, progress) {
      for (let iz = 0; iz < this.rootNz; iz++) {
        for (let ix = 0; ix < this.rootNx; ix++) {
          this.buildTile(0, ix, iz);
        }
        progress && progress((iz / this.rootNz) * 0.4);
        await SIM.nextFrame();
      }
      // Iteratively refine around the start position until the queue is empty.
      for (let pass = 0; pass < 8; pass++) {
        const out = [];
        this.queue.clear();
        this.forRoots((ix, iz) => this.select(0, ix, iz, cam, out));
        if (!this.queue.size) break;
        const jobs = Array.from(this.queue.values()).sort((a, b) => a.priority - b.priority);
        this.queue.clear();
        let n = 0;
        for (const j of jobs) {
          if (!this.tiles.has(this.key(j.level, j.ix, j.iz))) this.buildTile(j.level, j.ix, j.iz);
          if (++n % 6 === 0) {
            progress && progress(0.4 + 0.6 * Math.min(1, (pass + n / jobs.length) / 6));
            await SIM.nextFrame();
          }
        }
      }
      progress && progress(1);
    }

    forRoots(fn) {
      for (let iz = 0; iz < this.rootNz; iz++) for (let ix = 0; ix < this.rootNx; ix++) fn(ix, iz);
    }

    update(camera) {
      this.frame++;
      const camPos = camera.position;
      const out = [];
      this.forRoots((ix, iz) => this.select(0, ix, iz, camPos, out));
      // visibility (+ manual culling of the instanced trees, which three.js cannot cull per tile)
      if (!this.frustum) {
        this.frustum = new THREE.Frustum();
        this.projScreen = new THREE.Matrix4();
        this.sphere = new THREE.Sphere();
      }
      this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      this.frustum.setFromProjectionMatrix(this.projScreen);
      this.tiles.forEach((t) => (t.mesh.visible = false));
      out.forEach((t) => {
        t.mesh.visible = true;
        t.lastUsed = this.frame;
        if (t.mesh.children.length) {
          const bs = t.mesh.geometry.boundingSphere;
          this.sphere.center.copy(bs.center).add(t.mesh.position);
          this.sphere.radius = bs.radius + 20;
          const vis = this.frustum.intersectsSphere(this.sphere);
          for (const c of t.mesh.children) c.visible = vis;
        }
      });
      this.stats.visible = out.length;
      // build queue under a time budget (always at least one tile)
      if (this.queue.size) {
        const jobs = Array.from(this.queue.values()).sort((a, b) => a.priority - b.priority);
        const t0 = performance.now();
        let built = 0;
        for (const j of jobs) {
          if (built > 0 && performance.now() - t0 > C.TERRAIN_BUILD_BUDGET_MS) break;
          this.queue.delete(this.key(j.level, j.ix, j.iz));
          if (!this.tiles.has(this.key(j.level, j.ix, j.iz))) {
            this.buildTile(j.level, j.ix, j.iz);
            built++;
          }
        }
        // stale requests are regenerated next frame by select()
        this.queue.clear();
      }
      this.stats.queued = this.queue.size;
      // LRU eviction (roots are kept)
      if (this.tiles.size > C.TERRAIN_CACHE_LIMIT) {
        const candidates = Array.from(this.tiles.values()).filter((t) => t.level > 0 && !t.mesh.visible).sort((a, b) => a.lastUsed - b.lastUsed);
        const excess = this.tiles.size - C.TERRAIN_CACHE_LIMIT;
        for (let i = 0; i < excess && i < candidates.length; i++) this.disposeTile(candidates[i]);
      }
    }

    /** Rebuilds everything (e.g. after a terrain-detail change). */
    reset() {
      Array.from(this.tiles.values()).forEach((t) => this.disposeTile(t));
      this.queue.clear();
    }

    dispose() {
      this.reset();
      this.scene.remove(this.group);
      this.material.dispose();
      this.treeMaterial.dispose();
      this.treeGeoms.forEach((g) => g.dispose());
    }
  }

  SIM.TerrainRenderer = TerrainRenderer;
})(window.SIM);
