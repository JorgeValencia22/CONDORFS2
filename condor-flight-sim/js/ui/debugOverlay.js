/**
 * DebugOverlay — physics/performance readout (FPS, delta, altitude, IAS, VS, heading, roll, pitch,
 * yaw rate, throttle, RPM, fuel, position, AoA, CL/CD, forces...) and optional force vectors drawn
 * in 3D (lift green, drag red, thrust yellow, weight blue).
 */
(function (SIM) {
  'use strict';

  const M = SIM.MathUtil;
  const { h } = SIM.UI;

  class DebugOverlay {
    constructor(session) {
      this.s = session;
      this.el = h('div.debug-overlay.mono', { 'aria-label': 'Debug information' });
      this.pre = h('pre');
      this.vecToggle = h('input', { type: 'checkbox', 'aria-label': 'Show force vectors' });
      this.vecToggle.addEventListener('change', () => this.setVectors(this.vecToggle.checked));
      this.el.append(h('div.debug-head', 'DEBUG', h('label', this.vecToggle, ' force vectors')), this.pre);
      this.fps = 60;
      this.arrows = null;
    }

    setVectors(on) {
      const r = this.s.app.render;
      if (!r || !r.available) return;
      if (on && !this.arrows) {
        const mk = (c) => new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 1, c, 0.6, 0.35);
        this.arrows = { lift: mk(0x40ff70), drag: mk(0xff4040), thrust: mk(0xffd040), weight: mk(0x4090ff) };
        Object.values(this.arrows).forEach((a) => r.scene.add(a));
      }
      if (!on && this.arrows) {
        Object.values(this.arrows).forEach((a) => {
          r.scene.remove(a);
          a.dispose && a.dispose();
        });
        this.arrows = null;
      }
    }

    updateVectors(pos, quat) {
      if (!this.arrows) return;
      const ac = this.s.aircraft;
      const f = ac.fm.debugForces;
      const W = ac.mass * SIM.Phys.G;
      const v = new THREE.Vector3();
      const set = (arrow, vec, body) => {
        v.set(vec.x, vec.y, vec.z);
        if (body) v.applyQuaternion(quat);
        const len = v.length() / W * 6;
        arrow.position.copy(pos);
        if (len > 0.01) {
          arrow.setDirection(v.normalize());
          arrow.setLength(Math.max(0.5, len), 0.6, 0.35);
          arrow.visible = true;
        } else arrow.visible = false;
      };
      set(this.arrows.lift, f.lift, true);
      set(this.arrows.drag, f.drag, true);
      set(this.arrows.thrust, f.thrust, true);
      set(this.arrows.weight, f.weight, false);
    }

    update(dt, frameInfo) {
      this.fps = M.lerp(this.fps, dt > 0 ? 1 / dt : 60, 0.08);
      const s = this.s, ac = s.aircraft, st = ac.state, fm = ac.fm;
      const ll = s.world.geo.toGeo(fm.pos.x, fm.pos.z);
      const r = s.app.render && s.app.render.available ? s.app.render.info() : { calls: 0, triangles: 0 };
      const tr = s.world.terrainRenderer ? s.world.terrainRenderer.stats : { visible: 0, built: 0 };
      const e = ac.engines[0];
      const lines = [
        `FPS      ${this.fps.toFixed(0).padStart(5)}   DELTA ${(dt * 1000).toFixed(1)} ms   PHYS ${frameInfo.steps} steps @${SIM.Config.PHYSICS_HZ}Hz`,
        `STATE    ${s.state.state.padEnd(9)} CAM ${s.camera ? s.camera.mode : '-'}   RES ${s.app.render && s.app.render.available ? (s.app.render.renderer.getPixelRatio()).toFixed(2) : '-'}x`,
        `ALT      ${st.altFt.toFixed(0).padStart(6)} ft  TRUE ${st.altFtTrue.toFixed(0)} ft  AGL ${st.aglFt.toFixed(0)} ft`,
        `IAS      ${st.iasKt.toFixed(1).padStart(6)} kt  TAS ${st.tasKt.toFixed(1)} kt  GS ${st.gsKt.toFixed(1)} kt  M${st.mach.toFixed(3)}`,
        `VS       ${st.vsFpm.toFixed(0).padStart(6)} fpm  G ${st.gLoad.toFixed(2)}  LAT-G ${(fm.lateralG || 0).toFixed(2)}`,
        `HDG      ${st.headingDeg.toFixed(1).padStart(6)}°   TRK ${st.trackDeg.toFixed(1)}°  (true ${st.trueHeadingDeg.toFixed(1)}°)`,
        `ROLL     ${st.rollDeg.toFixed(2).padStart(6)}°   PITCH ${st.pitchDeg.toFixed(2)}°   YAW-RATE ${(-fm.omega.y * M.RAD).toFixed(2)}°/s`,
        `RATES    p ${(-fm.omega.z * M.RAD).toFixed(1)}  q ${(fm.omega.x * M.RAD).toFixed(1)}  r ${(-fm.omega.y * M.RAD).toFixed(1)} °/s`,
        `AERO     AoA ${st.aoaDeg.toFixed(2)}°  β ${st.betaDeg.toFixed(2)}°  CL ${fm.cl.toFixed(3)}  CD ${fm.cd.toFixed(4)}  q ${fm.qbar.toFixed(0)} Pa`,
        `STALL    σ ${fm.stallFactor.toFixed(2)}  α-stall ${(fm.stallAlpha(ac.systems.flapAero()) * M.RAD).toFixed(1)}°  GE ${(fm.groundEffect * 100).toFixed(0)}%`,
        `CONTROLS ELV ${ac.controls.elevator.toFixed(2)} AIL ${ac.controls.aileron.toFixed(2)} RUD ${ac.controls.rudder.toFixed(2)} TRIM ${ac.controls.elevatorTrim.toFixed(2)}`,
        `THROTTLE ${(e.throttle * 100).toFixed(0).padStart(4)}%  ${e.kind === 'piston' ? `RPM ${e.rpm.toFixed(0)}  MIX ${(e.mixture * 100).toFixed(0)}%  PWR ${(e.power / SIM.Units.HP).toFixed(0)}hp` : `N1 ${e.n1.toFixed(1)}%  N2 ${e.n2.toFixed(1)}%`}  T ${(e.thrust / 1000).toFixed(2)} kN`,
        `FUEL     ${ac.systems.totalFuel.toFixed(1)} ${ac.cfg.fuel.unit}   MASS ${ac.mass.toFixed(0)} kg   DMG ${(ac.damage * 100).toFixed(0)}%`,
        `GROUND   ${fm.onGround ? 'YES' : 'no '} wheels ${fm.wheelsOnGround} surface ${fm.surface}  ${fm.gear.map((g) => g.compression.toFixed(3)).join(' ')}`,
        `POSITION x ${fm.pos.x.toFixed(1)}  y ${fm.pos.y.toFixed(1)}  z ${fm.pos.z.toFixed(1)}`,
        `         ${SIM.Geo.formatLat(ll.lat)} ${SIM.Geo.formatLon(ll.lon)}`,
        `RENDER   calls ${r.calls}  tris ${(r.triangles / 1000).toFixed(0)}k  tiles ${tr.visible}/${tr.built}`,
      ];
      this.pre.textContent = lines.join('\n');
    }

    dispose() {
      this.setVectors(false);
    }
  }

  SIM.DebugOverlay = DebugOverlay;
})(window.SIM);
