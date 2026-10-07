// MIZUKAGAMI（水鏡）— a liquid mirror that is a fractal, and a fractal that will not let you reach the bottom.
// The Mandelbrot set as mercury: flat and dark far away, a meniscus rising at the set's edge, slow waves rolling in.
// Devices for prediction error (docs/philosophy.md):
// · An endless dive. The period-3 mini-brot on the needle is the set again, scaled by 1/K. Zooming at the fixed point
//   of that similarity returns to the same picture every K×, so the bottom never comes (a cross-fade hides the residue).
// · Drops open windows to the other side: where a drop lands at c, its ring shows the Julia set of c (the Mandelbrot set
//   is the map of all Julia sets) — then the ring runs backwards and closes, water that un-splashes.
// · Stillness after motion: the build stops the dive, and the still frame seems to flow backwards (motion aftereffect).
// · The drop turns the world inside out: a Möbius fold pulls infinity onto the screen and figure and ground swap —
//   the black world becomes light, the light becomes void.
// · In calm passages the dive slowly reverses: the world exhales.
import { HalfFloatType, MeshBasicNodeMaterial, QuadMesh, RenderPipeline, RenderTarget } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  Break, Fn, If, Loop, clamp, cos, exp, float, int, length, log, log2, mix, mx_noise_vec3, normalize, pow, screenUV, select,
  sin, smoothstep, texture, uniform, uv, vec2, vec3, vec4,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { defineGpuInstrument } from '../../src/engine/gpu/types';
import type { InstrumentManifest } from '../../src/engine/types';
import { Director } from '../../src/engine/gpu/world/director';
import { ease } from '../../src/engine/gpu/world/kit';

const manifest: InstrumentManifest = {
  id: 'mizukagami',
  name: 'MIZUKAGAMI',
  nameJa: '水鏡',
  mood: ['liquid', 'mirror', 'fractal'],
  energy: [0.15, 1],
  tempo: 'sync',
  macros: [
    { id: 'speed', label: 'Dive', default: 0.4, mod: { source: 'level', amount: 0.2 } },
    { id: 'ripple', label: 'Ripple', default: 0.5, mod: { source: 'low', amount: 0.25 } },
    { id: 'drops', label: 'Drops', default: 0.5 },
    { id: 'relief', label: 'Meniscus', default: 0.5 },
    { id: 'iris', label: 'Iridescence', default: 0.25, mod: { source: 'high', amount: 0.2 } },
    { id: 'light', label: 'Light', default: 0.5 },
    { id: 'blur', label: 'Motion', default: 0.45 },
    { id: 'glow', label: 'Glow', default: 0.4 },
  ],
  presets: {
    still: { speed: 0.12, ripple: 0.3, drops: 0.3, relief: 0.45, iris: 0.15, light: 0.4, blur: 0.2, glow: 0.3 },
    storm: { speed: 0.8, ripple: 0.85, drops: 0.9, relief: 0.6, iris: 0.5, light: 0.7, blur: 0.75, glow: 0.6 },
  },
};

// The similarity that maps the set onto its period-3 mini-brot: cusp 0.25 → −1.75, needle tip −2 → −1.78644…
const K = 61.7449018709541;
const F = -1.7829245737238786; // its fixed point: zooming here is self-similar
const SPAN = 2.6; // complex height of the frame at zoom 1 (the whole set, off to the right: negative space on the left)
const MAXIT = 200;
const JULIA_SCALE = 1.75; // complex units across a drop window's radius
const DROPS = 2;
const RIPPLES = 4;

/** Accent colours per director style (linear): acid green, oil-slick violet, cold blue, white gold. */
const ACCENTS: [number, number, number][] = [
  [0.18, 1.0, 0.12],
  [0.8, 0.25, 1.0],
  [0.15, 0.45, 1.0],
  [1.0, 0.72, 0.32],
];

type Settable = { set(...v: number[]): void };
const put = (u: ReturnType<typeof uniform>, ...v: number[]) => (u.value as unknown as Settable).set(...v);

export default defineGpuInstrument({
  manifest,
  create({ renderer, width, height }) {
    const director = new Director({ shots: 1, styles: ACCENTS.length, impactShot: 0, buildShot: 0, calmShots: [0], seed: 31 });
    const final = new RenderTarget(width, height, { type: HalfFloatType });

    // ------------------------------------------------------------------ uniforms
    const U = {
      time: uniform(0),
      aspect: uniform(width / height),
      px: uniform(1 / height), // one pixel in height-normalised units
      zoom: uniform(1),
      blend: uniform(0), // cross-fade to the self-similar frame near the end of a cycle
      ripple: uniform(0.5),
      relief: uniform(0.5),
      iris: uniform(0.3),
      light: uniform(0.5),
      accent: uniform(vec3(...ACCENTS[0])),
      lightAngle: uniform(0),
      fold: uniform(vec2(0, 0)), // Möbius fold: w → w / (1 − t·w), t complex
      invert: uniform(0), // figure/ground swap
    };
    /** Membrane sources: x, y, wave-front radius, amplitude (CPU drives fronts: outward for kicks, in & out for drops). */
    const waves = Array.from({ length: RIPPLES + DROPS }, () => uniform(vec4(0, 0, 0, 0)));
    /** Drop windows: x, y, radius (0 = closed), and the c whose Julia set they show. */
    const drops = Array.from({ length: DROPS }, () => ({ at: uniform(vec3(0, 0, 0)), c: uniform(vec2(0, 0)) }));

    /** The membrane: wave packets riding each front plus a slow breathing flow. Returns (∂h/∂x, ∂h/∂y). */
    const membrane = (q: Node<'vec2'>) => {
      let g: Node<'vec2'> = vec2(0, 0);
      for (const s of waves) {
        const d = q.sub(s.xy);
        const r = length(d).add(1e-4);
        const x = r.sub(s.z);
        const env = s.w.mul(exp(x.mul(7).pow(2).negate()));
        g = g.add(d.div(r).mul(cos(x.mul(40)).mul(40).mul(env)));
      }
      const flow = mx_noise_vec3(vec3(q.mul(1.3), U.time.mul(0.1))).xy.mul(0.35);
      return g.mul(U.ripple).add(flow.mul(U.ripple.mul(0.6).add(0.2)));
    };

    /** A studio around the mirror: a low key, two strip lights and the accent, all at grazing angles — a flat mirror
     *  stays black; only the meniscus, the waves and the ripples catch light. */
    const studio = (r: Node<'vec3'>) => {
      const a = U.lightAngle;
      // the key stays low (grazing): a flat mirror never catches it, only the meniscus and the waves do
      const key = normalize(vec3(cos(a).mul(0.85), sin(a).mul(0.85), 0.32));
      const keyL = exp(float(1).sub(r.dot(key)).mul(-26)).mul(3.2);
      const strip1 = exp(r.y.sub(sin(a.mul(0.7)).mul(0.25).add(0.35)).div(0.045).pow(2).negate()).mul(smoothstep(0.97, 0.55, r.z)).mul(1.5);
      const strip2 = exp(r.x.sub(cos(a.mul(0.5)).mul(0.4)).div(0.03).pow(2).negate()).mul(smoothstep(0.97, 0.6, r.z)).mul(0.8);
      const base = mix(float(0.003), float(0.035), smoothstep(-0.3, 1, r.y.add(r.z.mul(0.5))));
      const graze = exp(r.z.div(0.16).pow(2).negate());
      const white = keyL.add(strip1).add(strip2).mul(U.light.mul(1.2).add(0.4));
      return vec3(base).add(vec3(white)).add(U.accent.mul(graze).mul(0.5));
    };
    const film = (t: Node<'float'>) =>
      vec3(0.5).add(vec3(cos(t.mul(6.283)), cos(t.add(0.33).mul(6.283)), cos(t.add(0.67).mul(6.283))).mul(0.5));
    const reflectUp = (n: Node<'vec3'>) => vec3(n.x.mul(n.z).mul(2), n.y.mul(n.z).mul(2), n.z.mul(n.z).mul(2).sub(1));

    /**
     * One escape-time sample, Mandelbrot (z₀ = 0, c = p) or Julia (z₀ = p, c = k): returns (normal direction u = z/z′,
     * smooth iteration μ, distance to the set in complex units, or −1 inside).
     */
    const sample = Fn(([p, k, julia]: [Node<'vec2'>, Node<'vec2'>, Node<'float'>]) => {
      const isJ = julia.greaterThan(0.5);
      const c = select(isJ, k, p);
      const zr = select(isJ, p.x, float(0)).toVar();
      const zi = select(isJ, p.y, float(0)).toVar();
      const dr = select(isJ, float(1), float(0)).toVar();
      const di = float(0).toVar();
      const it = float(0).toVar();
      const esc = float(0).toVar();
      const one = select(isJ, float(0), float(1));
      Loop({ start: int(0), end: int(MAXIT), type: 'int', condition: '<' }, () => {
        const ndr = zr.mul(dr).sub(zi.mul(di)).mul(2).add(one).toVar();
        const ndi = zr.mul(di).add(zi.mul(dr)).mul(2).toVar();
        const nzr = zr.mul(zr).sub(zi.mul(zi)).add(c.x).toVar();
        const nzi = zr.mul(zi).mul(2).add(c.y).toVar();
        dr.assign(ndr);
        di.assign(ndi);
        zr.assign(nzr);
        zi.assign(nzi);
        it.addAssign(1);
        If(zr.mul(zr).add(zi.mul(zi)).greaterThan(1e6), () => {
          esc.assign(1);
          Break();
        });
      });
      const m2 = zr.mul(zr).add(zi.mul(zi));
      const den = dr.mul(dr).add(di.mul(di)).add(1e-30);
      const u = normalize(vec2(zr.mul(dr).add(zi.mul(di)), zi.mul(dr).sub(zr.mul(di))).div(den).add(vec2(1e-12, 0)));
      const mu = it.add(1).sub(log2(log(m2).mul(0.5)));
      const dist = select(esc.greaterThan(0.5), m2.sqrt().mul(log(m2).mul(0.5)).div(den.sqrt()), float(-1));
      return vec4(u, mu, dist);
    });

    /** Mercury: a meniscus at the set's edge (sized in screen heights so it keeps its shape while we zoom). */
    const shade = (s: Node<'vec4'>, perHeight: Node<'float'>, mem: Node<'vec2'>, tint: Node<'vec3'>) => {
      const esc = s.w.greaterThan(0);
      const dn = s.w.div(perHeight).div(0.03);
      const rim = exp(dn.negate()).mul(2.4);
      const roll = sin(s.z.mul(0.7).sub(U.time.mul(1.1))).mul(0.2).mul(exp(dn.mul(-0.1)));
      const tilt = rim.add(roll).mul(U.relief.mul(1.2).add(0.2));
      const nOut = normalize(vec3(s.xy.mul(tilt), 1));
      const n = normalize(select(esc, nOut, vec3(0, 0, 1)).add(vec3(mem.mul(0.04), 0)));
      const env = studio(reflectUp(n));
      const fres = float(0.86).add(pow(float(1).sub(n.z), 5).mul(0.14));
      const film1 = mix(vec3(1), film(float(1).sub(n.z).mul(2.2).add(s.z.mul(0.015)).add(U.time.mul(0.03))), U.iris);
      const outside = env.mul(fres).mul(film1).mul(tint);
      const pool = env.mul(0.2);
      // figure/ground swap: the world inside lights up, the outside drains to a black mirror with bright rims
      const swell = mx_noise_vec3(vec3(s.xy.mul(0.0).add(mem.mul(0.6)), U.time.mul(0.35))).xy;
      const flatN = normalize(vec3(mem.mul(0.3).add(swell.mul(0.45)), 1));
      const insideLit = studio(reflectUp(flatN)).mul(1.6).mul(film(flatN.x.add(flatN.y).mul(1.5).add(U.time.mul(0.05))).mul(0.5).add(0.5)).add(U.accent.mul(0.08));
      const outsideDark = env.mul(rim.mul(0.4)).mul(tint);
      return mix(select(esc, outside, pool), select(esc, outsideDark, insideLit), U.invert);
    };

    // ------------------------------------------------------------------ the frame
    const mat = new MeshBasicNodeMaterial();
    mat.colorNode = Fn(() => {
      const q = vec2(uv().x.sub(0.5).mul(U.aspect), float(0.5).sub(uv().y)); // y-up, height-normalised
      const mem = membrane(q);
      // the fold: w / (1 − t·w) — infinity comes onto the screen at 1/t
      const t = U.fold;
      const den = vec2(float(1).sub(t.x.mul(q.x)).add(t.y.mul(q.y)), t.x.mul(q.y).add(t.y.mul(q.x)).negate());
      const dd = den.dot(den).add(1e-6);
      const w = vec2(q.x.mul(den.x).add(q.y.mul(den.y)), q.y.mul(den.x).sub(q.x.mul(den.y))).div(dd);
      const lens = w.add(mem.mul(0.0012));
      const off = U.px.mul(0.25);
      const perA = float(SPAN).div(U.zoom);
      const zero = vec2(0, 0);
      const mand = (per: Node<'float'>) => {
        const a = sample(vec2(F, 0).add(lens.add(vec2(off, off)).mul(per)), zero, float(0));
        const b = sample(vec2(F, 0).add(lens.sub(vec2(off, off)).mul(per)), zero, float(0));
        return shade(a, per, mem, vec3(1)).add(shade(b, per, mem, vec3(1))).mul(0.5);
      };
      const col = mand(perA).toVar();
      // near the end of a cycle, fade to the frame K× back (the same picture, one level up): no seam
      If(U.blend.greaterThan(0.001), () => {
        col.assign(mix(col, mand(perA.mul(K)), U.blend));
      });
      // drop windows: the Julia set of the c where the drop fell, inside a ring that opens and closes again
      for (const d of drops) {
        const dq = q.sub(d.at.xy);
        const r = length(dq);
        If(r.lessThan(d.at.z), () => {
          const per = float(JULIA_SCALE).div(0.3);
          const s = sample(dq.mul(per).add(mem.mul(0.002)), d.c, float(1));
          const otherSide = mix(vec3(1), U.accent.mul(0.6).add(0.55), 0.35);
          col.assign(shade(s, per, mem, otherSide));
        });
        const lip = exp(r.sub(d.at.z).div(U.px.mul(3)).pow(2).negate()).mul(d.at.z.greaterThan(0.001).select(0.9, 0));
        col.addAssign(vec3(lip).mul(U.light.add(0.3)));
      }
      return vec4(col, 1);
    })();
    const quad = new QuadMesh(mat);

    // ------------------------------------------------------------------ the finish: zoom blur, glow
    const P = { speed: uniform(0), blur: uniform(0.5), glow: uniform(0.4), flash: uniform(0) };
    const fin = texture(final.texture);
    const composite = Fn(() => {
      const q = screenUV.sub(0.5).mul(vec2(U.aspect, 1));
      const toCentre = vec2(0.5, 0.5).sub(screenUV);
      const amount = clamp(P.speed.mul(P.blur).mul(0.035), -0.05, 0.08);
      let acc: Node<'vec3'> = vec3(0);
      const N = 8;
      for (let k = 0; k < N; k++) acc = acc.add(fin.sample(screenUV.add(toCentre.mul(amount.mul(k / N)))).rgb);
      const vig = float(1).sub(q.dot(q).mul(0.35));
      return vec4(acc.div(N).mul(vig).add(vec3(P.flash)), 1);
    })();
    const glowNode = bloom(composite, 1, 0.5, 0.7);
    glowNode.strength = P.glow;
    const pipeline = new RenderPipeline(renderer);
    pipeline.outputColorTransform = false;
    pipeline.outputNode = composite.add(glowNode);

    // ------------------------------------------------------------------ the dive
    const LNK = Math.log(K);
    let lnz = 0;
    let rate = 0.1;
    let surge = 0;
    let rush = 0;
    let lastDrops = 0;
    let lastKickAge = 99;
    let lastBar = -1;
    let foldAngle = 0;
    let invertT = 0;
    let dropAt = -99;
    let nextRipple = 0;
    let nextDrop = 0;
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const rip = Array.from({ length: RIPPLES }, () => ({ x: 0, y: 0, t0: -99, amp: 0 }));
    const win = Array.from({ length: DROPS }, () => ({ x: 0, y: 0, t0: -99, size: 0, hold: 1 }));

    /** A drop lands at (x, y): remembers the c under it, whose Julia set its window will show. */
    function drop(x: number, y: number, t: number, size: number, hold: number) {
      const k = nextDrop;
      nextDrop = (nextDrop + 1) % DROPS;
      win[k] = { x, y, t0: t, size, hold };
      const per = SPAN / Math.exp(lnz);
      put(drops[k].c, F + x * per, y * per);
    }

    return {
      render(frame, target) {
        const s = frame.signals;
        const m = frame.macros;
        const d = director.update(s);
        const dt = Math.min(1 / 20, Math.max(1 / 240, s.dt || 1 / 60));
        const beatSec = 60 / Math.max(30, s.bpm);
        const aspect = target.width / target.height;

        const kickHit = d.kickAge < lastKickAge && d.kickAge < 0.05;
        lastKickAge = d.kickAge;
        const dropped = d.drops !== lastDrops;
        lastDrops = d.drops;
        const bar = Math.floor(s.beats / 4);
        const newBar = bar !== lastBar;
        lastBar = bar;

        // ---- the dive: a rate that only eases; a build stops it dead (stillness after motion); calm exhales
        const energy = Math.min(1, s.level * 0.5 + s.low * 0.5);
        const building = d.phase === 'build';
        const goal = building ? 0 : d.phase === 'calm' ? -0.05 - m[0] * 0.05 : 0.05 + m[0] * 0.35 + energy * 0.12;
        rate += (goal - rate) * (1 - Math.exp(-dt / (building ? 0.25 : 0.8)));
        if (kickHit) {
          surge += 0.06 + m[0] * 0.18;
          rip[nextRipple] = { x: (rnd() - 0.5) * aspect * 0.9, y: (rnd() - 0.5) * 0.9, t0: s.time, amp: 0.16 + s.low * 0.26 };
          nextRipple = (nextRipple + 1) % RIPPLES;
        }
        // drops on the downbeat of some bars (more with the knob), near the set's edge
        if (newBar && !building && rnd() < 0.2 + m[2] * 0.6) {
          drop((rnd() - 0.2) * aspect * 0.55, (rnd() - 0.5) * 0.6, s.time, 0.16 + rnd() * 0.14, 1 + Math.floor(rnd() * 3));
        }
        if (dropped) {
          rush += 1.2 + m[0];
          dropAt = s.time;
          foldAngle = rnd() * Math.PI * 2;
          P.flash.value = 0.3;
          put(U.accent, ...ACCENTS[d.style % ACCENTS.length]);
          drop(0, 0, s.time, 0.42, 4);
        }
        surge *= Math.exp(-dt / 0.35);
        rush *= Math.exp(-dt / 0.9);
        const speed = rate + surge + rush;
        lnz += speed * dt;
        while (lnz >= LNK) lnz -= LNK;
        while (lnz < 0) lnz += LNK;

        // ---- the drop: the world folds and turns inside out for two bars, then unfolds
        const since = s.time - dropAt;
        const twoBars = beatSec * 8;
        const env = since >= 0 && since < twoBars ? Math.sin(Math.PI * (since / twoBars)) : 0;
        foldAngle += dt * 0.3;
        invertT += ((since >= 0 && since < twoBars * 0.75 ? 1 : 0) - invertT) * (1 - Math.exp(-dt / 0.18));

        // ---- membrane sources: kick rings travel outward; drop rims open, hold, then run backwards
        rip.forEach((r, k) => {
          const age = s.time - r.t0;
          put(waves[k], r.x, r.y, age * 0.45, age > 0 ? r.amp * Math.exp(-age * 1.3) : 0);
        });
        win.forEach((w, k) => {
          const age = s.time - w.t0;
          const open = beatSec * 1.2;
          const hold = beatSec * w.hold;
          const close = beatSec * 2;
          let radius = 0;
          if (age >= 0 && age < open) radius = w.size * ease.out(age / open);
          else if (age >= open && age < open + hold) radius = w.size;
          else if (age >= open + hold && age < open + hold + close) radius = w.size * (1 - ease.inOut((age - open - hold) / close));
          put(drops[k].at, w.x, w.y, radius);
          put(waves[RIPPLES + k], w.x, w.y, radius, radius > 0 ? 0.35 : 0);
        });

        // ---- uniforms
        U.time.value = s.time;
        U.aspect.value = aspect;
        U.px.value = 1 / target.height;
        U.zoom.value = Math.exp(lnz);
        U.blend.value = rate >= 0 ? ease.inOut((lnz / LNK - 0.82) / 0.18) : 0;
        U.ripple.value = m[1] * (1 + s.tension * 0.5);
        U.relief.value = m[3];
        U.iris.value = m[4];
        U.light.value = m[5];
        U.lightAngle.value = Number(U.lightAngle.value) - dt * (0.06 + s.mid * 0.15); // turns against the waves
        put(U.fold, Math.cos(foldAngle) * env * 0.9, Math.sin(foldAngle) * env * 0.9);
        U.invert.value = invertT;
        P.speed.value = speed;
        P.blur.value = m[6];
        P.glow.value = 0.15 + m[7] * 0.7;
        P.flash.value = Number(P.flash.value) * Math.exp(-dt / 0.12);

        renderer.setRenderTarget(final);
        quad.render(renderer);
        renderer.setRenderTarget(target);
        pipeline.render();
      },
      debug: () => ({ ...director.current, zoom: Math.exp(lnz), speed: rate + surge + rush, invert: invertT }),
      resize(w, h) {
        final.setSize(w, h);
      },
      dispose() {
        pipeline.dispose();
        mat.dispose();
        final.dispose();
      },
    };
  },
});
