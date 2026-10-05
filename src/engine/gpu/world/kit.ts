// Small building blocks for WebGPU worlds: camera helpers for shots and a post chain (bloom, trails, flash, negative)
// that renders into the deck's HDR target. Worlds stay linear; the engine's finishing pass converts for display.
import { RenderPipeline } from 'three/webgpu';
import type { Camera, Scene, WebGPURenderer } from 'three/webgpu';
import { float, mix, pass, uniform, vec3 } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { afterImage } from 'three/addons/tsl/display/AfterImageNode.js';

export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
export const ease = {
  inOut: (x: number) => {
    const t = clamp01(x);
    return t * t * (3 - 2 * t);
  },
  out: (x: number) => 1 - Math.pow(1 - clamp01(x), 3),
  in: (x: number) => Math.pow(clamp01(x), 3),
};

/** Smooth pseudo-random in -1..1 (cheap value noise) for handheld shake. */
export function wobble(t: number, seed: number): number {
  const s = (x: number) => (Math.sin(x * 12.9898 + seed * 78.233) * 43758.5453) % 1;
  const i = Math.floor(t);
  const f = t - i;
  const a = s(i);
  const b = s(i + 1);
  return (a + (b - a) * f * f * (3 - 2 * f)) * 2;
}

/** Handheld offset (world units) for amplitude `amp`. */
export function shake(t: number, amp: number): [number, number, number] {
  return [wobble(t * 3.1, 1) * amp, wobble(t * 2.7, 2) * amp, wobble(t * 2.3, 3) * amp * 0.5];
}

/** Vertical fov (degrees) keeping a subject of height `size` the same size at distance `d` (dolly zoom). */
export function dollyFov(size: number, d: number): number {
  return (2 * Math.atan(size / (2 * Math.max(0.01, d))) * 180) / Math.PI;
}

export interface Post {
  pipeline: RenderPipeline;
  flash: ReturnType<typeof uniform>;
  negative: ReturnType<typeof uniform>;
  bloom: ReturnType<typeof uniform>;
  trails: ReturnType<typeof uniform>;
  render(): void;
  dispose(): void;
}

/** Scene → bloom → trails → flash / negative, into whatever render target is current (linear, no tone mapping). */
export function makePost(renderer: WebGPURenderer, scene: Scene, camera: Camera): Post {
  const flash = uniform(0);
  const negative = uniform(0);
  const strength = uniform(0.9);
  const trails = uniform(0);
  const scenePass = pass(scene, camera);
  const color = scenePass.getTextureNode('output');
  const glow = bloom(color, 1, 0.4, 0.28);
  glow.strength = strength;
  // AfterImageNode's typings do not expose the swizzles it supports at runtime.
  const out = afterImage(color.add(glow), trails) as unknown as typeof color;
  const lit = out.rgb.add(vec3(flash));
  const inverted = vec3(1).sub(lit.clamp(0, 1)).mul(float(0.9));
  const pipeline = new RenderPipeline(renderer);
  pipeline.outputColorTransform = false;
  pipeline.outputNode = mix(lit, inverted, negative);
  return {
    pipeline, flash, negative, bloom: strength, trails,
    render: () => pipeline.render(),
    dispose: () => {
      pipeline.dispose();
      scenePass.dispose();
    },
  };
}
