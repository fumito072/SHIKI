// ALIEN SIGNAL / 聴く者 — the first WebGPU world.
// A creature nobody has seen: a folded ring of light with sixteen filament limbs and a halo of drifting eyes, made of
// ~400k stateful particles. It listens. Limbs sway with inertia; each kick is a wave that travels down the limbs a
// moment later. Through a build it coils, shivers and gathers light. On the drop it bursts and every particle
// re-forms as one giant eye that looks back at the room, then flows home. A point-cloud floor streams toward the
// camera (you feel you are moving while you sit still). A director edits seven shots to the music.
import {
  AdditiveBlending, Color, PerspectiveCamera, Scene, Sprite, SpriteNodeMaterial,
} from 'three/webgpu';
import type { RenderTarget } from 'three/webgpu';
import {
  Fn, TWO_PI, abs, clamp, cos, cross, exp, float, fract, hash, instanceIndex, instancedArray, length, max, mix,
  mx_noise_float, mx_noise_vec3, normalize, pow, select, sin, smoothstep, sqrt, uniform, uv, vec3, vec4,
} from 'three/tsl';
import { defineGpuInstrument } from '../../src/engine/gpu/types';
import type { InstrumentManifest } from '../../src/engine/types';
import { Director } from '../../src/engine/gpu/world/director';
import { dollyFov, ease, makePost, shake } from '../../src/engine/gpu/world/kit';

const manifest: InstrumentManifest = {
  id: 'alien-signal',
  name: 'ALIEN SIGNAL',
  nameJa: '聴く者',
  mood: ['alien', 'vast', 'cinematic'],
  energy: [0.25, 1],
  tempo: 'sync',
  macros: [
    { id: 'flow', label: 'Flow', default: 0.45, mod: { source: 'high', amount: 0.3 } },
    { id: 'cohesion', label: 'Cohesion', default: 0.55 },
    { id: 'size', label: 'Size', default: 0.5 },
    { id: 'glow', label: 'Glow', default: 0.55 },
    { id: 'trails', label: 'Trails', default: 0.35 },
    { id: 'vection', label: 'Vection', default: 0.5, mod: { source: 'low', amount: 0.3 } },
    { id: 'eye', label: 'Eye', default: 0 },
    { id: 'cut', label: 'Cut rate', default: 0.5 },
  ],
  presets: {
    deep: { flow: 0.3, cohesion: 0.7, size: 0.4, glow: 0.45, trails: 0.5, vection: 0.3, eye: 0, cut: 0.3 },
    storm: { flow: 0.8, cohesion: 0.4, size: 0.6, glow: 0.75, trails: 0.25, vection: 0.85, eye: 0, cut: 0.9 },
  },
};

const LIMBS = 16;
/** Independent random streams: TSL's hash() truncates its seed to an integer, so offsets must be whole and far apart. */
const STREAM = 1_048_573;
const N = 400_000;
const FLOOR_COLS = 520;
const FLOOR_ROWS = 380;
const STARS = 24_000;

// Static limb geometry shared by the particles (TSL) and the cameras (JS).
const limbPhase = (k: number) => (k / LIMBS) * Math.PI * 2;
const limbDir = (k: number): [number, number, number] => {
  const a = limbPhase(k);
  const d = [Math.cos(a) * 0.8, -0.65, Math.sin(a) * 0.8];
  const l = Math.hypot(d[0], d[1], d[2]);
  return [d[0] / l, d[1] / l, d[2] / l];
};

export default defineGpuInstrument({
  manifest,
  create({ renderer, width, height }) {
    const scene = new Scene();
    scene.background = new Color(0x000000);
    const camera = new PerspectiveCamera(40, width / height, 0.05, 400);
    camera.position.set(0, 1.5, 11);

    // ------------------------------------------------------------------ uniforms (set from JS every frame)
    const U = {
      t: uniform(0), dt: uniform(1 / 60), kickAge: uniform(9), tension: uniform(0), level: uniform(0),
      breath: uniform(0), morph: uniform(0), cohesion: uniform(16), burst: uniform(0), flow: uniform(0.5),
      damping: uniform(2.4), style: uniform(0), size: uniform(0.012), travel: uniform(0), kick: uniform(0),
    };

    // ------------------------------------------------------------------ the creature (where each particle wants to be)
    const creature = (i: ReturnType<typeof float>) => {
      const r1 = hash(i);
      const r2 = hash(i.add(STREAM));
      const r3 = hash(i.add(STREAM * 2));
      const r4 = hash(i.add(STREAM * 3));
      const t = U.t;
      const squeeze = float(1).sub(U.tension.mul(0.38));

      // Body: a ring with travelling folds that breathes on the bar.
      const a = r2.mul(TWO_PI);
      const v = r3.mul(TWO_PI);
      const R = float(1).add(sin(a.mul(6).add(t.mul(0.7))).mul(0.18)).add(U.breath.mul(0.08));
      const rr = float(0.32).mul(float(1).add(sin(v.mul(3).add(a.mul(5)).add(t)).mul(0.35)));
      const body = vec3(
        R.add(rr.mul(cos(v))).mul(cos(a)),
        rr.mul(sin(v)).mul(0.9).add(sin(a.mul(3).add(t.mul(0.5))).mul(0.15)),
        R.add(rr.mul(cos(v))).mul(sin(a)),
      ).mul(squeeze);

      // Limbs: sixteen filaments that lag behind the body; a kick travels down them as a wave.
      const k = r2.mul(LIMBS).floor();
      const ph = k.div(LIMBS).mul(TWO_PI);
      const u = pow(r3, 0.7);
      const base = vec3(cos(ph), 0, sin(ph)).mul(1.05).mul(squeeze);
      const dir = normalize(vec3(cos(ph).mul(0.8), float(-0.65), sin(ph).mul(0.8)));
      const len = float(4.5).mul(float(1).sub(U.tension.mul(0.55))).mul(float(0.8).add(hash(k.add(STREAM * 8)).mul(0.4)));
      const side = normalize(cross(dir, vec3(0, 1, 0)));
      const up = cross(side, dir);
      const lag = t.mul(0.9).sub(u.mul(2.2)).add(k.mul(0.7));
      const reach = pow(u, 1.6);
      const sway = side.mul(sin(lag).mul(reach).mul(float(0.9).add(U.level.mul(0.8))))
        .add(up.mul(cos(lag.mul(0.8).add(k)).mul(reach).mul(0.6)));
      const front = U.kickAge.mul(2.6);
      const wave = exp(pow(u.sub(front).mul(6), 2).negate()).mul(smoothstep(1.2, 0.2, U.kickAge));
      const shiver = mx_noise_vec3(vec3(i.mul(0.013), t.mul(9), k)).mul(U.tension.mul(0.09).mul(u));
      const thick = float(0.065).mul(float(1).sub(u.mul(0.8)));
      const jitter = vec3(hash(i.add(STREAM * 4)), hash(i.add(STREAM * 5)), hash(i.add(STREAM * 6))).sub(0.5).mul(2).mul(thick);
      const limb = base.add(dir.mul(u.mul(len))).add(sway).add(up.mul(wave.mul(0.45))).add(shiver).add(jitter);

      // Halo: eyes drifting on a loose shell.
      const th = r2.mul(TWO_PI).add(t.mul(r3.sub(0.5).mul(0.12)));
      const cz = r3.mul(2).sub(1);
      const rad = float(2.6).add(r4.mul(2.2));
      const sz = sqrt(max(float(0), float(1).sub(cz.mul(cz))));
      const halo = vec3(cos(th).mul(sz), cz.mul(0.7).add(0.4), sin(th).mul(sz)).mul(rad);

      // The eye: everything becomes one iris facing +z, with a pupil.
      const rho = float(1.25).add(sqrt(r2).mul(4.9));
      const ang = r3.mul(TWO_PI);
      const fibre = sin(ang.mul(48).add(r4.mul(3))).mul(0.06).add(1);
      const eye = vec3(cos(ang).mul(rho).mul(fibre), sin(ang).mul(rho).mul(fibre),
        cos(rho.div(6.2).mul(1.57)).mul(1.4).sub(1.6).add(r4.mul(0.08)));

      const shape = select(r1.lessThan(0.3), body, select(r1.lessThan(0.955), limb, halo));
      const pos = mix(shape, eye, U.morph);
      const heat = select(r1.lessThan(0.3), float(0), select(r1.lessThan(0.955), wave, float(0.9)));
      return { pos, heat };
    };

    // ------------------------------------------------------------------ stateful particles
    const position = instancedArray(N, 'vec3');
    const velocity = instancedArray(N, 'vec3');
    const heat = instancedArray(N, 'float');

    const init = Fn(() => {
      const i = float(instanceIndex);
      const c = creature(i);
      position.element(instanceIndex).assign(c.pos);
      velocity.element(instanceIndex).assign(vec3(0));
    })().compute(N);

    const update = Fn(() => {
      const i = float(instanceIndex);
      const p = position.element(instanceIndex);
      const vel = velocity.element(instanceIndex);
      const c = creature(i);
      const flow = mx_noise_vec3(p.mul(0.35).add(vec3(0, U.t.mul(0.15), U.t.mul(0.05)))).mul(U.flow);
      const outward = normalize(p.add(vec3(1e-3, 2e-3, 3e-3))).mul(U.burst.mul(hash(i.add(STREAM * 7)).mul(10).add(4)));
      const acc = c.pos.sub(p).mul(U.cohesion).add(flow);
      const nv = vel.mul(exp(U.dt.mul(U.damping).negate())).add(acc.mul(U.dt)).add(outward);
      vel.assign(nv);
      p.assign(p.add(nv.mul(U.dt)));
      heat.element(instanceIndex).assign(clamp(length(nv).mul(0.09).add(c.heat), 0, 1.5));
    })().compute(N);

    const mat = new SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending });
    mat.positionNode = position.toAttribute();
    const h = heat.toAttribute();
    const disc = smoothstep(0.5, 0.15, length(uv().sub(0.5)));
    const ice = vec3(0.62, 0.86, 1.0);
    const fire = vec3(1.0, 0.32, 0.12);
    const glowCol = mix(ice.mul(0.55), vec3(1.0, 0.97, 0.92), clamp(h, 0, 1)).add(fire.mul(h.sub(0.6).max(0).mul(1.2)));
    const thermal = mix(mix(vec3(0.18, 0.01, 0.0), vec3(1.0, 0.28, 0.04), clamp(h.mul(1.8), 0, 1)),
      vec3(1.0, 0.92, 0.75), clamp(h.sub(0.55).mul(2.2), 0, 1));
    const xray = vec3(0.35, 0.75, 1.0).mul(0.45);
    const col = select(U.style.lessThan(0.5), glowCol, select(U.style.lessThan(1.5), thermal, select(U.style.lessThan(2.5), xray, glowCol)));
    mat.colorNode = vec4(col.mul(disc).mul(0.55), 1);
    mat.scaleNode = U.size.mul(float(1).add(h.mul(1.4)));
    const swarm = new Sprite(mat);
    swarm.count = N;
    swarm.frustumCulled = false;
    scene.add(swarm);

    // ------------------------------------------------------------------ point-cloud floor streaming toward you
    const fm = new SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending });
    const fi = instanceIndex;
    const gx = float(fi.mod(FLOOR_COLS)).div(FLOOR_COLS).sub(0.5).mul(70);
    const depth = 90;
    const gz0 = float(fi.div(FLOOR_COLS)).div(FLOOR_ROWS).mul(depth);
    const gz = fract(gz0.add(U.travel).div(depth)).mul(depth).sub(depth * 0.8);
    const dist = length(vec3(gx, 0, gz));
    const ripple = sin(dist.mul(1.4).sub(U.kickAge.mul(9))).mul(exp(U.kickAge.mul(-2.2))).mul(0.35);
    const gy = mx_noise_float(vec3(gx.mul(0.18), gz.sub(U.travel).mul(0.18), U.t.mul(0.08))).mul(0.9).add(ripple).sub(3.4);
    fm.positionNode = vec3(gx, gy, gz);
    const fade = smoothstep(-depth * 0.8, -depth * 0.35, gz).mul(smoothstep(14, 4, abs(gz)).max(0.25));
    fm.colorNode = vec4(vec3(0.55, 0.66, 0.78).mul(0.24).mul(fade).mul(disc), 1);
    fm.scaleNode = float(0.035);
    const floor = new Sprite(fm);
    floor.count = FLOOR_COLS * FLOOR_ROWS;
    floor.frustumCulled = false;
    scene.add(floor);

    // ------------------------------------------------------------------ far stars
    const sm = new SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending });
    const si = float(instanceIndex);
    const sth = hash(si).mul(TWO_PI);
    const scz = hash(si.add(STREAM)).mul(2).sub(1);
    const ssz = sqrt(max(float(0), float(1).sub(scz.mul(scz))));
    sm.positionNode = vec3(cos(sth).mul(ssz), scz, sin(sth).mul(ssz)).mul(120);
    sm.colorNode = vec4(vec3(0.8, 0.85, 0.9).mul(hash(si.add(STREAM * 2)).mul(0.5).add(0.1)).mul(disc), 1);
    sm.scaleNode = float(0.25);
    const stars = new Sprite(sm);
    stars.count = STARS;
    stars.frustumCulled = false;
    scene.add(stars);

    // ------------------------------------------------------------------ editing
    const director = new Director({ shots: 7, styles: 4, impactShot: 5, buildShot: 6, calmShots: [0, 4], impactStyles: [0, 1], seed: 11 });
    const post = makePost(renderer, scene, camera);
    renderer.compute(init);

    let dropAt = -99;
    let lastFlashHigh = false;
    let travel = 0;

    /** Camera for shot `s`, `l` seconds into it. */
    function frameShot(s: number, l: number, sig: { tension: number; kick: number; level: number }, cut: number) {
      const tgt: [number, number, number] = [0, -0.3, 0];
      let p: [number, number, number] = [0, 1.5, 11];
      let fov = 40;
      let roll = 0;
      if (s === 0) { // void wide: slow orbit far away
        const a = 0.6 + cut * 1.3 + l * 0.07;
        p = [Math.sin(a) * 12, 2.2 + Math.sin(l * 0.1) * 0.6, Math.cos(a) * 12];
      } else if (s === 1) { // macro skin: grazing the ring, scale lost
        const a = cut * 2.1 + l * 0.06;
        p = [Math.cos(a) * 1.75, 0.35, Math.sin(a) * 1.75];
        tgt[0] = Math.cos(a + 0.35) * 1.0; tgt[1] = 0.05; tgt[2] = Math.sin(a + 0.35) * 1.0;
        fov = 26;
      } else if (s === 2) { // limb run: race from the body to a tip
        const k = cut % LIMBS;
        const d = limbDir(k);
        const ph = limbPhase(k);
        const u = Math.min(1, l * 0.3);
        const len = 4.5 * (1 - sig.tension * 0.55);
        const b = [Math.cos(ph) * 1.05, 0, Math.sin(ph) * 1.05];
        const at = (x: number) => [b[0] + d[0] * x * len, b[1] + d[1] * x * len, b[2] + d[2] * x * len];
        const c = at(u);
        const n = at(Math.min(1.2, u + 0.25));
        p = [c[0] - d[2] * 0.6, c[1] + 0.45, c[2] + d[0] * 0.6];
        tgt[0] = n[0]; tgt[1] = n[1]; tgt[2] = n[2];
        fov = 48;
        roll = Math.sin(l * 0.8) * 0.15;
      } else if (s === 3) { // floor skim: low, wide, the floor rushes past
        p = [Math.sin(l * 0.2) * 1.5, -2.7, 7.5];
        tgt[1] = 0.2;
        fov = 62;
        roll = Math.sin(l * 0.35) * 0.08;
      } else if (s === 4) { // below: limbs hanging overhead
        const a = cut * 0.9 + l * 0.05;
        p = [Math.sin(a) * 1.2, -5.2, Math.cos(a) * 1.2];
        tgt[1] = 1;
        fov = 64;
      } else if (s === 5) { // impact: rip backwards from the eye
        const d = 3 + ease.out(l / 1.2) * 11;
        p = [0, 0, d];
        tgt[1] = 0;
        fov = 52;
        roll = (1 - ease.out(l / 1.5)) * 0.4;
      } else if (s === 6) { // build: dolly zoom toward the core (vertigo)
        const d = 15 - ease.inOut(l / 14) * 11;
        p = [0, 0.4, d];
        tgt[1] = 0;
        fov = Math.min(95, dollyFov(4.2, d));
      }
      const amp = 0.015 + 0.09 * sig.kick * sig.level;
      const [sx, sy, sz] = shake(l, amp);
      camera.position.set(p[0] + sx, p[1] + sy, p[2] + sz);
      camera.fov = fov;
      camera.updateProjectionMatrix();
      camera.lookAt(tgt[0], tgt[1], tgt[2]);
      if (roll) camera.rotateZ(roll);
    }

    return {
      render(frame, target: RenderTarget) {
        const s = frame.signals;
        const m = frame.macros;
        const d = director.update(s);
        const dt = Math.min(1 / 30, Math.max(1 / 240, s.dt || 1 / 60));

        // Drop: burst, then everything becomes the eye for a while.
        if (d.flash > 0.95 && !lastFlashHigh) dropAt = s.time;
        lastFlashHigh = d.flash > 0.95;
        const since = s.time - dropAt;
        const eyeEnv = since < 0.25 ? ease.out(since / 0.25) : since < 3.2 ? 1 : Math.exp(-(since - 3.2) / 1.1);
        const burst = since >= 0 && since < dt * 1.5 ? 1 : s.kick > 0.95 ? 0.06 : 0;

        U.t.value = s.time;
        U.dt.value = dt;
        U.kickAge.value = d.kickAge;
        U.kick.value = s.kick;
        U.tension.value = s.tension;
        U.level.value = s.level;
        U.breath.value = Math.sin(s.bar * Math.PI * 2);
        U.morph.value = Math.max(eyeEnv, m[6]);
        U.burst.value = burst;
        U.cohesion.value = (since >= 0 && since < 0.35 ? 0.6 : 8 + 22 * m[1]) + s.tension * 26;
        U.flow.value = 0.15 + m[0] * 1.6 + (d.phase === 'calm' ? 0.25 : 0);
        U.damping.value = 2.2 + s.tension * 1.4;
        U.style.value = d.style;
        U.size.value = 0.006 + m[2] * 0.016;
        travel += dt * (0.4 + m[5] * 5 + (d.shot === 3 ? 6 : 0));
        U.travel.value = travel;

        post.flash.value = d.flash * 1.4;
        post.negative.value = d.style === 3 ? 1 : 0;
        post.bloom.value = 0.15 + m[3] * 0.75 + d.flash * 0.6;
        post.trails.value = Math.min(0.92, m[4] * 0.85 + (d.phase === 'impact' ? 0.35 : 0));

        frameShot(d.shot, (d.local * 60) / Math.max(30, s.bpm), s, d.cut);

        renderer.compute(update);
        renderer.setRenderTarget(target);
        post.render();
      },
      debug: () => ({ ...director.current }),
      resize(w, h) {
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      },
      dispose() {
        post.dispose();
        mat.dispose();
        fm.dispose();
        sm.dispose();
      },
    };
  },
});
