import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IUniform, Texture, WebGLRenderer, WebGLRenderTarget } from 'three';
import type { Frame, InstrumentModule, LiveSignals } from './types';
import { SILENT } from './types';

const gpu = vi.hoisted(() => ({
  targets: [] as WebGLRenderTarget[],
  passes: [] as { kind: string; dispose: ReturnType<typeof vi.fn> }[],
  draws: [] as { kind: string; target: WebGLRenderTarget | null; uniforms: Record<string, unknown> }[],
  copies: [] as { source: Texture; target: WebGLRenderTarget }[],
  clears: [] as { target: WebGLRenderTarget | null; color: number }[],
  observers: [] as { callback: () => void; disconnect: ReturnType<typeof vi.fn> }[],
}));

vi.mock('three', async importOriginal => {
  const actual = await importOriginal<typeof import('three')>();
  return { ...actual, WebGLRenderer: class {
    debug = { checkShaderErrors: false, onShaderError: null };
    autoClear = false;
    current: WebGLRenderTarget | null = null;
    color = new actual.Color(0);
    alpha = 1;
    dispose = vi.fn();
    setSize = vi.fn();
    getRenderTarget() { return this.current; }
    setRenderTarget(target: WebGLRenderTarget | null) { this.current = target; }
    getClearColor(color: InstanceType<typeof actual.Color>) { return color.copy(this.color); }
    getClearAlpha() { return this.alpha; }
    setClearColor(color: number | InstanceType<typeof actual.Color>, alpha: number) { this.color.set(color); this.alpha = alpha; }
    clear() { gpu.clears.push({ target: this.current, color: this.color.getHex() }); }
  } };
});

vi.mock('./passes', async importOriginal => {
  const actual = await importOriginal<typeof import('./passes')>();
  const track = (target: WebGLRenderTarget) => {
    vi.spyOn(target, 'dispose');
    gpu.targets.push(target);
    return target;
  };
  return { ...actual,
    createTarget: (w: number, h: number) => track(actual.createTarget(w, h)),
    PingPong: class extends actual.PingPong {
      constructor(w: number, h: number) { super(w, h); track(this.read); track(this.write); }
    },
    FullscreenPass: class {
      dispose = vi.fn();
      kind: string;
      constructor(private readonly opts: { fragmentShader: string; uniforms: Record<string, IUniform> }) {
        this.kind = opts.fragmentShader.match(/SHIKI (?:transition|FX): ([\w-]+)/)?.[1] ?? 'finish';
        gpu.passes.push(this);
      }
      render(_renderer: WebGLRenderer, target: WebGLRenderTarget | null) {
        const uniforms = Object.fromEntries(Object.entries(this.opts.uniforms).map(([k, u]) => [k, u.value]));
        if (target) for (const value of Object.values(uniforms)) expect(value).not.toBe(target.texture);
        gpu.draws.push({ kind: this.kind, target, uniforms });
      }
    },
    CopyPass: class {
      kind = 'copy';
      dispose = vi.fn();
      constructor() { gpu.passes.push(this); }
      render(_renderer: WebGLRenderer, source: Texture, target: WebGLRenderTarget) {
        expect(source).not.toBe(target.texture);
        gpu.copies.push({ source, target });
      }
    },
  };
});

import { DeckEngine } from './DeckEngine';
import type { Transition } from './DeckEngine';

const canvas = { clientWidth: 1920, clientHeight: 1080 } as HTMLCanvasElement;
function work(id: string) {
  const render = vi.fn((_frame: Frame, _target: WebGLRenderTarget) => {});
  const dispose = vi.fn();
  const resize = vi.fn();
  const module: InstrumentModule = {
    manifest: { id, name: id, mood: [], energy: [0, 1], tempo: 'both',
      macros: [{ id: 'energy', label: 'Energy', default: 0.2, mod: { source: 'low', amount: 0.5 } }],
      presets: { loud: { energy: 0.8 } } },
    create: vi.fn(() => ({ render, dispose, resize })),
  };
  return { module, render, dispose, resize };
}
const lastDraw = () => gpu.draws.at(-1)!;
const kinds = () => gpu.draws.map(draw => draw.kind);
function shaderFailure(renderer: WebGLRenderer) {
  const args = [{ getProgramInfoLog: () => 'bad shader', getShaderInfoLog: () => '' }, {}, {}, {}];
  renderer.debug.onShaderError!(...args as Parameters<NonNullable<typeof renderer.debug.onShaderError>>);
}
function setup() {
  let live: LiveSignals = { ...SILENT };
  const onError = vi.fn();
  const onLoad = vi.fn();
  const engine = new DeckEngine({ canvas, onError, onLoad });
  const signals = vi.fn(() => live);
  engine.signals = signals;
  const a = work('a'), b = work('b');
  engine.load('A', a.module);
  engine.load('B', b.module);
  a.render.mockClear(); b.render.mockClear(); signals.mockClear();
  gpu.draws.length = gpu.copies.length = 0;
  return { engine, a, b, onError, onLoad, signals,
    beat: (beats: number, now = beats * 500) => {
      live = { ...live, beats, beat: beats % 1, bar: beats / 4 % 1 };
      engine.renderAt(now);
    },
    live: (changes: Partial<LiveSignals>) => { live = { ...live, ...changes }; },
  };
}

beforeEach(() => {
  gpu.targets.length = gpu.passes.length = gpu.draws.length = gpu.copies.length = gpu.clears.length = gpu.observers.length = 0;
  vi.stubGlobal('window', { devicePixelRatio: 1 });
  vi.stubGlobal('ResizeObserver', class {
    disconnect = vi.fn();
    constructor(readonly callback: () => void) { gpu.observers.push(this); }
    observe() {}
  });
  let raf = 0;
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => ++raf));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

describe('DeckEngine fail-safe loading', () => {
  it.each(['create', 'trial', 'shader'] as const)('rejects %s failure without altering either deck or knobs', failure => {
    const { engine, a, b, onError } = setup();
    engine.knobs.A[0] = 0.7;
    const old = engine.previewTexture('A');
    const bad = work('bad');
    if (failure === 'create') vi.mocked(bad.module.create).mockImplementation(() => { throw new Error('create failed'); });
    if (failure === 'trial') bad.render.mockImplementation(() => { throw new Error('trial failed'); });
    if (failure === 'shader') bad.render.mockImplementation(() => shaderFailure(engine.renderer));
    expect(engine.load('A', bad.module)).toBe(false);
    expect(engine.workId('A')).toBe('a');
    expect(engine.workId('B')).toBe('b');
    expect(engine.knobs.A[0]).toBeCloseTo(0.7);
    expect(engine.previewTexture('A')).toBe(old);
    expect(a.dispose).not.toHaveBeenCalled();
    expect(b.dispose).not.toHaveBeenCalled();
    expect(bad.dispose).toHaveBeenCalledTimes(failure === 'create' ? 0 : 1);
    expect(onError).toHaveBeenCalledWith(expect.any(String), 'bad', 'A');
    engine.renderAt(0);
    expect(a.render).toHaveBeenCalledOnce();
    engine.dispose();
  });

  it('trials zero-dt frames at scratch size, keeps knobs for reloads, and resets on different work', () => {
    const { engine, a, b } = setup();
    engine.knobs.A[0] = 0.6;
    const reload = work('a');
    expect(engine.load('A', reload.module)).toBe(true);
    const [frame, target] = reload.render.mock.calls[0];
    expect([target.width, target.height, frame.width, frame.height, frame.signals.dt]).toEqual([64, 36, 1920, 1080, 0]);
    expect(frame.macros[0]).toBeCloseTo(0.6);
    expect(a.dispose).toHaveBeenCalledOnce();
    const other = work('other');
    engine.load('A', other.module, { keepKnobs: true });
    expect(engine.knobs.A[0]).toBeCloseTo(0.6);
    engine.load('A', work('reset').module);
    expect(engine.knobs.A[0]).toBeCloseTo(0.2);
    expect(b.dispose).not.toHaveBeenCalled();
    engine.dispose();
  });

  it('commits only successful live frames and reports once per failing burst', () => {
    const { engine, a, onError } = setup();
    engine.renderAt(0);
    const goodTexture = engine.previewTexture('A');
    a.render.mockImplementation(() => { throw new Error('partial render'); });
    engine.renderAt(16); engine.renderAt(32);
    expect(engine.previewTexture('A')).toBe(goodTexture);
    expect(lastDraw().uniforms.uTex).toBe(goodTexture);
    expect(onError).toHaveBeenCalledOnce();
    a.render.mockImplementation(() => {});
    engine.renderAt(48);
    expect(engine.previewTexture('A')).not.toBe(goodTexture);
    a.render.mockImplementation(() => shaderFailure(engine.renderer));
    engine.renderAt(64); engine.renderAt(80);
    expect(onError).toHaveBeenCalledTimes(2);
    engine.dispose();
  });
});

describe('DeckEngine rendering and takes', () => {
  it('renders one deck without mix/FX passes; previews are opt-in and manual mix is clamped', () => {
    const { engine, a, b } = setup();
    engine.renderAt(0);
    expect(a.render).toHaveBeenCalledOnce();
    expect(b.render).not.toHaveBeenCalled();
    expect(kinds()).toEqual(['finish']);
    engine.setPreview('B', true);
    engine.renderAt(16);
    expect(b.render).toHaveBeenCalledOnce();
    engine.setPreview('B', false);
    engine.mix = 0.25;
    engine.renderAt(32);
    expect(lastDraw().kind).toBe('finish');
    expect(kinds().slice(-2)).toEqual(['dissolve', 'finish']);
    expect(engine.onAir).toBe('A');
    engine.mix = 10;
    expect([engine.mix, engine.onAir]).toEqual([1, 'B']);
    engine.renderAt(48);
    expect(a.render).toHaveBeenCalledTimes(3);
    engine.mix = -2;
    expect([engine.mix, engine.onAir]).toEqual([0, 'A']);
    engine.dispose();
  });

  it('samples one shared signal snapshot with independent macro arrays and repeatable capture time', () => {
    const { engine, a, b, signals, live } = setup();
    engine.mix = 0.5;
    engine.knobs.A[0] = 0.3;
    engine.knobs.B[0] = 0.9;
    live({ low: 0.5 });
    engine.renderAt(1000);
    expect(signals).toHaveBeenCalledOnce();
    const fa = a.render.mock.calls[0][0], fb = b.render.mock.calls[0][0];
    expect(fa.signals).toBe(fb.signals);
    expect(fa.macros).not.toBe(fb.macros);
    expect(engine.macros.A[0]).toBeCloseTo(0.55);
    expect(engine.macros.B[0]).toBe(1);
    expect(fa.signals).toMatchObject({ time: 0, dt: 0, frame: 0 });
    engine.renderAt(1016);
    expect(a.render.mock.calls[1][0].signals).toMatchObject({ time: 0.016, dt: 0.016, frame: 1 });
    expect(lastDraw().uniforms.uTime).toBe(0.016);
    expect(engine.fps).toBeGreaterThan(0);
    engine.applyPreset('A', 'loud');
    expect(engine.knobs.A[0]).toBeCloseTo(0.8);
    engine.resetKnobs('B');
    expect(engine.knobs.B[0]).toBeCloseTo(0.2);
    engine.dispose();
  });

  it.each<Transition>(['cut', 'dissolve', 'luma-wipe', 'displace', 'feedback-melt'])('takes A→B→A with %s and exact endpoints', transition => {
    const { engine, beat, a, b } = setup();
    beat(0.5);
    expect(engine.take({ transition, beats: 2, quantize: 'beat' })).toBe(true);
    expect(engine.pending).toMatchObject({ startBeat: 1, transition });
    beat(0.9);
    expect(b.render).not.toHaveBeenCalled();
    beat(1);
    if (transition !== 'cut') {
      expect([engine.mix, engine.progress, engine.onAir]).toEqual([0, 0, 'A']);
      beat(2);
      const draw = gpu.draws.filter(d => d.kind === transition).at(-1)!;
      expect(draw.uniforms.uFrom).toBe(engine.previewTexture('A'));
      expect(draw.uniforms.uTo).toBe(engine.previewTexture('B'));
      expect(draw.uniforms.uProgress).toBe(0.5);
    }
    beat(3);
    expect([engine.onAir, engine.mix, engine.progress, engine.active]).toEqual(['B', 1, 1, null]);
    const aCalls = a.render.mock.calls.length;
    beat(4);
    expect(a.render).toHaveBeenCalledTimes(aCalls);
    engine.take({ transition, beats: 2, quantize: 'now' });
    beat(5);
    if (transition !== 'cut') expect(engine.mix).toBe(0.5);
    beat(6);
    expect([engine.onAir, engine.mix]).toEqual(['A', 0]);
    engine.dispose();
  });

  it('preserves the active transition for queued TAKE, and manual assignments cancel both', () => {
    const { engine, beat } = setup();
    beat(0);
    engine.take({ transition: 'dissolve', beats: 4, quantize: 'now' });
    beat(1);
    engine.take({ transition: 'luma-wipe', beats: 2, quantize: 'bar' });
    expect(engine.active?.transition).toBe('dissolve');
    expect(engine.pending).toMatchObject({ startBeat: 4, from: 'B', to: 'A' });
    const snapshot = engine.pending as { startBeat: number };
    snapshot.startBeat = 100;
    expect(engine.pending?.startBeat).toBe(4);
    engine.mix = 0.3;
    expect([engine.active, engine.pending, engine.mix]).toEqual([null, null, 0.3]);
    engine.take({ transition: 'dissolve', beats: 4, quantize: 'bar' });
    engine.onAir = 'B';
    expect([engine.active, engine.pending, engine.mix]).toEqual([null, null, 1]);
    engine.dispose();
  });

  it('declines an unloaded destination and invalid duration without disturbing output', () => {
    const onError = vi.fn();
    const engine = new DeckEngine({ canvas, onError });
    engine.load('A', work('a').module);
    engine.renderAt(0);
    expect(engine.take({ transition: 'dissolve', beats: 4, quantize: 'now' })).toBe(false);
    expect(engine.take({ transition: 'dissolve', beats: -1, quantize: 'now' })).toBe(false);
    expect([engine.mix, engine.onAir, engine.pending]).toEqual([0, 'A', null]);
    expect(onError).toHaveBeenCalledOnce();
    engine.dispose();
  });

  it('updates idle macros without drawing and accepts a shared request beat across windows', () => {
    const { engine, b, live, beat } = setup();
    live({ low: 0.8 });
    beat(15.99);
    expect(b.render).not.toHaveBeenCalled();
    expect(engine.macros.B[0]).toBeCloseTo(0.6);
    expect(engine.take({ transition: 'dissolve', beats: 4, quantize: 'phrase16' }, 16.01)).toBe(true);
    expect(engine.pending?.startBeat).toBe(32);
    engine.dispose();
  });
});

describe('DeckEngine master FX and panic', () => {
  it('runs FX in fixed order with no framebuffer feedback and resets stale trails on re-enable', () => {
    const { engine, beat } = setup();
    engine.mix = 0.5;
    for (const id of ['strobe', 'grain', 'rgb-split', 'kaleido', 'feedback'] as const) engine.setFx(id, { on: true });
    beat(0);
    expect(kinds()).toEqual(['dissolve', 'feedback', 'kaleido', 'rgb-split', 'grain', 'strobe', 'finish']);
    expect(gpu.copies).toHaveLength(1);
    beat(0.04);
    expect(gpu.copies).toHaveLength(1);
    engine.setFx('feedback', { on: false });
    engine.setFx('grain', { amount: 0 });
    gpu.draws.length = 0;
    beat(0.08);
    expect(kinds()).toEqual(['dissolve', 'kaleido', 'rgb-split', 'strobe', 'finish']);
    engine.setFx('feedback', { on: true, amount: 10 });
    beat(0.12);
    expect(gpu.copies).toHaveLength(2);
    expect(engine.fx.feedback.amount).toBe(1);
    engine.dispose();
  });

  it('seeds feedback-melt once per take and keeps its history separate from master feedback', () => {
    const { engine, beat } = setup();
    engine.setFx('feedback', { on: true });
    beat(0);
    engine.take({ transition: 'feedback-melt', beats: 2, quantize: 'now' });
    beat(0.5); beat(1);
    expect(gpu.copies).toHaveLength(2);
    const melt = gpu.draws.filter(d => d.kind === 'feedback-melt').at(-1)!;
    const feedback = gpu.draws.filter(d => d.kind === 'feedback').at(-1)!;
    expect(melt.uniforms.uHistory).not.toBe(feedback.uniforms.uHistory);
    beat(2);
    engine.take({ transition: 'feedback-melt', beats: 2, quantize: 'now' });
    beat(2.5);
    expect(gpu.copies).toHaveLength(3);
    engine.dispose();
  });

  it('blackout clears to exact black and skips finish/grain; unblackout renders normally', () => {
    const { engine } = setup();
    engine.renderer.setClearColor(0xff0000, 0.5);
    engine.blackout(true);
    engine.renderAt(0);
    expect(gpu.draws).toHaveLength(0);
    expect(gpu.clears.at(-1)).toEqual({ target: null, color: 0 });
    expect(engine.renderer.getClearAlpha()).toBe(0.5);
    engine.blackout(false);
    engine.renderAt(16);
    expect(kinds()).toEqual(['finish']);
    engine.dispose();
  });

  it('freezes the last pre-FX mix while previews and queued transitions continue', () => {
    const { engine, beat, a } = setup();
    beat(0);
    const mixed = engine.previewTexture('A');
    engine.freeze(true);
    expect(gpu.copies.at(-1)!.source).toBe(mixed);
    const frozen = gpu.copies.at(-1)!.target.texture;
    engine.take({ transition: 'dissolve', beats: 2, quantize: 'now' });
    engine.setPreview('A', true);
    beat(1); beat(2);
    expect(lastDraw().uniforms.uTex).toBe(frozen);
    expect(engine.onAir).toBe('B');
    expect(a.render).toHaveBeenCalledTimes(3);
    expect(gpu.copies).toHaveLength(1);
    engine.freeze(false);
    engine.freeze(true);
    beat(3);
    expect(lastDraw().uniforms.uTex).toBe(frozen);
    engine.freeze(false);
    beat(4);
    expect(lastDraw().uniforms.uTex).toBe(engine.previewTexture('B'));
    engine.dispose();
  });

  it('captures a valid frame if freeze is requested before the first draw', () => {
    const { engine, a, b } = setup();
    engine.freeze(true);
    engine.renderAt(0); engine.renderAt(16);
    expect(gpu.copies).toHaveLength(1);
    expect(a.render).toHaveBeenCalledOnce();
    expect(b.render).not.toHaveBeenCalled();
    engine.dispose();
  });

  it('SAFE clears both panic flags and takes, bypasses FX, and returns via onAir/take', () => {
    const { engine, beat, a, b } = setup();
    expect(engine.safe()).toBe(false);
    const safe = work('safe-work');
    expect(engine.setSafe(safe.module)).toBe(true);
    safe.render.mockClear();
    engine.setFx('feedback', { on: true });
    engine.setFx('strobe', { on: true, amount: 1 });
    beat(0);
    engine.take({ transition: 'dissolve', beats: 4, quantize: 'now' });
    engine.freeze(true); engine.blackout(true);
    engine.take({ transition: 'luma-wipe', beats: 4, quantize: 'bar' });
    expect(engine.safe()).toBe(true);
    expect([engine.isSafe, engine.isBlackout, engine.isFrozen, engine.active, engine.pending]).toEqual([true, false, false, null, null]);
    gpu.draws.length = 0;
    beat(1);
    expect(kinds()).toEqual(['finish']);
    expect(safe.render).toHaveBeenCalledOnce();
    expect(a.render).toHaveBeenCalledOnce();
    expect(b.render).not.toHaveBeenCalled();
    engine.onAir = 'A';
    expect(engine.isSafe).toBe(false);
    beat(2);
    expect(kinds().slice(-3)).toEqual(['feedback', 'strobe', 'finish']);
    engine.safe();
    expect(engine.take({ transition: 'cut', beats: 0, quantize: 'now' })).toBe(true);
    beat(3);
    expect([engine.isSafe, engine.onAir]).toEqual([false, 'B']);
    engine.dispose();
  });

  it('keeps the safe slot on failed replacement and disposes rejected/new safe resources', () => {
    const { engine } = setup();
    const safe = work('safe-work');
    engine.setSafe(safe.module);
    engine.safe();
    const bad = work('bad-safe');
    bad.render.mockImplementation(() => { throw new Error('failed safe'); });
    expect(engine.setSafe(bad.module)).toBe(false);
    expect(engine.workId('safe')).toBe('safe-work');
    expect(safe.dispose).not.toHaveBeenCalled();
    expect(bad.dispose).toHaveBeenCalledOnce();
    engine.dispose();
    expect(safe.dispose).toHaveBeenCalledOnce();
  });
});

describe('DeckEngine lifecycle', () => {
  it('resizes every live slot/history, re-seeds freeze, and disposes all resources exactly once', () => {
    const { engine, a, b, beat } = setup();
    const safe = work('safe-work');
    engine.setSafe(safe.module);
    beat(0);
    engine.take({ transition: 'feedback-melt', beats: 4, quantize: 'now' });
    engine.setFx('feedback', { on: true });
    engine.setFx('kaleido', { on: true });
    beat(1);
    engine.freeze(true);
    vi.stubGlobal('window', { devicePixelRatio: 2 });
    gpu.observers[0].callback();
    for (const target of gpu.targets) {
      if (target.width !== 64) expect([target.width, target.height]).toEqual([3840, 2160]);
    }
    expect(a.resize).toHaveBeenCalledWith(3840, 2160);
    expect(b.resize).toHaveBeenCalledWith(3840, 2160);
    expect(safe.resize).toHaveBeenCalledWith(3840, 2160);
    const copies = gpu.copies.length;
    beat(1.1);
    expect(gpu.copies.length).toBeGreaterThan(copies);
    for (const target of gpu.targets) vi.mocked(target.dispose).mockClear();
    engine.dispose(); engine.dispose();
    for (const target of gpu.targets) expect(target.dispose).toHaveBeenCalledOnce();
    for (const pass of gpu.passes) expect(pass.dispose).toHaveBeenCalledOnce();
    for (const work of [a, b, safe]) expect(work.dispose).toHaveBeenCalledOnce();
    expect(engine.renderer.dispose).toHaveBeenCalledOnce();
    expect(gpu.observers[0].disconnect).toHaveBeenCalledOnce();
  });

  it('has one rAF loop even if started twice and cannot restart after disposal', () => {
    const { engine } = setup();
    engine.start(); engine.start();
    expect(requestAnimationFrame).toHaveBeenCalledOnce();
    engine.stop();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    engine.start();
    expect(requestAnimationFrame).toHaveBeenCalledTimes(2);
    engine.dispose();
    engine.start(); engine.renderAt(1);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(2);
  });

  it('continues disposal if a work disposer throws', () => {
    const { engine, a, b, onError } = setup();
    a.dispose.mockImplementation(() => { throw new Error('dispose failed'); });
    engine.dispose();
    expect(onError).toHaveBeenCalledWith('dispose failed', 'a', 'A');
    expect(b.dispose).toHaveBeenCalledOnce();
    expect(engine.renderer.dispose).toHaveBeenCalledOnce();
  });
});
