// RAN（乱）— half a million strands of light running wild with the sound, an alien made of them, and fractals in them.
// Reference: the user's screen recording of sakrmusic's audio-visual loops — ink-fine particle trails on white that
// erupt from a horizon disc as spears, fountains, vortex rings, spiral galaxies and hair balls, flipping now and then to
// white light on black. Every particle is drawn as a hairline streak along its velocity and the streaks accumulate with
// a slow decay (a long exposure), so motion leaves strands instead of dots.
// The alien (ALIEN SIGNAL's Meshy model, skinned on the GPU) is made of strands: about half the particles cling to its
// dancing body; kicks shed strands that fly off and come back, the drop blows the whole body apart and it re-forms.
// Fractals: spears fired by kicks branch 2 → 4 → 8 as they rise (lightning, trees); in the "julia" form the strands on
// the floor circle the boundary of a slowly morphing Julia set and draw its filigree.
// Choreography: kicks fire spears; bars change the form (fountain, ring, spiral, hair, julia); a build draws the free
// strands into one rising needle while the alien slows; the drop explodes everything and turns ink into light.
import {
  AdditiveBlending, AnimationMixer, BufferAttribute, BufferGeometry, HalfFloatType, LineBasicNodeMaterial, LineSegments, Matrix4,
  MeshBasicNodeMaterial, PerspectiveCamera, QuadMesh, RenderPipeline, RenderTarget, Scene, Vector3,
} from 'three/webgpu';
import type { AnimationAction, AnimationClip, Node, Object3D, SkinnedMesh } from 'three/webgpu';
import {
  Break, Fn, If, Loop, abs, computeSkinning, cos, exp, float, hash, instanceIndex, instancedArray, int, length, max, mix,
  mx_noise_vec3, normalize, screenUV, select, sin, sqrt, texture, uniform, vec2, vec3, vec4, vertexIndex,
} from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { defineGpuInstrument } from '../../src/engine/gpu/types';
import type { InstrumentManifest } from '../../src/engine/types';
import { Director } from '../../src/engine/gpu/world/director';
import { ease, shake } from '../../src/engine/gpu/world/kit';
// the same alien as ALIEN SIGNAL (one model, two works)
import alienUrl from '../alien-signal/models/alien.glb?url';

const manifest: InstrumentManifest = {
  id: 'ran',
  name: 'RAN',
  nameJa: '乱',
  mood: ['ink', 'light', 'particles', 'alien'],
  energy: [0.2, 1],
  tempo: 'sync',
  macros: [
    { id: 'force', label: 'Force', default: 0.55, mod: { source: 'low', amount: 0.3 } },
    { id: 'chaos', label: 'Chaos', default: 0.4, mod: { source: 'high', amount: 0.3 } },
    { id: 'trail', label: 'Trail', default: 0.55 },
    { id: 'ink', label: 'Ink', default: 0.5 },
    { id: 'alien', label: 'Alien', default: 0.6 },
    { id: 'fractal', label: 'Fractal', default: 0.6 },
    { id: 'light', label: 'Light', default: 0 },
    { id: 'form', label: 'Form rate', default: 0.5 },
  ],
  presets: {
    ink: { force: 0.5, chaos: 0.35, trail: 0.65, ink: 0.55, alien: 0.6, fractal: 0.5, light: 0, form: 0.4 },
    light: { force: 0.6, chaos: 0.45, trail: 0.6, ink: 0.45, alien: 0.6, fractal: 0.6, light: 1, form: 0.6 },
    storm: { force: 0.9, chaos: 0.8, trail: 0.45, ink: 0.6, alien: 0.4, fractal: 0.9, light: 0.3, form: 0.9 },
  },
};

const N = 1 << 19; // 524 288 strands
const STREAM = 1_048_573;
const CLUSTERS = 40;
/** Forms that carry the free strands between kicks. */
const FORMS = ['fountain', 'ring', 'spiral', 'hair', 'julia'] as const;
const ROLE = { groove: /bass|rhythmic|hip ?hop/i, wild: /lightning/i, slow: /genie/i };
const ALIEN_SCALE = 1.45; // the 1.7-unit model becomes ~2.5 tall on the 2.6-radius disc

export default defineGpuInstrument({
  manifest,
  async create({ renderer, width, height }) {
    // ------------------------------------------------------------------ the alien: skinned on the GPU, never drawn as a mesh
    const gltf = await new GLTFLoader().loadAsync(alienUrl);
    const root = gltf.scene as Object3D;
    root.scale.setScalar(ALIEN_SCALE);
    let skinned: SkinnedMesh | null = null;
    root.traverse((o) => {
      if (!skinned && (o as SkinnedMesh).isSkinnedMesh) skinned = o as SkinnedMesh;
    });
    if (!skinned) throw new Error('alien.glb has no skinned mesh');
    const body3d = skinned as SkinnedMesh;
    const clips = gltf.animations as AnimationClip[];
    const byRole = (re: RegExp, i: number) => clips.find((c) => re.test(c.name)) ?? clips[Math.min(i, clips.length - 1)];
    const clipFor = { wild: byRole(ROLE.wild, 1), slow: byRole(ROLE.slow, 2) };
    const grooves = clips.filter((c) => c !== clipFor.wild && c !== clipFor.slow);
    if (!grooves.length && clips.length) grooves.push(clips[0]);
    const mixer = new AnimationMixer(root);
    let action: AnimationAction | null = null;
    const play = (clip: AnimationClip | undefined) => {
      if (!clip) return;
      const next = mixer.clipAction(clip);
      if (next === action) return;
      action?.stop();
      next.play();
      action = next;
    };
    /** Animation time locked to the beat grid: one loop of the clip = a whole number of bars. */
    const pose = (beats: number, bpm: number, speed: number) => {
      if (!action) return;
      const dur = action.getClip().duration;
      const loopBeats = Math.max(4, Math.round((dur * bpm) / 60 / speed / 4) * 4);
      action.time = ((beats % loopBeats) / loopBeats) * dur;
      mixer.update(0);
      root.updateMatrixWorld(true);
      // the mesh is never drawn, so nothing else refreshes the bone matrices the GPU skinning reads
      body3d.skeleton.update();
    };
    play(grooves[0]);
    root.updateMatrixWorld(true);
    body3d.skeleton.update();
    const V = body3d.geometry.getAttribute('position').count;

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
      julia: uniform(0),
      juliaC: uniform(new Vector3(-0.8, 0.156, 0)),
      chaos: uniform(0.4),
      jet: uniform(0), // impulse this frame: spears from the disc
      branch: uniform(0.6), // how hard the spears split (fractal trees)
      burst: uniform(0), // impulse this frame: explosion
      burstAt: uniform(new Vector3(0, 1.4, 0)),
      streak: uniform(0.04),
      weight: uniform(0.02),
      alienM: uniform(new Matrix4()),
      alienOn: uniform(1),
      bindFrac: uniform(0.55),
      spring: uniform(140),
      shed: uniform(0), // share of the body's strands released this frame
      center: uniform(new Vector3(0, 1.3, 0)),
    };

    // ------------------------------------------------------------------ the body: world positions and velocities of the alien's vertices
    const body = instancedArray(V, 'vec3');
    const bodyVel = instancedArray(V, 'vec3');
    const skin = Fn(() => {
      // (typed as void, but it returns the skinned position; the output-node form leaves the buffer empty)
      const local = (computeSkinning as unknown as (m: SkinnedMesh) => Node<'vec3'>)(body3d).toVar();
      const world = U.alienM.mul(vec4(local, 1)).xyz;
      const prev = body.element(instanceIndex);
      bodyVel.element(instanceIndex).assign(world.sub(prev).div(U.dt));
      body.element(instanceIndex).assign(world);
    })().compute(V);

    // ------------------------------------------------------------------ particles
    const pos = instancedArray(N, 'vec3');
    const vel = instancedArray(N, 'vec3');
    const life = instancedArray(N, 'float');
    const free = instancedArray(N, 'float'); // seconds a body strand stays free (≤ 0: clinging to the body)

    const rand = (k: number) => hash(instanceIndex.add(U.frame.mod(997).mul(STREAM).add(k * 7919).toUint()));
    const cluster = instanceIndex.mod(CLUSTERS);
    const spawn = (p: Node<'vec3'>, v: Node<'vec3'>, l: Node<'float'>, seedK: number) => {
      // bundles: every particle belongs to one of 40 clusters on the disc, so strands travel (and read) together
      const cr = sqrt(hash(cluster.add(STREAM * 7))).mul(2.4);
      const ca = hash(cluster.add(STREAM * 8)).mul(6.2832);
      const spread = rand(seedK).mul(0.22);
      const a = rand(seedK + 1).mul(6.2832);
      p.assign(vec3(cos(ca).mul(cr).add(cos(a).mul(spread)), rand(seedK + 2).mul(0.05), sin(ca).mul(cr).add(sin(a).mul(spread))));
      v.assign(vec3(0, 0, 0));
      l.assign(rand(seedK + 3).mul(7).add(2));
    };

    const init = Fn(() => {
      spawn(pos.element(instanceIndex), vel.element(instanceIndex), life.element(instanceIndex), 0);
      free.element(instanceIndex).assign(rand(40).mul(2));
    })().compute(N);

    /** Direction of steepest ascent of a Julia set's potential at w (complex), or 0 inside the set. */
    const juliaGrad = Fn(([w]: [Node<'vec2'>]) => {
      const zr = w.x.toVar();
      const zi = w.y.toVar();
      const dr = float(1).toVar();
      const di = float(0).toVar();
      const esc = float(0).toVar();
      Loop({ start: int(0), end: int(18), type: 'int', condition: '<' }, () => {
        const ndr = zr.mul(dr).sub(zi.mul(di)).mul(2).toVar();
        const ndi = zr.mul(di).add(zi.mul(dr)).mul(2).toVar();
        const nzr = zr.mul(zr).sub(zi.mul(zi)).add(U.juliaC.x).toVar();
        const nzi = zr.mul(zi).mul(2).add(U.juliaC.y).toVar();
        dr.assign(ndr);
        di.assign(ndi);
        zr.assign(nzr);
        zi.assign(nzi);
        If(zr.mul(zr).add(zi.mul(zi)).greaterThan(64), () => {
          esc.assign(1);
          Break();
        });
      });
      const den = dr.mul(dr).add(di.mul(di)).add(1e-20);
      const u = vec2(zr.mul(dr).add(zi.mul(di)), zi.mul(dr).sub(zr.mul(di))).div(den);
      return select(esc.greaterThan(0.5), normalize(u.add(vec2(1e-9, 0))), vec2(0, 0));
    });

    const update = Fn(() => {
      const p = pos.element(instanceIndex);
      const v = vel.element(instanceIndex);
      const l = life.element(instanceIndex);
      const ft = free.element(instanceIndex);
      const dt = U.dt;
      const up = vec3(0, 1, 0);
      const own = hash(instanceIndex.add(STREAM * 5));
      const ofBody = own.lessThan(U.bindFrac);
      const nv = v.toVar();
      const np = p.toVar();

      // ---- the body: strands that belong to the alien
      const vi = hash(instanceIndex.add(STREAM * 6)).mul(V - 1).toUint();
      const target = body.element(vi).add(vec3(hash(instanceIndex.add(STREAM * 2)), hash(instanceIndex.add(STREAM * 3)), hash(instanceIndex.add(STREAM * 4))).sub(0.5).mul(0.05));
      const tvel = bodyVel.element(vi);
      If(ofBody.and(ft.lessThanEqual(0)).and(rand(31).lessThan(U.shed)), () => {
        ft.assign(rand(32).mul(1.4).add(0.6));
        nv.addAssign(tvel.mul(1.2).add(normalize(p.sub(U.center).add(vec3(1e-3, 2e-3, 3e-3))).mul(rand(33).mul(5).add(1.5))));
      });
      If(ofBody.and(U.burst.greaterThan(0)), () => {
        ft.assign(rand(34).mul(1.5).add(2.2));
      });

      If(ofBody.and(ft.lessThanEqual(0)).and(U.alienOn.greaterThan(0.5)), () => {
        // clinging: a spring that also matches the body's velocity, so the strands dance with it; a little fuzz
        const fuzz = mx_noise_vec3(p.mul(6).add(vec3(0, U.time.mul(0.8), 0))).mul(6);
        const a = target.sub(p).mul(U.spring).add(tvel.sub(nv).mul(U.spring.sqrt().mul(1.7))).add(fuzz);
        const al = length(a);
        nv.addAssign(a.mul(float(600).div(max(al, 600))).mul(dt));
        np.assign(p.add(nv.mul(dt)));
      }).Else(() => {
        // ---- free strands: the forms
        const rho = length(vec2(p.x, p.z)).add(1e-4);
        const radial = vec3(p.x.div(rho), 0, p.z.div(rho));
        const tangent = vec3(p.z.negate().div(rho), 0, p.x.div(rho));
        const gravity = up.mul(-3.2).mul(U.gravity);
        const dR = rho.sub(1.7);
        const dY = p.y.sub(1.5);
        const core = sqrt(dR.mul(dR).add(dY.mul(dY))).add(0.2);
        const ring = radial.mul(dY.negate()).add(up.mul(dR)).div(core).mul(14).mul(U.ring)
          .add(radial.mul(dR.negate()).add(up.mul(dY.negate())).mul(1.2).mul(U.ring));
        const spiral = tangent.mul(float(6).div(rho.add(0.4))).sub(radial.mul(1.2)).sub(up.mul(p.y.mul(3))).mul(U.spiral);
        const column = radial.mul(rho.mul(-9)).add(up.mul(own.mul(5).add(3))).mul(U.column);
        // the floor as a Julia set: strands run along its equipotentials and lean toward its boundary
        const g = juliaGrad(vec2(p.x, p.z).div(1.25));
        const onFloor = float(1).sub(p.y.div(0.9)).max(0);
        const julia = vec3(g.y.negate(), 0, g.x).mul(7).sub(vec3(g.x, 0, g.y).mul(2.5)).mul(onFloor).mul(U.julia);
        const turb = mx_noise_vec3(p.mul(1.1).add(vec3(0, U.time.mul(0.35), U.time.mul(0.1)))).mul(18).mul(U.chaos);
        const accel = gravity.add(ring).add(spiral).add(column).add(julia).add(turb);
        nv.assign(v.add(accel.mul(dt)).mul(exp(dt.mul(-1.6))));

        // spears from the disc on kicks
        const onDisc = rho.lessThan(own.mul(1.6).add(0.4)).and(p.y.lessThan(0.6));
        If(onDisc.and(rand(11).lessThan(0.35)), () => {
          nv.addAssign(up.mul(U.jet.mul(rand(12).mul(10).add(3))).add(radial.mul(U.jet.mul(rand(13).sub(0.5).mul(3)))));
        });
        // the drop: an explosion
        const away = p.sub(U.burstAt);
        nv.addAssign(normalize(away.add(vec3(1e-3, 2e-3, 3e-3))).mul(U.burst.mul(own.mul(14).add(4)).div(length(away).mul(0.4).add(1))));

        np.assign(p.add(nv.mul(dt)));
        // fractal spears: crossing each branching height while rising fast, a bundle splits in two (2 → 4 → 8)
        for (let k = 0; k < 3; k++) {
          const h = 0.7 + k * 0.75;
          If(p.y.lessThan(h).and(np.y.greaterThanEqual(h)).and(nv.y.greaterThan(1.5)), () => {
            const side = hash(instanceIndex.add(STREAM * (11 + k))).greaterThan(0.5).select(1, -1);
            const plane = hash(cluster.mul(13).add(k * 977).add(STREAM * 12)).mul(6.2832);
            nv.addAssign(vec3(cos(plane), 0, sin(plane)).mul(nv.y.mul(0.5).mul(side).mul(U.branch)));
          });
        }
        // the disc is a floor: bounce low, slide with friction
        If(np.y.lessThan(0), () => {
          np.y.assign(np.y.negate().mul(0.3));
          nv.y.assign(abs(nv.y).mul(0.3));
          nv.x.mulAssign(0.82);
          nv.z.mulAssign(0.82);
        });
        ft.subAssign(dt);
        l.subAssign(dt);
        If(ofBody.not().and(l.lessThan(0).or(length(np).greaterThan(11))), () => {
          spawn(np, nv, l, 20);
        });
        If(ofBody.and(length(np).greaterThan(14)), () => {
          np.assign(target);
          nv.assign(vec3(0, 0, 0));
        });
      });
      p.assign(np);
      v.assign(nv);
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
    // strands on the body are many and close together: thinner ink, so the alien reads as fur, not a blot
    const clinging = hash(id.add(STREAM * 5)).lessThan(U.bindFrac).and(free.element(id).lessThanEqual(0)).and(U.alienOn.greaterThan(0.5));
    const share = clinging.select(0.5, 1);
    lineMat.colorNode = vec4(vec3(U.weight.mul(bright).mul(share).mul(float(0.5).add(speed.mul(0.08).min(1.5)))), 1);
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
      const light = vec3(inkAmt).mul(vec3(0.95, 0.97, 1.0));
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
    let juliaA = 0;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const W = { ring: 0, spiral: 0, column: 0, julia: 0, gravity: 1 };
    const at = new Vector3();
    const easeTo = (cur: number, goal: number, dt: number, tau: number) => cur + (goal - cur) * (1 - Math.exp(-dt / tau));

    /** Shots: 0 horizon, 1 low under the alien, 2 top-down (spirals, Julia floor), 3 impact pull-back, 4 build push, 5 orbit. */
    function frameShot(shot: number, l: number, cut: number, kick: number) {
      let fov = 42;
      at.set(0, 1.4, 0);
      const side = Math.sin(cut * 12.9898) > 0 ? 1 : -1;
      if (shot === 0) camera.position.set(side * (1.0 + l * 0.03), 1.3, 6.2);
      else if (shot === 1) {
        camera.position.set(side * 1.3, 0.25, 4.4);
        at.set(0, 1.9, 0);
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
        at.set(0, 1.8, 0);
      } else {
        const a = l * 0.06 + cut;
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

        const kickHit = d.kickAge < lastKickAge && d.kickAge < 0.05;
        lastKickAge = d.kickAge;
        const dropped = d.drops !== lastDrops;
        lastDrops = d.drops;
        const bar = Math.floor(s.beats / 4);
        const newBar = bar !== lastBar;
        lastBar = bar;
        const building = d.phase === 'build';
        const calm = d.phase === 'calm';
        const since = s.time - dropAt;
        const afterDrop = since >= 0 && since < beatSec * 8;

        // ---- the alien dances on the beat grid: slow in a build, wild after the drop, grooves otherwise
        play(afterDrop ? clipFor.wild : building ? clipFor.slow : grooves[Math.floor(bar / 2) % grooves.length]);
        pose(s.beats, s.bpm, building ? 0.5 : 1);
        (U.alienM.value as Matrix4).copy(body3d.matrixWorld);
        U.dt.value = dt;
        renderer.compute(skin);
        if (needInit) {
          renderer.compute(skin); // twice, so the first velocities are not a jump from the origin
          renderer.compute(init);
          needInit = false;
        }

        // ---- which form carries the free strands: changes on some bars, more often with the knob
        if (newBar && !building && rnd() < 0.25 + m[7] * 0.6) form = (form + 1 + Math.floor(rnd() * (FORMS.length - 1))) % FORMS.length;
        const f = FORMS[form];
        W.ring = easeTo(W.ring, !building && f === 'ring' ? 1 : 0, dt, 0.6);
        W.spiral = easeTo(W.spiral, !building && (f === 'spiral' || calm) ? 1 : 0, dt, 0.8);
        W.julia = easeTo(W.julia, !building && (f === 'julia' || calm) ? 1 : 0, dt, 0.8);
        W.column = easeTo(W.column, building ? 0.4 + s.tension : 0, dt, 0.5);
        W.gravity = easeTo(W.gravity, building ? 0.15 : f === 'hair' ? 0.35 : 1, dt, 0.5);

        U.jet.value = 0;
        U.burst.value = 0;
        U.shed.value = 0;
        if (kickHit && !building) {
          U.jet.value = (0.5 + m[0]) * (f === 'fountain' ? 1.3 : 0.7) * (0.6 + s.low * 0.6);
          U.shed.value = 0.04 + m[0] * 0.08;
        }
        if (dropped) {
          U.burst.value = 1 + m[0];
          dropAt = s.time;
          P.flash.value = 0.12;
          form = 1; // a ring after the explosion
        }
        // the Julia parameter walks the classic circle c = 0.7885·e^{iθ}, faster with the mids
        juliaA += dt * (0.05 + s.mid * 0.2);
        (U.juliaC.value as Vector3).set(0.7885 * Math.cos(juliaA), 0.7885 * Math.sin(juliaA), 0);

        // ---- uniforms
        U.time.value = s.time;
        U.frame.value = frameNo;
        U.ring.value = W.ring * (0.6 + m[0] * 0.8);
        U.spiral.value = W.spiral * (0.6 + m[0] * 0.6);
        U.column.value = W.column;
        U.julia.value = W.julia * (0.4 + m[5] * 0.9);
        U.gravity.value = W.gravity;
        U.chaos.value = 0.15 + m[1] * 0.9 + (f === 'hair' ? 0.6 : 0) + s.onset * 0.25;
        U.branch.value = m[5] * 1.1;
        U.streak.value = 0.045;
        U.weight.value = 0.003 + m[3] * 0.007;
        U.bindFrac.value = m[4] * 0.85;
        U.alienOn.value = calm ? 0 : 1; // quiet passages let the alien dissolve; it re-forms when the beat returns
        U.spring.value = building ? 220 : 140;

        // light on black for two bars after the drop (or by the knob)
        P.light.value = easeTo(Number(P.light.value), Math.max(afterDrop ? 1 : 0, m[6] > 0.5 ? 1 : 0), dt, 0.06);
        P.ink.value = m[3];
        P.glow.value = 0.25 + m[3] * 0.4;
        P.aspect.value = target.width / target.height;
        P.flash.value = Number(P.flash.value) * Math.exp(-dt / 0.1);
        decay.value = Math.exp(-dt / (0.03 + m[2] * 0.2 + (building ? s.tension * 0.25 : 0)));

        // ---- simulate, draw the strands, accumulate, finish
        renderer.compute(update);
        frameShot(d.shot, (d.local * 60) / Math.max(30, s.bpm), d.cut, s.kick);
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
      debug: () => ({ ...director.current, form: FORMS[form], light: Number(P.light.value), clip: action?.getClip().name }),
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
        [init, update, skin].forEach((k) => k.dispose());
        mixer.stopAllAction();
      },
    };
  },
});
