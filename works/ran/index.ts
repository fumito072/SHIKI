// RAN（乱）— half a million strands of light running wild with the sound.
// Reference: the user's screen recording of sakrmusic's audio-visual loops — ink-fine particle trails on white that
// erupt from a horizon disc as spears, fountains, vortex rings, spiral galaxies and hair balls, flipping now and then to
// white light on black. Every particle is drawn as a hairline streak along its velocity and the streaks accumulate with
// a slow decay (a long exposure), so motion leaves strands instead of dots.
// Choreography: kicks fire spears from the disc; each bar may change the form that carries the particles (ring,
// spiral, hair, fountain); a build draws everything into one rising needle; the drop explodes it and inverts the world
// to light on black for two bars.
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, HalfFloatType, LineBasicNodeMaterial, LineSegments, MeshBasicNodeMaterial,
  PerspectiveCamera, QuadMesh, RenderPipeline, RenderTarget, Scene, Vector3,
} from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  Fn, If, abs, cos, exp, float, hash, instanceIndex, instancedArray, length, mix, mx_noise_vec3, normalize, screenUV, sin, sqrt,
  texture, uniform, vec2, vec3, vec4, vertexIndex,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { defineGpuInstrument } from '../../src/engine/gpu/types';
import type { InstrumentManifest } from '../../src/engine/types';
import { Director } from '../../src/engine/gpu/world/director';
import { ease, shake } from '../../src/engine/gpu/world/kit';

const manifest: InstrumentManifest = {
  id: 'ran',
  name: 'RAN',
  nameJa: '乱',
  mood: ['ink', 'light', 'particles'],
  energy: [0.2, 1],
  tempo: 'sync',
  macros: [
    { id: 'force', label: 'Force', default: 0.55, mod: { source: 'low', amount: 0.3 } },
    { id: 'chaos', label: 'Chaos', default: 0.4, mod: { source: 'high', amount: 0.3 } },
    { id: 'trail', label: 'Trail', default: 0.55 },
    { id: 'ink', label: 'Ink', default: 0.5 },
    { id: 'streak', label: 'Streak', default: 0.5 },
    { id: 'light', label: 'Light', default: 0 },
    { id: 'form', label: 'Form rate', default: 0.5 },
    { id: 'cam', label: 'Camera', default: 0.5 },
  ],
  presets: {
    ink: { force: 0.5, chaos: 0.35, trail: 0.65, ink: 0.55, streak: 0.5, light: 0, form: 0.4, cam: 0.4 },
    light: { force: 0.6, chaos: 0.45, trail: 0.6, ink: 0.45, streak: 0.6, light: 1, form: 0.6, cam: 0.6 },
    storm: { force: 0.9, chaos: 0.8, trail: 0.45, ink: 0.6, streak: 0.8, light: 0.3, form: 0.9, cam: 0.8 },
  },
};

const N = 1 << 19; // 524 288 strands
const STREAM = 1_048_573;
/** Forms that carry the particles between kicks. */
const FORMS = ['fountain', 'ring', 'spiral', 'hair'] as const;

export default defineGpuInstrument({
  manifest,
  create({ renderer, width, height }) {
    const scene = new Scene();
    const camera = new PerspectiveCamera(42, width / height, 0.05, 100);
    const director = new Director({ shots: 6, styles: 2, impactShot: 3, buildShot: 4, calmShots: [0, 2], impactStyles: [1], seed: 17 });
    const rt = () => new RenderTarget(width, height, { type: HalfFloatType });
    const frameRT = rt();
    let accA = rt();
    let accB = rt();

    // ------------------------------------------------------------------ uniforms
    const U = {
      time: uniform(0),
      dt: uniform(1 / 60),
      frame: uniform(0),
      gravity: uniform(1),
      ring: uniform(0),
      spiral: uniform(0),
      column: uniform(0),
      chaos: uniform(0.4),
      jet: uniform(0), // impulse this frame: spears from the disc
      burst: uniform(0), // impulse this frame: explosion
      burstAt: uniform(new Vector3(0, 1, 0)),
      streak: uniform(0.04),
      weight: uniform(0.02),
    };

    // ------------------------------------------------------------------ particles
    const pos = instancedArray(N, 'vec3');
    const vel = instancedArray(N, 'vec3');
    const life = instancedArray(N, 'float');

    const rand = (k: number) => hash(instanceIndex.add(U.frame.mod(997).mul(STREAM).add(k * 7919).toUint()));
    const spawn = (p: Node<'vec3'>, v: Node<'vec3'>, l: Node<'float'>, seedK: number) => {
      // bundles: every particle belongs to one of 40 clusters on the disc, so strands travel (and read) together
      const cluster = hash(instanceIndex.mod(40).add(STREAM * 7)).toVar();
      const cr = sqrt(cluster).mul(2.4);
      const ca = hash(instanceIndex.mod(40).add(STREAM * 8)).mul(6.2832);
      const spread = rand(seedK).mul(0.22);
      const a = rand(seedK + 1).mul(6.2832);
      p.assign(vec3(cos(ca).mul(cr).add(cos(a).mul(spread)), rand(seedK + 2).mul(0.05), sin(ca).mul(cr).add(sin(a).mul(spread))));
      v.assign(vec3(0, 0, 0));
      l.assign(rand(seedK + 3).mul(7).add(2));
    };

    const init = Fn(() => {
      spawn(pos.element(instanceIndex), vel.element(instanceIndex), life.element(instanceIndex), 0);
    })().compute(N);

    const update = Fn(() => {
      const p = pos.element(instanceIndex);
      const v = vel.element(instanceIndex);
      const l = life.element(instanceIndex);
      const dt = U.dt;
      const up = vec3(0, 1, 0);
      const rho = length(vec2(p.x, p.z)).add(1e-4);
      const radial = vec3(p.x.div(rho), 0, p.z.div(rho));
      const tangent = vec3(p.z.negate().div(rho), 0, p.x.div(rho));
      const own = hash(instanceIndex.add(STREAM * 5));

      // forms (accelerations; strong drag turns them into flows)
      const gravity = up.mul(-3.2).mul(U.gravity);
      const dR = rho.sub(1.7);
      const dY = p.y.sub(1.5);
      const core = sqrt(dR.mul(dR).add(dY.mul(dY))).add(0.2);
      const ring = radial.mul(dY.negate()).add(up.mul(dR)).div(core).mul(14).mul(U.ring)
        .add(radial.mul(dR.negate()).add(up.mul(dY.negate())).mul(1.2).mul(U.ring)); // circulate around the core, held near it
      const spiral = tangent.mul(float(6).div(rho.add(0.4))).sub(radial.mul(1.2)).sub(up.mul(p.y.mul(3))).mul(U.spiral);
      const column = radial.mul(rho.mul(-9)).add(up.mul(own.mul(5).add(3))).mul(U.column);
      const turb = mx_noise_vec3(p.mul(1.1).add(vec3(0, U.time.mul(0.35), U.time.mul(0.1)))).mul(18).mul(U.chaos);
      const accel = gravity.add(ring).add(spiral).add(column).add(turb);
      const nv = v.add(accel.mul(dt)).mul(exp(dt.mul(-1.6))).toVar();

      // impulses: spears from the disc on kicks, an explosion on the drop
      const onDisc = rho.lessThan(own.mul(1.6).add(0.4)).and(p.y.lessThan(0.6));
      If(onDisc.and(rand(11).lessThan(0.35)), () => {
        nv.addAssign(up.mul(U.jet.mul(rand(12).mul(10).add(3))).add(radial.mul(U.jet.mul(rand(13).sub(0.5).mul(3)))));
      });
      const away = p.sub(U.burstAt);
      nv.addAssign(normalize(away.add(vec3(1e-3, 2e-3, 3e-3))).mul(U.burst.mul(own.mul(14).add(4)).div(length(away).mul(0.4).add(1))));

      const np = p.add(nv.mul(dt)).toVar();
      // the disc is a floor: bounce low, slide with friction
      If(np.y.lessThan(0), () => {
        np.y.assign(np.y.negate().mul(0.3));
        nv.y.assign(abs(nv.y).mul(0.3));
        nv.x.mulAssign(0.82);
        nv.z.mulAssign(0.82);
      });
      p.assign(np);
      v.assign(nv);
      l.subAssign(dt);
      If(l.lessThan(0).or(length(np).greaterThan(11)), () => {
        spawn(p, v, l, 20);
      });
    })().compute(N);

    // ------------------------------------------------------------------ strands: one hairline per particle, along its velocity
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(N * 2 * 3), 3));
    const lineMat = new LineBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: AdditiveBlending });
    const id = vertexIndex.div(2);
    const tail = vertexIndex.mod(2).toFloat();
    const lp = pos.element(id);
    const lv = vel.element(id);
    lineMat.positionNode = lp.sub(lv.mul(U.streak).mul(tail));
    const speed = length(lv);
    const bright = hash(id.add(STREAM * 9)).mul(0.9).add(0.4);
    lineMat.colorNode = vec4(vec3(U.weight.mul(bright).mul(float(0.5).add(speed.mul(0.08).min(1.5)))), 1);
    const strands = new LineSegments(geometry, lineMat);
    strands.frustumCulled = false;
    scene.add(strands);

    // ------------------------------------------------------------------ long exposure: accumulate the strands with a decay
    const decay = uniform(0.9);
    const prev = texture(accA.texture);
    const fresh = texture(frameRT.texture);
    const feedMat = new MeshBasicNodeMaterial();
    feedMat.colorNode = vec4(prev.rgb.mul(decay).add(fresh.rgb), 1);
    const feed = new QuadMesh(feedMat);

    // ------------------------------------------------------------------ the finish: ink on paper ↔ light on black
    const P = { light: uniform(0), ink: uniform(0.5), flash: uniform(0), glow: uniform(0.4), aspect: uniform(width / height) };
    const acc = texture(accB.texture);
    const composite = Fn(() => {
      const d = acc.r;
      const q = screenUV.sub(0.5).mul(vec2(P.aspect, 1));
      const inkAmt = float(1).sub(exp(d.mul(P.ink.mul(5).add(0.6)).negate()));
      const paperTone = float(0.86).sub(q.dot(q).mul(0.18));
      const paper = vec3(paperTone).mul(float(1).sub(inkAmt.mul(0.97)));
      const light = vec3(inkAmt.mul(1.35)).mul(vec3(0.95, 0.97, 1.0));
      return vec4(mix(paper, light, P.light).add(vec3(P.flash)), 1);
    })();
    const glowNode = bloom(composite, 1, 0.45, 0.6);
    glowNode.strength = P.glow;
    const pipeline = new RenderPipeline(renderer);
    pipeline.outputColorTransform = false;
    pipeline.outputNode = composite.add(glowNode.mul(P.light));

    // ------------------------------------------------------------------ the choreography
    let lastDrops = 0;
    let lastKickAge = 99;
    let lastBar = -1;
    let lastCut = -1;
    let form = 0;
    let dropAt = -99;
    let frameNo = 0;
    let seed = 3;
    let needInit = true;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const W = { ring: 0, spiral: 0, column: 0, gravity: 1 };
    const at = new Vector3();
    const easeTo = (cur: number, goal: number, dt: number, tau: number) => cur + (goal - cur) * (1 - Math.exp(-dt / tau));

    /** Shots: 0 horizon, 1 low under the spears, 2 top-down (spirals), 3 impact pull-back, 4 build push, 5 orbit. */
    function frameShot(shot: number, l: number, cut: number, kick: number, amt: number) {
      let fov = 42;
      at.set(0, 1.2, 0);
      const side = Math.sin(cut * 12.9898) > 0 ? 1 : -1;
      at.set(0, 1.4, 0);
      if (shot === 0) camera.position.set(side * (1.0 + l * 0.03), 1.3, 6.2);
      else if (shot === 1) {
        camera.position.set(side * 1.5, 0.25, 5.2);
        at.set(0, 2.2, 0);
        fov = 55;
      } else if (shot === 2) {
        const a = l * 0.04 + cut;
        camera.position.set(Math.sin(a) * 0.4, 8.0, Math.cos(a) * 0.4 + 0.01);
        at.set(0, 0, 0);
      } else if (shot === 3) {
        camera.position.set(0, 1.4, 3.5 + ease.out(l / 6) * 8);
        fov = 50;
      } else if (shot === 4) {
        const dist = 11 - ease.inOut(l / 16) * 7;
        camera.position.set(0, 1.5, dist);
        at.set(0, 2.2, 0);
      } else {
        const a = l * 0.08 * (0.5 + amt) + cut;
        camera.position.set(Math.sin(a) * 5.8, 2.0 + Math.sin(a * 0.6), Math.cos(a) * 5.8);
      }
      camera.up.set(0, shot === 2 ? 0 : 1, shot === 2 ? -1 : 0);
      const [sx, sy, sz] = shake(l, 0.004 + 0.04 * kick);
      camera.position.x += sx;
      camera.position.y += sy;
      camera.position.z += sz;
      camera.fov = fov;
      camera.updateProjectionMatrix();
      camera.lookAt(at);
    }

    return {
      render(frame, target) {
        const s = frame.signals;
        const m = frame.macros;
        const d = director.update(s);
        const dt = Math.min(1 / 30, Math.max(1 / 240, s.dt || 1 / 60));
        const beatSec = 60 / Math.max(30, s.bpm);
        frameNo++;
        if (needInit) {
          renderer.compute(init);
          needInit = false;
        }

        const kickHit = d.kickAge < lastKickAge && d.kickAge < 0.05;
        lastKickAge = d.kickAge;
        const dropped = d.drops !== lastDrops;
        lastDrops = d.drops;
        const bar = Math.floor(s.beats / 4);
        const newBar = bar !== lastBar;
        lastBar = bar;
        const building = d.phase === 'build';

        // ---- which form carries the particles: changes on some bars, more often with the knob
        if (newBar && !building && rnd() < 0.25 + m[6] * 0.6) form = (form + 1 + Math.floor(rnd() * (FORMS.length - 1))) % FORMS.length;
        const f = FORMS[form];
        const calm = d.phase === 'calm';
        W.ring = easeTo(W.ring, !building && f === 'ring' ? 1 : 0, dt, 0.6);
        W.spiral = easeTo(W.spiral, !building && (f === 'spiral' || calm) ? 1 : 0, dt, 0.8);
        W.column = easeTo(W.column, building ? 0.4 + s.tension : 0, dt, 0.5);
        W.gravity = easeTo(W.gravity, building ? 0.15 : f === 'hair' ? 0.35 : 1, dt, 0.5);

        U.jet.value = 0;
        U.burst.value = 0;
        if (kickHit && !building) U.jet.value = (0.5 + m[0]) * (f === 'fountain' ? 1.3 : 0.7) * (0.6 + s.low * 0.6);
        if (dropped) {
          U.burst.value = 1 + m[0];
          (U.burstAt.value as Vector3).set(0, 2.2, 0);
          dropAt = s.time;
          P.flash.value = 0.25;
          form = 1; // a ring after the explosion
        }

        // ---- uniforms
        U.time.value = s.time;
        U.dt.value = dt;
        U.frame.value = frameNo;
        U.ring.value = W.ring * (0.6 + m[0] * 0.8);
        U.spiral.value = W.spiral * (0.6 + m[0] * 0.6);
        U.column.value = W.column;
        U.gravity.value = W.gravity;
        U.chaos.value = 0.15 + m[1] * 0.9 + (f === 'hair' ? 0.6 : 0) + s.onset * 0.25;
        U.streak.value = 0.02 + m[4] * 0.08;
        U.weight.value = 0.003 + m[3] * 0.007;

        // light on black for two bars after the drop (or by the knob)
        const since = s.time - dropAt;
        const inverted = since >= 0 && since < beatSec * 8 ? 1 : 0;
        P.light.value = easeTo(Number(P.light.value), Math.max(inverted, m[5] > 0.5 ? 1 : 0), dt, 0.06);
        P.ink.value = m[3];
        P.glow.value = 0.25 + m[3] * 0.4;
        P.aspect.value = target.width / target.height;
        P.flash.value = Number(P.flash.value) * Math.exp(-dt / 0.1);
        // trail: a long exposure that lengthens through a build
        decay.value = Math.exp(-dt / (0.03 + m[2] * 0.2 + (building ? s.tension * 0.25 : 0)));

        // ---- simulate, draw the strands, accumulate, finish
        renderer.compute(update);
        frameShot(d.shot, (d.local * 60) / Math.max(30, s.bpm), d.cut, s.kick, m[7]);
        if (d.cut !== lastCut) decay.value = 0; // a cut starts a fresh exposure
        lastCut = d.cut;

        renderer.setRenderTarget(frameRT);
        renderer.setClearColor(0x000000, 1);
        renderer.clear();
        renderer.render(scene, camera);

        prev.value = accA.texture;
        renderer.setRenderTarget(accB);
        feed.render(renderer);
        acc.value = accB.texture;
        [accA, accB] = [accB, accA];

        renderer.setRenderTarget(target);
        pipeline.render();
      },
      debug: () => ({ ...director.current, form: FORMS[form], light: Number(P.light.value) }),
      resize(w, h) {
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        [frameRT, accA, accB].forEach((t) => t.setSize(w, h));
      },
      dispose() {
        pipeline.dispose();
        lineMat.dispose();
        feedMat.dispose();
        geometry.dispose();
        [frameRT, accA, accB].forEach((t) => t.dispose());
        init.dispose();
        update.dispose();
      },
    };
  },
});
