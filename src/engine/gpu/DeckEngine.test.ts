import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Texture, WebGPURenderer, RenderTarget } from 'three/webgpu';
import type { Frame, LiveSignals } from '../types';
import type { GpuInstrumentModule } from './types';
import { HalfFloatType, LinearSRGBColorSpace, NoToneMapping } from 'three/webgpu';
import { SILENT } from '../types';

const gpu = vi.hoisted(() => ({
  targets: [] as RenderTarget[],
  passes: [] as { kind: string; dispose: ReturnType<typeof vi.fn> }[],
  draws: [] as { kind: string; target: RenderTarget | null; uniforms: Record<string, unknown> }[],
  copies: [] as { source: Texture; target: RenderTarget }[],
  clears: [] as { target: RenderTarget | null; color: number }[],
  observers: [] as { callback: () => void; disconnect: ReturnType<typeof vi.fn> }[],
  renderers: [] as WebGPURenderer[],
  initWait: null as Promise<void> | null,
}));

vi.mock('three/webgpu', async importOriginal => {
  const actual = await importOriginal<typeof import('three/webgpu')>();
  return { ...actual, WebGPURenderer: class {
    debug = { checkShaderErrors: false, onShaderError: null };
    autoClear = false;
    toneMapping = actual.NoToneMapping;
    outputColorSpace = actual.SRGBColorSpace;
    backend: { device?: { pushErrorScope: ReturnType<typeof vi.fn>; popErrorScope: ReturnType<typeof vi.fn> } } = {};
    init = vi.fn(async () => { await gpu.initWait; });
    setViewport = vi.fn();
    setScissor = vi.fn();
    setScissorTest = vi.fn();
    current: RenderTarget | null = null;
    color = new actual.Color(0);
    alpha = 1;
    dispose = vi.fn();
    constructor(private readonly opts: { canvas: HTMLCanvasElement }) {
      gpu.renderers.push(this as unknown as WebGPURenderer);
    }
    setSize = vi.fn((w: number, h: number) => { this.opts.canvas.width = w; this.opts.canvas.height = h; });
    getRenderTarget() { return this.current; }
    setRenderTarget(target: RenderTarget | null) { this.current = target; }
    getClearColor(color: InstanceType<typeof actual.Color>) { return color.copy(this.color); }
    getClearAlpha() { return this.alpha; }
    setClearColor(color: number | InstanceType<typeof actual.Color>, alpha: number) { this.color.set(color); this.alpha = alpha; }
    clear() { gpu.clears.push({ target: this.current, color: this.color.getHex() }); }
  } };
});

const mockPass = vi.hoisted(() => (kind: string, uniforms: Record<string, { value: unknown }>) => {
  const pass = {
    kind, dispose: vi.fn(),
    render(renderer: WebGPURenderer, target: RenderTarget | null) {
      const values = Object.fromEntries(Object.entries(uniforms).map(([k, u]) => [k, u.value]));
      if (target) for (const value of Object.values(values)) expect(value).not.toBe(target.texture);
      renderer.setRenderTarget(target);
      gpu.draws.push({ kind, target, uniforms: values });
    },
  };
  gpu.passes.push(pass);
  return pass;
});

vi.mock('./passes', async importOriginal => {
  const actual = await importOriginal<typeof import('./passes')>();
  const track = (target: RenderTarget) => {
    vi.spyOn(target, 'dispose'); gpu.targets.push(target); return target;
  };
  return { ...actual,
    createTarget: (w: number, h: number, depth = false) => track(actual.createTarget(w, h, depth)),
    PingPong: class extends actual.PingPong {
      constructor(w: number, h: number) { super(w, h); track(this.read); track(this.write); }
    },
    CopyPass: class {
      kind = 'copy'; dispose = vi.fn();
      constructor() { gpu.passes.push(this); }
      render(renderer: WebGPURenderer, source: Texture, target: RenderTarget) {
        expect(source).not.toBe(target.texture);
        renderer.setRenderTarget(target);
        gpu.copies.push({ source, target });
      }
    },
  };
});
vi.mock('./transitions', async importOriginal => ({
  ...await importOriginal<typeof import('./transitions')>(),
  createTransitionPass: (kind: string, u: Record<string, { value: unknown }>) => mockPass(kind, u),
}));
vi.mock('./fx', async importOriginal => ({
  ...await importOriginal<typeof import('./fx')>(),
  createFxPass: (kind: string, u: Record<string, { value: unknown }>) => mockPass(kind, u),
}));
vi.mock('./finish', async importOriginal => ({
  ...await importOriginal<typeof import('./finish')>(),
  createFinishPass: (u: Record<string, { value: unknown }>) => mockPass('finish', u),
}));

import { GpuDeckEngine } from './DeckEngine';
import type { Transition } from './DeckEngine';

const canvas = { clientWidth: 1920, clientHeight: 1080, width: 1920, height: 1080 } as HTMLCanvasElement;
function work(id: string) {
  const render = vi.fn((_frame: Frame, _target: RenderTarget) => {});
  const dispose = vi.fn();
  const resize = vi.fn();
  const module: GpuInstrumentModule = {
    gpu: true,
    manifest: { id, name: id, mood: [], energy: [0, 1], tempo: 'both',
      macros: [{ id: 'energy', label: 'Energy', default: 0.2, mod: { source: 'low', amount: 0.5 } }],
      presets: { loud: { energy: 0.8 } } },
    create: vi.fn(() => ({ render, dispose, resize })),
  };
  return { module, render, dispose, resize };
}
const lastDraw = () => gpu.draws.at(-1)!;
const kinds = () => gpu.draws.map(draw => draw.kind);
function shaderFailure(renderer: WebGPURenderer) {
  const args = [{ getProgramInfoLog: () => 'bad shader', getShaderInfoLog: () => '' }, {}, {}, {}];
  renderer.debug.onShaderError!(...args as Parameters<NonNullable<typeof renderer.debug.onShaderError>>);
}
async function setup() {
  let live: LiveSignals = { ...SILENT };
  const onError = vi.fn();
  const onLoad = vi.fn();
  const engine = await GpuDeckEngine.create({ canvas, onError, onLoad });
  const signals = vi.fn(() => live);
  engine.signals = signals;
  const a = work('a'), b = work('b');
  await engine.load('A', a.module);
  await engine.load('B', b.module);
  a.render.mockClear(); b.render.mockClear(); signals.mockClear();
  gpu.draws.length = gpu.copies.length = 0;
  // RenderTarget.setSize disposes its attachments during initial sizing.
  for (const target of gpu.targets) vi.mocked(target.dispose).mockClear();
  return { engine, a, b, onError, onLoad, signals,
    beat: (beats: number, now = beats * 500) => {
      live = { ...live, beats, beat: beats % 1, bar: beats / 4 % 1 };
      engine.renderAt(now);
    },
    live: (changes: Partial<LiveSignals>) => { live = { ...live, ...changes }; },
  };
}

beforeEach(() => {
  gpu.initWait = null;
  gpu.renderers.length = 0;
  Object.assign(canvas, { clientWidth: 1920, clientHeight: 1080, width: 1920, height: 1080 });
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function validationDevice(engine: GpuDeckEngine) {
  const device = { pushErrorScope: vi.fn(), popErrorScope: vi.fn(async (): Promise<{ message: string } | null> => null) };
  Object.assign(engine.renderer.backend, { device });
  return device;
}

describe('GpuDeckEngine asynchronous lifecycle', () => {
  it('awaits backend initialization before allocating/clearing and disposes a rejected renderer', async () => {
    const ready = deferred<void>();
    gpu.initWait = ready.promise;
    const creating = GpuDeckEngine.create({ canvas });
    expect(gpu.targets).toHaveLength(0);
    expect(gpu.clears).toHaveLength(0);
    ready.resolve();
    const engine = await creating;
    expect(engine.renderer.init).toHaveBeenCalledOnce();
    expect(engine.renderer.toneMapping).toBe(NoToneMapping);
    expect(engine.renderer.outputColorSpace).toBe(LinearSRGBColorSpace);
    expect(gpu.targets).toHaveLength(4);
    for (const t of gpu.targets) {
      expect(t.depthBuffer).toBe(true);
      expect(t.texture.type).toBe(HalfFloatType);
      expect(t.texture.colorSpace).toBe(LinearSRGBColorSpace);
    }
    engine.dispose();
    const broken = deferred<void>();
    gpu.initWait = broken.promise;
    const failure = GpuDeckEngine.create({ canvas });
    broken.reject(new Error('backend init failed'));
    await expect(failure).rejects.toThrow('backend init failed');
    expect(gpu.renderers.at(-1)!.dispose).toHaveBeenCalledOnce();
  });

  it('keeps live knobs, macros, textures and rendering while create is pending or rejects', async () => {
    const { engine, a, onError, onLoad } = await setup();
    engine.knobs.A[0] = 0.7;
    const old = engine.previewTexture('A');
    const waiting = deferred<Awaited<ReturnType<typeof a.module.create>>>();
    const bad = work('async-bad');
    vi.mocked(bad.module.create).mockReturnValue(waiting.promise);
    const load = engine.load('A', bad.module);
    expect(engine.knobs.A[0]).toBeCloseTo(0.7);
    expect(engine.previewTexture('A')).toBe(old);
    engine.renderAt(0);
    expect(a.render).toHaveBeenCalledOnce();
    engine.knobs.A[0] = 0.9;
    waiting.reject(new Error('model failed'));
    expect(await load).toBe(false);
    expect(engine.workId('A')).toBe('a');
    expect(engine.knobs.A[0]).toBeCloseTo(0.9);
    expect(engine.macros.A[0]).toBeCloseTo(0.7);
    expect(onError).toHaveBeenCalledWith('model failed', 'async-bad', 'A');
    expect(onLoad).toHaveBeenCalledTimes(2);
    expect(a.dispose).not.toHaveBeenCalled();
    engine.dispose();
  });

  it.each(['success', 'reject'] as const)('ignores a stale asynchronous %s and keeps the newest deck', async outcome => {
    const { engine, a, onError, onLoad } = await setup();
    const stale = work('stale'), next = work('next');
    const waiting = deferred<Awaited<ReturnType<typeof stale.module.create>>>();
    vi.mocked(stale.module.create).mockReturnValue(waiting.promise);
    const oldLoad = engine.load('A', stale.module);
    expect(await engine.load('A', next.module)).toBe(true);
    if (outcome === 'success') waiting.resolve({ render: stale.render, dispose: stale.dispose, resize: stale.resize });
    else waiting.reject(new Error('stale rejection'));
    expect(await oldLoad).toBe(false);
    expect(engine.workId('A')).toBe('next');
    expect(stale.render).not.toHaveBeenCalled();
    expect(stale.dispose).toHaveBeenCalledTimes(outcome === 'success' ? 1 : 0);
    expect(a.dispose).toHaveBeenCalledOnce();
    expect(next.dispose).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onLoad).toHaveBeenLastCalledWith('next', 'A');
    engine.dispose();
  });

  it('keeps loads on separate decks independent', async () => {
    const { engine } = await setup();
    const a = work('slow-a'), b = work('new-b');
    const waiting = deferred<Awaited<ReturnType<typeof a.module.create>>>();
    vi.mocked(a.module.create).mockReturnValue(waiting.promise);
    const loading = engine.load('A', a.module);
    expect(await engine.load('B', b.module)).toBe(true);
    waiting.resolve({ render: a.render, dispose: a.dispose });
    expect(await loading).toBe(true);
    expect([engine.workId('A'), engine.workId('B')]).toEqual(['slow-a', 'new-b']);
    engine.dispose();
  });

  it.each(['validation', 'pop-reject', 'render'] as const)('balances validation scopes on %s failure and restores the render target', async failure => {
    const { engine, a, onError } = await setup();
    const device = validationDevice(engine);
    if (failure === 'validation') device.popErrorScope.mockResolvedValue({ message: 'invalid pipeline' });
    if (failure === 'pop-reject') device.popErrorScope.mockRejectedValue(new Error('device lost'));
    const bad = work('bad-gpu');
    const targetBefore = gpu.targets[1];
    engine.renderer.setRenderTarget(targetBefore);
    bad.render.mockImplementation((_f, t) => {
      engine.renderer.setRenderTarget(t);
      if (failure === 'render') throw new Error('trial failed');
    });
    expect(await engine.load('A', bad.module)).toBe(false);
    expect(device.pushErrorScope).toHaveBeenCalledWith('validation');
    expect(device.popErrorScope).toHaveBeenCalledOnce();
    expect(engine.renderer.getRenderTarget()).toBe(targetBefore);
    expect(engine.workId('A')).toBe('a');
    expect(a.dispose).not.toHaveBeenCalled();
    expect(bad.dispose).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
    engine.dispose();
  });

  it('pops the scope before yielding and rejects a stale validation result', async () => {
    const { engine, a, onError } = await setup();
    const device = validationDevice(engine);
    const checked = deferred<{ message: string } | null>();
    device.popErrorScope.mockReturnValueOnce(checked.promise);
    const stale = work('gpu-wait'), next = work('next');
    stale.render.mockImplementation((_f, t) => engine.renderer.setRenderTarget(t));
    const targetBefore = engine.renderer.getRenderTarget();
    const loading = engine.load('A', stale.module);
    await Promise.resolve();
    expect(device.popErrorScope).toHaveBeenCalledOnce();
    expect(engine.renderer.getRenderTarget()).toBe(targetBefore);
    engine.renderAt(0);
    expect(a.render).toHaveBeenCalledOnce();
    expect(await engine.load('A', next.module)).toBe(true);
    checked.resolve({ message: 'late validation error' });
    expect(await loading).toBe(false);
    expect(engine.workId('A')).toBe('next');
    expect(stale.dispose).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    engine.dispose();
  });

  it('resizes a candidate that loaded across a canvas-size change and preserves current knobs on reload', async () => {
    const { engine } = await setup();
    const reload = work('a');
    const waiting = deferred<Awaited<ReturnType<typeof reload.module.create>>>();
    vi.mocked(reload.module.create).mockReturnValue(waiting.promise);
    const loading = engine.load('A', reload.module);
    Object.assign(canvas, { clientWidth: 800, clientHeight: 450 });
    engine.renderAt(0);
    engine.knobs.A[0] = 0.85;
    waiting.resolve({ render: reload.render, dispose: reload.dispose, resize: reload.resize });
    expect(await loading).toBe(true);
    expect(reload.resize).toHaveBeenCalledWith(800, 450);
    expect(reload.render.mock.calls[0][0]).toMatchObject({ width: 800, height: 450 });
    expect(reload.render.mock.calls[0][0].macros[0]).toBeCloseTo(0.85);
    expect(engine.knobs.A[0]).toBeCloseTo(0.85);
    engine.dispose();
  });

  it('resizes again and uses current signals when GPU validation spans live frames', async () => {
    const { engine, live } = await setup();
    const device = validationDevice(engine), checked = deferred<{ message: string } | null>();
    device.popErrorScope.mockReturnValueOnce(checked.promise);
    const candidate = work('world');
    const loading = engine.load('A', candidate.module);
    await Promise.resolve();
    Object.assign(canvas, { clientWidth: 960, clientHeight: 540 });
    live({ low: 0.8 });
    engine.renderAt(16);
    checked.resolve(null);
    expect(await loading).toBe(true);
    expect(candidate.resize).toHaveBeenCalledWith(960, 540);
    expect(engine.macros.A[0]).toBeCloseTo(0.6);
    engine.dispose();
  });

  it('releases a first safe slot after rejection, and ignores concurrent stale safe loads', async () => {
    const { engine, onError } = await setup();
    const bad = work('bad-safe');
    vi.mocked(bad.module.create).mockRejectedValue(new Error('no safe'));
    expect(await engine.setSafe(bad.module)).toBe(false);
    expect(gpu.targets.at(-1)!.dispose).toHaveBeenCalledOnce();
    expect(engine.safe()).toBe(false);
    onError.mockClear();
    const slow = work('slow-safe'), next = work('safe');
    const waiting = deferred<Awaited<ReturnType<typeof slow.module.create>>>();
    vi.mocked(slow.module.create).mockReturnValue(waiting.promise);
    const loading = engine.setSafe(slow.module);
    expect(await engine.setSafe(next.module)).toBe(true);
    waiting.resolve({ render: slow.render, dispose: slow.dispose });
    expect(await loading).toBe(false);
    expect(engine.workId('safe')).toBe('safe');
    expect(slow.dispose).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    engine.dispose();
    for (const target of gpu.targets) expect(target.dispose).toHaveBeenCalledOnce();
  });

  it.each(['A', 'safe'] as const)('disposes a late %s candidate once after engine disposal', async deck => {
    const { engine, onLoad, onError } = await setup();
    const late = work('late');
    const waiting = deferred<Awaited<ReturnType<typeof late.module.create>>>();
    vi.mocked(late.module.create).mockReturnValue(waiting.promise);
    const loading = deck === 'A' ? engine.load(deck, late.module) : engine.setSafe(late.module);
    engine.dispose();
    waiting.resolve({ render: late.render, dispose: late.dispose });
    expect(await loading).toBe(false);
    expect(late.render).not.toHaveBeenCalled();
    expect(late.dispose).toHaveBeenCalledOnce();
    expect(onLoad).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
    expect(await engine.load('A', late.module)).toBe(false);
    expect(await engine.setSafe(late.module)).toBe(false);
    for (const target of gpu.targets) expect(target.dispose).toHaveBeenCalledOnce();
  });
});

describe('GpuDeckEngine mirroring and multiview', () => {
  it('round-trips queued takes, FX and panic state with independent snapshots', async () => {
    const first = await setup(), second = await setup();
    for (const engine of [first.engine, second.engine]) await engine.setSafe(work('safe').module);
    first.beat(0);
    first.engine.take({ transition: 'displace', beats: 4, quantize: 'now' });
    first.beat(1);
    first.engine.take({ transition: 'dissolve', beats: 2, quantize: 'bar' });
    first.engine.setFx('feedback', { on: true, amount: 0.8 });
    first.engine.exposure = second.engine.exposure = 1.7;
    first.engine.freeze(true);
    first.engine.blackout(true);
    const snapshot = first.engine.syncState();
    second.engine.applySync(snapshot);
    expect(second.engine.syncState()).toEqual(snapshot);
    snapshot.fx.feedback.amount = 0;
    snapshot.active!.endBeat = 100;
    expect(second.engine.fx.feedback.amount).toBe(0.8);
    expect(second.engine.active!.endBeat).toBe(4);
    first.beat(5); second.beat(5);
    expect(second.engine.syncState()).toEqual(first.engine.syncState());
    expect([first.engine.mix, second.engine.mix]).toEqual([0.5, 0.5]);
    first.engine.safe();
    second.engine.applySync(first.engine.syncState());
    expect(second.engine.isSafe).toBe(true);
    first.engine.onAir = 'B';
    second.engine.applySync(first.engine.syncState());
    expect(second.engine.isSafe).toBe(false);
    first.engine.dispose(); second.engine.dispose();
  });

  it.each(['webgpu', 'webgl'] as const)('uses top-left multiview viewports without clearing prior draws on %s', async backend => {
    vi.stubGlobal('window', { devicePixelRatio: 2 });
    let layout = { program: { x: 100, y: 50, w: 800, h: 450 }, previews: {
      A: { x: 20, y: 600, w: 320, h: 180 }, B: { x: 360, y: 600, w: 320, h: 180 },
    } };
    const engine = await GpuDeckEngine.create({ canvas, scale: 0.5, layout: () => layout });
    Object.assign(engine.renderer.backend, backend === 'webgpu' ? { isWebGPUBackend: true } : { isWebGLBackend: true });
    const a = work('a'), b = work('b');
    await engine.load('A', a.module); await engine.load('B', b.module);
    a.render.mockClear(); b.render.mockClear();
    const pass = gpu.passes.find(p => p.kind === 'finish') as unknown as { render: (r: WebGPURenderer, t: RenderTarget | null) => void };
    const render = pass.render;
    const clearFlags: boolean[] = [];
    pass.render = (r, t) => { clearFlags.push(r.autoClear); render(r, t); };
    gpu.draws.length = 0;
    engine.setPreview('B', true);
    engine.renderAt(0);
    expect([canvas.width, canvas.height]).toEqual([3840, 2160]);
    expect(a.render.mock.calls[0][0]).toMatchObject({ width: 800, height: 450 });
    expect(kinds()).toEqual(['finish', 'finish', 'finish']);
    expect(clearFlags).toEqual([false, false, false]);
    expect(engine.renderer.setViewport).toHaveBeenCalledWith(200, 100, 1600, 900);
    expect(engine.renderer.setScissor).toHaveBeenCalledWith(40, 1200, 640, 360);
    expect(engine.renderer.setScissor).toHaveBeenCalledWith(720, 1200, 640, 360);
    expect(engine.renderer.autoClear).toBe(true);
    expect(engine.renderer.setScissorTest).toHaveBeenLastCalledWith(false);
    expect(engine.renderer.setViewport).toHaveBeenLastCalledWith(0, 0, 3840, 2160);
    engine.setPreview('B', false);
    gpu.draws.length = 0;
    engine.blackout(true);
    engine.renderAt(16);
    expect(kinds()).toEqual(['finish', 'finish']);
    expect(b.render).toHaveBeenCalledOnce();
    layout = { ...layout, program: { ...layout.program, w: 640, h: 360 } };
    engine.renderAt(32);
    expect(a.resize).toHaveBeenCalledWith(640, 360);
    engine.dispose();
  });
});

describe('GpuDeckEngine fail-safe loading', () => {
  it.each(['create', 'trial', 'shader'] as const)('rejects %s failure without altering either deck or knobs', async failure => {
    const { engine, a, b, onError } = await setup();
    engine.knobs.A[0] = 0.7;
    const old = engine.previewTexture('A');
    const bad = work('bad');
    if (failure === 'create') vi.mocked(bad.module.create).mockImplementation(() => { throw new Error('create failed'); });
    if (failure === 'trial') bad.render.mockImplementation(() => { throw new Error('trial failed'); });
    if (failure === 'shader') bad.render.mockImplementation(() => shaderFailure(engine.renderer));
    expect(await engine.load('A', bad.module)).toBe(false);
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

  it('trials zero-dt frames at scratch size, keeps knobs for reloads, and resets on different work', async () => {
    const { engine, a, b } = await setup();
    engine.knobs.A[0] = 0.6;
    const reload = work('a');
    expect(await engine.load('A', reload.module)).toBe(true);
    const [frame, target] = reload.render.mock.calls[0];
    expect([target.width, target.height, frame.width, frame.height, frame.signals.dt]).toEqual([64, 36, 1920, 1080, 0]);
    expect(frame.macros[0]).toBeCloseTo(0.6);
    expect(a.dispose).toHaveBeenCalledOnce();
    const other = work('other');
    await engine.load('A', other.module, { keepKnobs: true });
    expect(engine.knobs.A[0]).toBeCloseTo(0.6);
    await engine.load('A', work('reset').module);
    expect(engine.knobs.A[0]).toBeCloseTo(0.2);
    expect(b.dispose).not.toHaveBeenCalled();
    engine.dispose();
  });

  it('commits only successful live frames and reports once per failing burst', async () => {
    const { engine, a, onError } = await setup();
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

describe('GpuDeckEngine rendering and takes', () => {
  it('renders one deck without mix/FX passes; previews are opt-in and manual mix is clamped', async () => {
    const { engine, a, b } = await setup();
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

  it('samples one shared signal snapshot with independent macro arrays and repeatable capture time', async () => {
    const { engine, a, b, signals, live } = await setup();
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

  it.each<Transition>(['cut', 'dissolve', 'luma-wipe', 'displace', 'feedback-melt'])('takes A→B→A with %s and exact endpoints', async transition => {
    const { engine, beat, a, b } = await setup();
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

  it('preserves the active transition for queued TAKE, and manual assignments cancel both', async () => {
    const { engine, beat } = await setup();
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

  it('declines an unloaded destination and invalid duration without disturbing output', async () => {
    const onError = vi.fn();
    const engine = await GpuDeckEngine.create({ canvas, onError });
    await engine.load('A', work('a').module);
    engine.renderAt(0);
    expect(engine.take({ transition: 'dissolve', beats: 4, quantize: 'now' })).toBe(false);
    expect(engine.take({ transition: 'dissolve', beats: -1, quantize: 'now' })).toBe(false);
    expect([engine.mix, engine.onAir, engine.pending]).toEqual([0, 'A', null]);
    expect(onError).toHaveBeenCalledOnce();
    engine.dispose();
  });

  it('updates idle macros without drawing and accepts a shared request beat across windows', async () => {
    const { engine, b, live, beat } = await setup();
    live({ low: 0.8 });
    beat(15.99);
    expect(b.render).not.toHaveBeenCalled();
    expect(engine.macros.B[0]).toBeCloseTo(0.6);
    expect(engine.take({ transition: 'dissolve', beats: 4, quantize: 'phrase16' }, 16.01)).toBe(true);
    expect(engine.pending?.startBeat).toBe(32);
    engine.dispose();
  });
});

describe('GpuDeckEngine master FX and panic', () => {
  it('runs FX in fixed order with no framebuffer feedback and resets stale trails on re-enable', async () => {
    const { engine, beat } = await setup();
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

  it('seeds feedback-melt once per take and keeps its history separate from master feedback', async () => {
    const { engine, beat } = await setup();
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

  it('blackout clears to exact black and skips finish/grain; unblackout renders normally', async () => {
    const { engine } = await setup();
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

  it('freezes the last pre-FX mix while previews and queued transitions continue', async () => {
    const { engine, beat, a } = await setup();
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

  it('captures a valid frame if freeze is requested before the first draw', async () => {
    const { engine, a, b } = await setup();
    engine.freeze(true);
    engine.renderAt(0); engine.renderAt(16);
    expect(gpu.copies).toHaveLength(1);
    expect(a.render).toHaveBeenCalledOnce();
    expect(b.render).not.toHaveBeenCalled();
    engine.dispose();
  });

  it('SAFE clears both panic flags and takes, bypasses FX, and returns via onAir/take', async () => {
    const { engine, beat, a, b } = await setup();
    expect(engine.safe()).toBe(false);
    const safe = work('safe-work');
    expect(await engine.setSafe(safe.module)).toBe(true);
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

  it('keeps the safe slot on failed replacement and disposes rejected/new safe resources', async () => {
    const { engine } = await setup();
    const safe = work('safe-work');
    await engine.setSafe(safe.module);
    engine.safe();
    const bad = work('bad-safe');
    bad.render.mockImplementation(() => { throw new Error('failed safe'); });
    expect(await engine.setSafe(bad.module)).toBe(false);
    expect(engine.workId('safe')).toBe('safe-work');
    expect(safe.dispose).not.toHaveBeenCalled();
    expect(bad.dispose).toHaveBeenCalledOnce();
    engine.dispose();
    expect(safe.dispose).toHaveBeenCalledOnce();
  });
});

describe('GpuDeckEngine lifecycle', () => {
  it('resizes every live slot/history, re-seeds freeze, and disposes all resources exactly once', async () => {
    const { engine, a, b, beat } = await setup();
    const safe = work('safe-work');
    await engine.setSafe(safe.module);
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

  it('has one rAF loop even if started twice and cannot restart after disposal', async () => {
    const { engine } = await setup();
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

  it('continues disposal if a work disposer throws', async () => {
    const { engine, a, b, onError } = await setup();
    a.dispose.mockImplementation(() => { throw new Error('dispose failed'); });
    engine.dispose();
    expect(onError).toHaveBeenCalledWith('dispose failed', 'a', 'A');
    expect(b.dispose).toHaveBeenCalledOnce();
    expect(engine.renderer.dispose).toHaveBeenCalledOnce();
  });
});
