import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  OrthographicCamera,
  Points,
  Scene,
  ShaderMaterial,
} from 'three';
import type { Texture } from 'three';
import type { InstrumentManifest } from '../../src/engine/types';
import { defineInstrument } from '../../src/engine/types';
import { CopyPass, FullscreenPass, PingPong, createTarget } from '../../src/engine/passes';
import { shaderPrelude, stdUniforms, updateStdUniforms } from '../../src/engine/glsl';
import commonGlsl from './common.glsl?raw';
import backgroundFrag from './background.frag?raw';
import particlesVert from './particles.vert?raw';
import particlesFrag from './particles.frag?raw';
import trailFrag from './trail.frag?raw';

/**
 * MOONSEA — "the moon is a harsh mistress". The sea is under the moon's control:
 * ripples converge before each beat (an omen) and a droplet falls upward on it; the reflection runs one bar late;
 * tension pulls the sea up into a column while the mist stops; on the drop time freezes, the sea floods the sky,
 * and the droplets are flung around the moon.
 */
const manifest: InstrumentManifest = {
  id: 'moonsea',
  name: 'MOONSEA',
  nameJa: '月海',
  mood: ['deep', 'cinematic', 'uncanny'],
  energy: [0.3, 0.9],
  tempo: 'sync',
  macros: [
    { id: 'energy', label: 'Energy', default: 0.5, mod: { source: 'low', amount: 0.2 } },
    { id: 'pull', label: 'Pull', default: 0.45, mod: { source: 'tension', amount: 0.5 } },
    { id: 'drizzle', label: 'Drizzle', default: 0.35 },
    { id: 'omen', label: 'Omen', default: 0.7 },
    { id: 'flood', label: 'Flood', default: 0.75 },
    { id: 'halo', label: 'Halo', default: 0.45, mod: { source: 'low', amount: 0.15 } },
    { id: 'mist', label: 'Mist', default: 0.5 },
    { id: 'trails', label: 'Trails', default: 0.6 },
  ],
  presets: {
    calm: { energy: 0.25, pull: 0.25, drizzle: 0.2, omen: 0.5, flood: 0.5, halo: 0.35, mist: 0.75, trails: 0.75 },
    surge: { energy: 0.85, pull: 0.8, drizzle: 0.65, omen: 0.9, flood: 0.95, halo: 0.7, mist: 0.35, trails: 0.5 },
  },
};

const PARTICLES = 450_000;
const FLOOD = manifest.macros.findIndex((m) => m.id === 'flood');

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function particleGeometry(): BufferGeometry {
  const rand = mulberry32(20261003);
  const pos = new Float32Array(PARTICLES * 3);
  const seed = new Float32Array(PARTICLES);
  for (let i = 0; i < PARTICLES; i++) {
    pos[i * 3] = rand();
    pos[i * 3 + 1] = rand();
    pos[i * 3 + 2] = rand();
    seed[i] = rand();
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('aSeed', new BufferAttribute(seed, 1));
  return g;
}

/** Exponential approach with separate rise/fall time constants (seconds). */
function approach(cur: number, target: number, dt: number, rise: number, fall: number): number {
  const tau = target > cur ? rise : fall;
  return cur + (target - cur) * (1 - Math.exp(-dt / tau));
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export default defineInstrument({
  manifest,
  create({ renderer, width, height }) {
    const header = `${shaderPrelude(manifest)}#include <shiki_noise>\n#include <shiki_color>\n${commonGlsl}\n`;
    const u = {
      ...stdUniforms(),
      uPClock: { value: 0 },
      uMistClock: { value: 0 },
      uWaterClock: { value: 0 },
      uTide: { value: 0 },
      uFlood: { value: 0 },
      uBurst: { value: 0 },
      uVis: { value: 1 },
    };

    const background = new FullscreenPass({ fragmentShader: header + backgroundFrag, uniforms: u });

    const geometry = particleGeometry();
    const material = new ShaderMaterial({
      vertexShader: header + particlesVert,
      fragmentShader: header + particlesFrag,
      uniforms: u,
      blending: AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    const points = new Points(geometry, material);
    points.frustumCulled = false;
    const scene = new Scene();
    scene.add(points);
    const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const layer = createTarget(width, height);
    const history = new PingPong(width, height);
    const trailU = { ...u, uCurrent: { value: null as Texture | null }, uPrev: { value: null as Texture | null } };
    const trail = new FullscreenPass({ fragmentShader: header + trailFrag, uniforms: trailU });
    const copy = new CopyPass();

    // Choreography state (integrated clocks so speed changes never jump).
    const st = { pclock: 0, mist: 0, water: 0, tide: 0, flood: 0, burst: 0, bursting: false, vis: 1 };

    return {
      render(frame, target) {
        const s = frame.signals;
        const dt = s.dt;

        // The tide follows tension; the drop releases it at once.
        st.tide = s.drop > 0.9 ? st.tide * Math.exp(-dt / 0.12) : approach(st.tide, s.tension, dt, 1.2, 2.5);

        // Drop: time stands still for ~1/3 s, then the droplets are flung and the sea floods the sky.
        const frozen = s.drop > 0.86;
        if (frozen) {
          st.bursting = true;
          st.burst = 0;
        } else if (st.bursting) {
          st.burst += dt / 1.6;
          if (st.burst >= 1) {
            st.bursting = false;
            st.burst = 0;
            st.vis = 0;
          }
        }
        if (!st.bursting) st.vis = approach(st.vis, 1, dt, 1.0, 1.0);

        st.pclock += frozen ? 0 : dt;
        st.mist += dt * 0.025 * (1 - 0.95 * st.tide) * (frozen ? 0 : 1);
        st.water += dt * 0.12 * (1 - 0.6 * st.tide) * (frozen ? 0.1 : 1);
        const floodTarget = (frame.macros[FLOOD] ?? 0.75) * 1.15 * smoothstep(0.3, 0.8, s.drop);
        st.flood = approach(st.flood, floodTarget, dt, 0.18, 1.4);

        u.uPClock.value = st.pclock;
        u.uMistClock.value = st.mist;
        u.uWaterClock.value = st.water;
        u.uTide.value = st.tide;
        u.uFlood.value = st.flood;
        u.uBurst.value = st.bursting ? 1 - Math.pow(1 - st.burst, 3) : 0;
        u.uVis.value = st.bursting ? 1 - st.burst : st.vis;
        updateStdUniforms(u, frame);

        background.render(renderer, layer);
        const autoClear = renderer.autoClear;
        renderer.autoClear = false;
        renderer.setRenderTarget(layer);
        renderer.render(scene, camera);
        renderer.autoClear = autoClear;

        trailU.uCurrent.value = layer.texture;
        trailU.uPrev.value = history.read.texture;
        trail.render(renderer, history.write);
        history.swap();
        copy.render(renderer, history.read.texture, target);
      },
      resize(w, h) {
        layer.setSize(w, h);
        history.resize(w, h);
      },
      dispose() {
        background.dispose();
        geometry.dispose();
        material.dispose();
        layer.dispose();
        history.dispose();
        trail.dispose();
        copy.dispose();
      },
    };
  },
});
