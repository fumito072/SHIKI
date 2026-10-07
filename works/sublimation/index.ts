// SUBLIMATION（昇華）— a world made by computation, and what the computation proves is not the world.
// The Mandelbrot set is computed in front of you like an old machine: a raster scan that re-passes the screen with
// finer and finer blocks (16 → 8 → 4 → 2 → 1 px), each kick pushing the iteration further so the boundary grows detail.
// A build stalls the computation. On the drop every pixel the computation proved "escapes to infinity" sublimates:
// it leaves the screen and flies along its own orbit z₁ = c, z₂ = c² + c, … into space (boundary pixels hesitate
// longest — they almost belonged to the world). Their orbits pile up into a ghost nebula (a Buddhabrot) behind the
// only thing left solid: the black world itself, outlined by its edge.
// Source: the user's Fract renderer (~/development/my_work/Fract) — progressive computation, Y2K palettes, CRT finish.
import {
  AdditiveBlending, Mesh, MeshBasicNodeMaterial, PerspectiveCamera, PlaneGeometry, RenderPipeline, Scene, Sprite,
  SpriteNodeMaterial, StorageInstancedBufferAttribute, Vector3,
} from 'three/webgpu';
import type { Node, RenderTarget } from 'three/webgpu';
import {
  Break, Fn, If, Loop, atomicAdd, atomicLoad, atomicMax, atomicStore, clamp, cos, exp, float, floor, fract, hash, instanceIndex,
  instancedArray, int, length, log, log2, max, min, mix, mx_noise_vec3, pass, screenCoordinate, screenUV, select,
  smoothstep, storage, uint, uniform, uv, vec2, vec3, vec4,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { afterImage } from 'three/addons/tsl/display/AfterImageNode.js';
import { defineGpuInstrument } from '../../src/engine/gpu/types';
import type { InstrumentManifest } from '../../src/engine/types';
import { Director } from '../../src/engine/gpu/world/director';
import { dollyFov, ease, shake } from '../../src/engine/gpu/world/kit';
import { PALETTES, PALETTE_SIZE, paletteData } from './palettes';

const manifest: InstrumentManifest = {
  id: 'sublimation',
  name: 'SUBLIMATION',
  nameJa: '昇華',
  mood: ['computation', 'fractal', 'retro'],
  energy: [0.2, 1],
  tempo: 'sync',
  macros: [
    { id: 'calc', label: 'Compute', default: 0.5, mod: { source: 'level', amount: 0.2 } },
    { id: 'pixel', label: 'Pixel', default: 0.15 },
    { id: 'cycle', label: 'Cycle', default: 0.35, mod: { source: 'high', amount: 0.25 } },
    { id: 'relief', label: 'Relief', default: 0.35 },
    { id: 'gas', label: 'Gas', default: 0.5 },
    { id: 'ghost', label: 'Ghost', default: 0.6 },
    { id: 'crt', label: 'CRT', default: 0.55 },
    { id: 'glow', label: 'Glow', default: 0.4 },
  ],
  presets: {
    machine: { calc: 0.3, pixel: 0.55, cycle: 0.2, relief: 0.1, gas: 0.4, ghost: 0.4, crt: 0.9, glow: 0.3 },
    clean: { calc: 0.6, pixel: 0, cycle: 0.3, relief: 0.35, gas: 0.6, ghost: 0.7, crt: 0.15, glow: 0.45 },
    ghost: { calc: 0.5, pixel: 0.1, cycle: 0.5, relief: 0.5, gas: 0.9, ghost: 1, crt: 0.5, glow: 0.6 },
  },
};

// ---- the machine: a 480×270 grid of pixels, each one complex number c
const GW = 480;
const GH = 270;
const N = GW * GH;
const W = 16; // world width of the screen plane
const H = 9;
const CELL = W / GW;
// ---- the ghost: a Buddhabrot histogram, the Buddha upright (real axis vertical)
const HW = 640;
const HH = 360;
const SPAN_V = 2.9;
const SPAN_U = SPAN_V * (16 / 9);
const RE_MID = -0.65;
const BUDDHA_THREADS = 65536;
const BUDDHA_MAX = 200;
const BUDDHA_MIN = 10;
/** Independent random streams: TSL's hash() truncates its seed to an integer, so offsets must be whole and far apart. */
const STREAM = 1_048_573;
const BLOCKS = [16, 8, 4, 2, 1];

/** Places to compute. The first is the whole world; the others dive into its boundary. */
const PLACES = [
  { cx: -0.62, cy: 0.0, span: 3.4, iter: 320, band: 1 / 22 },
  { cx: -0.7453, cy: 0.1127, span: 0.012, iter: 700, band: 1 / 60 },
  { cx: -0.1592, cy: 1.0317, span: 0.06, iter: 600, band: 1 / 45 },
  { cx: 0.2823, cy: 0.0103, span: 0.009, iter: 700, band: 1 / 60 },
  { cx: -1.7686, cy: 0.0018, span: 0.03, iter: 600, band: 1 / 40 },
];

export default defineGpuInstrument({
  manifest,
  create({ renderer, width, height }) {
    const scene = new Scene();
    const camera = new PerspectiveCamera(40, width / height, 0.05, 400);
    const director = new Director({ shots: 6, styles: PALETTES, impactShot: 3, buildShot: 4, calmShots: [0, 2], impactStyles: [0, 1, 2, 3], seed: 13 });

    // ------------------------------------------------------------------ uniforms
    const U = {
      time: uniform(0),
      frame: uniform(0),
      cx: uniform(PLACES[0].cx),
      cy: uniform(PLACES[0].cy),
      span: uniform(PLACES[0].span),
      maxIter: uniform(PLACES[0].iter),
      band: uniform(PLACES[0].band),
      steps: uniform(2), // iterations per frame
      scanRow: uniform(0),
      blockNew: uniform(16),
      blockOld: uniform(0), // 0 = nothing shown yet
      scanGlow: uniform(1),
      cycle: uniform(0),
      palRow: uniform(0),
      relief: uniform(0.35),
      tremble: uniform(0),
      released: uniform(0),
      t0: uniform(0),
      fly: uniform(4), // orbit steps per second
      gas: uniform(0.5),
      edge: uniform(0.15),
      bseed: uniform(0),
      ghost: uniform(0),
    };

    // ------------------------------------------------------------------ buffers
    const calc = instancedArray(N, 'vec4'); // z.re, z.im, iterations, smooth escape (−1 until escaped)
    const pos = instancedArray(N, 'vec3');
    const col = instancedArray(N, 'vec4'); // rgb, size
    const pal = storage(new StorageInstancedBufferAttribute(paletteData(), 4), 'vec4', PALETTES * PALETTE_SIZE);
    const hist = instancedArray(HW * HH, 'uint').toAtomic();
    const peak = instancedArray(1, 'uint').toAtomic();
    const dens = instancedArray(HW * HH + 1, 'float'); // the last entry holds the peak count, for log normalisation

    const gridOf = (fi: Node<'float'>) => ({ gx: fi.mod(GW), gy: floor(fi.div(GW)) });
    const cOf = (gx: Node<'float'>, gy: Node<'float'>) => {
      const k = U.span.div(GW);
      return vec2(U.cx.add(gx.add(0.5).sub(GW / 2).mul(k)), U.cy.add(float(GH / 2).sub(gy.add(0.5)).mul(k)));
    };
    const homeOf = (gx: Node<'float'>, gy: Node<'float'>) =>
      vec3(gx.add(0.5).mul(CELL).sub(W / 2), float(H / 2).sub(gy.add(0.5).mul(CELL)), 0);

    // ------------------------------------------------------------------ kernels
    const reset = Fn(() => {
      const { gx, gy } = gridOf(instanceIndex.toFloat());
      calc.element(instanceIndex).assign(vec4(0, 0, 0, -1));
      pos.element(instanceIndex).assign(homeOf(gx, gy));
      col.element(instanceIndex).assign(vec4(0));
    })().compute(N);

    const clearGhost = Fn(() => {
      atomicStore(hist.element(instanceIndex), uint(0));
      dens.element(instanceIndex).assign(0);
      If(instanceIndex.equal(0), () => {
        atomicStore(peak.element(0), uint(0));
        dens.element(HW * HH).assign(0);
      });
    })().compute(HW * HH);

    // The computation: a few more iterations of z → z² + c for every pixel still undecided.
    const iterate = Fn(() => {
      const cell = calc.element(instanceIndex);
      const st = cell.toVar();
      If(st.w.lessThan(0).and(st.z.lessThan(U.maxIter)), () => {
        const { gx, gy } = gridOf(instanceIndex.toFloat());
        const c = cOf(gx, gy).toVar();
        const zr = st.x.toVar();
        const zi = st.y.toVar();
        const it = st.z.toVar();
        const mu = st.w.toVar();
        Loop({ start: int(0), end: int(U.steps), type: 'int', condition: '<' }, () => {
          const nr = zr.mul(zr).sub(zi.mul(zi)).add(c.x).toVar();
          const ni = zr.mul(zi).mul(2).add(c.y).toVar();
          zr.assign(nr);
          zi.assign(ni);
          it.addAssign(1);
          const m2 = zr.mul(zr).add(zi.mul(zi));
          If(m2.greaterThan(256), () => {
            mu.assign(it.add(1).sub(log2(log(m2).mul(0.5))));
            Break();
          });
          If(it.greaterThanEqual(U.maxIter), () => {
            Break();
          });
        });
        cell.assign(vec4(zr, zi, it, mu));
      });
    })().compute(N);

    // Every pixel: what the screen shows (block-quantized, scan line), and where it is (home, relief, tremble, flight).
    const update = Fn(() => {
      const fi = instanceIndex.toFloat();
      const { gx, gy } = gridOf(fi);
      const scanned = gy.lessThanEqual(U.scanRow);
      const blk = select(scanned, U.blockNew, U.blockOld);
      const shown = blk.greaterThan(0.5);
      const b = max(blk, 1);
      const rx = floor(gx.div(b)).mul(b);
      const ry = floor(gy.div(b)).mul(b);
      const rep = calc.element(ry.mul(GW).add(rx).toUint());
      const right = calc.element(ry.mul(GW).add(min(rx.add(b), GW - 1)).toUint());
      const below = calc.element(min(ry.add(b), GH - 1).mul(GW).add(rx).toUint());
      const self = calc.element(instanceIndex);
      const mu = rep.w;
      const escaped = mu.greaterThanEqual(0);
      const edge = escaped.not().and(right.w.greaterThanEqual(0).or(below.w.greaterThanEqual(0)));
      const t = fract(mu.mul(U.band).add(U.cycle));
      const pc = pal.element(floor(t.mul(PALETTE_SIZE - 0.01)).add(U.palRow.mul(PALETTE_SIZE)).toUint()).xyz;
      const scanLight = smoothstep(2.5, 0, U.scanRow.sub(gy)).mul(scanned.select(1, 0)).mul(U.scanGlow);
      const base = select(escaped, pc.mul(0.55), select(edge, vec3(0.55, 0.62, 0.68).mul(U.edge), vec3(0.0)));
      const lit = base.add(vec3(0.75, 0.85, 0.9).mul(scanLight));

      // relief: the world is a black plateau, the escape-time field a terraced terrain below it
      const depth = clamp(log(mu.add(1)).div(log(U.maxIter)), 0, 1);
      const h = select(escaped, depth.mul(1.1), select(rep.z.greaterThanEqual(U.maxIter), float(1.5), float(0))).mul(U.relief);
      const home = homeOf(gx, gy);
      const r1 = hash(instanceIndex.add(U.frame.mod(997).mul(STREAM).toUint()));
      const r2 = hash(instanceIndex.add(U.frame.mod(997).mul(STREAM).add(STREAM / 2).toUint()));
      const quiver = vec3(r1.sub(0.5), r2.sub(0.5), 0).mul(CELL * 2.5).mul(U.tremble).mul(escaped.select(1, 0));
      const rest = home.add(vec3(0, 0, h)).add(quiver);

      // flight: the pixel's own orbit z₁ = c, z₂ = c² + c, …, compressed into a bounded space, rising as gas
      const ownMu = self.w;
      const flies = U.released.greaterThan(0.5).and(ownMu.greaterThanEqual(0));
      const since = U.time.sub(U.t0);
      const delay = clamp(log(ownMu.add(1)).div(log(U.maxIter)), 0, 1).mul(2.2);
      const s = max(since.sub(delay), 0).mul(U.fly);
      const c = cOf(gx, gy).toVar();
      const zr = c.x.toVar();
      const zi = c.y.toVar();
      const k = min(floor(s), 32);
      Loop({ start: int(0), end: int(k), type: 'int', condition: '<' }, () => {
        If(zr.mul(zr).add(zi.mul(zi)).greaterThan(1e6), () => {
          Break();
        });
        const nr = zr.mul(zr).sub(zi.mul(zi)).add(c.x).toVar();
        const ni = zr.mul(zi).mul(2).add(c.y).toVar();
        zr.assign(nr);
        zi.assign(ni);
      });
      const a = vec2(zr, zi).toVar();
      const big = a.dot(a).greaterThan(1e6);
      const bNext = select(big, a, vec2(a.x.mul(a.x).sub(a.y.mul(a.y)).add(c.x), a.x.mul(a.y).mul(2).add(c.y)));
      const comp = (z: Node<'vec2'>) => z.div(length(z).mul(0.35).add(1));
      const w = mix(comp(a), comp(bNext), fract(s));
      // the shell keeps expanding, and every pixel rises at its own rate: a wall of points becomes a volume of gas
      const off = w.sub(comp(c)).mul(s.mul(0.06).add(1).mul(3.2));
      const drift = mx_noise_vec3(home.mul(0.35).add(vec3(0, 0, U.time.mul(0.12)))).mul(s.mul(0.07).mul(U.gas));
      const rise = s.mul(hash(instanceIndex.add(STREAM * 3)).mul(0.35).add(0.06)).mul(U.gas.add(0.4));
      const flown = home.add(vec3(off, rise)).add(drift);
      const fade = exp(max(s.sub(22), 0).div(-26));
      const burn = float(1).add(exp(s.mul(-0.9)).mul(1.6)).mul(fade);

      pos.element(instanceIndex).assign(select(flies, flown, rest));
      // gapless squares: gaps between pixels alias into moiré once the camera moves away
      const size = float(CELL * 1.02);
      const flyCol = pc.mul(0.6).mul(burn);
      col.element(instanceIndex).assign(
        select(flies, vec4(flyCol, size.mul(fade).mul(0.95)), vec4(lit, select(shown, size, float(0)))),
      );
    })().compute(N);

    // The ghost: random c, those that escape deposit their whole orbit into the histogram.
    const buddha = Fn(() => {
      const i = instanceIndex.add(U.bseed.toUint());
      const cr = mix(-2.1, 0.8, hash(i));
      const ci = mix(-1.25, 1.25, hash(i.add(STREAM)));
      const q = cr.sub(0.25).mul(cr.sub(0.25)).add(ci.mul(ci));
      const inCardioid = q.mul(q.add(cr.sub(0.25))).lessThan(ci.mul(ci).mul(0.25));
      const inBulb = cr.add(1).mul(cr.add(1)).add(ci.mul(ci)).lessThan(1 / 16);
      If(inCardioid.or(inBulb).not(), () => {
        const zr = float(0).toVar();
        const zi = float(0).toVar();
        const n = int(-1).toVar();
        Loop({ start: int(0), end: int(BUDDHA_MAX), type: 'int', condition: '<' }, ({ i: k }) => {
          const nr = zr.mul(zr).sub(zi.mul(zi)).add(cr).toVar();
          const ni = zr.mul(zi).mul(2).add(ci).toVar();
          zr.assign(nr);
          zi.assign(ni);
          If(zr.mul(zr).add(zi.mul(zi)).greaterThan(4), () => {
            n.assign(k);
            Break();
          });
        });
        // orbits that escape within a few steps lay smooth nested shells over everything; keep the slow ones (the wisps)
        If(n.greaterThan(BUDDHA_MIN), () => {
          zr.assign(0);
          zi.assign(0);
          Loop({ start: int(0), end: n, type: 'int', condition: '<' }, () => {
            const nr = zr.mul(zr).sub(zi.mul(zi)).add(cr).toVar();
            const ni = zr.mul(zi).mul(2).add(ci).toVar();
            zr.assign(nr);
            zi.assign(ni);
            const u = zi.div(SPAN_U).add(0.5);
            const v = zr.sub(RE_MID).div(SPAN_V).add(0.5);
            If(u.greaterThanEqual(0).and(u.lessThan(1)).and(v.greaterThanEqual(0)).and(v.lessThan(1)), () => {
              const idx = floor(v.mul(HH)).mul(HW).add(floor(u.mul(HW))).toUint();
              atomicAdd(hist.element(idx), uint(1));
            });
          });
        });
      });
    })().compute(BUDDHA_THREADS);

    const resolve = Fn(() => {
      const n = atomicLoad(hist.element(instanceIndex));
      dens.element(instanceIndex).assign(n.toFloat());
      atomicMax(peak.element(0), n);
      // one frame late, so every thread of the previous dispatch has contributed
      If(instanceIndex.equal(0), () => {
        dens.element(HW * HH).assign(atomicLoad(peak.element(0)).toFloat());
      });
    })().compute(HW * HH);

    // ------------------------------------------------------------------ the scene
    const pixMat = new SpriteNodeMaterial();
    pixMat.positionNode = pos.toAttribute();
    const cv = col.toAttribute();
    pixMat.colorNode = vec4(cv.xyz, 1);
    pixMat.scaleNode = cv.w;
    const pixels = new Sprite(pixMat);
    pixels.count = N;
    pixels.frustumCulled = false;
    scene.add(pixels);

    // the nebula: the histogram drawn as a coarse luminous plane behind the world
    const ghostMat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending });
    const gp = uv();
    const gidx = floor(float(1).sub(gp.y).mul(HH)).min(HH - 1).mul(HW).add(floor(gp.x.mul(HW)).min(HW - 1)).toUint();
    const gd = dens.element(gidx);
    const gpeak = max(dens.element(HW * HH), 1);
    // one hue with a white core (the classic Buddhabrot look); the sparse halo stays near black
    // the faintest counts (1, 2, 3 …) step visibly, so the sparse halo is cut rather than lifted
    const gv = clamp(gd.div(gpeak).pow(0.6).mul(1.9).sub(0.07), 0, 1);
    const tint = pal.element(floor(fract(U.cycle.add(0.15)).mul(PALETTE_SIZE - 0.01)).add(U.palRow.mul(PALETTE_SIZE)).toUint()).xyz;
    ghostMat.colorNode = vec4(mix(tint.mul(0.7), vec3(1), gv.mul(gv)).mul(gv).mul(U.ghost), 1);
    const ghostPlane = new Mesh(new PlaneGeometry(W * 1.3, H * 1.3), ghostMat);
    ghostPlane.position.z = -1.6;
    scene.add(ghostPlane);

    // ------------------------------------------------------------------ the finish: glow, gas trails, CRT glass
    const P = { flash: uniform(0), negative: uniform(0), bloom: uniform(0.5), trails: uniform(0), crt: uniform(0.55), width: uniform(width) };
    const scenePass = pass(scene, camera);
    const tex = scenePass.getTextureNode('output');
    const shift = P.crt.mul(2.6).div(P.width);
    const fringe = vec3(tex.sample(screenUV.add(vec2(shift, 0))).r, tex.g, tex.sample(screenUV.sub(vec2(shift, 0))).b);
    const glow = bloom(vec4(fringe, 1), 1, 0.45, 0.55);
    glow.strength = P.bloom;
    const trail = afterImage(vec4(fringe, 1).add(glow), P.trails) as unknown as typeof tex;
    const lines = float(1).sub(P.crt.mul(0.34).mul(cos(screenUV.y.mul(GH * Math.PI * 2)).mul(0.5).add(0.5)));
    const vig = float(1).sub(screenUV.sub(0.5).dot(screenUV.sub(0.5)).mul(P.crt.mul(1.1).add(0.3)));
    const grain = hash(screenCoordinate.x.add(screenCoordinate.y.mul(8192)).add(U.frame.mod(89).mul(STREAM)).toUint()).sub(0.5).mul(P.crt.mul(0.06));
    const lit = trail.rgb.add(vec3(P.flash)).mul(lines).mul(vig).add(grain);
    const pipeline = new RenderPipeline(renderer);
    pipeline.outputColorTransform = false;
    pipeline.outputNode = mix(lit, vec3(1).sub(lit.clamp(0, 1)).mul(0.9), P.negative);

    // ------------------------------------------------------------------ the machine's state
    let place = 0;
    let mode: 'compute' | 'sublime' = 'compute';
    let passNo = 0;
    let scanRow = 0;
    let done = false;
    let doneBeats = 0;
    let dropBeats = 0;
    let lastDrops = 0;
    let lastCut = 0;
    let cutClear = 0;
    let lastKickAge = 99;
    let burst = 0;
    let cycle = 0;
    let bseed = 0;
    let frameNo = 0;
    let rebootFlash = 0;
    let needReset = true;
    const focus = new Vector3();
    const at = new Vector3();

    function goTo(index: number) {
      place = index % PLACES.length;
      const p = PLACES[place];
      U.cx.value = p.cx;
      U.cy.value = p.cy;
      U.span.value = p.span;
      U.maxIter.value = p.iter;
      U.band.value = p.band;
      mode = 'compute';
      passNo = 0;
      scanRow = 0;
      done = false;
      U.released.value = 0;
      needReset = true;
    }

    /** Shots: 0 the monitor, 1 grazing over the terrain, 2 close drift, 3 impact pull-back, 4 build dolly, 5 orbit. */
    function frameShot(shot: number, l: number, cut: number, kick: number, level: number) {
      let fov = 40;
      at.set(0, 0, 0);
      // the grazing shot looks along the plane, so "up" is the plane's normal there (otherwise lookAt rolls the view)
      camera.up.set(0, shot === 1 ? 0 : 1, shot === 1 ? 1 : 0);
      const scanY = H / 2 - (scanRow + 0.5) * CELL;
      if (shot === 0) camera.position.set(Math.sin(l * 0.03) * 0.35, Math.cos(l * 0.021) * 0.2, 12.4);
      else if (shot === 1) {
        camera.position.set(-5 + l * 0.06, -8.5, 2.6 + U.relief.value * 1.5);
        at.set(0.5, 1.5, 0);
      } else if (shot === 2) {
        const hx = Math.sin(cut * 12.9898) * 43758.5453;
        const hy = Math.sin(cut * 78.233) * 12345.678;
        focus.set((hx - Math.floor(hx) - 0.5) * 10, (hy - Math.floor(hy) - 0.5) * 5, 0);
        camera.position.set(focus.x + l * 0.04, focus.y - 0.6, 3.4);
        at.copy(focus);
      } else if (shot === 3) {
        camera.position.set(0, -1.2, 6 + ease.out(l / 6) * 14);
        at.set(0, 0, 1.2);
        fov = 50;
      } else if (shot === 4) {
        const d = 20 - ease.inOut(l / 16) * 14;
        at.set(0, mode === 'compute' ? scanY : 0, 0);
        camera.position.set(0, at.y, d);
        fov = Math.min(100, dollyFov(H * 0.8, d));
      } else {
        const a = l * 0.06 + cut;
        camera.position.set(Math.sin(a) * 13, -3 + Math.cos(a * 0.7) * 2, Math.cos(a) * 13 + 2);
        at.set(0, 0, 1.2);
      }
      const [sx, sy, sz] = shake(l, 0.006 + 0.05 * kick * level);
      camera.position.x += sx;
      camera.position.y += sy;
      camera.position.z += sz;
      camera.fov = fov;
      camera.updateProjectionMatrix();
      camera.lookAt(at);
    }

    goTo(0);

    return {
      render(frame, target: RenderTarget) {
        const s = frame.signals;
        const m = frame.macros;
        const d = director.update(s);
        const dt = Math.min(1 / 30, Math.max(1 / 240, s.dt || 1 / 60));
        const beatSec = 60 / Math.max(30, s.bpm);
        frameNo++;

        const dropEdge = d.drops !== lastDrops;
        lastDrops = d.drops;
        const kickHit = d.kickAge < lastKickAge && d.kickAge < 0.05;
        lastKickAge = d.kickAge;

        // ---- the machine
        if (dropEdge && mode === 'compute' && passNo > 0) {
          mode = 'sublime';
          U.released.value = 1;
          U.t0.value = s.time;
          dropBeats = s.beats;
          renderer.compute(clearGhost);
        } else if (mode === 'sublime' && s.beats - dropBeats > 40 && d.phase !== 'impact') {
          goTo(place + 1);
          rebootFlash = 1;
        } else if (mode === 'compute' && done && s.beats - doneBeats > 48 && d.phase !== 'build') {
          goTo(place + 1);
          rebootFlash = 1;
        }
        if (needReset) {
          renderer.compute(reset);
          renderer.compute(clearGhost);
          needReset = false;
        }

        const building = d.phase === 'build';
        if (mode === 'compute') {
          // one pass per bar while grooving (two when calm), finer blocks every pass; a build stalls the scan
          const barSec = beatSec * 4 * (d.phase === 'calm' ? 2 : 1);
          let speed = (GH / barSec) * (0.55 + m[0]);
          if (building) speed *= Math.max(0, 1 - s.tension * 1.6);
          if (!done) scanRow += speed * dt;
          const minBlock = 1 + Math.floor(m[1] * 3.99);
          const blocks = BLOCKS.map((b) => Math.max(b, minBlock));
          if (scanRow >= GH + 2 && !done) {
            if (passNo < blocks.length - 1 && blocks[passNo + 1] < blocks[passNo]) {
              passNo++;
              scanRow = 0;
            } else {
              done = true;
              doneBeats = s.beats;
            }
          }
          U.blockNew.value = blocks[passNo];
          U.blockOld.value = passNo > 0 ? blocks[passNo - 1] : 0;
          U.scanRow.value = done ? GH + 10 : scanRow;
          U.scanGlow.value = done ? 0 : building ? 0.4 + 0.6 * Math.random() : 1;
          if (kickHit) burst = 24 + m[0] * 40;
          burst *= Math.exp(-dt / 0.12);
          U.steps.value = building ? 0 : Math.round(1 + m[0] * 5 + burst);
        } else {
          U.steps.value = 0;
          U.scanRow.value = GH + 10;
          U.scanGlow.value = 0;
        }

        // ---- colour, motion, light
        cycle += dt * (0.01 + m[2] * 0.12) + (kickHit ? 0.015 + m[2] * 0.03 : 0);
        U.cycle.value = cycle % 1;
        U.palRow.value = d.style;
        U.relief.value = m[3] * (mode === 'sublime' ? 1.4 : 1);
        U.tremble.value = building ? s.tension : Number(U.tremble.value) * Math.exp(-dt / 0.2);
        U.gas.value = m[4];
        U.fly.value = 2 + m[4] * 2.5;
        U.edge.value = mode === 'sublime' ? 0.9 + d.flash : 0.18;
        U.time.value = s.time;
        U.frame.value = frameNo;

        renderer.compute(iterate);
        renderer.compute(update);

        // the ghost develops while the gas flies
        const since = s.time - Number(U.t0.value);
        if (mode === 'sublime' && m[5] > 0.01) {
          bseed = (bseed + BUDDHA_THREADS) % (30000 * BUDDHA_THREADS);
          U.bseed.value = bseed;
          renderer.compute(buddha);
          renderer.compute(resolve);
          U.ghost.value = m[5] * (1 - Math.exp(-since / 2.5)) * 1.15;
        } else U.ghost.value = 0;

        // ---- the finish
        rebootFlash *= Math.exp(-dt / 0.08);
        P.flash.value = d.flash * 0.45 + rebootFlash * 0.5;
        P.negative.value = rebootFlash > 0.5 ? 1 : 0;
        P.bloom.value = 0.15 + m[7] * 0.6 + d.flash * 0.5;
        // trails start empty after every cut, or the previous shot lingers as a double exposure
        if (d.cut !== lastCut) cutClear = 2;
        lastCut = d.cut;
        const clear = cutClear > 0;
        cutClear = Math.max(0, cutClear - 1);
        P.trails.value = d.flash > 0.2 || clear ? 0 : mode === 'sublime' ? 0.55 + m[4] * 0.35 : 0.08;
        P.crt.value = m[6];
        P.width.value = target.width;

        frameShot(d.shot, (d.local * 60) / Math.max(30, s.bpm), d.cut, s.kick, s.level);
        renderer.setRenderTarget(target);
        pipeline.render();
      },
      debug: () => ({ ...director.current, mode, place, pass: passNo, scan: Math.round(scanRow), done }),
      resize(w, h) {
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      },
      dispose() {
        pipeline.dispose();
        scenePass.dispose();
        pixMat.dispose();
        ghostMat.dispose();
        ghostPlane.geometry.dispose();
        [reset, clearGhost, iterate, update, buddha, resolve].forEach((k) => k.dispose());
      },
    };
  },
});
