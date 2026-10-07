// ALIEN SIGNAL — v2: a crowd of mesh aliens dancing on the beat grid.
// Our own alien (Studio design → Meshy image-to-3D → humanoid rig → five library dances), drawn as a wireframe over
// a near-black body so the wires read as a 3D form. Light is an event, never a state: each kick lights a random
// patch of cells (a different patch every hit, sometimes none), onsets sweep a scan band from feet to skull, the drop
// floods every wire. A director cuts between the group, skulls, hands, a low orbit and a tracking shot; builds slow
// the dance and hold a dolly zoom; the drop switches the whole crowd to the fastest dance at once.
import {
  AdditiveBlending, AnimationMixer, BufferAttribute, BufferGeometry, Color, LineBasicNodeMaterial, LineSegments,
  MeshBasicNodeMaterial, PerspectiveCamera, Scene, SkinnedMesh, Vector3,
} from 'three/webgpu';
import type { AnimationAction, AnimationClip, Bone, Object3D, RenderTarget } from 'three/webgpu';
import { abs, exp, float, floor, hash, length, mix, positionGeometry, smoothstep, step, uniform, vec3, vec4 } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { defineGpuInstrument } from '../../src/engine/gpu/types';
import type { InstrumentManifest } from '../../src/engine/types';
import { Director } from '../../src/engine/gpu/world/director';
import { dollyFov, ease, makePost, shake } from '../../src/engine/gpu/world/kit';
import alienUrl from './models/alien.glb?url';

const manifest: InstrumentManifest = {
  id: 'alien-signal',
  name: 'ALIEN SIGNAL',
  nameJa: '信号',
  mood: ['alien', 'dance', 'neon'],
  energy: [0.35, 1],
  tempo: 'sync',
  macros: [
    { id: 'hits', label: 'Hits', default: 0.55, mod: { source: 'low', amount: 0.2 } },
    { id: 'density', label: 'Density', default: 0.35 },
    { id: 'scan', label: 'Scan', default: 0.5, mod: { source: 'high', amount: 0.3 } },
    { id: 'wire', label: 'Wire', default: 0.4 },
    { id: 'glow', label: 'Glow', default: 0.45 },
    { id: 'trails', label: 'Trails', default: 0.2 },
    { id: 'crowd', label: 'Crowd', default: 1 },
    { id: 'cut', label: 'Cut rate', default: 0.5 },
  ],
  presets: {
    dark: { hits: 0.4, density: 0.2, scan: 0.3, wire: 0.2, glow: 0.35, trails: 0.3, crowd: 0.6, cut: 0.3 },
    rave: { hits: 0.85, density: 0.5, scan: 0.8, wire: 0.5, glow: 0.7, trails: 0.15, crowd: 1, cut: 0.9 },
  },
};

const ACCENT = new Color(0.42, 1.0, 0.24); // acid green, the one accent
const SLOTS: [number, number, number, number][] = [
  // x, z, beat offset, mirror
  [0, 0, 0, 1], [-1.7, -1.3, 0.5, -1], [1.7, -1.3, 1, -1], [-3.3, -2.8, 2, 1], [3.3, -2.8, 3, 1],
];
/** Clip roles by name (Meshy library names); fall back to clip order. */
const ROLE = { groove: /bass|rhythmic|hip ?hop/i, wild: /lightning/i, slow: /genie/i };

const makeHit = (seed: number) => ({ env: uniform(0), seed: uniform(seed), scanY: uniform(-1), scan: uniform(0) });
type Hit = ReturnType<typeof makeHit>;
interface Alien {
  root: Object3D;
  mixer: AnimationMixer;
  actions: Map<string, AnimationAction>;
  current: AnimationAction | null;
  offset: number;
  hit: Hit;
  head: Bone | null;
  hand: Bone | null;
}

export default defineGpuInstrument({
  manifest,
  async create({ renderer, width, height }) {
    const gltf = await new GLTFLoader().loadAsync(alienUrl);
    const clips = gltf.animations as AnimationClip[];
    if (!clips.length) throw new Error('alien.glb has no animation clips');
    const byRole = (re: RegExp, fallback: number) => clips.find((c) => re.test(c.name)) ?? clips[Math.min(fallback, clips.length - 1)];
    const clipFor = { groove: byRole(ROLE.groove, 0), wild: byRole(ROLE.wild, 1), slow: byRole(ROLE.slow, 2) };
    const grooves = clips.filter((c) => c !== clipFor.wild && c !== clipFor.slow);
    if (!grooves.length) grooves.push(clipFor.groove);

    const scene = new Scene();
    scene.background = new Color(0x000000);
    const camera = new PerspectiveCamera(40, width / height, 0.02, 200);

    // ------------------------------------------------------------------ shared uniforms
    const U = { density: uniform(0.35), wire: uniform(0.4), drop: uniform(0), negativeBody: uniform(0) };

    function wireMaterial(hit: Hit) {
      const p = positionGeometry;
      const cell = floor(p.mul(6)).add(50);
      const key = cell.x.add(cell.y.mul(101)).add(cell.z.mul(10201)).add(hit.seed.mul(1030301));
      const lit = step(float(1).sub(U.density), hash(key)).mul(hit.env);
      const scan = smoothstep(0.09, 0.0, abs(p.y.sub(hit.scanY))).mul(hit.scan);
      const drop = U.drop.mul(hash(key.add(7)).mul(0.6).add(0.4));
      const base = vec3(0.55, 0.7, 0.8).mul(U.wire.mul(0.06).add(0.012));
      const accent = vec3(ACCENT.r, ACCENT.g, ACCENT.b);
      const col = base.add(accent.mul(lit.mul(3.2))).add(vec3(1).mul(scan.mul(2.2))).add(mix(accent, vec3(1), 0.6).mul(drop.mul(3.5)));
      const m = new MeshBasicNodeMaterial({ wireframe: true, transparent: true, depthWrite: false, blending: AdditiveBlending });
      m.colorNode = vec4(col, 1);
      return m;
    }
    const bodyMaterial = new MeshBasicNodeMaterial({ polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 });
    bodyMaterial.colorNode = vec4(mix(vec3(0.004, 0.005, 0.006), vec3(0.9), U.negativeBody), 1);

    // ------------------------------------------------------------------ the crowd
    const aliens: Alien[] = SLOTS.map(([x, z, offset, mirror], k) => {
      const root = cloneSkinned(gltf.scene);
      root.position.set(x, 0, z);
      root.scale.x *= mirror;
      const hit = makeHit(k * 3);
      const wire = wireMaterial(hit);
      const skinned: SkinnedMesh[] = [];
      root.traverse((o) => {
        if ((o as SkinnedMesh).isSkinnedMesh) skinned.push(o as SkinnedMesh);
      });
      for (const mesh of skinned) {
        mesh.material = bodyMaterial;
        mesh.frustumCulled = false;
        const overlay = new SkinnedMesh(mesh.geometry, wire);
        overlay.bind(mesh.skeleton, mesh.bindMatrix);
        overlay.frustumCulled = false;
        mesh.parent?.add(overlay);
      }
      let head: Bone | null = null;
      let hand: Bone | null = null;
      root.traverse((o) => {
        const b = o as Bone;
        if (!b.isBone) return;
        if (!head && /head/i.test(b.name) && !/end|top/i.test(b.name)) head = b;
        if (!hand && /right.?hand|hand.?r\b/i.test(b.name)) hand = b;
      });
      scene.add(root);
      const mixer = new AnimationMixer(root);
      const actions = new Map<string, AnimationAction>();
      for (const c of clips) actions.set(c.name, mixer.clipAction(c));
      return { root, mixer, actions, current: null, offset, hit, head, hand };
    });

    // ------------------------------------------------------------------ wire floor with kick ripples
    const grid = new BufferGeometry();
    const lines: number[] = [];
    const span = 40;
    for (let i = -span; i <= span; i += 1) {
      lines.push(i * 0.5, 0, -span * 0.5, i * 0.5, 0, span * 0.5);
      lines.push(-span * 0.5, 0, i * 0.5, span * 0.5, 0, i * 0.5);
    }
    grid.setAttribute('position', new BufferAttribute(new Float32Array(lines), 3));
    const rippleAge = uniform(9);
    const gm = new LineBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending });
    const gd = length(positionGeometry.xz);
    const ring = smoothstep(0.35, 0.0, abs(gd.sub(rippleAge.mul(9)))).mul(exp(rippleAge.mul(-1.8)));
    const gfade = smoothstep(18, 3, gd);
    gm.colorNode = vec4(vec3(0.5, 0.62, 0.72).mul(0.05).add(vec3(ACCENT.r, ACCENT.g, ACCENT.b).mul(ring.mul(0.9))).mul(gfade), 1);
    scene.add(new LineSegments(grid, gm));

    // ------------------------------------------------------------------ editing
    const director = new Director({ shots: 7, styles: 4, impactShot: 5, buildShot: 6, calmShots: [0, 4], impactStyles: [0, 1], seed: 21 });
    const post = makePost(renderer, scene, camera);
    let rs = 99;
    const rnd = () => ((rs = (rs * 1664525 + 1013904223) >>> 0) / 4294967296);
    let lastKickAge = 9;
    let lastOnset = 0;
    let dropAt = -99;
    let lastDrops = 0;
    const tmp = new Vector3();

    function play(a: Alien, clip: AnimationClip) {
      const next = a.actions.get(clip.name)!;
      if (a.current === next) return;
      a.current?.stop();
      next.play();
      a.current = next;
    }

    /** Animation time locked to the beat grid: one loop of the clip = a whole number of bars. */
    function pose(a: Alien, beats: number, bpm: number, speed: number) {
      const act = a.current;
      if (!act) return;
      const dur = act.getClip().duration;
      const loopBeats = Math.max(4, Math.round((dur * bpm) / 60 / speed / 4) * 4);
      act.time = (((beats + a.offset) % loopBeats) / loopBeats) * dur;
      a.mixer.update(0);
    }

    function boneAt(b: Bone | null, fallback: Object3D, out: Vector3) {
      return (b ?? fallback).getWorldPosition(out);
    }

    function frameShot(s: number, l: number, sig: { kick: number; level: number }, cut: number) {
      const lead = aliens[0];
      const p = new Vector3(0, 1.2, 6.5);
      const tgt = new Vector3(0, 1.0, -0.8);
      let fov = 38;
      let roll = 0;
      if (s === 0) { // group, slightly low, slow lateral drift
        p.set(Math.sin(l * 0.15 + cut) * 1.5, 0.9, 7.5);
        tgt.set(0, 1.0, -1.2);
      } else if (s === 1) { // skull close-up
        const a = aliens[cut % aliens.length];
        boneAt(a.head, a.root, tmp);
        tgt.copy(tmp);
        p.copy(tmp).add(new Vector3(Math.sin(l * 0.3) * 0.35, 0.05, 0.75));
        fov = 30;
      } else if (s === 2) { // hands
        const a = aliens[(cut + 1) % aliens.length];
        boneAt(a.hand, a.root, tmp);
        tgt.copy(tmp);
        p.copy(tmp).add(new Vector3(0.45, 0.15, 0.55));
        fov = 34;
        roll = Math.sin(l * 0.6) * 0.12;
      } else if (s === 3) { // low orbit around the lead
        const ang = cut * 1.7 + l * 0.35;
        p.set(Math.sin(ang) * 2.4, 0.25, Math.cos(ang) * 2.4);
        boneAt(lead.head, lead.root, tmp);
        tgt.set(0, tmp.y * 0.75, 0);
        fov = 62;
      } else if (s === 4) { // tracking along the row
        const x = -5 + ((l * 0.9 + cut * 3) % 10);
        p.set(x, 1.25, 2.6);
        tgt.set(x * 0.6, 1.05, -1.4);
        fov = 42;
      } else if (s === 5) { // impact: rip back from the lead's skull
        boneAt(lead.head, lead.root, tmp);
        const d = 0.6 + ease.out(l / 1.0) * 7;
        p.copy(tmp).add(new Vector3(0, 0.1, d));
        tgt.copy(tmp).add(new Vector3(0, -0.6 * ease.out(l / 1.5), 0));
        fov = 48;
        roll = (1 - ease.out(l / 1.2)) * 0.35;
      } else if (s === 6) { // build: dolly zoom on the lead
        const d = 9 - ease.inOut(l / 14) * 7;
        p.set(0, 1.15, d);
        tgt.set(0, 1.0, 0);
        fov = Math.min(100, dollyFov(2.4, d));
      }
      const [sx, sy, sz] = shake(l, 0.006 + 0.045 * sig.kick * sig.level);
      camera.position.set(p.x + sx, p.y + sy, p.z + sz);
      camera.fov = fov;
      camera.updateProjectionMatrix();
      camera.lookAt(tgt);
      if (roll) camera.rotateZ(roll);
    }

    return {
      render(frame, target: RenderTarget) {
        const s = frame.signals;
        const m = frame.macros;
        const d = director.update(s);
        const dt = Math.min(1 / 30, Math.max(1 / 240, s.dt || 1 / 60));

        // Drop: flood, then the whole crowd snaps into the wildest dance together.
        if (d.drops !== lastDrops) dropAt = s.time;
        lastDrops = d.drops;
        const since = s.time - dropAt;
        U.drop.value = since >= 0 ? Math.exp(-since / 0.9) : 0;

        // Dance by phase; crowd size from the macro.
        const visible = 1 + Math.round(m[6] * (aliens.length - 1));
        aliens.forEach((a, k) => {
          a.root.visible = k < visible;
          const clip = d.phase === 'impact' ? clipFor.wild : d.phase === 'build' ? clipFor.slow : grooves[(k + Math.floor(d.cut / 2)) % grooves.length];
          play(a, clip);
          pose(a, s.beats, s.bpm, d.phase === 'build' ? 0.5 : 1);
        });

        // Light events: random patches on kicks (sometimes none), scan sweeps on onsets.
        const kickHit = d.kickAge < lastKickAge && d.kickAge < 0.05;
        lastKickAge = d.kickAge;
        const onsetHit = s.onset > 0.9 && lastOnset <= 0.9 && s.kick < 0.5;
        lastOnset = s.onset;
        aliens.forEach((a, k) => {
          const h = a.hit;
          if (kickHit && (k === 0 ? rnd() < 0.9 : rnd() < 0.35 + m[0] * 0.5)) {
            h.env.value = 0.6 + m[0] * 0.8;
            h.seed.value = (Number(h.seed.value) + 1 + Math.floor(rnd() * 5)) % 13;
          } else h.env.value = Number(h.env.value) * Math.exp(-dt / 0.16);
          if (onsetHit && rnd() < 0.3 + m[2] * 0.6) {
            h.scanY.value = -0.1;
            h.scan.value = 1;
          }
          h.scanY.value = Number(h.scanY.value) + dt * 7;
          h.scan.value = Number(h.scan.value) * Math.exp(-dt / 0.4);
        });
        rippleAge.value = d.kickAge;
        U.density.value = 0.12 + m[1] * 0.5 + s.tension * 0.2;
        U.wire.value = m[3] * (d.phase === 'build' ? 0.5 + s.tension : 1);
        U.negativeBody.value = d.style === 2 ? 1 : 0;

        post.flash.value = d.flash * 0.8;
        post.negative.value = d.style === 3 ? 1 : 0;
        post.bloom.value = 0.12 + m[4] * 0.5 + d.flash * 0.6;
        // No trails while the flash is up, or the white lingers as a grey veil.
        post.trails.value = d.flash > 0.2 ? 0 : Math.min(0.9, m[5] * 0.8 + (d.phase === 'impact' ? 0.3 : 0));

        frameShot(d.shot, (d.local * 60) / Math.max(30, s.bpm), s, d.cut);
        renderer.setRenderTarget(target);
        post.render();
      },
      debug: () => ({ ...director.current, clips: clips.map((c) => c.name) }),
      resize(w, h) {
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      },
      dispose() {
        post.dispose();
        bodyMaterial.dispose();
        gm.dispose();
        grid.dispose();
        aliens.forEach((a) => a.mixer.stopAllAction());
      },
    };
  },
});
