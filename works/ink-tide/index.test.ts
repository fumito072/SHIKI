import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Vector2 } from 'three';
import type { WebGLRenderer, WebGLRenderTarget } from 'three';
import type { Frame } from '../../src/engine/types';
import { SILENT } from '../../src/engine/types';

const gpu = vi.hoisted(() => ({
  target: { texture: {}, setSize: vi.fn(), dispose: vi.fn() },
  passes: [] as { uniforms: Record<string, { value: unknown }>; render: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }[],
}));

vi.mock('../../src/engine/passes', () => ({
  createTarget: () => gpu.target,
  FullscreenPass: class {
    constructor(options: { uniforms: Record<string, { value: unknown }> }) {
      const pass = { uniforms: options.uniforms, render: vi.fn(), dispose: vi.fn() };
      gpu.passes.push(pass);
      Object.assign(this, pass);
    }
  },
}));

import ink from './index';

const renderer = {} as WebGLRenderer;
const target = {} as WebGLRenderTarget;

function create(width = 1920, height = 1080) {
  return ink.create({ renderer, manifest: ink.manifest, width, height });
}

function frame(width = 1920, height = 1080): Frame {
  return {
    signals: { ...SILENT, time: 24, dt: 1 / 60, frame: 1440 },
    macros: new Float32Array(ink.manifest.macros.map(m => m.default)),
    width,
    height,
  };
}

beforeEach(() => {
  gpu.passes.length = 0;
  vi.clearAllMocks();
});

describe('INK TIDE', () => {
  it('has complete, bounded performance presets', () => {
    expect(ink.manifest.macros).toHaveLength(8);
    expect(new Set(ink.manifest.macros.map(m => m.id)).size).toBe(8);
    for (const preset of Object.values(ink.manifest.presets!)) {
      expect(Object.keys(preset).sort()).toEqual(ink.manifest.macros.map(m => m.id).sort());
      for (const value of Object.values(preset)) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it('caps the flow field at half resolution and 960 × 540', () => {
    const work = create();
    expect(gpu.target.setSize).toHaveBeenLastCalledWith(960, 540);
    work.resize!(3840, 2160);
    expect(gpu.target.setSize).toHaveBeenLastCalledWith(960, 540);
    work.resize!(1080, 1920);
    expect(gpu.target.setSize).toHaveBeenLastCalledWith(304, 540);
    work.resize!(1, 1);
    expect(gpu.target.setSize).toHaveBeenLastCalledWith(1, 1);
    expect((gpu.passes[1].uniforms.uFieldSize.value as Vector2).toArray()).toEqual([1, 1]);
  });

  it('draws the complete field before the complete output on every call', () => {
    const work = create();
    const f = frame();
    work.render(f, target);
    work.render(f, target);
    expect(gpu.passes[0].render).toHaveBeenCalledTimes(2);
    expect(gpu.passes[1].render).toHaveBeenCalledTimes(2);
    expect(gpu.passes[0].render).toHaveBeenCalledWith(renderer, gpu.target);
    expect(gpu.passes[1].render).toHaveBeenCalledWith(renderer, target);
    expect(gpu.passes[0].render.mock.invocationCallOrder[0]).toBeLessThan(gpu.passes[1].render.mock.invocationCallOrder[0]);
  });

  it('refreshes inputs without retaining an earlier frame or mutating macros', () => {
    const work = create();
    const f = frame();
    work.render(f, target);
    const initial = Array.from(f.macros);
    work.render({ ...f, signals: { ...f.signals, time: 200, low: 1, kick: 1 } }, target);
    work.render(f, target);
    for (const pass of gpu.passes) {
      expect(pass.uniforms.uTime.value).toBe(24);
      expect(pass.uniforms.uKick.value).toBe(0);
      expect(pass.uniforms.uLow.value).toBe(0);
      expect(Array.from(pass.uniforms.uMacro.value as Float32Array)).toEqual(initial);
      expect(pass.uniforms.uMacro.value).not.toBe(f.macros);
    }
    expect(Array.from(f.macros)).toEqual(initial);
  });

  it('resizes from the frame when the host has not sent resize yet', () => {
    const work = create();
    work.render(frame(1280, 720), target);
    expect(gpu.target.setSize).toHaveBeenLastCalledWith(640, 360);
    work.render(frame(1280, 720), target);
    expect(gpu.target.setSize).toHaveBeenCalledTimes(2);
  });

  it('releases both materials and the owned target', () => {
    const work = create();
    work.dispose();
    expect(gpu.target.dispose).toHaveBeenCalledOnce();
    for (const pass of gpu.passes) expect(pass.dispose).toHaveBeenCalledOnce();
  });
});
