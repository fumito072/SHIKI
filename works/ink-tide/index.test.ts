import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IUniform, WebGLRenderer, WebGLRenderTarget, Texture } from 'three';
import type { Frame } from '../../src/engine/types';
import { SILENT } from '../../src/engine/types';

const gpu = vi.hoisted(() => ({
  targets: [] as WebGLRenderTarget[],
  draws: [] as { kind: string; target: WebGLRenderTarget; uniforms: Record<string, unknown> }[],
  copies: [] as { source: Texture; target: WebGLRenderTarget }[],
  disposers: [] as ReturnType<typeof vi.fn>[],
}));

vi.mock('../../src/engine/passes', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/engine/passes')>();
  const track = (target: WebGLRenderTarget) => {
    vi.spyOn(target, 'dispose');
    vi.spyOn(target, 'setSize');
    gpu.targets.push(target);
    return target;
  };
  return {
    ...actual,
    createTarget: (w: number, h: number) => track(actual.createTarget(w, h)),
    PingPong: class extends actual.PingPong {
      constructor(w: number, h: number) {
        super(w, h);
        track(this.read); track(this.write);
      }
    },
    FullscreenPass: class {
      dispose = vi.fn();
      kind: string;
      uniforms: Record<string, IUniform>;
      constructor(options: { fragmentShader: string; uniforms: Record<string, IUniform> }) {
        this.kind = options.fragmentShader.match(/INK TIDE: (\w+)/)?.[1] ?? 'seed';
        this.uniforms = options.uniforms;
        gpu.disposers.push(this.dispose);
      }
      render(_renderer: WebGLRenderer, target: WebGLRenderTarget) {
        const uniforms = Object.fromEntries(Object.entries(this.uniforms).map(([key, uniform]) => [key, uniform.value]));
        for (const [name, value] of Object.entries(uniforms)) {
          if (value === target.texture) throw new Error(name + ' samples the active framebuffer');
        }
        gpu.draws.push({ kind: this.kind, target, uniforms });
      }
    },
    CopyPass: class {
      dispose = vi.fn();
      constructor() { gpu.disposers.push(this.dispose); }
      render(_renderer: WebGLRenderer, source: Texture, target: WebGLRenderTarget) {
        expect(source).not.toBe(target.texture);
        gpu.copies.push({ source, target });
      }
    },
  };
});

import ink from './index';
import { PRESSURE_ITERATIONS } from './choreography';
import { TIMELINE_DROPS, timelineSignals } from './timeline.fixture';

const fluidKinds = ['advect', 'divergence', 'jacobi', 'project', 'dye'];
const fluidDraws = () => gpu.draws.filter(draw => fluidKinds.includes(draw.kind));

const renderer = {} as WebGLRenderer;
const target = { texture: {} } as WebGLRenderTarget;
const create = () => ink.create({ renderer, manifest: ink.manifest, width: 1920, height: 1080 });
function frame(time = 0, changes: Partial<Frame['signals']> = {}): Frame {
  return {
    signals: { ...SILENT, time, dt: 1 / 60, frame: Math.round(time * 60), beats: time * 2, beat: time * 2 % 1, ...changes },
    macros: new Float32Array(ink.manifest.macros.map(m => m.default)),
    width: 1920, height: 1080,
  };
}

beforeEach(() => {
  gpu.targets.length = 0;
  gpu.draws.length = 0;
  gpu.copies.length = 0;
  gpu.disposers.length = 0;
});

describe('INK TIDE fluid integration', () => {
  it('offers complete bounded presets and eight distinct macros', () => {
    expect(ink.manifest.id).toBe('ink-tide');
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

  it('projects velocity with twelve dedicated Jacobi iterations before advecting dye, without feedback hazards', () => {
    const work = create();
    work.render(frame(), target);
    const draws = fluidDraws();
    expect(draws.map(draw => draw.kind)).toEqual(['advect', 'divergence', ...Array(PRESSURE_ITERATIONS).fill('jacobi'), 'project', 'dye']);
    expect(draws[0].uniforms.uVelocity).toBe(gpu.targets[0].texture);
    expect(draws[0].target).toBe(gpu.targets[1]);
    expect(draws[15].uniforms.uVelocity).toBe(draws[14].target.texture);
    expect(gpu.draws.at(-1)!.kind).toBe('ink');
    expect(gpu.draws.at(-1)!.target).toBe(target);
    expect(gpu.draws.at(-1)!.uniforms.uDye).toBe(draws[15].target.texture);
  });

  it('allocates 27 quarter-resolution targets and resizes all owned resources', () => {
    const work = create();
    expect(gpu.targets).toHaveLength(27);
    for (const t of gpu.targets) expect([t.width, t.height]).toEqual([480, 270]);
    work.resize!(3840, 2160);
    for (const t of gpu.targets) expect([t.width, t.height]).toEqual([480, 270]);
    work.render({ ...frame(), width: 1080, height: 1920 }, target);
    for (const t of gpu.targets) expect([t.width, t.height]).toEqual([152, 270]);
    work.resize!(1, 1);
    for (const t of gpu.targets) expect([t.width, t.height]).toEqual([1, 1]);
  });

  it('preserves GPU state between frames and draws paused frames without advancing the simulation', () => {
    const work = create();
    const f = frame();
    const knobs = Array.from(f.macros);
    work.render(f, target);
    gpu.draws.length = 0;
    work.render(f, target);
    expect(gpu.draws.map(draw => draw.kind)).toEqual(['normal', 'ink']);
    work.render(frame(1 / 60), target);
    expect(gpu.draws.filter(draw => draw.kind === 'seed')).toHaveLength(0);
    expect(fluidDraws()).toHaveLength(16);
    expect(Array.from(f.macros)).toEqual(knobs);
  });

  it('bounds catch-up work and fully reseeds after a backward transport seek', () => {
    const work = create();
    work.render(frame(20), target);
    gpu.draws.length = 0;
    work.render(frame(21, { dt: 4 }), target);
    expect(fluidDraws()).toHaveLength(32);
    for (const draw of fluidDraws().filter(d => ['advect', 'dye'].includes(d.kind))) expect(draw.uniforms.uDt).toBeCloseTo(0.025);
    gpu.draws.length = 0;
    work.render(frame(1), target);
    expect(gpu.draws.filter(draw => draw.kind === 'seed')).toHaveLength(8);
  });

  it('freezes history during reverse playback, seeds one drop once, then exposes the left side', () => {
    const work = create();
    for (let i = 0; i < 150; i++) work.render(frame(i / 60), target);
    work.render(frame(2.5, { drop: 1 }), target);
    const copiesAtDrop = gpu.copies.length;
    gpu.draws.length = 0;
    for (let i = 1; i < 120; i++) work.render(frame(2.5 + i / 60, { drop: Math.exp(-i / 60 / 2.2) }), target);
    expect(gpu.copies).toHaveLength(copiesAtDrop);
    expect(gpu.draws.every(draw => ['replay', 'normal', 'ink'].includes(draw.kind))).toBe(true);
    const before = gpu.draws.filter(draw => draw.kind === 'replay').at(-1)!;
    expect(before.uniforms.uReplay).toBe(1);
    expect(Number(before.uniforms.uCollapse)).toBeGreaterThan(0.96);
    work.render(frame(4.5, { drop: Math.exp(-2 / 2.2) }), target);
    expect(gpu.draws.filter(draw => draw.kind === 'seed' && draw.uniforms.uSeedKind === 2)).toHaveLength(2);
    expect(gpu.draws.at(-1)!.uniforms.uFlood).toBe(1);
    expect(gpu.draws.at(-1)!.uniforms.uDye).not.toBe(gpu.targets[8].texture);
    expect(fluidDraws()).toHaveLength(16);
    work.render(frame(4.5 + 1 / 60, { drop: Math.exp(-(2 + 1 / 60) / 2.2) }), target);
    expect(gpu.draws.filter(draw => draw.kind === 'seed' && draw.uniforms.uSeedKind === 2)).toHaveLength(2);
  });

  it('survives the 64×36 zero-dt load trial and steps the first live frame at the same time', () => {
    const work = create();
    const trial = frame(0, { dt: 0 });
    work.render(trial, { texture: {}, width: 64, height: 36 } as WebGLRenderTarget);
    expect(fluidDraws()).toHaveLength(0);
    for (const t of gpu.targets) expect([t.width, t.height]).toEqual([480, 270]);
    gpu.draws.length = 0;
    work.render(frame(0), target);
    expect(fluidDraws()).toHaveLength(16);
    expect(gpu.draws.filter(d => d.kind === 'seed')).toHaveLength(0);
  });

  it('keeps stepping when the frame or musical clock advances at a repeated timestamp', () => {
    const work = create();
    work.render(frame(0), target);
    for (let i = 1; i <= 120; i++) {
      gpu.draws.length = 0;
      work.render(frame(0, { frame: i, ...timelineSignals(i / 60) }), target);
      expect(fluidDraws()).toHaveLength(16);
    }
  });

  it('draws a living fluid throughout a 60-second timeline and resumes within two seconds of every DROP', () => {
    const work = create();
    const resumes: number[] = [];
    let pendingDrop = -1, dropSeeds = 0;
    const fps = 24;
    for (let i = 0; i < 60 * fps; i++) {
      const time = i / fps;
      if (TIMELINE_DROPS.includes(time)) pendingDrop = time;
      gpu.draws.length = 0;
      work.render(frame(time, { ...timelineSignals(time), dt: 1 / fps, frame: i }), target);
      expect(gpu.draws.at(-1)!.kind).toBe('ink');
      expect(gpu.draws.at(-1)!.target).toBe(target);
      dropSeeds += gpu.draws.filter(d => d.kind === 'seed' && d.uniforms.uSeedKind === 2).length;
      const steps = fluidDraws().length;
      if (steps > 0) {
        expect(steps).toBe(32);
        if (pendingDrop >= 0) {
          expect(time - pendingDrop).toBeLessThan(2);
          resumes.push(time);
          pendingDrop = -1;
        }
        expect(gpu.draws.filter(d => d.kind === 'replay')).toHaveLength(0);
      } else {
        expect(pendingDrop).toBeGreaterThanOrEqual(0);
        expect(time - pendingDrop).toBeLessThan(2);
        expect(gpu.draws.filter(d => d.kind === 'replay')).toHaveLength(1);
      }
    }
    expect(resumes).toHaveLength(3);
    expect(dropSeeds).toBe(6);
    expect(pendingDrop).toBe(-1);
  });

  it('disposes every owned target and material', () => {
    const work = create();
    for (const t of gpu.targets) vi.mocked(t.dispose).mockClear();
    work.dispose();
    for (const t of gpu.targets) expect(t.dispose).toHaveBeenCalledOnce();
    for (const dispose of gpu.disposers) expect(dispose).toHaveBeenCalledOnce();
    expect(gpu.disposers).toHaveLength(10);
  });
});
