// MIZUKAGAMI（水鏡）— a descent through fractals. One continuous dive: inside the Mandelbrot set is a Julia set, inside
// that a Burning Ship, then a Lyapunov field, Cantor dust, a Sierpinski gasket, a Koch snowflake, the Takagi curve, the
// Peano and Hilbert curves, a Menger sponge, a Barnsley fern, a Romanesco — and inside the Romanesco the Mandelbrot set
// again. Each world dives toward a point of its own (self-similar where the mathematics allows), and in the last third of
// its stretch the next world opens from the centre outward and takes over; the colours change with the worlds.
// Music: the dive rate follows energy, kicks surge it and flash the lines; a build stops it dead (the still frame then
// seems to flow backwards); the drop rushes through a world or two, folds infinity onto the screen and swaps figure and
// ground for two bars; calm passages let it drift back out.
import { HalfFloatType, QuadMesh, RenderPipeline, RenderTarget } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { Fn, atan, clamp, float, length, sin, smoothstep, screenUV, texture, uniform, vec2, vec3, vec4, mix } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { defineGpuInstrument } from '../../src/engine/gpu/types';
import type { InstrumentManifest } from '../../src/engine/types';
import { Director } from '../../src/engine/gpu/world/director';
import { buildWorlds, sharedUniforms } from './fractals';
import type { Shared } from './fractals';

const manifest: InstrumentManifest = {
  id: 'mizukagami',
  name: 'MIZUKAGAMI',
  nameJa: '水鏡',
  mood: ['fractal', 'descent', 'light'],
  energy: [0.15, 1],
  tempo: 'sync',
  macros: [
    { id: 'speed', label: 'Dive', default: 0.45, mod: { source: 'level', amount: 0.2 } },
    { id: 'pulse', label: 'Pulse', default: 0.5, mod: { source: 'low', amount: 0.2 } },
    { id: 'line', label: 'Line', default: 0.5 },
    { id: 'halo', label: 'Halo', default: 0.4, mod: { source: 'high', amount: 0.2 } },
    { id: 'blur', label: 'Motion', default: 0.4 },
    { id: 'glow', label: 'Glow', default: 0.4 },
  ],
  presets: {
    still: { speed: 0.15, pulse: 0.2, line: 0.45, halo: 0.3, blur: 0.15, glow: 0.3 },
    storm: { speed: 0.85, pulse: 0.9, line: 0.65, halo: 0.6, blur: 0.7, glow: 0.6 },
  },
};

/** Where in its stretch a world starts to hand over to the next. */
const HANDOVER = 0.65;
const NAMES_JA: Record<string, string> = {
  mandelbrot: 'マンデルブロ', julia: 'ジュリア', ship: 'バーニングシップ', lyapunov: 'リアプノフ', cantor: 'カントール',
  sierpinski: 'シェルピンスキー', koch: 'コッホ', takagi: '高木曲線', peano: 'ペアノ曲線', hilbert: 'ヒルベルト曲線',
  menger: 'メンガーのスポンジ', fern: 'バーンズリーのシダ', romanesco: 'ロマネスコ',
};

export default defineGpuInstrument({
  manifest,
  create({ renderer, width, height }) {
    const director = new Director({ shots: 1, styles: 4, impactShot: 0, buildShot: 0, calmShots: [0], seed: 31 });
    const rt = () => new RenderTarget(width, height, { type: HalfFloatType });
    const rtA = rt();
    const rtB = rt();

    const S: Shared = sharedUniforms(width, height);
    const worlds = buildWorlds(S);
    const quads = worlds.map((w) => new QuadMesh(w.material));

    // ------------------------------------------------------------------ the finish: the next world opens from the centre, zoom blur, glow
    const P = { take: uniform(0), speed: uniform(0), blur: uniform(0.4), glow: uniform(0.4), flash: uniform(0) };
    const texA = texture(rtA.texture);
    const texB = texture(rtB.texture);
    const composite = Fn(() => {
      const q = screenUV.sub(0.5).mul(vec2(S.aspect, 1));
      const toCentre = vec2(0.5, 0.5).sub(screenUV);
      const amount = clamp(P.speed.mul(P.blur).mul(0.035), -0.05, 0.08);
      let a: Node<'vec3'> = vec3(0);
      let b: Node<'vec3'> = vec3(0);
      const N = 8;
      for (let k = 0; k < N; k++) {
        const at = screenUV.add(toCentre.mul(amount.mul(k / N)));
        a = a.add(texA.sample(at).rgb);
        b = b.add(texB.sample(at).rgb);
      }
      // an organic opening: the next world spreads from the centre with a slowly turning, uneven rim
      const ragged = sin(atan(q.y, q.x).mul(5).add(S.time.mul(0.6))).mul(0.05);
      const open = smoothstep(0, 1, P.take.mul(2.2).sub(length(q).mul(1.1)).add(ragged));
      const col = mix(a.div(N), b.div(N), open);
      const vig = float(1).sub(q.dot(q).mul(0.3));
      return vec4(col.mul(vig).add(vec3(P.flash)), 1);
    })();
    const glowNode = bloom(composite, 1, 0.5, 0.7);
    glowNode.strength = P.glow;
    const pipeline = new RenderPipeline(renderer);
    pipeline.outputColorTransform = false;
    pipeline.outputNode = composite.add(glowNode);

    // ------------------------------------------------------------------ the descent
    let cur = 0;
    let lnz = 0; // log zoom within the current world
    let rate = 0.1;
    let surge = 0;
    let rush = 0;
    let pulse = 0;
    let lastDrops = 0;
    let lastKickAge = 99;
    let foldAngle = 0;
    let invertT = 0;
    let dropAt = -99;
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const lnZ = (i: number) => Math.log(worlds[i].Z);
    const next = (i: number) => (i + 1) % worlds.length;
    const prev = (i: number) => (i + worlds.length - 1) % worlds.length;
    // the journey as one line: world i starts at offsets[i] (in units of log zoom)
    const offsets: number[] = [];
    let total = 0;
    worlds.forEach((_, i) => {
      offsets.push(total);
      total += lnZ(i);
    });
    let steered = false;
    const locate = (pos: number) => {
      const p = ((pos % total) + total) % total;
      let i = worlds.length - 1;
      while (i > 0 && offsets[i] > p) i--;
      return { i, lnz: p - offsets[i] };
    };
    if (import.meta.env.DEV) {
      Object.assign(window, {
        __mizu: {
          worlds: worlds.map((w) => w.id),
          jump(i: number, at = 0) {
            cur = ((i % worlds.length) + worlds.length) % worlds.length;
            lnz = at * lnZ(cur);
          },
        },
      });
    }

    return {
      render(frame, target) {
        const s = frame.signals;
        const m = frame.macros;
        const d = director.update(s);
        const dt = Math.min(1 / 20, Math.max(1 / 240, s.dt || 1 / 60));
        const beatSec = 60 / Math.max(30, s.bpm);

        const kickHit = d.kickAge < lastKickAge && d.kickAge < 0.05;
        lastKickAge = d.kickAge;
        const dropped = d.drops !== lastDrops;
        lastDrops = d.drops;

        // ---- the dive: a rate that only eases; a build stops it dead; calm drifts back out
        const energy = Math.min(1, s.level * 0.5 + s.low * 0.5);
        const building = d.phase === 'build';
        const goal = building ? 0 : d.phase === 'calm' ? -0.04 - m[0] * 0.04 : 0.06 + m[0] * 0.38 + energy * 0.12;
        rate += (goal - rate) * (1 - Math.exp(-dt / (building ? 0.25 : 0.8)));
        if (kickHit) {
          surge += 0.06 + m[0] * 0.16;
          pulse = Math.max(pulse, m[1] * (0.6 + s.low * 0.6));
        }
        if (dropped) {
          rush += 1.6 + m[0] * 1.2; // through a world or two
          dropAt = s.time;
          foldAngle = rnd() * Math.PI * 2;
          P.flash.value = 0.06; // a breath of light, not a grey veil
        }
        surge *= Math.exp(-dt / 0.35);
        rush *= Math.exp(-dt / 0.9);
        pulse *= Math.exp(-dt / 0.16);
        const speed = steered ? 0 : rate + surge + rush;
        lnz += speed * dt;
        while (lnz >= lnZ(cur)) {
          lnz -= lnZ(cur);
          cur = next(cur);
        }
        while (lnz < 0) {
          cur = prev(cur);
          lnz += lnZ(cur);
        }

        // ---- the drop: the world folds and turns inside out for two bars, then unfolds
        const since = s.time - dropAt;
        const twoBars = beatSec * 8;
        const env = since >= 0 && since < twoBars ? Math.sin(Math.PI * (since / twoBars)) : 0;
        foldAngle += dt * 0.3;
        invertT += ((since >= 0 && since < twoBars * 0.75 ? 1 : 0) - invertT) * (1 - Math.exp(-dt / 0.25));

        // ---- shared uniforms
        S.time.value = s.time;
        S.aspect.value = target.width / target.height;
        S.height.value = target.height;
        S.fold.value.set(Math.cos(foldAngle) * env * 0.9, Math.sin(foldAngle) * env * 0.9);
        S.pulse.value = pulse;
        S.invert.value = invertT;
        S.line.value = m[2];
        S.halo.value = m[3];
        P.speed.value = speed;
        P.blur.value = m[4];
        P.glow.value = 0.15 + m[5] * 0.7;
        P.flash.value = Number(P.flash.value) * Math.exp(-dt / 0.12);

        // ---- draw this world, and the next one opening inside it
        const lz = lnz / lnZ(cur);
        const zoom = Math.exp(lnz);
        const take = Math.max(0, (lz - HANDOVER) / (1 - HANDOVER));
        P.take.value = take;
        const here = worlds[cur];
        here.z.value = zoom;
        here.prepare?.(renderer, target.width, target.height);
        renderer.setRenderTarget(rtA);
        quads[cur].render(renderer);
        if (take > 0) {
          const n = next(cur);
          worlds[n].z.value = zoom / here.Z;
          worlds[n].prepare?.(renderer, target.width, target.height);
          renderer.setRenderTarget(rtB);
          quads[n].render(renderer);
        }

        renderer.setRenderTarget(target);
        pipeline.render();
      },
      debug: () => ({ ...director.current, world: worlds[cur].id, zoom: Math.exp(lnz), speed: rate + surge + rush }),
      timeline: {
        length: total,
        rate: 0.35,
        position: () => offsets[cur] + lnz,
        seek(pos: number) {
          const at = locate(pos);
          cur = at.i;
          lnz = at.lnz;
        },
        steer(on: boolean) {
          steered = on;
        },
        label(pos: number) {
          const at = locate(pos);
          return `${NAMES_JA[worlds[at.i].id] ?? worlds[at.i].label} ${Math.round((at.lnz / lnZ(at.i)) * 100)}%`;
        },
      },
      resize(w, h) {
        rtA.setSize(w, h);
        rtB.setSize(w, h);
      },
      dispose() {
        pipeline.dispose();
        worlds.forEach((w) => w.dispose());
        rtA.dispose();
        rtB.dispose();
      },
    };
  },
});
