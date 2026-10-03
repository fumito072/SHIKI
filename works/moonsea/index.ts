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
import backgroundFrag from './background.frag?raw';
import particlesVert from './particles.vert?raw';
import particlesFrag from './particles.frag?raw';
import trailFrag from './trail.frag?raw';

const manifest: InstrumentManifest = {
  id: 'moonsea',
  name: 'MOONSEA',
  nameJa: '月海',
  mood: ['deep', 'cinematic', 'organic'],
  energy: [0.4, 0.8],
  tempo: 'both',
  macros: [
    { id: 'energy', label: 'Energy', default: 0.5, mod: { source: 'low', amount: 0.25 } },
    { id: 'density', label: 'Density', default: 0.75 },
    { id: 'drift', label: 'Drift', default: 0.35 },
    { id: 'spray', label: 'Spray', default: 0.35, mod: { source: 'kick', amount: 0.45 } },
    { id: 'halo', label: 'Halo', default: 0.45, mod: { source: 'low', amount: 0.2 } },
    { id: 'mist', label: 'Mist', default: 0.5 },
    { id: 'trails', label: 'Trails', default: 0.55 },
    { id: 'tint', label: 'Tint', default: 0.35 },
  ],
  presets: {
    calm: { energy: 0.25, density: 0.55, drift: 0.18, spray: 0.12, halo: 0.35, mist: 0.75, trails: 0.75, tint: 0.3 },
    surge: { energy: 0.85, density: 0.95, drift: 0.6, spray: 0.75, halo: 0.7, mist: 0.35, trails: 0.45, tint: 0.45 },
  },
};

const PARTICLES = 700_000;

/** Deterministic PRNG so every window builds the same particle cloud. */
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
    pos[i * 3] = rand(); // position along the wave
    pos[i * 3 + 1] = rand(); // position across its thickness
    pos[i * 3 + 2] = rand(); // size / spray / depth
    seed[i] = rand(); // density mask and twinkle phase
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('aSeed', new BufferAttribute(seed, 1));
  return g;
}

export default defineInstrument({
  manifest,
  create({ renderer, width, height }) {
    const prelude = shaderPrelude(manifest);
    const u = stdUniforms();

    const background = new FullscreenPass({ fragmentShader: prelude + backgroundFrag, uniforms: u });

    const geometry = particleGeometry();
    const material = new ShaderMaterial({
      vertexShader: prelude + particlesVert,
      fragmentShader: prelude + particlesFrag,
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
    const trail = new FullscreenPass({ fragmentShader: prelude + trailFrag, uniforms: trailU });
    const copy = new CopyPass();

    return {
      render(frame, target) {
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
